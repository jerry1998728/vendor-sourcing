import type { Metadata } from "next";

import { SourceDiscovery } from "@/components/database/source-discovery";
import { SourceTools } from "@/components/database/source-tools";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { listRuns, listSchedules } from "@/lib/db/queries";
import { listConfigs, listRulesets } from "@/lib/rulesets/loader";

export const metadata: Metadata = { title: "Vendor Source" };
export const dynamic = "force-dynamic";

export default function VendorSourcePage() {
  const db = getDb();
  const configs = listConfigs();
  return (
    <>
      <PageHeader
        title="Source Discovery & Channel"
        help="Where vendors come from. Pick a channel, describe what you want, and run it: every candidate is normalized, evidenced and screened on the way in, then waits in the Review Queue. Schedules and run history are in the buttons on the right."
        actions={<SourceTools configs={configs} runs={listRuns(db, 100)} schedules={listSchedules(db)} />}
      />
      <SourceDiscovery rulesets={listRulesets()} />
    </>
  );
}
