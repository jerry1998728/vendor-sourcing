/**
 * Outreach drafts (PRD §4.3). Claude (sonnet, CLAUDE.md routing) writes a
 * first-contact email that cites at least one verified evidence row and,
 * when next_action is outreach_to_verify, asks about every unknown must-field.
 * The result is stored as an interactions row with direction=draft.
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { getDb, type Db } from "@/lib/db";
import { getVendorDetail, insertInteraction } from "@/lib/db/queries";
import type { EvidenceRow, InteractionRow, Vendor } from "@/lib/db/schema";
import { getAnthropic, modelFor, supportsEffort } from "@/lib/llm/client";
import { DraftEmailOutput } from "@/lib/pipeline/types";
import { rulesetForVendor } from "@/lib/rulesets/vendor";
import { unknownMustFields as unknownMustFieldPaths } from "@/lib/shared/must-fields";

export class DraftError extends Error {}

export type DraftContext = {
  vendor: Vendor;
  category: string;
  evidence: EvidenceRow[];
  unknownMustFields: { field_path: string; description: string }[];
  mustAsk: boolean;
};

const HIDDEN_FIELDS = new Set(["source_channel", "github_org"]);

export function draftContext(vendorId: string, db: Db = getDb()): DraftContext {
  const detail = getVendorDetail(vendorId, db);
  if (!detail) throw new DraftError(`vendor ${vendorId} not found`);
  const ruleset = rulesetForVendor(detail.vendor, db);
  const evidence = detail.evidence.filter((e) => e.verified && e.value && !HIDDEN_FIELDS.has(e.field_path));
  // The set comes from the last screening (shared definition); the ruleset only supplies the wording.
  const unknownMustFields = unknownMustFieldPaths(detail.vendor).map((field_path) => ({
    field_path,
    description:
      ruleset?.fields.find((f) => f.path === field_path)?.description ??
      ruleset?.must.find((m) => m.field_path === field_path)?.description ??
      field_path,
  }));
  return {
    vendor: detail.vendor,
    category: ruleset?.description ?? detail.vendor.vendor_type,
    evidence,
    unknownMustFields,
    mustAsk: detail.vendor.next_action === "outreach_to_verify" && unknownMustFields.length > 0,
  };
}

const SYSTEM = `You write first-contact outreach emails for a sourcing analyst at an AI company that licenses training data.
Voice: concise (120-220 words), specific, professional, warm but not salesy. No hype, no flattery, no invented facts.
Structure:
1. One sentence on why we are writing (we evaluate suppliers in this category).
2. One or two sentences that show we did our homework, using specific facts from the evidence list. Work them into prose naturally; never mention ids, "evidence", "screening", "must-field" or any internal term.
3. If questions are listed: the questions, one short line each, phrased as a buyer would ask them.
4. A call to action for a 20-minute call.
Plain text only, with blank lines between paragraphs. Sign off with "Best regards," and a placeholder line "[Your name]".
Return only the JSON object required by the schema.`;

export function buildDraftPrompt(ctx: DraftContext): string {
  const v = ctx.vendor;
  const evidenceLines = ctx.evidence.map(
    (e) => `#${e.evidence_id} ${e.field_path} = ${e.value}${e.snippet ? ` — "${e.snippet.slice(0, 200)}"` : ""}${e.source_url ? ` (${e.source_url})` : ""}`,
  );
  const questionLines = ctx.unknownMustFields.map((f) => `- ${f.field_path}: ${f.description.replace(/\s+/g, " ").trim()}`);
  return [
    `Vendor: ${v.name}${v.primary_domain ? ` (${v.primary_domain})` : ""}`,
    `Category we are sourcing: ${ctx.category.replace(/\s+/g, " ").trim()}`,
    ``,
    `Verified facts about the vendor (cite at least one; list the # numbers you used in cited_evidence_ids):`,
    ...(evidenceLines.length ? evidenceLines : ["(none)"]),
    ``,
    ctx.mustAsk
      ? `We still need answers on every item below. Ask about each one and list their field paths in asked_field_paths:\n${questionLines.join("\n")}`
      : ctx.unknownMustFields.length
        ? `Optional things we would like to learn (ask about them if natural; list what you asked in asked_field_paths):\n${questionLines.join("\n")}`
        : `Nothing further is unknown; ask for a call to discuss licensing terms. asked_field_paths may be empty.`,
    ``,
    `Subject line: short and specific to their offering.`,
  ].join("\n");
}

export type DraftCheck = { citedIds: number[]; missingFields: string[]; ok: boolean };

/** Pure validation used by generateDraft and tests. */
export function checkDraft(out: DraftEmailOutput, ctx: Pick<DraftContext, "evidence" | "unknownMustFields" | "mustAsk">): DraftCheck {
  const verifiedIds = new Set(ctx.evidence.map((e) => e.evidence_id));
  const citedIds = [...new Set(out.cited_evidence_ids.filter((id) => verifiedIds.has(id)))];
  const asked = new Set(out.asked_field_paths.map((p) => p.trim().toLowerCase()));
  const missingFields = ctx.mustAsk ? ctx.unknownMustFields.map((f) => f.field_path).filter((p) => !asked.has(p.toLowerCase())) : [];
  const ok = (citedIds.length > 0 || ctx.evidence.length === 0) && missingFields.length === 0 && out.body.trim().length >= 120 && out.subject.trim().length > 0;
  return { citedIds, missingFields, ok };
}

export type DraftOptions = {
  /** follow-up after silence; cites nothing new, references the previous email */
  mode?: "first_contact" | "follow_up";
  followUpKind?: "7d" | "14d";
  previous?: Pick<InteractionRow, "subject" | "body_text" | "sent_at"> | null;
};

const FOLLOW_UP_SYSTEM = `You write short follow-up emails for a sourcing analyst who has not heard back from a data vendor.
Voice: friendly, brief (60-110 words), no guilt, no pressure. Reference the earlier email in one clause, restate in one sentence why the vendor is interesting, and offer an easy out ("if now is not the right time, a quick no is fine"). One question at most.
The 14-day version is the last touch: say so plainly and thank them.
Plain text, blank lines between paragraphs, sign off with "Best regards," and "[Your name]". Return only the JSON object required by the schema.`;

export function buildFollowUpPrompt(ctx: DraftContext, opts: DraftOptions): string {
  const v = ctx.vendor;
  return [
    `Vendor: ${v.name}${v.primary_domain ? ` (${v.primary_domain})` : ""}`,
    `Category: ${ctx.category.replace(/\s+/g, " ").trim()}`,
    `Follow-up: ${opts.followUpKind === "14d" ? "second and last touch after 14 days" : "first nudge after 7 days"} without a reply.`,
    ``,
    `Our earlier email${opts.previous?.sent_at ? ` (${opts.previous.sent_at.slice(0, 10)})` : ""}:`,
    `Subject: ${opts.previous?.subject ?? ""}`,
    (opts.previous?.body_text ?? "").slice(0, 800),
    ``,
    `Subject line: reply-style, starting with "Re: " and the earlier subject. cited_evidence_ids and asked_field_paths may be empty.`,
  ].join("\n");
}

/** Model call plus validation with one retry; no database access. */
export async function draftEmail(ctx: DraftContext, opts: DraftOptions = {}): Promise<{ out: DraftEmailOutput; check: DraftCheck; model: string }> {
  const model = modelFor("drafting");
  const client = getAnthropic();
  const followUp = opts.mode === "follow_up";
  const prompt = followUp ? buildFollowUpPrompt(ctx, opts) : buildDraftPrompt(ctx);

  let out: DraftEmailOutput | null = null;
  let check: DraftCheck | null = null;
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.messages.parse({
      model,
      max_tokens: 2000,
      output_config: {
        ...(supportsEffort(model) ? { effort: "medium" as const } : {}),
        format: zodOutputFormat(DraftEmailOutput),
      },
      system: followUp ? FOLLOW_UP_SYSTEM : SYSTEM,
      messages: [{ role: "user", content: feedback ? `${prompt}\n\nYour previous draft was rejected: ${feedback}` : prompt }],
    });
    const parsed = res.parsed_output ? DraftEmailOutput.parse(res.parsed_output) : null;
    if (!parsed) throw new DraftError(`model returned no parseable draft (${res.stop_reason})`);
    check = followUp ? checkDraft(parsed, { evidence: [], unknownMustFields: [], mustAsk: false }) : checkDraft(parsed, ctx);
    out = parsed;
    if (check.ok) break;
    feedback = [
      check.citedIds.length === 0 && ctx.evidence.length > 0 ? "cite at least one verified fact and list its # in cited_evidence_ids" : "",
      check.missingFields.length ? `ask about and list in asked_field_paths: ${check.missingFields.join(", ")}` : "",
      parsed.body.trim().length < 120 ? "the body is too short" : "",
    ].filter(Boolean).join("; ");
  }
  if (!out || !check || !check.ok) {
    throw new DraftError(`draft did not meet the rules after two attempts (${feedback})`);
  }

  return { out, check, model };
}

/** Pure: the one-line provenance stored next to the draft. */
export function draftSummary(out: DraftEmailOutput, check: DraftCheck, model: string, opts: DraftOptions = {}): string {
  return opts.mode === "follow_up"
    ? `follow_up_${opts.followUpKind ?? "7d"}; model=${model}`
    : `model=${model}; cites evidence ${check.citedIds.map((i) => `#${i}`).join(", ") || "-"}; asks about ${out.asked_field_paths.join(", ") || "-"}`;
}

/** I/O: persist a validated draft as an interactions row. */
export function storeDraft(db: Db, vendorId: string, out: DraftEmailOutput, summary: string): InteractionRow {
  return insertInteraction(
    { vendor_id: vendorId, direction: "draft", gmail_thread_id: null, sent_at: null, subject: out.subject.trim(), body_text: out.body.trim(), llm_summary: summary },
    db,
  );
}

export async function generateDraft(vendorId: string, db: Db = getDb(), opts: DraftOptions = {}): Promise<{ interaction: InteractionRow; check: DraftCheck; model: string }> {
  const ctx = draftContext(vendorId, db);
  const { out, check, model } = await draftEmail(ctx, opts);
  const interaction = storeDraft(db, vendorId, out, draftSummary(out, check, model, opts));
  return { interaction, check, model };
}
