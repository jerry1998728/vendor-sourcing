import type { Metadata } from "next";
import { count } from "drizzle-orm";

import { InputsTab } from "@/components/database/inputs-tab";
import { ReviewQueue } from "@/components/database/review-queue";
import { VendorsTab } from "@/components/database/vendors-tab";
import { PageHeader } from "@/components/page-header";
import { UrlTabs } from "@/components/url-tabs";
import { getDb } from "@/lib/db";
import {
  listReReview,
  listReviewQueue,
  listVendorsFiltered,
  parseVendorFilters,
  vendorFilterOptions,
  type SearchParams,
} from "@/lib/db/filters";
import { getVendorDetail, listRuns, listSchedules } from "@/lib/db/queries";
import { vendors as vendorsTable } from "@/lib/db/schema";
import { listConfigs, listRulesets } from "@/lib/rulesets/loader";
import { mustFieldsFor } from "@/lib/rulesets/vendor";

export const metadata: Metadata = { title: "Database" };
export const dynamic = "force-dynamic";

const DEFAULT_CONFIG = "ego_data_stereo";
export default async function DatabasePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const tabParam = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab = tabParam === "review" || tabParam === "inputs" ? tabParam : "vendors";
  const filters = parseVendorFilters(sp);
  const db = getDb();

  const vendors = listVendorsFiltered(filters, db);
  const total = db.select({ n: count() }).from(vendorsTable).get()?.n ?? 0;
  const options = vendorFilterOptions(db);
  const configs = listConfigs();
  const rulesets = listRulesets();
  // ?config=<name> preselects the run config (deep link from the Dashboard / Inputs).
  const configParam = Array.isArray(sp.config) ? sp.config[0] : sp.config;
  const defaultConfig = configParam && configs.some((c) => c.name === configParam && c.valid) ? configParam : DEFAULT_CONFIG;
  const runs = listRuns(db, 100);
  const schedules = listSchedules(db);
  const reReview = listReReview(db);

  const queue = listReviewQueue({ vendor_type: filters.vendor_type }, db);
  const vendorParam = Array.isArray(sp.vendor) ? sp.vendor[0] : sp.vendor;
  const currentId = vendorParam && queue.some((q) => q.vendor_id === vendorParam) ? vendorParam : queue[0]?.vendor_id;
  const current = currentId ? getVendorDetail(currentId, db) : null;
  const mustFields = current ? mustFieldsFor(current.vendor, db) : [];

  return (
    <>
      <PageHeader
        title="Database"
        description="Every vendor with its evidence, tags and screening result. Filters live in the URL."
      />
      <UrlTabs
        value={tab}
        items={[
          {
            value: "vendors",
            label: "Vendors",
            content: <VendorsTab vendors={vendors} total={total} filters={filters} options={options} configs={configs} defaultConfig={defaultConfig} />,
          },
          {
            value: "review",
            label: (
              <>
                Review Queue
                {queue.length ? <span className="ml-1 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{queue.length}</span> : null}
              </>
            ),
            content: (
              <ReviewQueue
                queue={queue.map((v) => ({ vendor_id: v.vendor_id, name: v.name, vendor_type: v.vendor_type, screen_result: v.screen_result, coverage_confidence: v.coverage_confidence }))}
                current={current}
                mustFields={mustFields}
                reReview={reReview.map((v) => ({ vendor_id: v.vendor_id, name: v.name, status: v.status, screen_result: v.screen_result }))}
              />
            ),
          },
          { value: "inputs", label: "Inputs", content: <InputsTab configs={configs} rulesets={rulesets} runs={runs} schedules={schedules} /> },
        ]}
      />
    </>
  );
}
