import assert from "node:assert/strict";
import { test } from "node:test";

import { screen, type EvidenceLike } from "@/lib/pipeline/screen";
import { loadRuleset } from "@/lib/rulesets/loader";

const ruleset = loadRuleset("ego_data_supplier@v1");
const vendor = { vendor_id: "acme.example", name: "Acme", vendor_type: "ego_data" };

const ev = (
  field_path: string,
  value: string | null,
  verified = true,
  confidence = 0.9,
  evidence_id?: number,
): EvidenceLike => ({ field_path, value, verified, confidence, evidence_id });

test("all must-fields verified and passing -> pass, should score counts diversity", () => {
  const out = screen(
    vendor,
    [
      ev("sensor_rig", "stereo", true, 0.95, 1),
      ev("sensor_rig", "imu", true, 0.8, 2),
      ev("registration_country", "DE", true, 0.9, 3),
      ev("ownership_country", "DE", true, 0.7, 4),
      ev("collection_countries", "DE"),
      ev("collection_countries", "FR"),
      ev("collection_countries", "ES"),
      ev("scale", "1,200 hours"),
    ],
    ruleset,
  );
  assert.equal(out.result, "pass");
  assert.equal(out.mustFieldCoverage, 1);
  assert.equal(out.coverageConfidence, 0.85);
  assert.equal(out.shouldScore, 1);
  assert.deepEqual(out.unknownMustFields, []);
  assert.deepEqual(out.reasons.find((r) => r.rule_id === "stereo_rig")?.evidence_ids, [1, 2]);
});

test("verified evidence failing a threshold -> fail even when other fields are unknown", () => {
  const out = screen(
    vendor,
    [ev("sensor_rig", "mono"), ev("registration_country", "CN")],
    ruleset,
  );
  assert.equal(out.result, "fail");
  assert.equal(out.reasons.find((r) => r.rule_id === "stereo_rig")?.outcome, "fail");
  assert.equal(out.reasons.find((r) => r.rule_id === "registered_outside_china")?.outcome, "fail");
  assert.equal(out.reasons.find((r) => r.rule_id === "owned_outside_china")?.outcome, "unknown");
});

test("missing or unverified must-field -> unknown, never fail", () => {
  const out = screen(
    vendor,
    [
      ev("sensor_rig", "stereo"),
      ev("registration_country", "US"),
      ev("ownership_country", "CN", false), // unverified: must not count
      ev("ownership_country", null, false),
    ],
    ruleset,
  );
  assert.equal(out.result, "unknown");
  assert.deepEqual(out.unknownMustFields, ["ownership_country"]);
  assert.equal(out.mustFieldCoverage, 0.667);
  assert.equal(out.shouldScore, 0);
});

test("ruleset / vendor type mismatch throws", () => {
  assert.throws(() => screen({ ...vendor, vendor_type: "code_data" }, [], ruleset), /is for ego_data/);
});
