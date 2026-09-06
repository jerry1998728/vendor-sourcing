import { NextResponse } from "next/server";

import { latestDraft, listInteractions } from "@/lib/db/queries";
import { DraftError, generateDraft } from "@/lib/outreach/draft";

export const dynamic = "force-dynamic";

/** Latest draft plus the full interaction history. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const vendorId = decodeURIComponent(id);
  return NextResponse.json({ draft: latestDraft(vendorId) ?? null, interactions: listInteractions(vendorId) });
}

/** Generate a new draft (always creates a new interactions row, direction=draft). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const vendorId = decodeURIComponent(id);
  try {
    const { interaction, check, model } = await generateDraft(vendorId);
    return NextResponse.json({ draft: interaction, cited_evidence_ids: check.citedIds, model }, { status: 201 });
  } catch (err) {
    const status = err instanceof DraftError ? 422 : 502;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
