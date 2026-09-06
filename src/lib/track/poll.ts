/**
 * Inbound tracking (PRD §7 "Gmail poll -> infer"). For every vendor with an
 * outbound Gmail thread: fetch messages not yet stored, insert them as
 * interactions (direction=inbound), move Contacted -> Replied on the first
 * one (actor=system), then run inference and apply or propose (PRD §6).
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb, nowIso, type Db } from "@/lib/db";
import { insertInteraction } from "@/lib/db/queries";
import { interactions, proposals, vendors, type InteractionRow, type Vendor } from "@/lib/db/schema";
import { TransitionError, transition } from "@/lib/db/state";
import { listThreadMessages, profile } from "@/lib/outreach/gmail";
import { unknownMustFields } from "@/lib/shared/must-fields";

import { inferStatus, type Inference, type InferenceInput } from "./infer";

const ACTIVE: Vendor["status"][] = ["Contacted", "Replied", "In Discussion"];
const RESPOND_WITHIN_DAYS = 2;

/** Drop quoted history so inference sees only the new text. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{5,200} wrote:\s*$/.test(line.trim())) break;
    if (/^-{3,}\s*Original Message\s*-{3,}$/i.test(line.trim())) break;
    if (/^_{10,}$/.test(line.trim())) break;
    if (/^From:\s.+$/.test(line.trim()) && out.length > 0) break;
    if (line.trim().startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export type InboundMessage = {
  thread_id: string;
  /** message time, ISO; also the dedup key inside a thread */
  sent_at: string;
  subject: string | null;
  body_text: string;
  from?: string | null;
};

export type IngestResult = {
  vendor_id: string;
  interaction_id: number;
  replied: boolean;
  inference: Inference | null;
  applied: boolean;
  proposal_id: number | null;
  error?: string;
};

export type IngestOptions = {
  infer?: boolean;
  /** test seam: replaces the LLM call */
  inferFn?: (input: InferenceInput) => Promise<Inference>;
};

/** I/O: store the inbound message, move Contacted -> Replied on the first one, set the human's next action. */
export function recordInbound(db: Db, vendor: Vendor, message: InboundMessage, body: string, now: string): { interaction: InteractionRow; replied: boolean } {
  return db.transaction((tx) => {
    const row = insertInteraction(
      { vendor_id: vendor.vendor_id, direction: "inbound", gmail_thread_id: message.thread_id, sent_at: message.sent_at, subject: message.subject, body_text: body, llm_summary: null },
      tx,
    );
    let replied = false;
    if (vendor.status === "Contacted") {
      transition({ vendorId: vendor.vendor_id, toStatus: "Replied", actor: "system", reason: "first inbound reply", evidenceRef: `interaction:${row.interaction_id}` }, tx);
      replied = true;
    }
    tx.update(vendors)
      .set({ next_action: "respond", due_at: new Date(Date.now() + RESPOND_WITHIN_DAYS * 86_400_000).toISOString(), updated_at: now })
      .where(eq(vendors.vendor_id, vendor.vendor_id))
      .run();
    return { interaction: row, replied };
  });
}

/** Pure: what the model gets to look at. */
export function buildInferenceInput(current: Vendor, message: InboundMessage, body: string, lastOutbound: InteractionRow | undefined): InferenceInput {
  return {
    vendor: { name: current.name, vendor_type: current.vendor_type, status: current.status, stage: current.diligence_stage },
    message: { from: message.from, subject: message.subject, body, date: message.sent_at },
    lastOutbound: lastOutbound ? { subject: lastOutbound.subject, body: lastOutbound.body_text ?? "" } : null,
    unknownMustFields: unknownMustFields(current),
  };
}

/** I/O: record the inference on the interaction, then apply it or file a proposal (PRD section 6). */
export function applyInference(db: Db, vendorId: string, interactionId: number, inference: Inference): { applied: boolean; proposal_id: number | null } {
  db.update(interactions).set({ llm_summary: `${inference.summary} [${inference.action}: ${inference.reason}]` }).where(eq(interactions.interaction_id, interactionId)).run();
  const propose = () =>
    db
      .insert(proposals)
      .values({ vendor_id: vendorId, interaction_id: interactionId, to_status: inference.to_status, to_stage: inference.to_stage, confidence: inference.confidence, evidence_snippet: inference.evidence_snippet })
      .returning()
      .get().proposal_id;
  if (inference.action === "apply") {
    try {
      transition(
        {
          vendorId,
          toStatus: inference.to_status,
          toStage: inference.to_stage ?? undefined,
          actor: "llm_inference",
          reason: inference.summary,
          confidence: inference.confidence,
          evidenceRef: `interaction:${interactionId}`,
          payload: { evidence_snippet: inference.evidence_snippet, model: inference.model, proposal: false },
        },
        db,
      );
      return { applied: true, proposal_id: null };
    } catch (err) {
      if (err instanceof TransitionError) return { applied: false, proposal_id: propose() };
      throw err;
    }
  }
  if (inference.action === "propose") return { applied: false, proposal_id: propose() };
  return { applied: false, proposal_id: null };
}

/** One inbound message through the whole pipeline; used by the poller and by the simulate route. */
export async function ingestInbound(vendorId: string, message: InboundMessage, opts: IngestOptions = {}, db: Db = getDb()): Promise<IngestResult> {
  const vendor = db.select().from(vendors).where(eq(vendors.vendor_id, vendorId)).get();
  if (!vendor) throw new Error(`vendor ${vendorId} not found`);
  const body = stripQuotedReply(message.body_text) || message.body_text.trim();
  const { interaction, replied } = recordInbound(db, vendor, message, body, nowIso());
  const result: IngestResult = { vendor_id: vendorId, interaction_id: interaction.interaction_id, replied, inference: null, applied: false, proposal_id: null };
  if (opts.infer === false) return result;

  const current = db.select().from(vendors).where(eq(vendors.vendor_id, vendorId)).get() as Vendor;
  if (!ACTIVE.includes(current.status) || current.status === "Contacted") return result;
  const lastOutbound = db.select().from(interactions).where(and(eq(interactions.vendor_id, vendorId), eq(interactions.direction, "outbound"))).orderBy(desc(interactions.interaction_id)).get();
  try {
    result.inference = await (opts.inferFn ?? inferStatus)(buildInferenceInput(current, message, body, lastOutbound));
  } catch (err) {
    result.error = `inference failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  const applied = applyInference(db, vendorId, interaction.interaction_id, result.inference);
  result.applied = applied.applied;
  result.proposal_id = applied.proposal_id;
  return result;
}

export type PollResult = {
  threads: number;
  new_inbound: number;
  replied: number;
  applied: number;
  proposals: number;
  errors: string[];
  results: IngestResult[];
};

/** Fetch every active vendor's Gmail thread and ingest messages not yet stored. */
export async function pollThreads(opts: { vendorId?: string; infer?: boolean } = {}, db: Db = getDb()): Promise<PollResult> {
  const out: PollResult = { threads: 0, new_inbound: 0, replied: 0, applied: 0, proposals: 0, errors: [], results: [] };
  const conds = [eq(interactions.direction, "outbound"), isNotNull(interactions.gmail_thread_id)];
  if (opts.vendorId) conds.push(eq(interactions.vendor_id, opts.vendorId));
  const outbound = db.selectDistinct({ vendor_id: interactions.vendor_id, thread_id: interactions.gmail_thread_id }).from(interactions).where(and(...conds)).all();
  const active = new Set(db.select({ vendor_id: vendors.vendor_id }).from(vendors).where(inArray(vendors.status, ACTIVE)).all().map((v) => v.vendor_id));
  const threads = outbound.filter((t): t is { vendor_id: string; thread_id: string } => Boolean(t.thread_id) && active.has(t.vendor_id));
  if (threads.length === 0) return out;

  const me = (await profile()).email.toLowerCase();
  for (const t of threads) {
    out.threads += 1;
    try {
      const messages = await listThreadMessages(t.thread_id);
      const seen = new Set(
        db.select({ sent_at: interactions.sent_at }).from(interactions).where(and(eq(interactions.gmail_thread_id, t.thread_id), eq(interactions.direction, "inbound"))).all().map((r) => r.sent_at),
      );
      const inbound = messages
        .filter((m) => !m.is_sent && !m.from.toLowerCase().includes(me) && !seen.has(m.internal_date))
        .sort((a, b) => a.internal_date.localeCompare(b.internal_date));
      for (const m of inbound) {
        const r = await ingestInbound(t.vendor_id, { thread_id: t.thread_id, sent_at: m.internal_date, subject: m.subject, body_text: m.body_text, from: m.from }, { infer: opts.infer }, db);
        out.results.push(r);
        out.new_inbound += 1;
        if (r.replied) out.replied += 1;
        if (r.applied) out.applied += 1;
        if (r.proposal_id) out.proposals += 1;
        if (r.error) out.errors.push(`${t.vendor_id}: ${r.error}`);
      }
    } catch (err) {
      out.errors.push(`${t.vendor_id} (${t.thread_id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
