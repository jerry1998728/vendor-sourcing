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
        help="Where vendors come from. Pick a channel, describe what you want, and run it: every candidate is normalized, evidenced and screened on the way in, then waits in the Review Queue. Runs and scheduled refreshes are in the buttons on the right."
      />
      <InputsTab configs={listConfigs()} rulesets={listRulesets()} runs={listRuns(db, 100)} schedules={listSchedules(db)} />
    </>
  );
}
