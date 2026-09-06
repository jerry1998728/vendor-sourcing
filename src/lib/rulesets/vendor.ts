import { getDb, type DbOrTx } from "@/lib/db";
import { getRun } from "@/lib/db/queries";
import type { Vendor } from "@/lib/db/schema";
import type { Ruleset } from "@/lib/pipeline/screen";

import { defaultRulesetFor } from "@/lib/shared/rulesets";

import { loadRuleset } from "./loader";


/**
 * The ruleset a vendor was screened with (its first run's version), else the
 * type default. Null only when there is no reference at all; a ruleset that
 * exists but fails to load throws, because silently dropping it would make
 * drafts stop asking questions.
 */
export function rulesetForVendor(vendor: Vendor, db: DbOrTx = getDb()): Ruleset | null {
  const ref = (vendor.first_seen_run_id ? getRun(vendor.first_seen_run_id, db)?.ruleset_version : undefined) ?? defaultRulesetFor(vendor.vendor_type);
  return ref ? loadRuleset(ref) : null;
}

export type MustField = { id: string; field_path: string; description?: string };

/** UI helper that tolerates a broken ruleset: logs it and shows no must-fields rather than failing the page. */
export function mustFieldsFor(vendor: Vendor, db: DbOrTx = getDb()): MustField[] {
  try {
    const ruleset = rulesetForVendor(vendor, db);
    return ruleset ? ruleset.must.map((m) => ({ id: m.id, field_path: m.field_path, description: m.description })) : [];
  } catch (err) {
    console.error(`[rulesets] cannot load the ruleset for ${vendor.vendor_id}:`, err instanceof Error ? err.message : err);
    return [];
  }
}
