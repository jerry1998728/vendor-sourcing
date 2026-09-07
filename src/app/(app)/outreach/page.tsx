import { redirect } from "next/navigation";

import { sectionTarget, type RawSearchParams } from "@/lib/shared/params";

export const dynamic = "force-dynamic";

/** Section root: opens the Board. Legacy ?tab= links keep their meaning. */
const LEGACY_TABS: Record<string, string> = {
  board: "/outreach/board",
  draft: "/outreach/draft",
  proposals: "/outreach/proposals",
};

export default async function OutreachPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  redirect(sectionTarget(await searchParams, LEGACY_TABS, "/outreach/board"));
}
