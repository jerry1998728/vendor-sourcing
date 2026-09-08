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
      <PageHeader title="Proposals" help="What inference did with inbound replies. Changes below 0.85 confidence, and anything about a quote or a sample, wait here for your decision; changes it applied on its own are listed so you can revert them." />
      <ProposalsTab proposals={pending} llmEvents={llmEvents} activeThreads={activeThreads} />
    </>
  );
}
