import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// importManualCsv() persists a run folder; keep it out of data/runs during tests.
process.env.RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-sourcing-test-runs-"));
import { eq } from "drizzle-orm";

import { createDb, evidence, tags, vendors } from "@/lib/db";
import { importManualCsv, manualTemplateColumns, manualTemplateCsv, parseCsv } from "@/lib/pipeline/manual";
import { loadRuleset } from "@/lib/rulesets/loader";

test("parseCsv handles quotes, escaped quotes, embedded newlines and CRLF", () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"multi\nline",\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "x, y", 'he said "hi"'], ["2", "multi\nline", ""]]);
});

test("template columns cover must-fields, catalog fields and tag dimensions", () => {
  const ruleset = loadRuleset("ego_data_supplier@v1");
  const cols = manualTemplateColumns(ruleset, "ego_data");
  for (const c of ["name", "primary_domain", "sensor_rig", "registration_country", "ownership_country", "scene_class", "licensing_model", "source_url", "attestation"]) {
    assert.ok(cols.includes(c), c);
  }
  const csv = manualTemplateCsv(ruleset, "ego_data");
  assert.equal(parseCsv(csv).length, 2);
});

test("manual rows: verified only with source_url or attestation, badges manual/unknown, must placeholders", () => {
  const db = createDb(":memory:");
  const csv = [
    "name,primary_domain,sensor_rig,registration_country,ownership_country,collection_countries,scene_class,scale,source_url,attestation",
    "Alpha Ego,alpha-ego.example,stereo|imu,DE,DE,DE|FR|ES,urban|night,900 hours,https://alpha-ego.example/about,false",
    "Beta Wearables,beta-wear.example,stereo,US,,US,indoor,,,true",
    "Gamma Mono,gamma.example,mono,GB,GB,GB,urban,,,false",
    "Delta Unknown,delta.example,,,,,,,,false",
    ",nodomain.example,stereo,,,,,,,false",
  ].join("\n");
  const out = importManualCsv(csv, { vendorType: "ego_data", rulesetRef: "ego_data_supplier@v1", uploader: "tester@example.com", attestAll: false }, db);
  assert.equal(out.run.input_type, "manual");
  assert.equal(out.rows.length, 5);
  assert.equal(out.rows[4].error, "name is required");
  assert.equal(out.counts.normalized, 4);
  const byId = (id: string) => db.select().from(vendors).where(eq(vendors.vendor_id, id)).get()!;

  const alpha = byId("alpha-ego.example");
  assert.equal(alpha.screen_result, "pass");
  assert.equal(alpha.status, "Screened");
  assert.deepEqual(alpha.attributes.sensor_rig, ["stereo", "imu"]);
  assert.deepEqual(alpha.collection_countries, ["DE", "FR", "ES"]);
  const alphaTags = db.select().from(tags).where(eq(tags.vendor_id, "alpha-ego.example")).all();
  assert.ok(alphaTags.every((t) => t.source_badge === "manual"));

  const beta = byId("beta-wear.example");
  assert.equal(beta.screen_result, "unknown"); // ownership not given
  assert.equal(beta.registration_country, "US"); // attested -> verified
  const betaEv = db.select().from(evidence).where(eq(evidence.vendor_id, "beta-wear.example")).all();
  assert.ok(betaEv.some((e) => e.field_path === "ownership_country" && e.value === null));
  assert.ok(betaEv.filter((e) => e.field_path === "registration_country").every((e) => e.attested_by === "tester@example.com"));

  const gamma = byId("gamma.example");
  assert.equal(gamma.screen_result, "unknown"); // no URL, no attestation -> nothing verified, nothing fails
  assert.equal(gamma.registration_country, null);
  const gammaTags = db.select().from(tags).where(eq(tags.vendor_id, "gamma.example")).all();
  assert.ok(gammaTags.filter((t) => t.dimension === "sensor_rig").every((t) => t.source_badge === "unknown"));

  const delta = byId("delta.example");
  assert.equal(delta.screen_result, "unknown");
  const deltaEv = db.select().from(evidence).where(eq(evidence.vendor_id, "delta.example")).all();
  for (const fp of ["sensor_rig", "registration_country", "ownership_country"]) {
    assert.ok(deltaEv.some((e) => e.field_path === fp && e.value === null), fp);
  }
});
