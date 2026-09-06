import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvidenceRow } from "@/lib/db/schema";
import { isAllowedRecipient, normalizeEmail, parseAllowlist } from "@/lib/outreach/allowlist";
import { buildDraftPrompt, checkDraft } from "@/lib/outreach/draft";
import { buildRawMessage, encodeHeader, extractPlainText, toThreadMessage } from "@/lib/outreach/gmail";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("raw message: base64url RFC 2822, encoded subject, base64 body round-trips", () => {
  const raw = buildRawMessage({ to: "a@example.com", subject: "Stereo rigs — quick question", body: "Hello\n\nWorld" });
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  assert.match(decoded, /^To: a@example\.com\r\n/);
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
  assert.match(decoded, /Content-Type: text\/plain; charset="UTF-8"/);
  const bodyB64 = decoded.split("\r\n\r\n")[1];
  assert.equal(Buffer.from(bodyB64, "base64").toString("utf8"), "Hello\n\nWorld");
  assert.equal(encodeHeader("plain ascii"), "plain ascii");
  assert.equal(encodeHeader("line\r\nbreak"), "line break");
});

test("allowlist: parsing, exact case-insensitive matching, empty list allows nobody", () => {
  assert.deepEqual(parseAllowlist(" A@X.com, b@y.org;c@z.net not-an-email "), ["a@x.com", "b@y.org", "c@z.net"]);
  assert.equal(isAllowedRecipient("Jerry <A@x.com>", ["a@x.com"]), true);
  assert.equal(isAllowedRecipient("a@x.com", []), false);
  assert.equal(isAllowedRecipient("other@x.com", ["a@x.com"]), false);
  assert.equal(parseAllowlist(undefined).length, 0);
  assert.equal(normalizeEmail("Name <Foo@Bar.com>"), "foo@bar.com");
});

test("thread messages: plain text preferred over html, nested parts, SENT label", () => {
  const nested = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "multipart/related", parts: [{ mimeType: "text/plain", body: { data: b64url("Thanks, we do stereo.") } }] },
      { mimeType: "text/html", body: { data: b64url("<p>Thanks, <b>we</b> do stereo.</p>") } },
    ],
  };
  assert.equal(extractPlainText(nested), "Thanks, we do stereo.");
  assert.equal(extractPlainText({ mimeType: "text/html", body: { data: b64url("<p>Only <i>html</i></p>") } }), "Only html");
  const msg = toThreadMessage({
    id: "m1",
    threadId: "t1",
    labelIds: ["SENT"],
    internalDate: "1700000000000",
    snippet: "s",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: "me@x.com" }, { name: "Subject", value: "Re: hi" }], body: { data: b64url("body") } },
  });
  assert.equal(msg.is_sent, true);
  assert.equal(msg.from, "me@x.com");
  assert.equal(msg.subject, "Re: hi");
  assert.equal(msg.body_text, "body");
  assert.equal(msg.internal_date, new Date(1700000000000).toISOString());
});

test("checkDraft: needs a real citation and a question per unknown must-field", () => {
  const evidence = [{ evidence_id: 1, field_path: "sensor_rig", value: "stereo" }, { evidence_id: 2, field_path: "registration_country", value: "DE" }] as unknown as EvidenceRow[];
  const ctx = { evidence, unknownMustFields: [{ field_path: "ownership_country", description: "Country of the ultimate owner" }], mustAsk: true };
  const body = "x".repeat(150);
  assert.equal(checkDraft({ subject: "s", body, cited_evidence_ids: [2, 99], asked_field_paths: ["Ownership_Country"] }, ctx).ok, true);
  const noCite = checkDraft({ subject: "s", body, cited_evidence_ids: [99], asked_field_paths: ["ownership_country"] }, ctx);
  assert.equal(noCite.ok, false);
  assert.deepEqual(noCite.citedIds, []);
  const noAsk = checkDraft({ subject: "s", body, cited_evidence_ids: [1], asked_field_paths: [] }, ctx);
  assert.deepEqual(noAsk.missingFields, ["ownership_country"]);
  assert.equal(noAsk.ok, false);
  assert.equal(checkDraft({ subject: "s", body, cited_evidence_ids: [1], asked_field_paths: [] }, { ...ctx, mustAsk: false }).ok, true);
  assert.equal(checkDraft({ subject: "", body, cited_evidence_ids: [1], asked_field_paths: ["ownership_country"] }, ctx).ok, false);
  const prompt = buildDraftPrompt({ vendor: { name: "Acme", primary_domain: "acme.example" } as never, category: "ego", evidence, unknownMustFields: ctx.unknownMustFields, mustAsk: true });
  assert.match(prompt, /#1 sensor_rig = stereo/);
  assert.match(prompt, /ownership_country: Country of the ultimate owner/);
});

test("unknownMustFields is derived from screening, and draftContext words it from the ruleset", async () => {
  const { unknownMustFields } = await import("@/lib/shared/must-fields");
  const reasons = [
    { rule_id: "stereo_rig", kind: "must" as const, field_path: "sensor_rig", outcome: "pass" as const, detail: "", observed: ["stereo"], evidence_ids: [] },
    { rule_id: "owned_outside_china", kind: "must" as const, field_path: "ownership_country", outcome: "unknown" as const, detail: "", observed: [], evidence_ids: [] },
    { rule_id: "scene_diversity", kind: "should" as const, field_path: "scene_class", outcome: "unknown" as const, detail: "", observed: [], evidence_ids: [] },
  ];
  assert.deepEqual(unknownMustFields({ screen_reasons: reasons }), ["ownership_country"]);

  const { createDb, runs, vendors } = await import("@/lib/db");
  const { draftContext } = await import("@/lib/outreach/draft");
  const db = createDb(":memory:");
  const now = new Date().toISOString();
  db.insert(runs).values({ run_id: "run_x", input_type: "manual", adapter: "t", vendor_type: "ego_data", query: {}, ruleset_version: "ego_data_supplier@v1", started_at: now }).run();
  db.insert(vendors).values({ vendor_id: "acme.example", name: "Acme", vendor_type: "ego_data", discovered_at: now, updated_at: now, first_seen_run_id: "run_x", next_action: "outreach_to_verify", screen_reasons: reasons }).run();
  const ctx = draftContext("acme.example", db);
  assert.deepEqual(ctx.unknownMustFields.map((f) => f.field_path), ["ownership_country"]);
  assert.ok(ctx.unknownMustFields[0].description.length > "ownership_country".length, "description comes from the ruleset catalog");
  assert.equal(ctx.mustAsk, true);
});
