import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { events, getDb } from "@/lib/db";
import { REVERT_REASON, TransitionError, transition } from "@/lib/db/state";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ event_id: z.number().int().positive() });

/** Reverse one llm_inference event (PRD §4.3 Revert): actor=human, reason=revert. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const vendorId = decodeURIComponent(id);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "body must be { event_id }" }, { status: 400 });

  const db = getDb();
  const event = db.select().from(events).where(eq(events.event_id, parsed.data.event_id)).get();
  if (!event || event.vendor_id !== vendorId) return NextResponse.json({ error: `event ${parsed.data.event_id} not found for ${vendorId}` }, { status: 404 });
  if (event.actor !== "llm_inference") return NextResponse.json({ error: "only llm_inference events can be reverted" }, { status: 409 });
  if (!event.from_status) return NextResponse.json({ error: "event has no origin status" }, { status: 409 });

  try {
    const result = transition(
      { vendorId, toStatus: event.from_status, actor: "human", reason: REVERT_REASON, evidenceRef: `event:${event.event_id}`, payload: { revert_event_id: event.event_id } },
      db,
    );
    return NextResponse.json({ ok: true, transition: result });
  } catch (err) {
    if (err instanceof TransitionError) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
