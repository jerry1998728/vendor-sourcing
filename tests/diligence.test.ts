import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { createDb, events, runs, vendors } from "@/lib/db";
import type { EvidenceRow } from "@/lib/db/schema";
import type { DiligenceItem } from "@/lib/pipeline/screen";
import { loadRuleset } from "@/lib/rulesets/loader";
import {
  DILIGENCE_PREFIX,
  DiligenceError,
  diligenceErrorStatus,
  diligenceItemsFor,
  diligenceStatus,
  listDiligenceEvidence,
  recordDiligence,
} from "@/lib/track/diligence";

const now = "2026-09-08T00:00:00.000Z";

function seed() {
  const db = createDb(":memory:");
  db.insert(runs)
    .values({ run_id: "run_20260901_000000_aaaaaa", input_type: "web_search", adapter: "web_search_llm", vendor_type: "ego_data", query: {}, ruleset_version: "ego_data_supplier@v1", started_at: now, finished_at: now, counts: {} })
    .run();
  db.insert(vendors)
    .values({ vendor_id: "acme.example", name: "Acme", vendor_type: "ego_data", status: "In Discussion", diligence_stage: "responded", discovered_at: now, updated_at: now, first_seen_run_id: "run_20260901_000000_aaaaaa" })
    .run();
  return db;
}

const item = (id: string, required = false): DiligenceItem => ({ id, category: "technical", label: id, required });
const row = (field_path: string, value: string, verified: boolean, evidence_id: number): EvidenceRow =>
  ({ evidence_id, vendor_id: "acme.example", field_path, value, source_url: null, snippet: null, extraction_method: "manual", confidence: 1, proxy: false, verified, attested_by: null, observed_at: now }) as EvidenceRow;

test("the checklist comes from the vendor's ruleset, and every shipped ruleset defines one", () => {
  const db = seed();
  const vendor = db.select().from(vendors).get()!;
  const items = diligenceItemsFor(vendor, db);
  assert.equal(items.length, loadRuleset("ego_data_supplier@v1").diligence.length);
  assert.ok(items.some((i) => i.id === "pricing_received" && i.required));
  for (const ref of ["ego_data_supplier@v1", "repo_owner@v1", "code_data_broker@v1"]) {
    const d = loadRuleset(ref).diligence;
    assert.ok(d.length >= 6, `${ref} has ${d.length} diligence items`);
    assert.equal(new Set(d.map((i) => i.id)).size, d.length, `${ref} has duplicate item ids`);
  }
});

test("only the latest answer per item counts, and only when it is verified", () => {
  const items = [item("a", true), item("b"), item("c")];
  const status = diligenceStatus(items, [
    row(`${DILIGENCE_PREFIX}a`, "fail", true, 1),
    row(`${DILIGENCE_PREFIX}a`, "pass", true, 2), // the later answer wins
    row(`${DILIGENCE_PREFIX}b`, "pass", false, 3), // recorded but unverified
    row("sensor_rig", "stereo", true, 4), // not a diligence row
  ]);
  assert.equal(status.done, 1);
  assert.equal(status.total, 3);
  assert.equal(status.required_done, 1);
  assert.equal(status.required_total, 1);
  assert.equal(status.answers[0].value, "pass");
  assert.equal(status.answers[1].value, "pass");
  assert.equal(status.answers[1].verified, false);
  assert.equal(status.answers[2].value, null);
  assert.deepEqual(status.by_category, [{ category: "technical", done: 1, total: 3 }]);
});

test("recording: a source or an attestation makes an answer count, neither leaves it unverified", () => {
  const db = seed();

  const unverified = recordDiligence("acme.example", { item_id: "sample_reviewed", value: "pass", note: "looked at a clip" }, db);
  assert.equal(unverified.done, 0, "no source and no attestation: recorded, not counted");
  assert.equal(unverified.answers.find((a) => a.item.id === "sample_reviewed")?.note, "looked at a clip");

  const withSource = recordDiligence("acme.example", { item_id: "sample_reviewed", value: "pass", source_url: "https://acme.example/sample" }, db);
  assert.equal(withSource.done, 1);
  assert.equal(withSource.answers.find((a) => a.item.id === "sample_reviewed")?.source_url, "https://acme.example/sample");

  const attested = recordDiligence("acme.example", { item_id: "pricing_received", value: "pass", attested_by: "jerry@example.com" }, db);
  assert.equal(attested.done, 2);
  assert.equal(attested.required_done, 2, "sample_reviewed and pricing_received are both required");
  assert.equal(attested.answers.find((a) => a.item.id === "pricing_received")?.attested_by, "jerry@example.com");

  // Three evidence rows, newest first; the vendor's status never moved.
  assert.equal(listDiligenceEvidence("acme.example", db).length, 3);
  assert.equal(db.select().from(vendors).get()?.status, "In Discussion");
});

test("every answer writes an informational event that names the item and the result", () => {
  const db = seed();
  recordDiligence("acme.example", { item_id: "consent_and_pii", value: "fail", source_url: "https://acme.example/policy" }, db);
  const rows = db.select().from(events).where(eq(events.vendor_id, "acme.example")).all();
  assert.equal(rows.length, 1);
  const [event] = rows;
  assert.equal(event.from_status, event.to_status, "informational: the status does not change");
  assert.equal(event.actor, "human");
  assert.match(event.reason ?? "", /Consent and PII handling confirmed — fail/);
  assert.equal(event.evidence_ref, "https://acme.example/policy");
  assert.equal((event.payload as { diligence_item?: string }).diligence_item, "consent_and_pii");
});

test("unknown vendors and items are rejected with a typed error", () => {
  const db = seed();
  assert.throws(() => recordDiligence("nope.example", { item_id: "sample_reviewed", value: "pass" }, db), (err: DiligenceError) => err.code === "vendor_not_found");
  assert.throws(() => recordDiligence("acme.example", { item_id: "not_a_check", value: "pass" }, db), (err: DiligenceError) => err.code === "unknown_item");
  assert.equal(diligenceErrorStatus("vendor_not_found"), 404);
  assert.equal(diligenceErrorStatus("unknown_item"), 422);
  assert.equal(diligenceErrorStatus("no_ruleset"), 409);
});
