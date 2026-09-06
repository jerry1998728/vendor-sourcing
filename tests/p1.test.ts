import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Run folders created by createRefresh() must not land in data/runs during tests.
process.env.RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-sourcing-test-runs-"));
import { eq } from "drizzle-orm";

import { createDb, events, interactions, runs, vendors, type Db } from "@/lib/db";
import { csvCell, vendorsToCsv } from "@/lib/db/export";
import { transition } from "@/lib/db/state";
import { cronMatches, isDue, nextFireAfter, parseCron } from "@/lib/pipeline/cron";
import { createRefresh, describeDiff, diffSnapshots, executeRefresh } from "@/lib/pipeline/refresh";
import { writeNormalizedVendor } from "@/lib/pipeline/run";
import type { Evidence, NormalizeResult, SourceAdapter, VendorCandidate } from "@/lib/pipeline/types";
import { loadRuleset } from "@/lib/rulesets/loader";
import { runFollowUps } from "@/lib/track/followups";

test("cron: parse, match, next fire, due", () => {
  const daily = parseCron("0 3 * * *")!;
  assert.ok(daily);
  assert.equal(cronMatches(daily, new Date("2026-09-07T03:00:00Z")), true);
  assert.equal(cronMatches(daily, new Date("2026-09-07T04:00:00Z")), false);
  assert.equal(parseCron("*/15 * * * *")!.minute.size, 4);
  assert.equal(parseCron("0 7 * * 1-5")!.dow.has(6), false);
  assert.equal(parseCron("0 3 * * 7")!.dow.has(0), true);
  assert.equal(parseCron("bad"), null);
  assert.equal(parseCron("60 * * * *"), null);
  assert.equal(nextFireAfter(daily, new Date("2026-09-07T02:59:00Z"))!.toISOString(), "2026-09-07T03:00:00.000Z");
  assert.equal(isDue("0 3 * * *", "2026-09-06T03:00:00Z", new Date("2026-09-07T03:05:00Z")), true);
  assert.equal(isDue("0 3 * * *", "2026-09-07T03:00:00Z", new Date("2026-09-07T12:00:00Z")), false);
  assert.equal(isDue("0 3 * * *", null, new Date("2026-09-07T12:00:00Z")), true); // never ran, fired today
  assert.equal(isDue("0 3 * * *", null, new Date("2026-09-07T02:00:00Z")), true); // never ran, fired 23h ago (inside the 24h window)
  assert.equal(isDue("0 3 * * 1", null, new Date("2026-09-09T12:00:00Z")), false); // weekly Monday job, checked on Wednesday
});

test("csv: escaping, arrays, tag columns", () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(["x", "y"]), "x|y");
  assert.equal(csvCell(null), "");
  const now = "2026-09-07T00:00:00.000Z";
  const csv = vendorsToCsv(
    [{ vendor_id: "a.example", name: "A, Inc", vendor_type: "ego_data", primary_domain: "a.example", contact_email: null, registration_country: "DE", ownership_country: null, parent_entity: null, collection_countries: ["DE", "FR"], attributes: {}, screen_result: "pass", screen_reasons: [], status: "Screened", diligence_stage: null, status_confidence: null, coverage_confidence: 0.9, next_action: null, owner: null, due_at: null, first_seen_run_id: null, discovered_via: "manual", last_verified_at: now, discovered_at: now, updated_at: now }],
    new Map([["a.example", [{ dimension: "sensor_rig", value: "stereo" }, { dimension: "sensor_rig", value: "imu" }]]]),
  );
  const [header, row] = csv.trim().split("\r\n");
  assert.ok(header.startsWith("vendor_id,name,"));
  assert.ok(header.includes("tag:sensor_rig"));
  assert.ok(row.startsWith('a.example,"A, Inc",ego_data'));
  assert.ok(row.includes("DE|FR"));
  assert.ok(row.includes("stereo|imu"));
});

function seed(): { db: Db; run: ReturnType<typeof createRefreshSeedRun> } {
  const db = createDb(":memory:");
  const run = createRefreshSeedRun(db);
  return { db, run };
}
function createRefreshSeedRun(db: Db) {
  const now = new Date().toISOString();
  return db.insert(runs).values({ run_id: "run_20260901_000000_000001", input_type: "web_search", adapter: "web_search_llm", vendor_type: "ego_data", query: { config: "ego_data_stereo" }, ruleset_version: "ego_data_supplier@v1", started_at: now, finished_at: now }).returning().get();
}
const ev = (field_path: string, value: string, proxy = false): Evidence => ({ field_path, value, source_url: `https://acme.example/${field_path}`, snippet: `${field_path} is ${value}`, extraction_method: "llm", confidence: 0.9, proxy, verified: true, attested_by: null, observed_at: new Date().toISOString() });
const candidate = (extra: Evidence[]): NormalizeResult & { vendor: VendorCandidate } => ({
  page_type: "vendor_site",
  vendor: { vendor_id: "acme.example", name: "Acme", vendor_type: "ego_data", primary_domain: "acme.example", contact_email: null, registration_country: "DE", ownership_country: null, parent_entity: null, collection_countries: [], discovered_via: "web_search_llm" },
  evidence: [ev("sensor_rig", "stereo"), ev("registration_country", "DE"), ...extra],
  tags: [{ dimension: "sensor_rig", value: "stereo", source_badge: "verified", evidence_index: 0 }],
  mentioned_vendors: [],
  raw: {},
});

test("refresh: new evidence writes tag_changed, a screen change past Screened flags re_review", async () => {
  const { db, run } = seed();
  const ruleset = loadRuleset("ego_data_supplier@v1");
  writeNormalizedVendor(db, run, ruleset, candidate([]));
  transition({ vendorId: "acme.example", toStatus: "Qualified", actor: "human", reason: "review" }, db);
  const before = db.select().from(vendors).where(eq(vendors.vendor_id, "acme.example")).get()!;
  assert.equal(before.screen_result, "unknown");

  const fake: SourceAdapter = {
    name: "web_search_llm",
    vendorTypes: ["ego_data"],
    discover: async () => [],
    normalize: async () => candidate([]),
    refresh: async () => candidate([ev("ownership_country", "DE", true), ev("scene_class", "urban")]),
  };
  const refresh = createRefresh("ego_data_stereo", { vendorIds: ["acme.example"] }, db);
  assert.equal(refresh.input_type, "refresh");
  const done = await executeRefresh(refresh.run_id, db, { adapter: fake });
  assert.equal(done.counts.refreshed, 1);
  assert.equal(done.counts.changed, 1);
  assert.equal(done.counts.screen_changed, 1);

  const after = db.select().from(vendors).where(eq(vendors.vendor_id, "acme.example")).get()!;
  assert.equal(after.screen_result, "pass");
  assert.equal(after.status, "Qualified"); // status untouched
  assert.equal(after.next_action, "re_review");
  const evs = db.select().from(events).where(eq(events.vendor_id, "acme.example")).all();
  const info = evs.filter((e) => e.from_status === e.to_status);
  assert.equal(info.length, 2);
  assert.match(info[0].reason ?? "", /tag_changed: .*ownership_country \+DE/);
  assert.match(info[1].reason ?? "", /screen_changed: unknown -> pass/);
  // replay still consistent with informational events in the log
  const { rebuildStatus } = await import("@/lib/db/state");
  assert.equal(rebuildStatus("acme.example", db).status, "Qualified");
  const d = diffSnapshots({ attributes: { a: ["1"] }, tags: {}, screen_result: "pass", status: "x" }, { attributes: { a: ["1", "2"] }, tags: { t: ["v"] }, screen_result: "pass", status: "x" });
  assert.equal(describeDiff(d), "t +v; a +2");
});

test("follow-ups: 7d draft, Dormant at 10d, last draft at 14d, replies excluded", async () => {
  const db = createDb(":memory:");
  const run = createRefreshSeedRun(db);
  const ruleset = loadRuleset("ego_data_supplier@v1");
  writeNormalizedVendor(db, run, ruleset, candidate([]));
  transition({ vendorId: "acme.example", toStatus: "Qualified", actor: "human", reason: "review" }, db);
  transition({ vendorId: "acme.example", toStatus: "Contacted", actor: "human", reason: "sent" }, db);
  const sentAt = new Date("2026-09-01T10:00:00Z");
  db.insert(interactions).values({ vendor_id: "acme.example", direction: "outbound", gmail_thread_id: "t1", sent_at: sentAt.toISOString(), subject: "Hi", body_text: "first email" }).run();
  const drafted: string[] = [];
  const draftFn = async (vendorId: string, kind: "7d" | "14d") => {
    drafted.push(kind);
    return db.insert(interactions).values({ vendor_id: vendorId, direction: "draft", subject: `Re: Hi`, body_text: "nudge", llm_summary: `follow_up_${kind}; model=fake` }).returning().get();
  };
  const day = (n: number) => new Date(sentAt.getTime() + n * 86_400_000 + 3_600_000);

  const d3 = await runFollowUps({ now: day(3), draftFn }, db);
  assert.equal(d3.drafted_7d, 0);
  const d8 = await runFollowUps({ now: day(8), draftFn }, db);
  assert.equal(d8.drafted_7d, 1);
  assert.equal(db.select().from(vendors).where(eq(vendors.vendor_id, "acme.example")).get()!.next_action, "follow_up_7d");
  const d8b = await runFollowUps({ now: day(8), draftFn }, db);
  assert.equal(d8b.drafted_7d, 0); // idempotent
  const d11 = await runFollowUps({ now: day(11), draftFn }, db);
  assert.equal(d11.dormant, 1);
  assert.equal(db.select().from(vendors).where(eq(vendors.vendor_id, "acme.example")).get()!.status, "Dormant");
  const d15 = await runFollowUps({ now: day(15), draftFn }, db);
  assert.equal(d15.drafted_14d, 1);
  assert.deepEqual(drafted, ["7d", "14d"]);
  // a vendor that replied is left alone
  db.insert(interactions).values({ vendor_id: "acme.example", direction: "inbound", gmail_thread_id: "t1", sent_at: day(16).toISOString(), subject: "Re", body_text: "hello" }).run();
  const d20 = await runFollowUps({ now: day(20), draftFn }, db);
  assert.equal(d20.checked, 0);
});
