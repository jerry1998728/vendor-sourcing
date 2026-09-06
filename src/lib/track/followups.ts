/**
 * P1 follow-ups (PRD §3, §6): Contacted vendors with no reply get a
 * follow-up draft at 7 days and a last one at 14 days; at 10 days they
 * become Dormant (actor=system). Drafts are proposals for a human to send.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb, type Db } from "@/lib/db";
import { updateVendorFields } from "@/lib/db/queries";
import { interactions, vendors, type InteractionRow, type Vendor } from "@/lib/db/schema";
import { transition } from "@/lib/db/state";
import { generateDraft } from "@/lib/outreach/draft";

export const FOLLOW_UP_DAYS = { first: 7, dormant: 10, last: 14 } as const;

export type FollowUpKind = "7d" | "14d";
export type FollowUpResult = { vendor_id: string; days: number; dormant: boolean; drafted: FollowUpKind | null; error?: string };
export type FollowUpSummary = { checked: number; drafted_7d: number; drafted_14d: number; dormant: number; results: FollowUpResult[] };

export type FollowUpOptions = {
  now?: Date;
  /** test seam replacing the LLM draft */
  draftFn?: (vendorId: string, kind: FollowUpKind, previous: InteractionRow) => Promise<InteractionRow>;
};

export async function runFollowUps(opts: FollowUpOptions = {}, db: Db = getDb()): Promise<FollowUpSummary> {
  const now = opts.now ?? new Date();
  const summary: FollowUpSummary = { checked: 0, drafted_7d: 0, drafted_14d: 0, dormant: 0, results: [] };
  const candidates: Vendor[] = db.select().from(vendors).where(inArray(vendors.status, ["Contacted", "Dormant"])).all();

  for (const v of candidates) {
    const lastOutbound = db.select().from(interactions).where(and(eq(interactions.vendor_id, v.vendor_id), eq(interactions.direction, "outbound"))).orderBy(desc(interactions.interaction_id)).get();
    if (!lastOutbound?.sent_at) continue;
    const inbound = db.select({ id: interactions.interaction_id }).from(interactions).where(and(eq(interactions.vendor_id, v.vendor_id), eq(interactions.direction, "inbound"))).get();
    if (inbound) continue;
    summary.checked += 1;
    const days = Math.floor((now.getTime() - Date.parse(lastOutbound.sent_at)) / 86_400_000);
    const result: FollowUpResult = { vendor_id: v.vendor_id, days, dormant: false, drafted: null };
    const drafts = db.select().from(interactions).where(and(eq(interactions.vendor_id, v.vendor_id), eq(interactions.direction, "draft"))).all();
    const has = (kind: FollowUpKind) => drafts.some((d) => d.llm_summary?.startsWith(`follow_up_${kind}`));

    try {
      if (v.status === "Contacted" && days >= FOLLOW_UP_DAYS.dormant) {
        transition({ vendorId: v.vendor_id, toStatus: "Dormant", actor: "system", reason: `no reply for ${days} days`, evidenceRef: `interaction:${lastOutbound.interaction_id}` }, db);
        result.dormant = true;
        summary.dormant += 1;
      }
      const kind: FollowUpKind | null = days >= FOLLOW_UP_DAYS.last && !has("14d") ? "14d" : days >= FOLLOW_UP_DAYS.first && !has("7d") && !has("14d") ? "7d" : null;
      if (kind) {
        const draft = opts.draftFn
          ? await opts.draftFn(v.vendor_id, kind, lastOutbound)
          : (await generateDraft(v.vendor_id, db, { mode: "follow_up", followUpKind: kind, previous: lastOutbound })).interaction;
        void draft;
        updateVendorFields(v.vendor_id, { next_action: `follow_up_${kind}`, due_at: now.toISOString() }, db);
        result.drafted = kind;
        if (kind === "7d") summary.drafted_7d += 1;
        else summary.drafted_14d += 1;
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    summary.results.push(result);
  }
  return summary;
}
