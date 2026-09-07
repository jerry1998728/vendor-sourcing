import assert from "node:assert/strict";
import { test } from "node:test";

import { createDb, events, interactions, proposals, runs, vendors } from "@/lib/db";
import { funnelReached, runHistory, sidebarCounts } from "@/lib/db/metrics";
import { listSendable } from "@/lib/db/queries";
import type { VendorStatus } from "@/lib/db/schema";

const now = "2026-09-06T00:00:00.000Z";

function vendor(db: ReturnType<typeof createDb>, id: string, status: VendorStatus, coverage: number | null = null) {
  db.insert(vendors).values({ vendor_id: id, name: id, vendor_type: "ego_data", status, coverage_confidence: coverage, discovered_at: now, updated_at: now }).run();
}

function move(db: ReturnType<typeof createDb>, vendorId: string, path: VendorStatus[]) {
  for (let i = 1; i < path.length; i += 1) {
    db.insert(events).values({ vendor_id: vendorId, from_status: path[i - 1], to_status: path[i], actor: "system", created_at: `2026-09-0${i}T00:00:00.000Z` }).run();
  }
}

test("funnelReached: distinct vendors per status from the event log, next to the vendors there now", () => {
  const db = createDb(":memory:");
  vendor(db, "a", "Contacted");
  vendor(db, "b", "Screened");
  vendor(db, "c", "Identified");
  move(db, "a", ["Identified", "Screened", "Qualified", "Contacted"]);
  move(db, "b", ["Identified", "Screened"]);
  const steps = funnelReached(db);
  assert.deepEqual(
    steps.map((s) => [s.status, s.reached, s.current]),
    [
      ["Identified", 3, 1],
      ["Screened", 2, 1],
      ["Qualified", 1, 0],
      ["Contacted", 1, 1],
      ["Replied", 0, 0],
      ["In Discussion", 0, 0],
      ["Approved", 0, 0],
    ],
  );
});

test("runHistory: finished discovery runs only, oldest first, refreshes and failed runs excluded", () => {
  const db = createDb(":memory:");
  const run = (run_id: string, input_type: "web_search" | "github" | "refresh", started_at: string, counts: Record<string, unknown>, config = "cfg") =>
    db.insert(runs).values({ run_id, input_type, adapter: input_type, vendor_type: "ego_data", query: { config }, ruleset_version: "x@v1", started_at, finished_at: started_at, counts }).run();
  run("run_20260901_000000_aaaaaa", "web_search", "2026-09-01T00:00:00Z", { discovered: 3, pass: 2, unknown: 1, fail: 0, must_field_coverage: 0.8 }, "ego");
  run("run_20260902_000000_bbbbbb", "refresh", "2026-09-02T00:00:00Z", { refreshed: 2 });
  run("run_20260903_000000_cccccc", "web_search", "2026-09-03T00:00:00Z", { progress: { phase: "failed" } });
  run("run_20260904_000000_dddddd", "github", "2026-09-04T00:00:00Z", { discovered: 5, pass: 4, unknown: 0, fail: 1 }, "gh");
  db.insert(runs).values({ run_id: "run_20260905_000000_eeeeee", input_type: "web_search", adapter: "web_search_llm", vendor_type: "ego_data", query: {}, ruleset_version: "x@v1", started_at: "2026-09-05T00:00:00Z", finished_at: null, counts: {} }).run();
  const points = runHistory(10, db);
  assert.deepEqual(points.map((p) => [p.config, p.discovered, p.pass, p.unknown, p.fail, p.coverage]), [
    ["ego", 3, 2, 1, 0, 0.8],
    ["gh", 5, 4, 0, 1, null],
  ]);
  assert.equal(runHistory(1, db)[0].config, "gh");
});

test("listSendable and sidebarCounts: qualified plus follow-up drafts, review queue, pending proposals", () => {
  const db = createDb(":memory:");
  vendor(db, "q1", "Qualified", 0.9);
  vendor(db, "c1", "Contacted", 0.8);
  vendor(db, "c2", "Contacted", 0.7);
  vendor(db, "d1", "Dormant", 0.6);
  vendor(db, "s1", "Screened");
  const draft = (vendor_id: string, llm_summary: string) => db.insert(interactions).values({ vendor_id, direction: "draft", sent_at: null, subject: "s", body_text: "b", llm_summary }).run();
  draft("c1", "first contact; model=x");
  draft("c1", "follow_up_7d; model=x"); // the latest draft wins
  draft("c2", "first contact; model=x");
  draft("d1", "follow_up_14d; model=x");
  db.insert(proposals).values({ vendor_id: "c1", to_status: "In Discussion", to_stage: "quote_received", confidence: 0.9 }).run();

  const s = listSendable({}, db);
  assert.deepEqual(s.qualified.map((v) => v.vendor_id), ["q1"]);
  assert.deepEqual(s.followUps.map((v) => v.vendor_id), ["c1", "d1"]);
  assert.equal(s.drafts.get("c1")?.llm_summary, "follow_up_7d; model=x");
  assert.deepEqual(listSendable({ vendor_type: ["code_data"] }, db).qualified, []);

  assert.deepEqual(sidebarCounts(db), { "/database/review": 1, "/outreach/draft": 3, "/outreach/proposals": 1 });
});
