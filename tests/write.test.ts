import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { createDb, events, evidence, runs, tags, vendors, type Db, type Run } from "@/lib/db";
import { rebuildStatus } from "@/lib/db/state";
import { writeNormalizedVendor } from "@/lib/pipeline/run";
import type { Evidence, NormalizeResult, Tag, VendorCandidate } from "@/lib/pipeline/types";
import { loadRuleset } from "@/lib/rulesets/loader";

const ruleset = loadRuleset("ego_data_supplier@v1");

function makeRun(db: Db, id: string): Run {
  return db
    .insert(runs)
    .values({
      run_id: id,
      input_type: "web_search",
      adapter: "web_search_llm",
      vendor_type: "ego_data",
      query: { config: "ego_data_stereo" },
      ruleset_version: ruleset.ruleset_version,
      started_at: new Date().toISOString(),
    })
    .returning()
    .get();
}

const now = new Date().toISOString();
const ev = (
  field_path: string,
  value: string | null,
  o: Partial<Evidence> = {},
): Evidence => ({
  field_path,
  value,
  source_url: value === null ? null : "https://northlight-ego.example/about",
  snippet: value === null ? null : `We use ${value} rigs`,
  extraction_method: "llm",
  confidence: 0.9,
  proxy: false,
  verified: value !== null,
  attested_by: null,
  observed_at: now,
  ...o,
});

function candidate(): NormalizeResult & { vendor: VendorCandidate } {
  const evidenceRows: Evidence[] = [
    ev("sensor_rig", "stereo"),
    ev("sensor_rig", "imu", { confidence: 0.7 }),
    ev("registration_country", "DE", { proxy: true, confidence: 0.7 }),
    ev("ownership_country", null, { confidence: 0 }), // explicit unknown
    ev("ownership_country", "DE", { verified: false, source_url: null, snippet: null, confidence: 0.3 }), // guess, no snippet
    ev("collection_countries", "DE"),
    ev("collection_countries", "FR"),
    ev("scale", "1,200 hours"),
    ev("contact_email", "sales@northlight-ego.example"),
    ev("modality", "video"),
    {
      ...ev("source_channel", "web_search"),
      extraction_method: "api",
      source_url: "https://search.example/result",
      snippet: "Search result: Northlight",
      confidence: 1,
    },
  ];
  const tagRows: Tag[] = [
    { dimension: "sensor_rig", value: "stereo", source_badge: "verified", evidence_index: 0 },
    { dimension: "sensor_rig", value: "imu", source_badge: "verified", evidence_index: 1 },
    { dimension: "modality", value: "video", source_badge: "verified", evidence_index: 9 },
    { dimension: "scene_class", value: "urban", source_badge: "unknown", evidence_index: null },
    { dimension: "source_channel", value: "web_search", source_badge: "verified", evidence_index: 10 },
  ];
  return {
    page_type: "vendor_site",
    vendor: {
      vendor_id: "northlight-ego.example",
      name: "Northlight Ego",
      vendor_type: "ego_data",
      primary_domain: "northlight-ego.example",
      contact_email: "sales@northlight-ego.example",
      registration_country: "DE",
      ownership_country: null,
      parent_entity: null,
      collection_countries: ["DE", "FR"],
      discovered_via: "web_search_llm",
    },
    evidence: evidenceRows,
    tags: tagRows,
    mentioned_vendors: [],
    raw: {},
  };
}

test("write path: attributes are verified-only, must-fields have rows, Identified -> Screened", () => {
  const db = createDb(":memory:");
  const run = makeRun(db, "run_20260905_000000_aaaaaa");
  const out = writeNormalizedVendor(db, run, ruleset, candidate());
  assert.equal(out.is_new, true);
  assert.equal(out.result, "unknown"); // ownership_country not evidenced
  assert.deepEqual(out.unknown_must_fields, ["ownership_country"]);

  const v = db.select().from(vendors).where(eq(vendors.vendor_id, "northlight-ego.example")).get()!;
  assert.equal(v.status, "Screened");
  assert.equal(v.screen_result, "unknown");
  assert.equal(v.next_action, "outreach_to_verify");
  assert.equal(v.first_seen_run_id, run.run_id);
  assert.equal(v.registration_country, "DE");
  assert.equal(v.ownership_country, null); // unverified guess never promoted
  assert.deepEqual(v.collection_countries, ["DE", "FR"]);
  assert.deepEqual(v.attributes.sensor_rig, ["stereo", "imu"]);
  assert.equal(v.attributes.registration_country, "DE");
  assert.equal("ownership_country" in v.attributes, false);
  assert.equal(v.attributes.contact_email, "sales@northlight-ego.example");
  assert.ok(v.last_verified_at);

  const rows = db.select().from(evidence).where(eq(evidence.vendor_id, v.vendor_id)).all();
  for (const must of ruleset.must) {
    assert.ok(rows.some((r) => r.field_path === must.field_path), `evidence row for ${must.field_path}`);
  }
  // the unverified guess keeps the must-field's row; no verified row exists for it
  const ownership = rows.filter((r) => r.field_path === "ownership_country");
  assert.ok(ownership.length >= 1);
  assert.ok(ownership.every((r) => !r.verified));
  for (const [field, value] of Object.entries(v.attributes)) {
    for (const val of Array.isArray(value) ? value : [value]) {
      assert.ok(
        rows.some((r) => r.field_path === field && r.value === val && r.verified),
        `attribute ${field}=${val} is backed by verified evidence`,
      );
    }
  }

  const tagRows = db.select().from(tags).where(eq(tags.vendor_id, v.vendor_id)).all();
  assert.equal(tagRows.length, 5);
  assert.equal(tagRows.find((t) => t.dimension === "scene_class")?.source_badge, "unknown");
  assert.ok(tagRows.find((t) => t.dimension === "sensor_rig" && t.value === "stereo")?.evidence_id);

  const evs = db.select().from(events).where(eq(events.vendor_id, v.vendor_id)).all();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].actor, "system");
  assert.equal(evs[0].reason, "screened:unknown");
  assert.equal(rebuildStatus(v.vendor_id, db).status, "Screened");
});

test("re-run creates no duplicates and new verified evidence upgrades the screen", () => {
  const db = createDb(":memory:");
  const run1 = makeRun(db, "run_20260905_000000_aaaaaa");
  writeNormalizedVendor(db, run1, ruleset, candidate());
  const count = () => ({
    evidence: db.select().from(evidence).all().length,
    tags: db.select().from(tags).all().length,
    events: db.select().from(events).all().length,
    vendors: db.select().from(vendors).all().length,
  });
  const before = count();

  const run2 = makeRun(db, "run_20260905_000001_bbbbbb");
  const again = writeNormalizedVendor(db, run2, ruleset, candidate());
  assert.equal(again.is_new, false);
  assert.deepEqual(count(), before);
  const v = db.select().from(vendors).where(eq(vendors.vendor_id, "northlight-ego.example")).get()!;
  assert.equal(v.first_seen_run_id, run1.run_id);
  assert.equal(v.status, "Screened");

  // A later run finds the ownership statement: placeholder goes, attributes gain it, result -> pass.
  const c = candidate();
  c.evidence.push(ev("ownership_country", "DE", { snippet: "We are a privately held company in Berlin", proxy: true, confidence: 0.7 }));
  const run3 = makeRun(db, "run_20260905_000002_cccccc");
  const third = writeNormalizedVendor(db, run3, ruleset, c);
  assert.equal(third.result, "pass");
  const v3 = db.select().from(vendors).where(eq(vendors.vendor_id, "northlight-ego.example")).get()!;
  assert.equal(v3.screen_result, "pass");
  assert.equal(v3.attributes.ownership_country, "DE");
  assert.equal(v3.next_action, "review");
  const rows = db.select().from(evidence).where(eq(evidence.vendor_id, v3.vendor_id)).all();
  assert.equal(rows.filter((r) => r.field_path === "ownership_country" && r.value === null).length, 0);
  assert.equal(db.select().from(events).all().length, 1); // still one transition
  assert.equal(rebuildStatus(v3.vendor_id, db).status, "Screened");
});

test("verified evidence failing a must threshold screens as fail", () => {
  const db = createDb(":memory:");
  const run = makeRun(db, "run_20260905_000000_aaaaaa");
  const c = candidate();
  c.evidence = c.evidence.map((e) =>
    e.field_path === "registration_country" ? { ...e, value: "CN", snippet: "Registered in Shenzhen, CN" } : e,
  );
  const out = writeNormalizedVendor(db, run, ruleset, c);
  assert.equal(out.result, "fail");
  const v = db.select().from(vendors).where(eq(vendors.vendor_id, "northlight-ego.example")).get()!;
  assert.equal(v.status, "Screened");
  assert.equal(v.next_action, "review");
  assert.equal(v.registration_country, "CN");
});
