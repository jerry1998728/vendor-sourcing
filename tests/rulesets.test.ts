import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RulesetExistsError, listRulesets, loadRuleset, readRulesetYaml, writeRuleset } from "@/lib/rulesets/loader";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-sourcing-test-rulesets-"));

test("writeRuleset: a clone of the shipped ego ruleset round-trips under its new name, comments kept", () => {
  const yaml = readRulesetYaml("ego_data_supplier@v1");
  const summary = writeRuleset({ name: "ego_demo", version: "v1", yaml }, dir);
  assert.equal(summary.ref, "ego_demo@v1");
  assert.equal(summary.valid, true);
  assert.equal(summary.vendor_type, "ego_data");

  const loaded = loadRuleset("ego_demo@v1", dir);
  assert.equal(loaded.name, "ego_demo");
  assert.equal(loaded.ruleset_version, "ego_demo@v1");
  assert.ok(loaded.must.length >= 1 && loaded.fields.length >= 1);
  assert.deepEqual(listRulesets(dir).map((r) => r.ref), ["ego_demo@v1"]);

  const text = fs.readFileSync(path.join(dir, "ego_demo.v1.yaml"), "utf8");
  assert.match(text, /^# rulesets\/ego_demo\.v1\.yaml — created from the Vendor Source page/);
  assert.match(text, /\nname: ego_demo\nversion: v1\n/);
  assert.match(text, /# Extraction catalog/); // the source file's comments survive the clone
});

test("writeRuleset: version bump of an existing name is a new file; the same ref is refused", () => {
  const yaml = readRulesetYaml("ego_demo@v1", dir);
  assert.equal(writeRuleset({ name: "ego_demo", version: "v2", yaml }, dir).ref, "ego_demo@v2");
  assert.throws(() => writeRuleset({ name: "ego_demo", version: "v1", yaml }, dir), RulesetExistsError);
});

test("writeRuleset: bad names, versions, YAML and schema violations are rejected with a reason", () => {
  const yaml = readRulesetYaml("repo_owner@v1");
  assert.throws(() => writeRuleset({ name: "Bad Name", version: "v1", yaml }, dir), /invalid ruleset name/);
  assert.throws(() => writeRuleset({ name: "x_y", version: "1", yaml }, dir), /invalid version/);
  assert.throws(() => writeRuleset({ name: "x_y", version: "v1", yaml: "must: [\nfoo" }, dir), /YAML does not parse/);
  assert.throws(() => writeRuleset({ name: "x_y", version: "v1", yaml: "- just\n- a list\n" }, dir), /YAML does not parse/); // name/version are prepended, a list cannot follow
  assert.throws(() => writeRuleset({ name: "x_y", version: "v1", yaml: "vendor_type: ego_data\nmust: []\n" }, dir), /invalid ruleset: must/);
  assert.throws(() => writeRuleset({ name: "x_y", version: "v1", yaml: "vendor_type: nope\nmust:\n  - field_path: a\n    op: present\n" }, dir), /vendor_type/);
  assert.throws(() => readRulesetYaml("missing@v9", dir), /not found/);
  assert.deepEqual(listRulesets(dir).map((r) => r.ref), ["ego_demo@v1", "ego_demo@v2"]);
});
