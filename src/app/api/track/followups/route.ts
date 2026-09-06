import { NextResponse } from "next/server";
import { z } from "zod";

import { isDev } from "@/lib/shared/env";
import { runFollowUps } from "@/lib/track/followups";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ as_of: z.string().datetime().optional() });

/** P1: 7d / 14d follow-up drafts and Dormant at 10d. `as_of` is honoured outside production for demos. */
export async function POST(req: Request) {
  let body: unknown = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "body must be { as_of? }" }, { status: 400 });
  const now = parsed.data.as_of && isDev() ? new Date(parsed.data.as_of) : new Date();
  try {
    return NextResponse.json(await runFollowUps({ now }));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
