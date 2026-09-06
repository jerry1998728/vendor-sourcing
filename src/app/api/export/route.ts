import { NextResponse } from "next/server";

import { tagsFor, vendorsToCsv } from "@/lib/db/export";
import { listVendorsFiltered, parseVendorFilters } from "@/lib/db/filters";

export const dynamic = "force-dynamic";

/** GET /api/export?<same params as the Vendors tab> -> vendors.csv */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (sp[k] = v));
  const rows = listVendorsFiltered(parseVendorFilters(sp));
  const csv = vendorsToCsv(rows, tagsFor(rows.map((r) => r.vendor_id)));
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="vendors_${stamp}.csv"` },
  });
}
