import type { Metadata } from "next";

import { ProposalsTab } from "@/components/outreach/proposals-tab";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { countActiveThreads, listLlmEvents, listPendingProposals } from "@/lib/db/queries";

export const metadata: Metadata = { title: "Proposals" };
export const dynamic = "force-dynamic";

export default function ProposalsPage() {
  const db = getDb();
  const pending = listPendingProposals(db);
  const llmEvents = listLlmEvents(25, db);
  const activeThreads = countActiveThreads(db);

  return (
    <>
      <PageHeader title="Proposals" description="Inferred status changes waiting for a decision, and automatic changes you can revert." />
      <ProposalsTab proposals={pending} llmEvents={llmEvents} activeThreads={activeThreads} />
    </>
  );
}
