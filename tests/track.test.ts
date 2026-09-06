import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { createDb, events, interactions, proposals, runs, vendors } from "@/lib/db";
import { transition } from "@/lib/db/state";
import { decideAction, type Inference, type InferenceInput } from "@/lib/track/infer";
import { ingestInbound, stripQuotedReply } from "@/lib/track/poll";

test("decideAction applies PRD §6: threshold, human-only stages, no change, illegal", () => {
  const replied = { status: "Replied" as const, stage: null };
  assert.equal(decideAction(replied, { to_status: "In Discussion", to_stage: "responded", confidence: 0.9 }).action, "apply");
  assert.equal(decideAction(replied, { to_status: "In Discussion", to_stage: "responded", confidence: 0.7 }).action, "propose");
  assert.equal(decideAction(replied, { to_status: "In Discussion", to_stage: "quote_received", confidence: 0.99 }).action, "propose");
  assert.equal(decideAction(replied, { to_status: "Rejected", to_stage: null, confidence: 0.9 }).action, "apply");
  assert.equal(decideAction(replied, { to_status: "Replied", to_stage: null, confidence: 0.9 }).action, "none");
  assert.equal(decideAction(replied, { to_status: "Approved", to_stage: null, confidence: 0.9 }).action, "propose"); // human-only, legal for a human
  assert.equal(decideAction(replied, { to_status: "Contacted", to_stage: null, confidence: 0.9 }).action, "illegal");
  // a stage implies In Discussion; a bare In Discussion gets the first stage
  const d = decideAction(replied, { to_status: "Replied", to_stage: "responded", confidence: 0.9 });
  assert.equal(d.to_status, "In Discussion");
  assert.equal(decideAction(replied, { to_status: "In Discussion", to_stage: null, confidence: 0.9 }).to_stage, "responded");
  const inDisc = { status: "In Discussion" as const, stage: "technical_review" as const };
  assert.equal(decideAction(inDisc, { to_status: "In Discussion", to_stage: "responded", confidence: 0.9 }).action, "none");
  assert.equal(decideAction(inDisc, { to_status: "In Discussion", to_stage: "sampling", confidence: 0.9 }).action, "propose");
});

test("stripQuotedReply drops quoted history", () => {
  const text = "Yes, works for us.\n\nOn Mon, Sep 7, 2026 at 9:00 AM Jerry <j@x.com> wrote:\n> Hi there\n> original text";
  assert.equal(stripQuotedReply(text), "Yes, works for us.");
  assert.equal(stripQuotedReply("Line 1\r\n> quoted\r\nLine 2"), "Line 1\nLine 2");
});

function seed() {
  const db = createDb(":memory:");
  const now = new Date().toISOString();
  db.insert(runs).values({ run_id: "run_x", input_type: "manual", adapter: "t", vendor_type: "ego_data", query: {}, ruleset_version: "ego_data_supplier@v1", started_at: now }).run();
  db.insert(vendors).values({ vendor_id: "v.example", name: "V", vendor_type: "ego_data", discovered_at: now, updated_at: now, status: "Identified", first_seen_run_id: "run_x" }).run();
  transition({ vendorId: "v.example", toStatus: "Screened", actor: "system", reason: "screened:pass" }, db);
  transition({ vendorId: "v.example", toStatus: "Qualified", actor: "human", reason: "review" }, db);
  transition({ vendorId: "v.example", toStatus: "Contacted", actor: "human", reason: "sent" }, db);
  db.insert(interactions).values({ vendor_id: "v.example", direction: "outbound", gmail_thread_id: "t1", sent_at: now, subject: "Hi", body_text: "our email" }).run();
  return db;
}

const fake = (partial: Partial<Inference>): (() => Promise<Inference>) => async () => ({
  to_status: "In Discussion",
  to_stage: "responded",
  action: "apply",
  reason: "test",
  confidence: 0.9,
  evidence_snippet: "snippet",
  summary: "vendor agreed to talk",
  model: "fake",
  raw: { to_status: "In Discussion", to_stage: "responded", confidence: 0.9, evidence_snippet: "snippet", summary: "vendor agreed to talk" },
  ...partial,
});

test("ingestInbound: first inbound moves Contacted -> Replied (system), then inference applies", async () => {
  const db = seed();
  const r = await ingestInbound("v.example", { thread_id: "t1", sent_at: "2026-09-07T09:00:00.000Z", subject: "Re: Hi", body_text: "Yes let's talk", from: "vendor@v.example" }, { inferFn: fake({}) }, db);
  assert.equal(r.replied, true);
  assert.equal(r.applied, true);
  assert.equal(r.proposal_id, null);
  const v = db.select().from(vendors).where(eq(vendors.vendor_id, "v.example")).get()!;
  assert.equal(v.status, "In Discussion");
  assert.equal(v.diligence_stage, "responded");
  assert.equal(v.next_action, "respond");
  const evs = db.select().from(events).where(eq(events.vendor_id, "v.example")).all();
  assert.deepEqual(evs.slice(-2).map((e) => `${e.actor}:${e.to_status}`), ["system:Replied", "llm_inference:In Discussion"]);
  const inbound = db.select().from(interactions).where(eq(interactions.direction, "inbound")).all();
  assert.equal(inbound.length, 1);
  assert.match(inbound[0].llm_summary ?? "", /vendor agreed to talk \[apply/);
});

test("ingestInbound: a quote goes to proposals, never auto-applied; accept path via transition", async () => {
  const db = seed();
  const quote = fake({ to_status: "In Discussion", to_stage: "quote_received", action: "propose", reason: "human-only stage", confidence: 0.95 });
  const r = await ingestInbound("v.example", { thread_id: "t1", sent_at: "2026-09-07T09:00:00.000Z", subject: "Quote", body_text: "USD 1,800 per hour", from: "vendor@v.example" }, { inferFn: quote }, db);
  assert.equal(r.applied, false);
  assert.ok(r.proposal_id);
  const v = db.select().from(vendors).where(eq(vendors.vendor_id, "v.example")).get()!;
  assert.equal(v.status, "Replied");
  const p = db.select().from(proposals).where(eq(proposals.proposal_id, r.proposal_id!)).get()!;
  assert.equal(p.to_stage, "quote_received");
  assert.equal(p.decided_at, null);
  // a human accepting the proposal is a legal transition
  transition({ vendorId: "v.example", toStatus: "In Discussion", toStage: "quote_received", actor: "human", reason: "accepted proposal" }, db);
  assert.equal(db.select().from(vendors).where(eq(vendors.vendor_id, "v.example")).get()!.diligence_stage, "quote_received");
});

test("ingestInbound: low confidence -> proposal; revert of an applied llm event restores Replied", async () => {
  const db = seed();
  await ingestInbound("v.example", { thread_id: "t1", sent_at: "2026-09-07T09:00:00.000Z", subject: "Re", body_text: "maybe", from: "v@v.example" }, { inferFn: fake({ action: "propose", confidence: 0.6, reason: "low" }) }, db);
  assert.equal(db.select().from(proposals).all().length, 1);
  assert.equal(db.select().from(vendors).where(eq(vendors.vendor_id, "v.example")).get()!.status, "Replied");
  const r2 = await ingestInbound("v.example", { thread_id: "t1", sent_at: "2026-09-07T10:00:00.000Z", subject: "Re", body_text: "yes, call tomorrow", from: "v@v.example" }, { inferFn: fake({}) }, db);
  assert.equal(r2.applied, true);
  const last = db.select().from(events).where(eq(events.vendor_id, "v.example")).all().at(-1)!;
  assert.equal(last.actor, "llm_inference");
  transition({ vendorId: "v.example", toStatus: "Replied", actor: "human", reason: "revert", payload: { revert_event_id: last.event_id } }, db);
  const v = db.select().from(vendors).where(eq(vendors.vendor_id, "v.example")).get()!;
  assert.equal(v.status, "Replied");
  assert.equal(v.diligence_stage, null);
});

test("inference receives the unknown must-fields from the last screening (shared definition)", async () => {
  const db = seed();
  // seed() leaves the vendor unscreened; give it screening reasons like the write path would
  db.update(vendors)
    .set({ screen_reasons: [{ rule_id: "owned_outside_china", kind: "must", field_path: "ownership_country", outcome: "unknown", detail: "no evidence", observed: [], evidence_ids: [] }] })
    .where(eq(vendors.vendor_id, "v.example"))
    .run();
  let seen: string[] | undefined;
  const capture = async (input: InferenceInput) => {
    seen = input.unknownMustFields;
    return fake({})();
  };
  await ingestInbound("v.example", { thread_id: "t1", sent_at: "2026-09-07T09:00:00.000Z", subject: "Re", body_text: "we are owned locally", from: "v@v.example" }, { inferFn: capture }, db);
  assert.deepEqual(seen, ["ownership_country"]);
});

test("decideProposal: accept applies the transition as a human, reject only records, and a proposal is decided once", async () => {
  const { decideProposal, ProposalError } = await import("@/lib/track/proposals");
  const { proposals } = await import("@/lib/db");
  const db = seed();
  const quote = fake({ to_status: "In Discussion", to_stage: "quote_received", action: "propose", reason: "human-only stage", confidence: 0.95 });
  const r = await ingestInbound("v.example", { thread_id: "t1", sent_at: "2026-09-07T09:00:00.000Z", subject: "Quote", body_text: "USD 1,800 per hour", from: "vendor@v.example" }, { inferFn: quote }, db);
  const accepted = decideProposal(r.proposal_id!, "accept", undefined, db);
  assert.equal(accepted.proposal.decided_by, "human:accepted");
  assert.equal(accepted.transition?.toStage, "quote_received");
  assert.equal(db.select().from(vendors).where(eq(vendors.vendor_id, "v.example")).get()!.diligence_stage, "quote_received");
  assert.throws(() => decideProposal(r.proposal_id!, "reject", undefined, db), (e: unknown) => e instanceof ProposalError && e.code === "already_decided");
  assert.throws(() => decideProposal(999, "accept", undefined, db), (e: unknown) => e instanceof ProposalError && e.code === "not_found");
  const r2 = await ingestInbound("v.example", { thread_id: "t1", sent_at: "2026-09-07T10:00:00.000Z", subject: "Sample", body_text: "we can send a sample", from: "vendor@v.example" }, { inferFn: fake({ to_status: "In Discussion", to_stage: "sampling", action: "propose", reason: "human-only stage", confidence: 0.9 }) }, db);
  const rejected = decideProposal(r2.proposal_id!, "reject", "not now", db);
  assert.equal(rejected.proposal.decided_by, "human:rejected");
  assert.equal(rejected.transition, null);
  assert.equal(db.select().from(proposals).all().filter((p) => p.decided_at === null).length, 0);
});
