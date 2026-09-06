/**
 * Writing one normalized vendor, split in three:
 *   planVendorWrite  (pure)  decides inserts, refreshes, placeholder deletes and tag upserts
 *   applyVendorWrite (I/O)   executes the plan inside the caller's transaction
 *   finalizeVendor   (pure)  screens the resulting evidence and derives the vendors row
 * writeNormalizedVendor composes them; every caller keeps that entry point.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { nowIso, type DbOrTx } from "@/lib/db";
import {
  evidence,
  tags,
  vendors,
  type EvidenceRow,
  type Run,
  type ScreenResult,
  type SourceBadge,
  type TagRow,
  type Vendor,
  type VendorAttributes,
} from "@/lib/db/schema";
import { transition } from "@/lib/db/state";

import { screen, type Ruleset, type ScreenOutcome } from "./screen";
import { MULTI_VALUE_FIELDS, type Evidence, type NormalizeResult, type Tag, type VendorCandidate } from "./types";

export type WriteOutcome = {
  vendor_id: string;
  is_new: boolean;
  result: ScreenResult;
  coverage_confidence: number;
  must_field_coverage: number;
  unknown_must_fields: string[];
};

export const BADGE_RANK: Record<SourceBadge, number> = { verified: 3, proxy: 2, manual: 1, unknown: 0 };

export type ExistingVendorState = { vendor: Vendor | null; evidence: EvidenceRow[]; tags: TagRow[] };

export function loadExistingVendor(db: DbOrTx, vendorId: string): ExistingVendorState {
  return {
    vendor: db.select().from(vendors).where(eq(vendors.vendor_id, vendorId)).get() ?? null,
    evidence: db.select().from(evidence).where(eq(evidence.vendor_id, vendorId)).orderBy(asc(evidence.evidence_id)).all(),
    tags: db.select().from(tags).where(eq(tags.vendor_id, vendorId)).all(),
  };
}

export type EvidenceOp =
  | { op: "insert"; index: number; row: Evidence }
  | { op: "refresh"; index: number; evidence_id: number; upgrade: { snippet: string | null; confidence: number; proxy: boolean } | null }
  | { op: "skip"; index: number; reason: "duplicate_in_batch" | "placeholder_superseded"; of?: number };

export type TagOp =
  | { op: "insert"; tag: Tag }
  | { op: "upgrade"; tag_id: number; source_badge: SourceBadge; evidence_index: number | null };

export type WritePlan = {
  vendor_id: string;
  is_new: boolean;
  vendor_insert: typeof vendors.$inferInsert | null;
  evidence: EvidenceOp[];
  /** field paths whose stored "not found" placeholder rows are now superseded by a value */
  placeholder_deletes: string[];
  tags: TagOp[];
};

const evidenceKey = (field: string, value: string | null, url: string | null) => JSON.stringify([field, value, url]);
const tagKey = (dimension: string, value: string) => JSON.stringify([dimension, value]);

/** Pure: compare the incoming result with what is stored and decide every write. */
export function planVendorWrite(existing: ExistingVendorState, result: NormalizeResult & { vendor: VendorCandidate }, run: Run, now: string): WritePlan {
  const v = result.vendor;
  const known = new Map<string, { evidence_id?: number; index?: number; verified: boolean }>();
  for (const row of existing.evidence) known.set(evidenceKey(row.field_path, row.value, row.source_url), { evidence_id: row.evidence_id, verified: row.verified });
  const fieldsWithValues = new Set(existing.evidence.filter((r) => r.value !== null).map((r) => r.field_path));
  for (const e of result.evidence) if (e.value !== null) fieldsWithValues.add(e.field_path);

  const evidenceOps: EvidenceOp[] = [];
  result.evidence.forEach((e, index) => {
    const key = evidenceKey(e.field_path, e.value, e.source_url);
    const seen = known.get(key);
    if (seen?.evidence_id !== undefined) {
      evidenceOps.push({
        op: "refresh",
        index,
        evidence_id: seen.evidence_id,
        upgrade: e.verified && !seen.verified ? { snippet: e.snippet, confidence: e.confidence, proxy: e.proxy } : null,
      });
      if (e.verified) seen.verified = true;
      return;
    }
    if (seen?.index !== undefined) {
      // the same claim twice in one result: one row, and a verified repeat upgrades it
      const first = evidenceOps[seen.index];
      if (first.op === "insert" && e.verified && !first.row.verified) {
        first.row = { ...first.row, verified: true, snippet: e.snippet, confidence: e.confidence, proxy: e.proxy };
      }
      evidenceOps.push({ op: "skip", index, reason: "duplicate_in_batch", of: seen.index });
      return;
    }
    if (e.value === null && fieldsWithValues.has(e.field_path)) {
      evidenceOps.push({ op: "skip", index, reason: "placeholder_superseded" });
      return;
    }
    known.set(key, { index: evidenceOps.length, verified: e.verified });
    evidenceOps.push({ op: "insert", index, row: e });
  });
  const placeholder_deletes = [...new Set(existing.evidence.filter((r) => r.value === null && fieldsWithValues.has(r.field_path)).map((r) => r.field_path))];

  const existingTags = new Map(existing.tags.map((t) => [tagKey(t.dimension, t.value), t]));
  const plannedTags = new Map<string, number>();
  const tagOps: TagOp[] = [];
  for (const t of result.tags) {
    const key = tagKey(t.dimension, t.value);
    const ex = existingTags.get(key);
    if (ex) {
      const stronger = BADGE_RANK[t.source_badge] > BADGE_RANK[ex.source_badge];
      const addsRef = t.evidence_index !== null && !ex.evidence_id;
      // a stronger badge wins; a weaker one may only contribute a missing evidence link
      if (stronger || addsRef) {
        tagOps.push({ op: "upgrade", tag_id: ex.tag_id, source_badge: stronger ? t.source_badge : ex.source_badge, evidence_index: t.evidence_index });
      }
      continue;
    }
    const planned = plannedTags.get(key);
    if (planned !== undefined) {
      const prev = tagOps[planned];
      if (prev.op === "insert" && BADGE_RANK[t.source_badge] > BADGE_RANK[prev.tag.source_badge]) prev.tag = t;
      continue;
    }
    plannedTags.set(key, tagOps.length);
    tagOps.push({ op: "insert", tag: t });
  }

  return {
    vendor_id: v.vendor_id,
    is_new: !existing.vendor,
    vendor_insert: existing.vendor
      ? null
      : {
          vendor_id: v.vendor_id,
          name: v.name,
          vendor_type: v.vendor_type,
          primary_domain: v.primary_domain,
          first_seen_run_id: run.run_id,
          discovered_via: v.discovered_via,
          discovered_at: now,
          updated_at: now,
        },
    evidence: evidenceOps,
    placeholder_deletes,
    tags: tagOps,
  };
}

/** I/O: execute the plan. Returns the evidence id behind each incoming evidence index (null when skipped). */
export function applyVendorWrite(tx: DbOrTx, plan: WritePlan, now: string): { evidenceIds: (number | null)[] } {
  if (plan.vendor_insert) tx.insert(vendors).values(plan.vendor_insert).run();
  const ids: (number | null)[] = new Array<number | null>(plan.evidence.length).fill(null);
  for (const op of plan.evidence) {
    if (op.op === "insert") {
      const e = op.row;
      const ins = tx
        .insert(evidence)
        .values({
          vendor_id: plan.vendor_id,
          field_path: e.field_path,
          value: e.value,
          source_url: e.source_url,
          snippet: e.snippet,
          extraction_method: e.extraction_method,
          confidence: e.confidence,
          proxy: e.proxy,
          verified: e.verified,
          attested_by: e.attested_by,
          observed_at: e.observed_at || now,
        })
        .returning({ id: evidence.evidence_id })
        .get();
      ids[op.index] = ins.id;
    } else if (op.op === "refresh") {
      tx.update(evidence)
        .set({ observed_at: now, ...(op.upgrade ? { verified: true, ...op.upgrade } : {}) })
        .where(eq(evidence.evidence_id, op.evidence_id))
        .run();
      ids[op.index] = op.evidence_id;
    }
  }
  for (const op of plan.evidence) if (op.op === "skip" && op.of !== undefined) ids[op.index] = ids[op.of];
  if (plan.placeholder_deletes.length > 0) {
    tx.delete(evidence)
      .where(and(eq(evidence.vendor_id, plan.vendor_id), isNull(evidence.value), inArray(evidence.field_path, plan.placeholder_deletes)))
      .run();
  }
  const ref = (index: number | null) => (index === null ? null : (ids[index] ?? null));
  for (const op of plan.tags) {
    if (op.op === "insert") {
      tx.insert(tags)
        .values({ vendor_id: plan.vendor_id, dimension: op.tag.dimension, value: op.tag.value, source_badge: op.tag.source_badge, evidence_id: ref(op.tag.evidence_index), updated_at: now })
        .run();
    } else {
      const current = tx.select({ evidence_id: tags.evidence_id }).from(tags).where(eq(tags.tag_id, op.tag_id)).get();
      tx.update(tags)
        .set({ source_badge: op.source_badge, evidence_id: ref(op.evidence_index) ?? current?.evidence_id ?? null, updated_at: now })
        .where(eq(tags.tag_id, op.tag_id))
        .run();
    }
  }
  return { evidenceIds: ids };
}

export function buildAttributes(rows: EvidenceRow[]): VendorAttributes {
  const out: VendorAttributes = {};
  const byField = new Map<string, EvidenceRow[]>();
  for (const r of rows) {
    if (!r.verified || r.value === null || r.value === "") continue;
    const list = byField.get(r.field_path) ?? [];
    list.push(r);
    byField.set(r.field_path, list);
  }
  for (const [field, list] of byField) {
    // confidence first, then insertion order, so attribute order never depends on which index SQLite picked
    const values = [...new Set(list.sort((a, b) => b.confidence - a.confidence || a.evidence_id - b.evidence_id).map((r) => r.value as string))];
    out[field] = MULTI_VALUE_FIELDS.has(field) ? values : values[0];
  }
  return out;
}

function nextActionFor(result: ScreenResult): string {
  return result === "unknown" ? "outreach_to_verify" : "review";
}

export type Finalized = { patch: Partial<typeof vendors.$inferInsert>; outcome: ScreenOutcome; screenTransition: boolean };

/** Pure: screen the stored evidence and derive the vendors row from it. */
export function finalizeVendor(existing: Vendor | null, candidate: VendorCandidate, rows: EvidenceRow[], ruleset: Ruleset, verifiedNow: boolean, now: string): Finalized {
  const outcome = screen({ vendor_id: candidate.vendor_id, name: candidate.name, vendor_type: candidate.vendor_type }, rows, ruleset);
  const verified = (fp: string) => rows.filter((x) => x.field_path === fp && x.verified && x.value);
  const first = (fp: string) => verified(fp).sort((a, b) => b.confidence - a.confidence || a.evidence_id - b.evidence_id)[0]?.value ?? null;
  const status = existing?.status ?? "Identified";
  const keepNextAction = status !== "Identified" && status !== "Screened";
  return {
    outcome,
    screenTransition: status === "Identified",
    patch: {
      name: existing?.name && existing.name.trim() ? existing.name : candidate.name,
      primary_domain: candidate.primary_domain ?? existing?.primary_domain ?? null,
      contact_email: first("contact_email") ?? existing?.contact_email ?? null,
      registration_country: first("registration_country"),
      ownership_country: first("ownership_country"),
      parent_entity: first("parent_entity"),
      collection_countries: [...new Set(verified("collection_countries").map((x) => x.value as string))],
      attributes: buildAttributes(rows),
      screen_result: outcome.result,
      screen_reasons: outcome.reasons,
      coverage_confidence: outcome.coverageConfidence,
      next_action: keepNextAction ? (existing?.next_action ?? null) : nextActionFor(outcome.result),
      last_verified_at: verifiedNow ? now : (existing?.last_verified_at ?? null),
      updated_at: now,
    },
  };
}

/**
 * Upsert one normalized vendor with its evidence and tags, screen it against
 * the run's ruleset, promote verified values to attributes and move new
 * vendors Identified -> Screened. Idempotent for re-runs.
 */
export function writeNormalizedVendor(db: DbOrTx, run: Run, ruleset: Ruleset, r: NormalizeResult & { vendor: VendorCandidate }): WriteOutcome {
  return db.transaction((tx) => {
    const now = nowIso();
    const existing = loadExistingVendor(tx, r.vendor.vendor_id);
    const plan = planVendorWrite(existing, r, run, now);
    applyVendorWrite(tx, plan, now);
    const rows = tx.select().from(evidence).where(eq(evidence.vendor_id, r.vendor.vendor_id)).orderBy(asc(evidence.evidence_id)).all();
    const fin = finalizeVendor(existing.vendor, r.vendor, rows, ruleset, r.evidence.some((e) => e.verified), now);
    tx.update(vendors).set(fin.patch).where(eq(vendors.vendor_id, r.vendor.vendor_id)).run();
    if (fin.screenTransition) {
      transition(
        {
          vendorId: r.vendor.vendor_id,
          toStatus: "Screened",
          actor: "system",
          reason: `screened:${fin.outcome.result}`,
          confidence: fin.outcome.coverageConfidence,
          evidenceRef: run.run_id,
          payload: {
            run_id: run.run_id,
            ruleset_version: ruleset.ruleset_version,
            result: fin.outcome.result,
            unknown_must_fields: fin.outcome.unknownMustFields,
          },
        },
        tx,
      );
    }
    return {
      vendor_id: r.vendor.vendor_id,
      is_new: plan.is_new,
      result: fin.outcome.result,
      coverage_confidence: fin.outcome.coverageConfidence,
      must_field_coverage: fin.outcome.mustFieldCoverage,
      unknown_must_fields: fin.outcome.unknownMustFields,
    };
  });
}
