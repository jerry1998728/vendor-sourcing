import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFiltersToParams, countActiveFilters, listVendorsFiltered, parseVendorFilters } from "@/lib/db/filters";
import { createDb, runs, tags, vendors } from "@/lib/db";

test("filters round-trip through URL params", () => {
  const f = parseVendorFilters({
    q: "north",
    vendor_type: "ego_data",
    screen_result: "pass,unknown,bogus",
    status: "Screened",
    owner: "a@x.com,none",
    country: "de, fr,zz1",
    country_mode: "not_in",
    coverage_min: "50",
    coverage_max: "100",
    stale: "1",
    "tag.sensor_rig": "stereo,imu",
    "tag.not_a_dimension": "x",
  });
  assert.deepEqual(f.screen_result, ["pass", "unknown"]);
  assert.deepEqual(f.country, ["DE", "FR"]);
  assert.equal(f.country_mode, "not_in");
  assert.equal(f.coverage_min, 50);
  assert.equal(f.coverage_max, undefined); // 100 is the default upper bound
  assert.deepEqual(f.tags, { sensor_rig: ["stereo", "imu"] });
  assert.equal(countActiveFilters(f), 9);
  const params = applyFiltersToParams(f, new URLSearchParams("tab=vendors"));
  assert.equal(params.get("tab"), "vendors");
  assert.equal(params.get("tag.sensor_rig"), "stereo,imu");
  assert.deepEqual(parseVendorFilters(Object.fromEntries(params.entries())), f);
});

test("filtered query applies tags, country mode, stale and owner", () => {
  const db = createDb(":memory:");
  const now = new Date().toISOString();
  db.insert(runs).values({ run_id: "run_x", input_type: "manual", adapter: "t", vendor_type: "ego_data", query: {}, ruleset_version: "r@v1", started_at: now }).run();
  const mk = (id: string, o: Partial<typeof vendors.$inferInsert>) =>
    db.insert(vendors).values({ vendor_id: id, name: id, vendor_type: "ego_data", discovered_at: now, updated_at: now, discovered_via: "web_search", ...o }).run();
  mk("a.example", { registration_country: "DE", owner: "me", coverage_confidence: 0.9, last_verified_at: now, status: "Screened" });
  mk("b.example", { registration_country: "CN", coverage_confidence: 0.4, last_verified_at: new Date(Date.now() - 40 * 86_400_000).toISOString(), status: "Qualified" });
  mk("c.example", { registration_country: null, coverage_confidence: null, status: "Screened" });
  db.insert(tags).values([
    { vendor_id: "a.example", dimension: "sensor_rig", value: "stereo", source_badge: "verified", updated_at: now },
    { vendor_id: "b.example", dimension: "sensor_rig", value: "mono", source_badge: "verified", updated_at: now },
  ]).run();
  const ids = (f: Parameters<typeof listVendorsFiltered>[0]) => listVendorsFiltered(f, db).map((v) => v.vendor_id).sort();
  assert.deepEqual(ids({}), ["a.example", "b.example", "c.example"]);
  assert.deepEqual(ids({ tags: { sensor_rig: ["stereo"] } }), ["a.example"]);
  assert.deepEqual(ids({ country: ["CN"], country_mode: "in" }), ["b.example"]);
  assert.deepEqual(ids({ country: ["CN"], country_mode: "not_in" }), ["a.example", "c.example"]);
  assert.deepEqual(ids({ stale: true }), ["b.example", "c.example"]);
  assert.deepEqual(ids({ owner: ["none"] }), ["b.example", "c.example"]);
  assert.deepEqual(ids({ owner: ["me"] }), ["a.example"]);
  assert.deepEqual(ids({ coverage_min: 50 }), ["a.example"]);
  assert.deepEqual(ids({ status: ["Qualified"], q: "b." }), ["b.example"]);
});
