import type { Metadata } from "next";

import { DraftSendTab } from "@/components/outreach/draft-send-tab";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { listVendorsFiltered, parseVendorFilters, type SearchParams } from "@/lib/db/filters";
import { latestDraftsFor } from "@/lib/db/queries";
import { parseAllowlist } from "@/lib/outreach/allowlist";
import { isConfigured, isConnected } from "@/lib/outreach/gmail";
import { singleParam } from "@/lib/shared/params";

export const metadata: Metadata = { title: "Draft & Send" };
export const dynamic = "force-dynamic";

export default async function DraftSendPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const all = parseVendorFilters(sp);
  const filters = { owner: all.owner, vendor_type: all.vendor_type };
  const db = getDb();

  const board = listVendorsFiltered(filters, db);
  const qualified = board.filter((v) => v.status === "Qualified");
  const silent = board.filter((v) => v.status === "Contacted" || v.status === "Dormant");
  const draftMap = latestDraftsFor([...qualified, ...silent].map((v) => v.vendor_id), db);
  // Contacted / Dormant vendors with a follow-up draft join the sendable list.
  const followUps = silent.filter((v) => draftMap.get(v.vendor_id)?.llm_summary?.startsWith("follow_up"));
  const drafts = Object.fromEntries(draftMap);
  const sendable = [...qualified, ...followUps];
  const configured = isConfigured();
  const gmail = { configured, connected: configured && isConnected() };
  const allowlist = parseAllowlist();
  const gmailParam = singleParam(sp.gmail);
  const gmailError = singleParam(sp.gmail_error);
  const notice = gmailParam === "connected" ? "Gmail connected. token.json was written to the repo root." : gmailError ? `Gmail authorization failed: ${gmailError}` : null;

  return (
    <>
      <PageHeader title="Draft & Send" help="Qualified vendors and due follow-ups. The draft cites verified evidence and asks about each unknown must-field; sending is always a human click, and only to an allowlisted recipient." />
      <DraftSendTab vendors={sendable} drafts={drafts} gmail={gmail} allowlist={allowlist} notice={notice} />
    </>
  );
}
