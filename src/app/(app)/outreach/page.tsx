import type { Metadata } from "next";

import { BoardTab } from "@/components/outreach/board-tab";
import { DraftSendTab } from "@/components/outreach/draft-send-tab";
import { ProposalsTab } from "@/components/outreach/proposals-tab";
import { PageHeader } from "@/components/page-header";
import { UrlTabs } from "@/components/url-tabs";
import { getDb } from "@/lib/db";
import { listVendorsFiltered, parseVendorFilters, vendorFilterOptions, type SearchParams } from "@/lib/db/filters";
import { countActiveThreads, latestDraftsFor, listLlmEvents, listPendingProposals } from "@/lib/db/queries";
import { parseAllowlist } from "@/lib/outreach/allowlist";
import { isConfigured, isConnected } from "@/lib/outreach/gmail";

export const metadata: Metadata = { title: "Outreach" };
export const dynamic = "force-dynamic";

const single = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function OutreachPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const tabParam = single(sp.tab);
  const tab = tabParam === "draft" || tabParam === "proposals" ? tabParam : "board";
  const all = parseVendorFilters(sp);
  const filters = { owner: all.owner, vendor_type: all.vendor_type };
  const db = getDb();

  const board = listVendorsFiltered(filters, db);
  const qualified = board.filter((v) => v.status === "Qualified");
  const silent = board.filter((v) => v.status === "Contacted" || v.status === "Dormant");
  const draftMap = latestDraftsFor([...qualified, ...silent].map((v) => v.vendor_id), db);
  // P1: Contacted / Dormant vendors with a follow-up draft join the Draft & Send list.
  const followUps = silent.filter((v) => draftMap.get(v.vendor_id)?.llm_summary?.startsWith("follow_up"));
  const drafts = Object.fromEntries(draftMap);
  const sendable = [...qualified, ...followUps];
  const options = vendorFilterOptions(db);
  const configured = isConfigured();
  const gmail = { configured, connected: configured && isConnected() };
  const allowlist = parseAllowlist();
  const pending = listPendingProposals(db);
  const llmEvents = listLlmEvents(25, db);
  const activeThreads = countActiveThreads(db);
  const gmailParam = single(sp.gmail);
  const gmailError = single(sp.gmail_error);
  const notice = gmailParam === "connected" ? "Gmail connected. token.json was written to the repo root." : gmailError ? `Gmail authorization failed: ${gmailError}` : null;

  return (
    <>
      <PageHeader title="Outreach" description="Board, Draft & Send and Proposals. Every send is a human click to an allowlisted recipient." />
      <UrlTabs
        value={tab}
        items={[
          { value: "board", label: "Board", content: <BoardTab vendors={board} options={options} filters={filters} /> },
          {
            value: "draft",
            label: (
              <>
                Draft &amp; Send
                {sendable.length ? <span className="ml-1 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{sendable.length}</span> : null}
              </>
            ),
            content: <DraftSendTab vendors={sendable} drafts={drafts} gmail={gmail} allowlist={allowlist} notice={notice} />,
          },
          {
            value: "proposals",
            label: (
              <>
                Proposals
                {pending.length ? <span className="ml-1 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">{pending.length}</span> : null}
              </>
            ),
            content: <ProposalsTab proposals={pending} llmEvents={llmEvents} activeThreads={activeThreads} />,
          },
        ]}
      />
    </>
  );
}
