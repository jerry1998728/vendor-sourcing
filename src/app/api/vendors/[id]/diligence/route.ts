import { NextResponse } from "next/server";
import { z } from "zod";

import { DILIGENCE_VALUES, DiligenceError, diligenceErrorStatus, recordDiligence } from "@/lib/track/diligence";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  item_id: z.string().trim().regex(/^[a-z0-9_]+$/),
  value: z.enum(DILIGENCE_VALUES),
  note: z.string().trim().max(1000).optional(),
  source_url: z.string().trim().url().max(2000).optional().or(z.literal("")),
  attested_by: z.string().trim().max(200).optional(),
});

/** Record one due-diligence answer. Verification follows the evidence rule: a source URL or an attestation. */
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
    const status = recordDiligence(decodeURIComponent(id), { ...parsed.data, source_url: parsed.data.source_url || undefined });
    return NextResponse.json(status);
  } catch (err) {
    if (err instanceof DiligenceError) return NextResponse.json({ error: err.message }, { status: diligenceErrorStatus(err.code) });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
