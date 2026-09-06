import assert from "node:assert/strict";
import { test } from "node:test";

import { createDb, runs, vendors, type Db } from "@/lib/db";
import {
  StateMismatchError,
  TransitionError,
  rebuildStatus,
  transition,
} from "@/lib/db/state";
import { eq } from "drizzle-orm";

function seed(): Db {
  const db = createDb(":memory:");
  const now = new Date().toISOString();
  db.insert(runs)
    .values({
      run_id: "run_test",
      input_type: "web_search",
      adapter: "web_search_llm",
      vendor_type: "ego_data",
      query: {},
      ruleset_version: "ego_data_supplier@v1",
      started_at: now,
    })
    .run();
  db.insert(vendors)
    .values({
      vendor_id: "acme.example",
      name: "Acme",
      vendor_type: "ego_data",
      first_seen_run_id: "run_test",
      discovered_at: now,
      updated_at: now,
    })
    .run();
  return db;
}

function expectCode(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof TransitionError, `expected TransitionError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

test("happy path through the whitelist, replay matches", () => {
  const db = seed();
  const v = "acme.example";
  const r1 = transition({ vendorId: v, toStatus: "Screened", actor: "system", reason: "screened:pass" }, db);
  assert.equal(r1.fromStatus, "Identified");
  transition({ vendorId: v, toStatus: "Qualified", actor: "human", reason: "looks good" }, db);
  transition({ vendorId: v, toStatus: "Contacted", actor: "human", reason: "sent" }, db);
  transition({ vendorId: v, toStatus: "Replied", actor: "system", reason: "inbound" }, db);
  const r5 = transition(
    { vendorId: v, toStatus: "In Discussion", actor: "llm_inference", reason: "positive reply", confidence: 0.9 },
    db,
  );
  assert.equal(r5.toStage, "responded");
  transition(
    { vendorId: v, toStatus: "In Discussion", toStage: "technical_review", actor: "llm_inference", reason: "specs", confidence: 0.95 },
    db,
  );
  transition(
    { vendorId: v, toStatus: "In Discussion", toStage: "quote_received", actor: "human", reason: "accepted proposal" },
    db,
  );
  transition({ vendorId: v, toStatus: "Approved", actor: "human", reason: "go" }, db);
  const rebuilt = rebuildStatus(v, db);
  assert.equal(rebuilt.status, "Approved");
  assert.equal(rebuilt.stage, "quote_received");
  assert.equal(rebuilt.eventCount, 8);
});

test("illegal transitions, actors and stages throw", () => {
  const db = seed();
  const v = "acme.example";
  expectCode(() => transition({ vendorId: v, toStatus: "Contacted", actor: "human", reason: "x" }, db), "illegal_transition");
  expectCode(() => transition({ vendorId: v, toStatus: "Screened", actor: "human", reason: "x" }, db), "illegal_actor");
  transition({ vendorId: v, toStatus: "Screened", actor: "system", reason: "screened:unknown" }, db);
  expectCode(() => transition({ vendorId: v, toStatus: "Rejected", actor: "human", reason: "  " }, db), "reason_required");
  expectCode(() => transition({ vendorId: v, toStatus: "Qualified", actor: "system", reason: "x" }, db), "illegal_actor");
  expectCode(
    () => transition({ vendorId: v, toStatus: "Qualified", toStage: "responded", actor: "human", reason: "x" }, db),
    "illegal_stage",
  );
  transition({ vendorId: v, toStatus: "Qualified", actor: "human", reason: "ok" }, db);
  transition({ vendorId: v, toStatus: "Contacted", actor: "human", reason: "sent" }, db);
  transition({ vendorId: v, toStatus: "Replied", actor: "system", reason: "inbound" }, db);
  expectCode(
    () => transition({ vendorId: v, toStatus: "In Discussion", actor: "llm_inference", reason: "x", confidence: 0.7 }, db),
    "confidence_below_threshold",
  );
  expectCode(
    () => transition({ vendorId: v, toStatus: "In Discussion", toStage: "quote_received", actor: "llm_inference", reason: "x", confidence: 0.99 }, db),
    "illegal_stage",
  );
  transition({ vendorId: v, toStatus: "In Discussion", toStage: "technical_review", actor: "llm_inference", reason: "x", confidence: 0.9 }, db);
  expectCode(
    () => transition({ vendorId: v, toStatus: "In Discussion", toStage: "responded", actor: "llm_inference", reason: "x", confidence: 0.9 }, db),
    "illegal_stage",
  );
  expectCode(() => transition({ vendorId: "nope", toStatus: "Screened", actor: "system", reason: "x" }, db), "not_found");
  assert.equal(rebuildStatus(v, db).status, "In Discussion");
});

test("revert reverses the latest llm_inference event only", () => {
  const db = seed();
  const v = "acme.example";
  transition({ vendorId: v, toStatus: "Screened", actor: "system", reason: "s" }, db);
  transition({ vendorId: v, toStatus: "Qualified", actor: "human", reason: "q" }, db);
  transition({ vendorId: v, toStatus: "Contacted", actor: "human", reason: "c" }, db);
  transition({ vendorId: v, toStatus: "Replied", actor: "system", reason: "r" }, db);
  // Nothing from the LLM yet: revert must fail.
  expectCode(() => transition({ vendorId: v, toStatus: "Contacted", actor: "human", reason: "revert" }, db), "illegal_transition");
  const llm = transition({ vendorId: v, toStatus: "In Discussion", actor: "llm_inference", reason: "x", confidence: 0.9 }, db);
  // Wrong target state for a revert.
  expectCode(() => transition({ vendorId: v, toStatus: "Qualified", actor: "human", reason: "revert" }, db), "illegal_transition");
  const back = transition(
    { vendorId: v, toStatus: "Replied", actor: "human", reason: "revert", payload: { revert_event_id: llm.eventId } },
    db,
  );
  assert.equal(back.fromStatus, "In Discussion");
  assert.equal(back.toStatus, "Replied");
  assert.equal(back.toStage, null);
  assert.equal(rebuildStatus(v, db).status, "Replied");
});

test("rebuildStatus throws when the vendors row disagrees with the log", () => {
  const db = seed();
  const v = "acme.example";
  transition({ vendorId: v, toStatus: "Screened", actor: "system", reason: "s" }, db);
  db.update(vendors).set({ status: "Approved" }).where(eq(vendors.vendor_id, v)).run();
  assert.throws(() => rebuildStatus(v, db), StateMismatchError);
});

test("rules flagged requiresReason refuse placeholder reasons", async () => {
  const { createDb, runs, vendors } = await import("@/lib/db");
  const { REASON_MIN_CHARS, TransitionError, transition } = await import("@/lib/db/state");
  const db = createDb(":memory:");
  const now = new Date().toISOString();
  db.insert(runs).values({ run_id: "run_x", input_type: "manual", adapter: "t", vendor_type: "ego_data", query: {}, ruleset_version: "r@v1", started_at: now }).run();
  db.insert(vendors).values({ vendor_id: "r.example", name: "R", vendor_type: "ego_data", discovered_at: now, updated_at: now, status: "Screened" }).run();
  assert.ok(REASON_MIN_CHARS >= 3);
  assert.throws(() => transition({ vendorId: "r.example", toStatus: "Rejected", actor: "human", reason: "x" }, db), (e: unknown) => e instanceof TransitionError && e.code === "reason_required");
  assert.throws(() => transition({ vendorId: "r.example", toStatus: "Rejected", actor: "human", reason: "--" }, db), TransitionError);
  const ok = transition({ vendorId: "r.example", toStatus: "Rejected", actor: "human", reason: "duplicate" }, db);
  assert.equal(ok.toStatus, "Rejected");
});
