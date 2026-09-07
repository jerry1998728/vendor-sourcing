/** Merges a vendor's events and interactions into one ordered rail (client-safe: types only). */
import type { EventRow, InteractionRow } from "@/lib/db/schema";

export type TimelineItem =
  | { kind: "status" | "stage" | "note"; at: string; order: number; event: EventRow }
  | { kind: "email"; at: string; order: number; interaction: InteractionRow };

export function timelineKind(event: Pick<EventRow, "from_status" | "to_status" | "from_stage" | "to_stage">): "status" | "stage" | "note" {
  if (event.from_status !== event.to_status) return "status";
  if (event.from_stage !== event.to_stage) return "stage";
  return "note";
}

/** Oldest first; an undated item (a draft without sent_at) goes last, as the newest activity; ties keep insertion order. */
export function buildTimeline(events: EventRow[], interactions: InteractionRow[]): TimelineItem[] {
  const items: TimelineItem[] = events.map((event, order) => ({ kind: timelineKind(event), at: event.created_at, order, event }));
  for (const [order, interaction] of interactions.entries()) items.push({ kind: "email", at: interaction.sent_at ?? "", order, interaction });
  return items.sort((a, b) => {
    if (a.at === b.at) return a.order - b.order;
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at < b.at ? -1 : 1;
  });
}
