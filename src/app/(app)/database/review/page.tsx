import type { Metadata } from "next";

import { ReviewQueue } from "@/components/database/review-queue";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { listReReview, listReviewQueue, parseVendorFilters, type SearchParams } from "@/lib/db/filters";
import { getVendorDetail } from "@/lib/db/queries";
import { mustFieldsFor } from "@/lib/rulesets/vendor";
import { singleParam } from "@/lib/shared/params";

export const metadata: Metadata = { title: "Review Queue" };
export const dynamic = "force-dynamic";

export default async function ReviewQueuePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const filters = parseVendorFilters(sp);
  const db = getDb();

  const queue = listReviewQueue({ vendor_type: filters.vendor_type }, db);
  const vendorParam = singleParam(sp.vendor);
  const currentId = vendorParam && queue.some((q) => q.vendor_id === vendorParam) ? vendorParam : queue[0]?.vendor_id;
  const current = currentId ? getVendorDetail(currentId, db) : null;
  const mustFields = current ? mustFieldsFor(current.vendor, db) : [];
  const reReview = listReReview(db);

  return (
    <>
      <PageHeader
        title="Review Queue"
        help="The human gate between discovery and outreach. One screened vendor at a time with its unknown must-fields pinned on top: Qualify, Reject with a reason, or Need info to ask the vendor. Vendors a refresh flagged sit on top."
      />
      <ReviewQueue
        queue={queue.map((v) => ({ vendor_id: v.vendor_id, name: v.name, vendor_type: v.vendor_type, screen_result: v.screen_result, coverage_confidence: v.coverage_confidence }))}
        current={current}
        mustFields={mustFields}
        reReview={reReview.map((v) => ({ vendor_id: v.vendor_id, name: v.name, status: v.status, screen_result: v.screen_result }))}
      />
    </>
  );
}
