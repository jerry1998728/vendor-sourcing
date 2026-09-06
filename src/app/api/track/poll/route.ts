import { NextResponse } from "next/server";
import { z } from "zod";

import { GmailNotConfiguredError, GmailNotConnectedError } from "@/lib/outreach/gmail";
import { pollThreads } from "@/lib/track/poll";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ vendor_id: z.string().min(1).optional(), infer: z.boolean().optional() });

/** Fetch new inbound Gmail messages for every active thread, then infer and apply/propose. */
export async function POST(req: Request) {
  let body: unknown = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "body must be { vendor_id?, infer? }" }, { status: 400 });
  try {
    const result = await pollThreads({ vendorId: parsed.data.vendor_id, infer: parsed.data.infer }, undefined);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GmailNotConnectedError || err instanceof GmailNotConfiguredError) {
      return NextResponse.json({ error: err.message, auth_url: "/api/gmail/auth" }, { status: 409 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
