/**
 * SQL side of the vendor filters (see src/lib/vendor-filters.ts for the
 * URL <-> filters mapping, which client components import).
 */
import { and, asc, eq, inArray, isNull, like, lt, notInArray, or, sql, type SQL } from "drizzle-orm";

import { TAG_DIMENSION_NAMES } from "@/lib/pipeline/types";
import { OWNER_UNASSIGNED, STALE_DAYS, type VendorFilters } from "@/lib/vendor-filters";

import { getDb, type DbOrTx } from "./index";
import { tags, vendors, type Vendor } from "./schema";

export * from "@/lib/vendor-filters";

function need(x: SQL | undefined): SQL {
  if (!x) throw new Error("empty SQL condition");
  return x;
}

export function vendorWhere(f: VendorFilters, db: DbOrTx): SQL | undefined {
  const conds: SQL[] = [];
  if (f.q) {
    const pattern = `%${f.q.replace(/[%_]/g, "")}%`;
    conds.push(need(or(like(vendors.name, pattern), like(vendors.primary_domain, pattern), like(vendors.vendor_id, pattern))));
  }
  if (f.vendor_type?.length) conds.push(inArray(vendors.vendor_type, f.vendor_type));
  if (f.screen_result?.length) conds.push(inArray(vendors.screen_result, f.screen_result));
  if (f.status?.length) conds.push(inArray(vendors.status, f.status));
  if (f.owner?.length) {
    const named = f.owner.filter((o) => o !== OWNER_UNASSIGNED);
    const parts: SQL[] = [];
    if (named.length) parts.push(inArray(vendors.owner, named));
    if (f.owner.includes(OWNER_UNASSIGNED)) parts.push(isNull(vendors.owner));
    conds.push(need(or(...parts)));
  }
  if (f.country?.length) {
    if (f.country_mode === "not_in") {
      conds.push(need(or(isNull(vendors.registration_country), notInArray(vendors.registration_country, f.country))));
    } else {
      conds.push(inArray(vendors.registration_country, f.country));
    }
  }
  if (f.coverage_min !== undefined) conds.push(sql`coalesce(${vendors.coverage_confidence}, 0) >= ${f.coverage_min / 100}`);
  if (f.coverage_max !== undefined) conds.push(sql`coalesce(${vendors.coverage_confidence}, 0) <= ${f.coverage_max / 100}`);
  if (f.source_channel?.length) conds.push(inArray(vendors.discovered_via, f.source_channel));
  if (f.stale) {
    const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
    conds.push(need(or(isNull(vendors.last_verified_at), lt(vendors.last_verified_at, cutoff))));
  }
  for (const [dimension, values] of Object.entries(f.tags ?? {})) {
    if (!values || values.length === 0) continue;
    conds.push(
      inArray(
        vendors.vendor_id,
        db
          .select({ vendor_id: tags.vendor_id })
          .from(tags)
          .where(and(eq(tags.dimension, dimension), inArray(tags.value, values))),
      ),
    );
  }
  return conds.length ? and(...conds) : undefined;
}

export function listVendorsFiltered(f: VendorFilters, db: DbOrTx = getDb()): Vendor[] {
  const where = vendorWhere(f, db);
  const base = db.select().from(vendors);
  const q = where ? base.where(where) : base;
  return q.orderBy(sql`${vendors.coverage_confidence} desc nulls last`, asc(vendors.name)).all();
}

export type VendorFilterOptions = {
  vendor_types: string[];
  owners: string[];
  source_channels: string[];
  countries: string[];
  tags: Record<string, string[]>;
};

export function vendorFilterOptions(db: DbOrTx = getDb()): VendorFilterOptions {
  const distinct = (rows: { v: string | null }[]) => [...new Set(rows.map((r) => r.v).filter((v): v is string => !!v))].sort();
  const tagRows = db.selectDistinct({ dimension: tags.dimension, value: tags.value }).from(tags).all();
  const tagOptions: Record<string, string[]> = {};
  for (const d of TAG_DIMENSION_NAMES) {
    const values = tagRows.filter((t) => t.dimension === d).map((t) => t.value).sort();
    if (values.length) tagOptions[d] = values;
  }
  return {
    vendor_types: distinct(db.selectDistinct({ v: vendors.vendor_type }).from(vendors).all()),
    owners: distinct(db.selectDistinct({ v: vendors.owner }).from(vendors).all()),
    source_channels: distinct(db.selectDistinct({ v: vendors.discovered_via }).from(vendors).all()),
    countries: distinct(db.selectDistinct({ v: vendors.registration_country }).from(vendors).all()),
    tags: tagOptions,
  };
}

/** Screened vendors, most covered first (PRD §4.2). */
export const RE_REVIEW = "re_review";

/** Vendors past Screened whose screen_result changed on a refresh (P1); they need a human look. */
export function listReReview(db: DbOrTx = getDb()): Vendor[] {
  return db.select().from(vendors).where(eq(vendors.next_action, RE_REVIEW)).orderBy(asc(vendors.name)).all();
}

export function listReviewQueue(f: Pick<VendorFilters, "vendor_type">, db: DbOrTx = getDb()): Vendor[] {
  const conds: SQL[] = [eq(vendors.status, "Screened")];
  if (f.vendor_type?.length) conds.push(inArray(vendors.vendor_type, f.vendor_type));
  return db
    .select()
    .from(vendors)
    .where(and(...conds))
    .orderBy(sql`${vendors.coverage_confidence} desc nulls last`, asc(vendors.name))
    .all();
}
