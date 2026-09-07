import { redirect } from "next/navigation";

import { sectionTarget, type RawSearchParams } from "@/lib/shared/params";

export const dynamic = "force-dynamic";

/** Section root: opens Vendor Source. Legacy ?tab= links keep their meaning. */
const LEGACY_TABS: Record<string, string> = {
  inputs: "/database/sources",
  vendors: "/database/vendors",
  review: "/database/review",
};

export default async function DatabasePage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  redirect(sectionTarget(await searchParams, LEGACY_TABS, "/database/sources"));
}
