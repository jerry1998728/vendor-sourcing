import type { Metadata } from "next";

import { BoardTab } from "@/components/outreach/board-tab";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { listVendorsFiltered, parseVendorFilters, vendorFilterOptions, type SearchParams } from "@/lib/db/filters";
import { diligenceProgressFor } from "@/lib/db/queries";
import { diligenceItemsFor } from "@/lib/track/diligence";

export const metadata: Metadata = { title: "Board" };
export const dynamic = "force-dynamic";

export default async function BoardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const all = parseVendorFilters(sp);
  const filters = { owner: all.owner, vendor_type: all.vendor_type };
  const db = getDb();
  const board = listVendorsFiltered(filters, db);
  const options = vendorFilterOptions(db);
  // Progress badges for vendors under evaluation.
  const underEvaluation = board.filter((v) => v.status === "In Discussion");
  const done = diligenceProgressFor(underEvaluation.map((v) => v.vendor_id), db);
  const diligence = Object.fromEntries(
    underEvaluation.map((v) => [v.vendor_id, { done: done.get(v.vendor_id) ?? 0, total: diligenceItemsFor(v, db).length }]).filter(([, p]) => (p as { total: number }).total > 0),
  );

  return (
    <>
      <PageHeader title="Board" help="Every active vendor by status, with its owner, next action and due date. Overdue dates are red; In Discussion cards show the diligence stage." />
      <BoardTab vendors={board} options={options} filters={filters} diligence={diligence} />
    </>
  );
}
