/**
 * Due diligence on a vendor under evaluation (PRD §4.3, lifecycle stage 2).
 *
 * The checklist itself lives in the ruleset, so a new question is a YAML edit.
 * An answer is an evidence row on `diligence.<item_id>`, which keeps the eight
 * tables intact and puts diligence under the same rule as every other value:
 * without a source URL or an attestation it is recorded but does not count.
 * Every answer also appends an informational event, so the vendor Timeline
 * shows who checked what and when.
 */
import { and, desc, eq, like } from "drizzle-orm";

import { getDb, nowIso, type DbOrTx } from "@/lib/db";
import { evidence, vendors, type EvidenceRow, type Vendor } from "@/lib/db/schema";
import { recordEvent } from "@/lib/db/state";
import type { DiligenceCategory, DiligenceItem } from "@/lib/pipeline/screen";
import { rulesetForVendor } from "@/lib/rulesets/vendor";

export const DILIGENCE_PREFIX = "diligence.";
export const DILIGENCE_VALUES = ["pass", "fail", "na"] as const;
export type DiligenceValue = (typeof DILIGENCE_VALUES)[number];

export class DiligenceError extends Error {
  constructor(
    public readonly code: "vendor_not_found" | "unknown_item" | "no_ruleset",
    message: string,
  ) {
    super(message);
  }
}

export function diligenceErrorStatus(code: DiligenceError["code"]): number {
  return code === "vendor_not_found" ? 404 : code === "no_ruleset" ? 409 : 422;
}

/** The checklist a vendor is judged by; empty when its ruleset defines none. */
export function diligenceItemsFor(vendor: Vendor, db: DbOrTx = getDb()): DiligenceItem[] {
  try {
    return rulesetForVendor(vendor, db)?.diligence ?? [];
  } catch (err) {
    console.error(`[diligence] cannot load the ruleset for ${vendor.vendor_id}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

export type DiligenceAnswer = {
  item: DiligenceItem;
  value: DiligenceValue | null;
  /** a source URL or an attestation; only then does the answer count */
  verified: boolean;
  source_url: string | null;
  attested_by: string | null;
  note: string | null;
  answered_at: string | null;
};

export type DiligenceStatus = {
  answers: DiligenceAnswer[];
  /** verified answers, and of those the required ones */
  done: number;
  total: number;
  required_done: number;
  required_total: number;
  by_category: { category: DiligenceCategory; done: number; total: number }[];
};

const isValue = (v: string | null): v is DiligenceValue => v !== null && (DILIGENCE_VALUES as readonly string[]).includes(v);

/** The latest answer per item, folded into per-category and required-item progress. */
export function diligenceStatus(items: DiligenceItem[], rows: EvidenceRow[]): DiligenceStatus {
  // Highest evidence_id wins: evidence is append-only, so that is the latest answer.
  const latest = new Map<string, EvidenceRow>();
  for (const row of [...rows].sort((a, b) => a.evidence_id - b.evidence_id)) {
    if (row.field_path.startsWith(DILIGENCE_PREFIX)) latest.set(row.field_path.slice(DILIGENCE_PREFIX.length), row);
  }

  const answers = items.map((item) => {
    const row = latest.get(item.id);
    return {
      item,
      value: row && isValue(row.value) ? row.value : null,
      verified: row?.verified ?? false,
      source_url: row?.source_url ?? null,
      attested_by: row?.attested_by ?? null,
      note: row?.snippet ?? null,
      answered_at: row?.observed_at ?? null,
    };
  });

  const counted = (a: DiligenceAnswer) => a.verified && a.value !== null;
  const categories = [...new Set(items.map((i) => i.category))];
  return {
    answers,
    done: answers.filter(counted).length,
    total: items.length,
    required_done: answers.filter((a) => a.item.required && counted(a)).length,
    required_total: items.filter((i) => i.required).length,
    by_category: categories.map((category) => ({
      category,
      done: answers.filter((a) => a.item.category === category && counted(a)).length,
      total: items.filter((i) => i.category === category).length,
    })),
  };
}

export function listDiligenceEvidence(vendorId: string, db: DbOrTx = getDb()): EvidenceRow[] {
  return db
    .select()
    .from(evidence)
    .where(and(eq(evidence.vendor_id, vendorId), like(evidence.field_path, `${DILIGENCE_PREFIX}%`)))
    .orderBy(desc(evidence.evidence_id))
    .all();
}

export type DiligenceInput = {
  item_id: string;
  value: DiligenceValue;
  note?: string;
  source_url?: string;
  attested_by?: string;
};

/** Record one answer: an evidence row plus an informational event. Returns the new status. */
export function recordDiligence(vendorId: string, input: DiligenceInput, db: DbOrTx = getDb()): DiligenceStatus {
  const vendor = db.select().from(vendors).where(eq(vendors.vendor_id, vendorId)).get();
  if (!vendor) throw new DiligenceError("vendor_not_found", `vendor ${vendorId} not found`);

  const items = diligenceItemsFor(vendor, db);
  if (items.length === 0) throw new DiligenceError("no_ruleset", `no diligence checklist is defined for ${vendor.vendor_type}`);
  const item = items.find((i) => i.id === input.item_id);
  if (!item) throw new DiligenceError("unknown_item", `"${input.item_id}" is not on the checklist for ${vendor.vendor_type}`);

  const source = input.source_url?.trim() || null;
  const attester = input.attested_by?.trim() || null;
  const note = input.note?.trim() || null;
  // The evidence rule, unchanged: a value with neither a source nor an
  // attestation is recorded but never counts as done.
  const verified = Boolean(source || attester);
  const now = nowIso();

  return db.transaction((tx) => {
    tx.insert(evidence)
      .values({
        vendor_id: vendorId,
        field_path: `${DILIGENCE_PREFIX}${item.id}`,
        value: input.value,
        source_url: source,
        snippet: note,
        extraction_method: "manual",
        confidence: verified ? 1 : 0,
        proxy: false,
        verified,
        attested_by: attester,
        observed_at: now,
      })
      .run();

    recordEvent(
      {
        vendorId,
        actor: "human",
        reason: `diligence: ${item.label} — ${input.value}${verified ? "" : " (unverified)"}${note ? `; ${note}` : ""}`,
        evidenceRef: source ?? (attester ? `attested:${attester}` : undefined),
        payload: { diligence_item: item.id, category: item.category, value: input.value, verified },
      },
      tx,
    );

    return diligenceStatus(items, listDiligenceEvidence(vendorId, tx));
  });
}
