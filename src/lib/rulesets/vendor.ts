import { getDb, type DbOrTx } from "@/lib/db";
import { getRun } from "@/lib/db/queries";
import type { Vendor } from "@/lib/db/schema";
import type { Ruleset } from "@/lib/pipeline/screen";

import { loadRuleset } from "./loader";

const DEFAULT_RULESET: Record<string, string> = { ego_data: "ego_data_supplier@v1", code_data: "repo_owner@v1" };

/** The ruleset a vendor was screened with (its first run's version), else the type default. */
export function rulesetForVendor(vendor: Vendor, db: DbOrTx = getDb()): Ruleset | null {
  const ref = (vendor.first_seen_run_id ? getRun(vendor.first_seen_run_id, db)?.ruleset_version : undefined) ?? DEFAULT_RULESET[vendor.vendor_type];
  if (!ref) return null;
  try {
    return loadRuleset(ref);
  } catch {
    return null;
  }
}

export type MustField = { id: string; field_path: string; description?: string };

export function mustFieldsFor(vendor: Vendor, db: DbOrTx = getDb()): MustField[] {
  const ruleset = rulesetForVendor(vendor, db);
  return ruleset ? ruleset.must.map((m) => ({ id: m.id, field_path: m.field_path, description: m.description })) : [];
}
