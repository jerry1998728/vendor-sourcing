import type { Metadata } from "next";
import { count } from "drizzle-orm";

import { VendorsTab } from "@/components/database/vendors-tab";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { listVendorsFiltered, parseVendorFilters, vendorFilterOptions, type SearchParams } from "@/lib/db/filters";
import { vendors as vendorsTable } from "@/lib/db/schema";
import { listConfigs } from "@/lib/rulesets/loader";
import { singleParam } from "@/lib/shared/params";

export const metadata: Metadata = { title: "Vendor Data" };
export const dynamic = "force-dynamic";

const DEFAULT_CONFIG = "ego_data_stereo";

export default async function VendorDataPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const filters = parseVendorFilters(sp);
  const db = getDb();

  const vendors = listVendorsFiltered(filters, db);
  const total = db.select({ n: count() }).from(vendorsTable).get()?.n ?? 0;
  const options = vendorFilterOptions(db);
  const configs = listConfigs();
  // ?config=<name> preselects the run config (deep link from the Dashboard / Vendor Source).
  const configParam = singleParam(sp.config);
  const defaultConfig = configParam && configs.some((c) => c.name === configParam && c.valid) ? configParam : DEFAULT_CONFIG;

  return (
    <>
      <PageHeader
        title="Vendor Data"
        help="Every vendor with its evidence, tags and screening result. Filters live in the URL, so any view here can be shared as a link or exported as CSV."
      />
      <VendorsTab vendors={vendors} total={total} filters={filters} options={options} configs={configs} defaultConfig={defaultConfig} />
    </>
  );
}
