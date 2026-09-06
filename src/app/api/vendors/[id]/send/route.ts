import { NextResponse } from "next/server";
import { z } from "zod";

import { SendError, sendErrorStatus, sendOutreach } from "@/lib/outreach/send";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  to: z.string().trim().min(3).max(320),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20_000),
  draft_interaction_id: z.number().int().positive().optional(),
});

/** Validation and HTTP mapping only; the rules live in src/lib/outreach/send.ts. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  try {
    const result = await sendOutreach(decodeURIComponent(id), parsed.data);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof SendError) return NextResponse.json({ error: err.message, code: err.code, ...err.details }, { status: sendErrorStatus(err.code) });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
