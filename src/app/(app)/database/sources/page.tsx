import type { Metadata } from "next";

import { InputsTab } from "@/components/database/inputs-tab";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { listRuns, listSchedules } from "@/lib/db/queries";
import { listConfigs, listRulesets } from "@/lib/rulesets/loader";

export const metadata: Metadata = { title: "Vendor Source" };
export const dynamic = "force-dynamic";

export default function VendorSourcePage() {
  const db = getDb();
  return (
    <>
      <PageHeader
        title="Vendor Source"
        description="Where vendors come from: custom web search, GitHub organisations and manual upload, plus scheduled refreshes and run history."
      />
      <InputsTab configs={listConfigs()} rulesets={listRulesets()} runs={listRuns(db, 100)} schedules={listSchedules(db)} />
    </>
  );
}
