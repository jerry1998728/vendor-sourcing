import { NextResponse } from "next/server";
import { z } from "zod";

import { isDev } from "@/lib/shared/env";
import { ingestInbound } from "@/lib/track/poll";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  vendor_id: z.string().min(1),
  subject: z.string().trim().max(500).default(""),
  body: z.string().trim().min(1).max(20_000),
  from: z.string().trim().max(320).optional(),
  infer: z.boolean().optional(),
});

/** Demo/test seam: inject an inbound reply without Gmail. Disabled in production builds. */
export async function POST(req: Request) {
  if (!isDev()) {
    return NextResponse.json({ error: "simulate is disabled in production" }, { status: 403 });
  }
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
  const { vendor_id, subject, body: text, from, infer } = parsed.data;
  try {
    const result = await ingestInbound(
      vendor_id,
      { thread_id: `simulated-${vendor_id}`, sent_at: new Date().toISOString(), subject: subject || null, body_text: text, from: from ?? "vendor@simulated.example" },
      { infer },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
