/**
 * The only way status / diligence_stage may change. `transition()` validates
 * against the PRD §6 whitelist, appends an events row and updates vendors in
 * one transaction. `rebuildStatus()` replays events and throws on mismatch.
 */
import { asc, desc, eq } from "drizzle-orm";

import { getDb, nowIso, type DbOrTx } from "./index";
import {
  ACTORS,
  DILIGENCE_STAGES,
  VENDOR_STATUSES,
  events,
  vendors,
  type Actor,
  type DiligenceStage,
  type VendorStatus,
} from "./schema";
import type { EventRow } from "./schema";

export type TransitionErrorCode =
  | "not_found"
  | "invalid_input"
  | "illegal_transition"
  | "illegal_actor"
  | "illegal_stage"
  | "confidence_below_threshold"
  | "reason_required"
  | "no_change";

export class TransitionError extends Error {
  readonly code: TransitionErrorCode;
  constructor(code: TransitionErrorCode, message: string) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
  }
}

export class StateMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateMismatchError";
  }
}

export const LLM_AUTO_APPLY_THRESHOLD = 0.85;
/** Stages that always go through a human, never llm_inference. */
export const HUMAN_ONLY_STAGES: readonly DiligenceStage[] = [
  "quote_received",
  "sampling",
];

export type TransitionInput = {
  vendorId: string;
  toStatus: VendorStatus;
  actor: Actor;
  reason: string;
  confidence?: number;
  evidenceRef?: string;
  /** Only meaningful when toStatus is "In Discussion". */
  toStage?: DiligenceStage | null;
  /** Free-form extra data stored on the events row. */
  payload?: Record<string, unknown>;
};

export type TransitionResult = {
  eventId: number;
  vendorId: string;
  fromStatus: VendorStatus;
  toStatus: VendorStatus;
  fromStage: DiligenceStage | null;
  toStage: DiligenceStage | null;
};

type Rule = {
  from: VendorStatus | "*";
  to: VendorStatus;
  actors: readonly Actor[];
  requiresReason?: boolean;
};

/** PRD §6. `*` = any status. */
export const TRANSITION_WHITELIST: readonly Rule[] = [
  { from: "Identified", to: "Screened", actors: ["system", "adapter"] },
  { from: "Screened", to: "Qualified", actors: ["human"] },
  { from: "Screened", to: "Rejected", actors: ["human"], requiresReason: true },
  { from: "Qualified", to: "Contacted", actors: ["human"] },
  { from: "Qualified", to: "Rejected", actors: ["human"], requiresReason: true },
  { from: "Contacted", to: "Replied", actors: ["system"] },
  { from: "Contacted", to: "Dormant", actors: ["system"] },
  { from: "Replied", to: "In Discussion", actors: ["llm_inference", "human"] },
  { from: "Replied", to: "Rejected", actors: ["llm_inference", "human"] },
  // stage change while In Discussion
  { from: "In Discussion", to: "In Discussion", actors: ["llm_inference", "human"] },
  { from: "In Discussion", to: "Rejected", actors: ["llm_inference", "human"] },
  { from: "*", to: "Approved", actors: ["human"] },
  { from: "Rejected", to: "Qualified", actors: ["human"], requiresReason: true },
  { from: "Dormant", to: "Qualified", actors: ["human"], requiresReason: true },
];

export const REVERT_REASON = "revert";

/** Pure whitelist check (no DB): may `actor` move a vendor from `from` to `to`? */
export function isLegalTransition(from: VendorStatus, to: VendorStatus, actor: Actor): boolean {
  const rule = findRule(from, to);
  return Boolean(rule && rule.actors.includes(actor));
}

function stageIndex(stage: DiligenceStage | null): number {
  return stage === null ? -1 : DILIGENCE_STAGES.indexOf(stage);
}

function findRule(
  from: VendorStatus,
  to: VendorStatus,
): Rule | undefined {
  return (
    TRANSITION_WHITELIST.find((r) => r.from === from && r.to === to) ??
    TRANSITION_WHITELIST.find((r) => r.from === "*" && r.to === to)
  );
}

function validateInput(input: TransitionInput): void {
  if (!input.vendorId) {
    throw new TransitionError("invalid_input", "vendorId is required");
  }
  if (!VENDOR_STATUSES.includes(input.toStatus)) {
    throw new TransitionError(
      "invalid_input",
      `unknown status "${String(input.toStatus)}"`,
    );
  }
  if (!ACTORS.includes(input.actor)) {
    throw new TransitionError(
      "invalid_input",
      `unknown actor "${String(input.actor)}"`,
    );
  }
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new TransitionError("reason_required", "reason is required");
  }
  if (
    input.toStage !== undefined &&
    input.toStage !== null &&
    !DILIGENCE_STAGES.includes(input.toStage)
  ) {
    throw new TransitionError(
      "invalid_input",
      `unknown stage "${String(input.toStage)}"`,
    );
  }
  if (
    input.confidence !== undefined &&
    (Number.isNaN(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1)
  ) {
    throw new TransitionError(
      "invalid_input",
      "confidence must be between 0 and 1",
    );
  }
}

/**
 * Apply one status/stage change. Throws TransitionError on anything the
 * PRD §6 whitelist does not allow. Pass a transaction handle to compose
 * with other writes.
 */
export function transition(
  input: TransitionInput,
  db: DbOrTx = getDb(),
): TransitionResult {
  validateInput(input);

  return db.transaction((tx) => {
    const vendor = tx
      .select({
        status: vendors.status,
        diligence_stage: vendors.diligence_stage,
      })
      .from(vendors)
      .where(eq(vendors.vendor_id, input.vendorId))
      .get();
    if (!vendor) {
      throw new TransitionError(
        "not_found",
        `vendor "${input.vendorId}" not found`,
      );
    }

    const fromStatus = vendor.status;
    const fromStage = vendor.diligence_stage ?? null;
    const { toStatus, actor } = input;

    const isRevert =
      actor === "human" && input.reason.trim().toLowerCase() === REVERT_REASON;
    const revertTarget = isRevert ? resolveRevertTarget(tx, input) : null;

    // Resolve the target stage.
    let toStage: DiligenceStage | null;
    if (isRevert) {
      if (!revertTarget) {
        throw new TransitionError(
          "illegal_transition",
          "revert requires a prior llm_inference event to reverse",
        );
      }
      // A revert restores exactly the state the reverted event started from.
      toStage = revertTarget.from_stage ?? null;
    } else if (input.toStage !== undefined && input.toStage !== null) {
      if (toStatus !== "In Discussion") {
        throw new TransitionError(
          "illegal_stage",
          `a diligence stage can only be set while "In Discussion" (got ${toStatus})`,
        );
      }
      toStage = input.toStage;
    } else if (toStatus === "In Discussion") {
      toStage = fromStatus === "In Discussion" ? fromStage : "responded";
    } else {
      // Leaving or outside In Discussion: the stage is carried unchanged.
      toStage = input.toStage === null ? null : fromStage;
    }

    if (isRevert && revertTarget) {
      // Reverse of a prior llm_inference event (PRD §4.3 "Revert").
      const target = revertTarget;
      if (
        target.to_status !== fromStatus ||
        (target.to_stage ?? null) !== fromStage
      ) {
        throw new TransitionError(
          "illegal_transition",
          `event ${target.event_id} led to ${target.to_status}/${target.to_stage ?? "-"} but the vendor is now at ${fromStatus}/${fromStage ?? "-"}`,
        );
      }
      if (target.from_status !== toStatus) {
        throw new TransitionError(
          "illegal_transition",
          `revert of event ${target.event_id} must return to ${target.from_status}/${target.from_stage ?? "-"}`,
        );
      }
    } else {
      const rule = findRule(fromStatus, toStatus);
      if (!rule) {
        throw new TransitionError(
          "illegal_transition",
          `${fromStatus} -> ${toStatus} is not allowed`,
        );
      }
      if (!rule.actors.includes(actor)) {
        throw new TransitionError(
          "illegal_actor",
          `${fromStatus} -> ${toStatus} may not be performed by ${actor} (allowed: ${rule.actors.join(", ")})`,
        );
      }
      if (fromStatus === toStatus && fromStage === toStage) {
        throw new TransitionError(
          "no_change",
          `vendor is already ${fromStatus}/${fromStage ?? "-"}`,
        );
      }
      if (actor === "llm_inference") {
        if (input.confidence === undefined) {
          throw new TransitionError(
            "invalid_input",
            "llm_inference transitions require a confidence",
          );
        }
        if (input.confidence < LLM_AUTO_APPLY_THRESHOLD) {
          throw new TransitionError(
            "confidence_below_threshold",
            `confidence ${input.confidence} is below the auto-apply threshold ${LLM_AUTO_APPLY_THRESHOLD}; file a proposal instead`,
          );
        }
        if (toStage !== null && HUMAN_ONLY_STAGES.includes(toStage)) {
          throw new TransitionError(
            "illegal_stage",
            `stage ${toStage} is always a human decision; file a proposal instead`,
          );
        }
        if (
          toStatus === "In Discussion" &&
          fromStatus === "In Discussion" &&
          stageIndex(toStage) <= stageIndex(fromStage)
        ) {
          throw new TransitionError(
            "illegal_stage",
            `llm_inference may only advance the stage (${fromStage ?? "-"} -> ${toStage ?? "-"})`,
          );
        }
      }
    }

    const createdAt = nowIso();
    const inserted = tx
      .insert(events)
      .values({
        vendor_id: input.vendorId,
        from_status: fromStatus,
        to_status: toStatus,
        from_stage: fromStage,
        to_stage: toStage,
        actor,
        reason: input.reason,
        confidence: input.confidence ?? null,
        evidence_ref: input.evidenceRef ?? null,
        payload: input.payload ?? null,
        created_at: createdAt,
      })
      .returning({ event_id: events.event_id })
      .get();

    tx.update(vendors)
      .set({
        status: toStatus,
        diligence_stage: toStage,
        status_confidence: input.confidence ?? null,
        updated_at: createdAt,
      })
      .where(eq(vendors.vendor_id, input.vendorId))
      .run();

    return {
      eventId: inserted.event_id,
      vendorId: input.vendorId,
      fromStatus,
      toStatus,
      fromStage,
      toStage,
    };
  });
}

function resolveRevertTarget(db: DbOrTx, input: TransitionInput) {
  const explicit = input.payload?.revert_event_id;
  if (typeof explicit === "number") {
    const row = db
      .select()
      .from(events)
      .where(eq(events.event_id, explicit))
      .get();
    if (!row || row.vendor_id !== input.vendorId || row.actor !== "llm_inference") {
      return null;
    }
    return row;
  }
  const latest = db
    .select()
    .from(events)
    .where(eq(events.vendor_id, input.vendorId))
    .orderBy(desc(events.event_id))
    .limit(1)
    .get();
  return latest && latest.actor === "llm_inference" ? latest : null;
}

/**
 * Informational event (tag_changed, screen_changed): appended to the log
 * without changing status or stage, so replay treats it as identity.
 */
export function recordEvent(
  input: { vendorId: string; actor: Actor; reason: string; payload?: Record<string, unknown>; evidenceRef?: string },
  db: DbOrTx = getDb(),
): EventRow {
  const v = db.select().from(vendors).where(eq(vendors.vendor_id, input.vendorId)).get();
  if (!v) throw new TransitionError("not_found", `vendor ${input.vendorId} not found`);
  return db
    .insert(events)
    .values({
      vendor_id: input.vendorId,
      from_status: v.status,
      to_status: v.status,
      from_stage: v.diligence_stage,
      to_stage: v.diligence_stage,
      actor: input.actor,
      reason: input.reason,
      confidence: null,
      evidence_ref: input.evidenceRef ?? null,
      payload: input.payload ?? null,
      created_at: nowIso(),
    })
    .returning()
    .get();
}

export type RebuildResult = {
  vendorId: string;
  status: VendorStatus;
  stage: DiligenceStage | null;
  eventCount: number;
};

/**
 * Replay the append-only event log from the initial state (Identified, no
 * stage). Throws StateMismatchError if the chain is broken or the replayed
 * state differs from vendors.status / diligence_stage.
 */
export function rebuildStatus(vendorId: string, db: DbOrTx = getDb()): RebuildResult {
  const vendor = db
    .select({
      status: vendors.status,
      diligence_stage: vendors.diligence_stage,
    })
    .from(vendors)
    .where(eq(vendors.vendor_id, vendorId))
    .get();
  if (!vendor) {
    throw new TransitionError("not_found", `vendor "${vendorId}" not found`);
  }

  const rows = db
    .select()
    .from(events)
    .where(eq(events.vendor_id, vendorId))
    .orderBy(asc(events.event_id))
    .all();

  let status: VendorStatus = "Identified";
  let stage: DiligenceStage | null = null;
  for (const e of rows) {
    if (e.from_status !== status || (e.from_stage ?? null) !== stage) {
      throw new StateMismatchError(
        `vendor ${vendorId}: event ${e.event_id} starts from ${e.from_status}/${e.from_stage ?? "-"} but replay is at ${status}/${stage ?? "-"}`,
      );
    }
    status = e.to_status;
    stage = e.to_stage ?? null;
  }

  if (vendor.status !== status || (vendor.diligence_stage ?? null) !== stage) {
    throw new StateMismatchError(
      `vendor ${vendorId}: vendors row says ${vendor.status}/${vendor.diligence_stage ?? "-"} but events replay to ${status}/${stage ?? "-"}`,
    );
  }

  return { vendorId, status, stage, eventCount: rows.length };
}
