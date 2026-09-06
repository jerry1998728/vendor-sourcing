import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, nowIso, vendors, DILIGENCE_STAGES, VENDOR_STATUSES } from "@/lib/db";
import { getVendorDetail } from "@/lib/db/queries";
import { TransitionError, transition } from "@/lib/db/state";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  to_status: z.enum(VENDOR_STATUSES),
  reason: z.string().trim().min(1, "reason is required"),
  to_stage: z.enum(DILIGENCE_STAGES).nullable().optional(),
  next_action: z.string().trim().max(64).nullable().optional(),
  owner: z.string().trim().max(200).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

/** The human gate: every transition made from the UI goes through here with actor=human. */
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
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const input = parsed.data;
  if (input.to_status === "Rejected" && input.reason.replace(/[^a-z0-9]/gi, "").length < 3) {
    return NextResponse.json({ error: "Reject needs a reason" }, { status: 400 });
  }

  const db = getDb();
  try {
    const result = db.transaction((tx) => {
      const r = transition(
        {
          vendorId,
          toStatus: input.to_status,
          toStage: input.to_stage ?? undefined,
          actor: "human",
          reason: input.reason,
          payload: input.payload,
        },
        tx,
      );
      const patch: Partial<typeof vendors.$inferInsert> = { updated_at: nowIso() };
      if (input.next_action !== undefined) patch.next_action = input.next_action;
      if (input.owner !== undefined) patch.owner = input.owner;
      tx.update(vendors).set(patch).where(eq(vendors.vendor_id, vendorId)).run();
      return r;
    });
    return NextResponse.json({ ok: true, result, vendor: getVendorDetail(vendorId, db)?.vendor ?? null });
  } catch (err) {
    if (err instanceof TransitionError) {
      const status = err.code === "not_found" ? 404 : err.code === "illegal_transition" || err.code === "illegal_actor" ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
