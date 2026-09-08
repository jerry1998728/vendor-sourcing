/** Read/write helpers shared by pages, API routes and scripts. */
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";

import { isFollowUpDraft } from "@/lib/shared/drafts";
import type { VendorFilters } from "@/lib/shared/vendor-filters";

import { listVendorsFiltered } from "./filters";
import { getDb, nowIso, type DbOrTx } from "./index";
import {
  events,
  evidence,
  interactions,
  proposals,
  runs,
  schedules,
  tags,
  vendors,
  type EventRow,
  type EvidenceRow,
  type InteractionRow,
  type NewInteraction,
  type ProposalRow,
  type Run,
  type RunCounts,
  type ScheduleRow,
  type TagRow,
  type Vendor,
} from "./schema";

export function listVendors(db: DbOrTx = getDb()): Vendor[] {
  return db
    .select()
    .from(vendors)
    .orderBy(sql`${vendors.coverage_confidence} desc nulls last`, asc(vendors.name))
    .all();
}

export type VendorDetail = {
  vendor: Vendor;
  evidence: EvidenceRow[];
  tags: TagRow[];
  events: EventRow[];
};

export function getVendorDetail(vendorId: string, db: DbOrTx = getDb()): VendorDetail | null {
  const vendor = db.select().from(vendors).where(eq(vendors.vendor_id, vendorId)).get();
  if (!vendor) return null;
  return {
    vendor,
    evidence: db
      .select()
      .from(evidence)
      .where(eq(evidence.vendor_id, vendorId))
      .orderBy(desc(evidence.verified), asc(evidence.field_path), desc(evidence.confidence))
      .all(),
    tags: db
      .select()
      .from(tags)
      .where(eq(tags.vendor_id, vendorId))
      .orderBy(asc(tags.dimension), asc(tags.value))
      .all(),
    events: db
      .select()
      .from(events)
      .where(eq(events.vendor_id, vendorId))
      .orderBy(asc(events.event_id))
      .all(),
  };
}

export function listRuns(db: DbOrTx = getDb(), limit = 50): Run[] {
  return db.select().from(runs).orderBy(desc(runs.started_at)).limit(limit).all();
}

export function getRun(runId: string, db: DbOrTx = getDb()): Run | undefined {
  return db.select().from(runs).where(eq(runs.run_id, runId)).get();
}

export { runStatus, type RunStatus } from "@/lib/shared/run-status";

/**
 * An unfinished run for this config. No time window: markInterruptedRuns()
 * fails leftovers at boot, so an unfinished row means a run really is executing.
 */
export function findActiveRun(configName: string, db: DbOrTx = getDb()): Run | undefined {
  return db.select().from(runs).where(isNull(runs.finished_at)).all().find((r) => r.query.config === configName);
}

/** Boot-time cleanup: a run still marked unfinished cannot be executing, the process just started. */
export function markInterruptedRuns(db: DbOrTx = getDb()): number {
  const open = db.select().from(runs).where(isNull(runs.finished_at)).all();
  for (const r of open) {
    finishRun(r.run_id, { progress: { ...(r.counts.progress ?? { phase: "queued" }), phase: "failed", error: "interrupted by a restart before it finished" } }, db);
  }
  return open.length;
}

/** Flag a running run; executeRun / executeRefresh check the flag between vendors. */
export function requestCancel(runId: string, db: DbOrTx = getDb()): Run | undefined {
  const run = getRun(runId, db);
  if (!run || run.finished_at) return undefined;
  updateRunCounts(runId, { progress: { ...(run.counts.progress ?? { phase: "queued" }), cancel_requested: true } }, db);
  return getRun(runId, db);
}

export function isCancelRequested(runId: string, db: DbOrTx = getDb()): boolean {
  return getRun(runId, db)?.counts.progress?.cancel_requested === true;
}

/** Merge a partial counts object into runs.counts. */
export function updateRunCounts(runId: string, patch: Partial<RunCounts>, db: DbOrTx = getDb()): RunCounts {
  return db.transaction((tx) => {
    const row = tx.select({ counts: runs.counts }).from(runs).where(eq(runs.run_id, runId)).get();
    if (!row) throw new Error(`run ${runId} not found`);
    // progress merges too, so flags such as cancel_requested survive phase updates
    const counts: RunCounts = {
      ...row.counts,
      ...patch,
      progress: patch.progress ? { ...(row.counts.progress ?? {}), ...patch.progress } : row.counts.progress,
    };
    tx.update(runs).set({ counts }).where(eq(runs.run_id, runId)).run();
    return counts;
  });
}

export function finishRun(runId: string, patch: Partial<RunCounts>, db: DbOrTx = getDb()): RunCounts {
  const counts = updateRunCounts(runId, patch, db);
  db.update(runs).set({ finished_at: nowIso() }).where(eq(runs.run_id, runId)).run();
  return counts;
}

// ---------------------------------------------------------------------------
// Interactions (outreach)
// ---------------------------------------------------------------------------


export function listInteractions(vendorId: string, db: DbOrTx = getDb()): InteractionRow[] {
  return db.select().from(interactions).where(eq(interactions.vendor_id, vendorId)).orderBy(asc(interactions.interaction_id)).all();
}

export function insertInteraction(values: NewInteraction, db: DbOrTx = getDb()): InteractionRow {
  return db.insert(interactions).values(values).returning().get();
}

/** Latest draft per vendor, for the Draft & Send list. */
export function latestDraftsFor(vendorIds: string[], db: DbOrTx = getDb()): Map<string, InteractionRow> {
  const out = new Map<string, InteractionRow>();
  if (vendorIds.length === 0) return out;
  const rows = db
    .select()
    .from(interactions)
    .where(and(inArray(interactions.vendor_id, vendorIds), eq(interactions.direction, "draft")))
    .orderBy(desc(interactions.interaction_id))
    .all();
  for (const r of rows) if (!out.has(r.vendor_id)) out.set(r.vendor_id, r);
  return out;
}

export function latestDraft(vendorId: string, db: DbOrTx = getDb()): InteractionRow | undefined {
  return latestDraftsFor([vendorId], db).get(vendorId);
}

// ---------------------------------------------------------------------------
// Proposals and automatic (llm_inference) events
// ---------------------------------------------------------------------------


export type PendingProposal = ProposalRow & {
  vendor_name: string;
  vendor_status: Vendor["status"];
  vendor_stage: Vendor["diligence_stage"];
  interaction_subject: string | null;
  interaction_summary: string | null;
  interaction_body: string | null;
};

export function listPendingProposals(db: DbOrTx = getDb()): PendingProposal[] {
  return db
    .select({
      proposal_id: proposals.proposal_id,
      vendor_id: proposals.vendor_id,
      interaction_id: proposals.interaction_id,
      to_status: proposals.to_status,
      to_stage: proposals.to_stage,
      confidence: proposals.confidence,
      evidence_snippet: proposals.evidence_snippet,
      decided_by: proposals.decided_by,
      decided_at: proposals.decided_at,
      vendor_name: vendors.name,
      vendor_status: vendors.status,
      vendor_stage: vendors.diligence_stage,
      interaction_subject: interactions.subject,
      interaction_summary: interactions.llm_summary,
      interaction_body: interactions.body_text,
    })
    .from(proposals)
    .innerJoin(vendors, eq(vendors.vendor_id, proposals.vendor_id))
    .leftJoin(interactions, eq(interactions.interaction_id, proposals.interaction_id))
    .where(isNull(proposals.decided_at))
    .orderBy(desc(proposals.proposal_id))
    .all();
}

export type LlmEvent = EventRow & { vendor_name: string; revertable: boolean };

/** Recent llm_inference events; revertable when they are still the vendor's latest event. */
export function listLlmEvents(limit = 25, db: DbOrTx = getDb()): LlmEvent[] {
  const rows = db
    .select({ event: events, vendor_name: vendors.name })
    .from(events)
    .innerJoin(vendors, eq(vendors.vendor_id, events.vendor_id))
    .where(eq(events.actor, "llm_inference"))
    .orderBy(desc(events.event_id))
    .limit(limit)
    .all();
  return rows.map(({ event, vendor_name }) => ({ ...event, vendor_name, revertable: isLatestEvent(event, db) }));
}

/** Latest *transition* for the vendor; informational events (from == to) do not count. */
export function isLatestEvent(event: EventRow, db: DbOrTx = getDb()): boolean {
  const latest = db
    .select({ id: events.event_id })
    .from(events)
    .where(and(eq(events.vendor_id, event.vendor_id), sql`(${events.from_status} is not ${events.to_status} or coalesce(${events.from_stage}, '') != coalesce(${events.to_stage}, ''))`))
    .orderBy(desc(events.event_id))
    .get();
  return latest?.id === event.event_id;
}

// ---------------------------------------------------------------------------
// Schedules (P1)
// ---------------------------------------------------------------------------


export type ScheduleWithRun = ScheduleRow & { last_run: Run | null };

export function listSchedules(db: DbOrTx = getDb()): ScheduleWithRun[] {
  return db.select().from(schedules).orderBy(asc(schedules.config)).all().map((s) => ({ ...s, last_run: s.last_run_id ? (getRun(s.last_run_id, db) ?? null) : null }));
}

export function upsertSchedule(input: { config: string; cron: string; enabled: boolean }, db: DbOrTx = getDb()): ScheduleRow {
  const existing = db.select().from(schedules).where(eq(schedules.config, input.config)).get();
  if (existing) {
    return db.update(schedules).set({ cron: input.cron, enabled: input.enabled }).where(eq(schedules.schedule_id, existing.schedule_id)).returning().get();
  }
  return db.insert(schedules).values({ config: input.config, cron: input.cron, enabled: input.enabled }).returning().get();
}

export function setScheduleLastRun(scheduleId: number, runId: string, db: DbOrTx = getDb()): void {
  db.update(schedules).set({ last_run_id: runId }).where(eq(schedules.schedule_id, scheduleId)).run();
}

export function updateVendorFields(vendorId: string, patch: { next_action?: string | null; owner?: string | null; due_at?: string | null }, db: DbOrTx = getDb()): Vendor | undefined {
  return db.update(vendors).set({ ...patch, updated_at: nowIso() }).where(eq(vendors.vendor_id, vendorId)).returning().get();
}

/** Vendors that can still receive replies and have a real outbound Gmail thread. */
export function countActiveThreads(db: DbOrTx = getDb()): number {
  const active = db.select({ vendor_id: vendors.vendor_id }).from(vendors).where(inArray(vendors.status, ["Contacted", "Replied", "In Discussion"])).all().map((v) => v.vendor_id);
  if (active.length === 0) return 0;
  return db
    .select({ n: sql<number>`count(distinct ${interactions.vendor_id})` })
    .from(interactions)
    .where(and(eq(interactions.direction, "outbound"), isNotNull(interactions.gmail_thread_id), inArray(interactions.vendor_id, active)))
    .get()?.n ?? 0;
}

export type Sendable = { qualified: Vendor[]; followUps: Vendor[]; drafts: Map<string, InteractionRow> };

/** Draft & Send: Qualified vendors plus Contacted / Dormant vendors holding a follow-up draft, with each vendor's latest draft. */
export function listSendable(f: Pick<VendorFilters, "owner" | "vendor_type"> = {}, db: DbOrTx = getDb()): Sendable {
  const rows = listVendorsFiltered({ owner: f.owner, vendor_type: f.vendor_type, status: ["Qualified", "Contacted", "Dormant"] }, db);
  const drafts = latestDraftsFor(rows.map((v) => v.vendor_id), db);
  const qualified = rows.filter((v) => v.status === "Qualified");
  const followUps = rows.filter((v) => v.status !== "Qualified" && isFollowUpDraft(drafts.get(v.vendor_id)));
  return { qualified, followUps, drafts };
}

/** Verified diligence answers per vendor, for the Board's progress badge. */
export function diligenceProgressFor(vendorIds: string[], db: DbOrTx = getDb()): Map<string, number> {
  const out = new Map<string, number>();
  if (vendorIds.length === 0) return out;
  const rows = db
    .select({ vendor_id: evidence.vendor_id, field_path: evidence.field_path })
    .from(evidence)
    .where(and(inArray(evidence.vendor_id, vendorIds), eq(evidence.verified, true), like(evidence.field_path, "diligence.%")))
    .all();
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = seen.get(r.vendor_id) ?? new Set<string>();
    set.add(r.field_path);
    seen.set(r.vendor_id, set);
  }
  for (const [vendorId, set] of seen) out.set(vendorId, set.size);
  return out;
}
