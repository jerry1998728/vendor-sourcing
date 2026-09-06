import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";

process.env.RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-sourcing-test-runs-"));

import { createDb, runs, vendors } from "@/lib/db";
import { findActiveRun, isCancelRequested, markInterruptedRuns, requestCancel, runStatus } from "@/lib/db/queries";
import { createRefresh, executeRefresh } from "@/lib/pipeline/refresh";
import { writeNormalizedVendor } from "@/lib/pipeline/run";
import type { NormalizeResult, SourceAdapter, VendorCandidate } from "@/lib/pipeline/types";
import { loadRuleset } from "@/lib/rulesets/loader";

test("boot cleanup fails unfinished runs regardless of age; finished runs untouched", () => {
  const db = createDb(":memory:");
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  db.insert(runs).values({ run_id: "run_20260901_000000_aaaaaa", input_type: "web_search", adapter: "web_search_llm", vendor_type: "ego_data", query: { config: "ego_data_stereo" }, ruleset_version: "r@v1", started_at: old, counts: { progress: { phase: "normalizing", step: 2, total: 5 } } }).run();
  db.insert(runs).values({ run_id: "run_20260901_000000_bbbbbb", input_type: "web_search", adapter: "web_search_llm", vendor_type: "ego_data", query: { config: "ego_data_stereo" }, ruleset_version: "r@v1", started_at: old, finished_at: old, counts: { progress: { phase: "done" } } }).run();
  // no time window any more: a two-day-old unfinished run still counts as active
  assert.equal(findActiveRun("ego_data_stereo", db)?.run_id, "run_20260901_000000_aaaaaa");
  assert.equal(markInterruptedRuns(db), 1);
  const a = db.select().from(runs).where(eq(runs.run_id, "run_20260901_000000_aaaaaa")).get()!;
  assert.ok(a.finished_at);
  assert.equal(runStatus(a), "failed");
  assert.match(a.counts.progress?.error ?? "", /interrupted/);
  assert.equal(a.counts.progress?.step, 2); // progress preserved for the runs list
  assert.equal(findActiveRun("ego_data_stereo", db), undefined);
  assert.equal(markInterruptedRuns(db), 0);
});

test("cancel: flag is honoured between vendors and the run finishes as cancelled", async () => {
  const db = createDb(":memory:");
  const now = new Date().toISOString();
  const run = db.insert(runs).values({ run_id: "run_20260901_000000_cccccc", input_type: "web_search", adapter: "web_search_llm", vendor_type: "ego_data", query: { config: "ego_data_stereo" }, ruleset_version: "ego_data_supplier@v1", started_at: now, finished_at: now }).returning().get();
  const ruleset = loadRuleset("ego_data_supplier@v1");
  const candidate = (id: string): NormalizeResult & { vendor: VendorCandidate } => ({
    page_type: "vendor_site",
    vendor: { vendor_id: id, name: id, vendor_type: "ego_data", primary_domain: id, contact_email: null, registration_country: null, ownership_country: null, parent_entity: null, collection_countries: [], discovered_via: "web_search_llm" },
    evidence: [],
    tags: [],
    mentioned_vendors: [],
    raw: {},
  });
  for (const id of ["a.example", "b.example", "c.example"]) writeNormalizedVendor(db, run, ruleset, candidate(id));
  let refreshed = 0;
  const adapter: SourceAdapter = {
    name: "web_search_llm",
    vendorTypes: ["ego_data"],
    discover: async () => [],
    normalize: async () => candidate("a.example"),
    refresh: async (vendor) => {
      refreshed += 1;
      return candidate(vendor.vendor_id);
    },
  };
  const refresh = createRefresh("ego_data_stereo", { vendorIds: ["a.example", "b.example", "c.example"] }, db);
  assert.equal(isCancelRequested(refresh.run_id, db), false);
  assert.ok(requestCancel(refresh.run_id, db));
  assert.equal(isCancelRequested(refresh.run_id, db), true);
  const done = await executeRefresh(refresh.run_id, db, { adapter });
  assert.equal(runStatus(done), "cancelled");
  assert.equal(refreshed, 0);
  assert.equal(requestCancel(refresh.run_id, db), undefined); // finished runs cannot be cancelled
  assert.equal(db.select().from(vendors).all().length, 3);
});
