import { NextResponse } from "next/server";
import { z } from "zod";

import { updateVendorFields } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ next_action: z.string().trim().max(64).nullable().optional(), owner: z.string().trim().max(200).nullable().optional(), due_at: z.string().datetime().nullable().optional() });

/** Small human edits that are not status changes: next_action, owner, due_at. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "body must be { next_action?, owner?, due_at? }" }, { status: 400 });
  const vendor = updateVendorFields(decodeURIComponent(id), parsed.data);
  if (!vendor) return NextResponse.json({ error: "vendor not found" }, { status: 404 });
  return NextResponse.json({ ok: true, vendor });
}
