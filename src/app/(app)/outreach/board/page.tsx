import type { Metadata } from "next";

import { BoardTab } from "@/components/outreach/board-tab";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { listVendorsFiltered, parseVendorFilters, vendorFilterOptions, type SearchParams } from "@/lib/db/filters";

export const metadata: Metadata = { title: "Board" };
export const dynamic = "force-dynamic";

export default async function BoardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const all = parseVendorFilters(sp);
  const filters = { owner: all.owner, vendor_type: all.vendor_type };
  const db = getDb();
  const board = listVendorsFiltered(filters, db);
  const options = vendorFilterOptions(db);

  return (
    <>
      <PageHeader title="Board" description="Vendors by status with owner, next action and due date." />
      <BoardTab vendors={board} options={options} filters={filters} />
    </>
  );
}
