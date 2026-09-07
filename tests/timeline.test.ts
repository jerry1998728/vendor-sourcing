import assert from "node:assert/strict";
import { test } from "node:test";

import type { EventRow, InteractionRow } from "@/lib/db/schema";
import { buildTimeline, timelineKind } from "@/lib/shared/timeline";

const ev = (event_id: number, created_at: string, patch: Partial<EventRow>): EventRow =>
  ({ event_id, vendor_id: "v", from_status: "Identified", to_status: "Screened", from_stage: null, to_stage: null, actor: "system", reason: null, confidence: null, evidence_ref: null, payload: null, created_at, ...patch }) as EventRow;
const mail = (interaction_id: number, direction: InteractionRow["direction"], sent_at: string | null): InteractionRow =>
  ({ interaction_id, vendor_id: "v", gmail_thread_id: null, direction, sent_at, subject: null, body_text: null, llm_summary: null }) as InteractionRow;

test("timelineKind: status change, stage-only change, informational event", () => {
  assert.equal(timelineKind({ from_status: "Contacted", to_status: "Replied", from_stage: null, to_stage: null }), "status");
  assert.equal(timelineKind({ from_status: "In Discussion", to_status: "In Discussion", from_stage: "responded", to_stage: "quote_received" }), "stage");
  assert.equal(timelineKind({ from_status: "Screened", to_status: "Screened", from_stage: null, to_stage: null }), "note");
});

test("buildTimeline: oldest first, emails interleaved, undated draft last, ties keep insertion order", () => {
  const events = [
    ev(1, "2026-09-01T10:00:00Z", {}),
    ev(2, "2026-09-02T10:00:00Z", { from_status: "Screened", to_status: "Qualified", actor: "human" }),
    ev(3, "2026-09-03T10:00:00Z", { from_status: "Qualified", to_status: "Contacted", actor: "human" }),
    ev(4, "2026-09-03T10:00:00Z", { from_status: "Contacted", to_status: "Contacted", reason: "tag_changed" }),
  ];
  const interactions = [mail(1, "outbound", "2026-09-03T09:59:00Z"), mail(2, "inbound", "2026-09-04T08:00:00Z"), mail(3, "draft", null)];
  const items = buildTimeline(events, interactions);
  assert.deepEqual(
    items.map((i) => (i.kind === "email" ? `${i.kind}:${i.interaction.interaction_id}` : `${i.kind}:${i.event.event_id}`)),
    ["status:1", "status:2", "email:1", "status:3", "note:4", "email:2", "email:3"],
  );
  assert.deepEqual(buildTimeline([], []), []);
});
