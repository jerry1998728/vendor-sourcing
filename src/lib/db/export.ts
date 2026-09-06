/** CSV export of the (filtered) Vendors table, one column per tag dimension. */
import { inArray } from "drizzle-orm";

import { TAG_DIMENSION_NAMES } from "@/lib/pipeline/types";

import { getDb, type DbOrTx } from "./index";
import { tags, type Vendor } from "./schema";

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("|") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const EXPORT_COLUMNS = [
  "vendor_id", "name", "vendor_type", "primary_domain", "status", "diligence_stage", "screen_result", "coverage_confidence",
  "registration_country", "ownership_country", "parent_entity", "collection_countries", "contact_email", "owner", "next_action", "due_at",
  "discovered_via", "first_seen_run_id", "last_verified_at", "discovered_at", "updated_at",
] as const;

export function vendorsToCsv(rows: Vendor[], tagsByVendor: Map<string, { dimension: string; value: string }[]>): string {
  const header = [...EXPORT_COLUMNS, ...TAG_DIMENSION_NAMES.map((d) => `tag:${d}`)];
  const lines = [header.join(",")];
  for (const v of rows) {
    const t = tagsByVendor.get(v.vendor_id) ?? [];
    const base = EXPORT_COLUMNS.map((c) => csvCell(v[c]));
    const tagCells = TAG_DIMENSION_NAMES.map((d) => csvCell(t.filter((x) => x.dimension === d).map((x) => x.value)));
    lines.push([...base, ...tagCells].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function tagsFor(vendorIds: string[], db: DbOrTx = getDb()): Map<string, { dimension: string; value: string }[]> {
  const out = new Map<string, { dimension: string; value: string }[]>();
  if (vendorIds.length === 0) return out;
  for (const t of db.select({ vendor_id: tags.vendor_id, dimension: tags.dimension, value: tags.value }).from(tags).where(inArray(tags.vendor_id, vendorIds)).all()) {
    (out.get(t.vendor_id) ?? out.set(t.vendor_id, []).get(t.vendor_id)!).push({ dimension: t.dimension, value: t.value });
  }
  return out;
}
