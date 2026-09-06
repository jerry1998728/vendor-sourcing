/** Dashboard numbers (PRD §4.1). Every metric maps to a filtered Database or Outreach view. */
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { getDb, type DbOrTx } from "./index";
import { STALE_DAYS } from "./filters";
import { events, proposals, runs, vendors, type Run, type VendorStatus } from "./schema";

export type Funnel = { discovered: number; pass: number; unknown: number; fail: number; byStatus: Record<VendorStatus, number> };

export function funnel(db: DbOrTx = getDb()): Funnel {
  const byStatus = Object.fromEntries(db.select({ status: vendors.status, n: count() }).from(vendors).groupBy(vendors.status).all().map((r) => [r.status, r.n])) as Record<VendorStatus, number>;
  const screen = Object.fromEntries(db.select({ r: vendors.screen_result, n: count() }).from(vendors).groupBy(vendors.screen_result).all().map((r) => [r.r ?? "none", r.n]));
  const discovered = db.select({ n: count() }).from(vendors).get()?.n ?? 0;
  return { discovered, pass: screen.pass ?? 0, unknown: screen.unknown ?? 0, fail: screen.fail ?? 0, byStatus };
}

export type CoverageByType = { vendor_type: string; vendors: number; coverage: number | null };

export function coverageByType(db: DbOrTx = getDb()): CoverageByType[] {
  return db
    .select({ vendor_type: vendors.vendor_type, vendors: count(), coverage: sql<number | null>`avg(${vendors.coverage_confidence})` })
    .from(vendors)
    .groupBy(vendors.vendor_type)
    .all();
}

export type Pipeline = { contacted: number; in_discussion: number; ever_contacted: number; ever_replied: number; reply_rate: number | null };

export function pipeline(db: DbOrTx = getDb()): Pipeline {
  const f = funnel(db);
  const everContacted = db.select({ n: sql<number>`count(distinct ${events.vendor_id})` }).from(events).where(eq(events.to_status, "Contacted")).get()?.n ?? 0;
  const everReplied = db.select({ n: sql<number>`count(distinct ${events.vendor_id})` }).from(events).where(eq(events.to_status, "Replied")).get()?.n ?? 0;
  return {
    contacted: f.byStatus.Contacted ?? 0,
    in_discussion: f.byStatus["In Discussion"] ?? 0,
    ever_contacted: everContacted,
    ever_replied: everReplied,
    reply_rate: everContacted ? everReplied / everContacted : null,
  };
}

export type Backlog = { review_queue: number; proposals: number; overdue: number };

export function backlog(db: DbOrTx = getDb()): Backlog {
  const now = new Date().toISOString();
  return {
    review_queue: db.select({ n: count() }).from(vendors).where(eq(vendors.status, "Screened")).get()?.n ?? 0,
    proposals: db.select({ n: count() }).from(proposals).where(isNull(proposals.decided_at)).get()?.n ?? 0,
    overdue: db.select({ n: count() }).from(vendors).where(and(isNotNull(vendors.due_at), lt(vendors.due_at, now), inArray(vendors.status, ["Qualified", "Contacted", "Replied", "In Discussion"]))).get()?.n ?? 0,
  };
}

export type Secondary = {
  by_source: { source: string; n: number }[];
  stale: number;
  last_run: Run | null;
  median_hours_to_first_reply: number | null;
  replies_measured: number;
  by_country: { country: string; n: number }[];
};

export function secondary(db: DbOrTx = getDb()): Secondary {
  const cutoff = new Date(Date.now() - STALE_DAYS * 86_400_000).toISOString();
  const bySource = db.select({ source: vendors.discovered_via, n: count() }).from(vendors).groupBy(vendors.discovered_via).orderBy(desc(count())).all().map((r) => ({ source: r.source ?? "unknown", n: r.n }));
  const stale = db.select({ n: count() }).from(vendors).where(or(isNull(vendors.last_verified_at), lt(vendors.last_verified_at, cutoff))).get()?.n ?? 0;
  const lastRun = db.select().from(runs).where(isNotNull(runs.finished_at)).orderBy(desc(runs.started_at)).get() ?? null;

  const contacted = db.select({ vendor_id: events.vendor_id, at: sql<string>`min(${events.created_at})` }).from(events).where(eq(events.to_status, "Contacted")).groupBy(events.vendor_id).all();
  const replied = new Map(db.select({ vendor_id: events.vendor_id, at: sql<string>`min(${events.created_at})` }).from(events).where(eq(events.to_status, "Replied")).groupBy(events.vendor_id).all().map((r) => [r.vendor_id, r.at]));
  const hours = contacted
    .map((c) => {
      const r = replied.get(c.vendor_id);
      return r ? (Date.parse(r) - Date.parse(c.at)) / 3_600_000 : null;
    })
    .filter((h): h is number => h !== null && h >= 0)
    .sort((a, b) => a - b);
  const median = hours.length ? (hours.length % 2 ? hours[(hours.length - 1) / 2] : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2) : null;

  const byCountry = db
    .select({ country: vendors.registration_country, n: count() })
    .from(vendors)
    .where(isNotNull(vendors.registration_country))
    .groupBy(vendors.registration_country)
    .orderBy(desc(count()))
    .limit(8)
    .all()
    .map((r) => ({ country: r.country ?? "?", n: r.n }));

  return { by_source: bySource, stale, last_run: lastRun, median_hours_to_first_reply: median, replies_measured: hours.length, by_country: byCountry };
}
