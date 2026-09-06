import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvidenceRow, Run, TagRow, Vendor } from "@/lib/db/schema";
import type { Evidence, NormalizeResult, Tag, VendorCandidate } from "@/lib/pipeline/types";
import { planVendorWrite, type ExistingVendorState } from "@/lib/pipeline/write";

const now = "2026-09-07T00:00:00.000Z";
const run = { run_id: "run_20260901_000000_000001" } as Run;
const candidate: VendorCandidate = {
  vendor_id: "acme.example",
  name: "Acme",
  vendor_type: "ego_data",
  primary_domain: "acme.example",
  contact_email: null,
  registration_country: null,
  ownership_country: null,
  parent_entity: null,
  collection_countries: [],
  discovered_via: "web_search_llm",
};
const ev = (field_path: string, value: string | null, url: string | null = "https://acme.example/", verified = value !== null): Evidence => ({
  field_path,
  value,
  source_url: url,
  snippet: value ? `${field_path} ${value}` : null,
  extraction_method: "llm",
  confidence: 0.9,
  proxy: false,
  verified,
  attested_by: null,
  observed_at: now,
});
const row = (evidence_id: number, e: Evidence): EvidenceRow => ({ evidence_id, vendor_id: "acme.example", ...e, attested_by: null }) as EvidenceRow;
const tag = (dimension: Tag["dimension"], value: string, source_badge: Tag["source_badge"], evidence_index: number | null): Tag => ({ dimension, value, source_badge, evidence_index });
const result = (evidence: Evidence[], tags: Tag[] = []): NormalizeResult & { vendor: VendorCandidate } => ({
  page_type: "vendor_site",
  vendor: candidate,
  evidence,
  tags,
  mentioned_vendors: [],
  raw: {},
});
const empty: ExistingVendorState = { vendor: null, evidence: [], tags: [] };

test("new vendor: insert the row, every evidence row and every tag", () => {
  const plan = planVendorWrite(empty, result([ev("sensor_rig", "stereo"), ev("ownership_country", null, null)], [tag("sensor_rig", "stereo", "verified", 0)]), run, now);
  assert.equal(plan.is_new, true);
  assert.equal(plan.vendor_insert?.first_seen_run_id, run.run_id);
  assert.deepEqual(plan.evidence.map((o) => o.op), ["insert", "insert"]); // the placeholder stays: nothing supersedes it
  assert.deepEqual(plan.placeholder_deletes, []);
  assert.deepEqual(plan.tags, [{ op: "insert", tag: tag("sensor_rig", "stereo", "verified", 0) }]);
});

test("same claim twice in one result: one insert, and a verified repeat upgrades it", () => {
  const plan = planVendorWrite(empty, result([ev("sensor_rig", "stereo", "https://acme.example/", false), ev("sensor_rig", "stereo")], [tag("sensor_rig", "stereo", "verified", 1)]), run, now);
  assert.equal(plan.evidence[0].op, "insert");
  assert.equal(plan.evidence[0].op === "insert" && plan.evidence[0].row.verified, true);
  assert.deepEqual(plan.evidence[1], { op: "skip", index: 1, reason: "duplicate_in_batch", of: 0 });
});

test("existing row: refresh, and upgrade to verified when the new claim is grounded", () => {
  const existing: ExistingVendorState = {
    vendor: { vendor_id: "acme.example", status: "Screened" } as Vendor,
    evidence: [row(7, ev("sensor_rig", "stereo", "https://acme.example/", false))],
    tags: [],
  };
  const plan = planVendorWrite(existing, result([ev("sensor_rig", "stereo")]), run, now);
  assert.equal(plan.is_new, false);
  assert.equal(plan.vendor_insert, null);
  assert.deepEqual(plan.evidence, [{ op: "refresh", index: 0, evidence_id: 7, upgrade: { snippet: "sensor_rig stereo", confidence: 0.9, proxy: false } }]);
});

test("placeholders: a stored not-found row is deleted once a value arrives; a new placeholder for a valued field is skipped", () => {
  const existing: ExistingVendorState = { vendor: null, evidence: [row(3, ev("ownership_country", null, null))], tags: [] };
  const plan = planVendorWrite(existing, result([ev("ownership_country", "DE"), ev("registration_country", "DE"), ev("registration_country", null, null)]), run, now);
  assert.deepEqual(plan.placeholder_deletes, ["ownership_country"]);
  assert.deepEqual(plan.evidence.map((o) => o.op), ["insert", "insert", "skip"]);
  assert.equal(plan.evidence[2].op === "skip" && plan.evidence[2].reason, "placeholder_superseded");
});

test("tags: a stronger badge wins; a weaker badge only adds a missing evidence link and keeps the stronger badge", () => {
  const t = (tag_id: number, source_badge: TagRow["source_badge"], evidence_id: number | null): TagRow => ({
    tag_id,
    vendor_id: "acme.example",
    dimension: "sensor_rig",
    value: "stereo",
    source_badge,
    evidence_id,
    updated_at: now,
  });
  const weaker = planVendorWrite({ vendor: null, evidence: [], tags: [t(1, "unknown", null)] }, result([ev("sensor_rig", "stereo")], [tag("sensor_rig", "stereo", "verified", 0)]), run, now);
  assert.deepEqual(weaker.tags, [{ op: "upgrade", tag_id: 1, source_badge: "verified", evidence_index: 0 }]);
  const stronger = planVendorWrite({ vendor: null, evidence: [], tags: [t(2, "verified", null)] }, result([ev("sensor_rig", "stereo")], [tag("sensor_rig", "stereo", "unknown", 0)]), run, now);
  assert.deepEqual(stronger.tags, [{ op: "upgrade", tag_id: 2, source_badge: "verified", evidence_index: 0 }]);
  const same = planVendorWrite({ vendor: null, evidence: [], tags: [t(3, "verified", 9)] }, result([ev("sensor_rig", "stereo")], [tag("sensor_rig", "stereo", "manual", 0)]), run, now);
  assert.deepEqual(same.tags, []);
});
