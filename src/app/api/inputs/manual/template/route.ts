import { NextResponse } from "next/server";

import { manualTemplateCsv } from "@/lib/pipeline/manual";
import { VENDOR_TYPES, type VendorType } from "@/lib/pipeline/types";
import { loadRuleset } from "@/lib/rulesets/loader";

export const dynamic = "force-dynamic";

const DEFAULT_RULESET: Record<VendorType, string> = { ego_data: "ego_data_supplier@v1", code_data: "repo_owner@v1" };

/** CSV template: field paths + tag dimensions + source_url + attestation. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const vendorType = url.searchParams.get("vendor_type") ?? "ego_data";
  if (!(VENDOR_TYPES as readonly string[]).includes(vendorType)) {
    return NextResponse.json({ error: `vendor_type must be one of ${VENDOR_TYPES.join(", ")}` }, { status: 400 });
  }
  const ref = url.searchParams.get("ruleset") ?? DEFAULT_RULESET[vendorType as VendorType];
  try {
    const ruleset = loadRuleset(ref);
    const csv = manualTemplateCsv(ruleset, vendorType as VendorType);
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="manual_${vendorType}_${ruleset.name}.csv"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
