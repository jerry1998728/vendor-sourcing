import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, nowIso, proposals } from "@/lib/db";
import { TransitionError, transition } from "@/lib/db/state";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ decision: z.enum(["accept", "reject"]), reason: z.string().trim().max(500).optional() });

/** Accept applies the proposed transition as a human; reject just records the decision. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposalId = Number(id);
  if (!Number.isInteger(proposalId)) return NextResponse.json({ error: "invalid proposal id" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "body must be { decision: accept|reject, reason? }" }, { status: 400 });

  const db = getDb();
  const proposal = db.select().from(proposals).where(eq(proposals.proposal_id, proposalId)).get();
  if (!proposal) return NextResponse.json({ error: `proposal ${proposalId} not found` }, { status: 404 });
  if (proposal.decided_at) return NextResponse.json({ error: `proposal ${proposalId} was already decided (${proposal.decided_by})` }, { status: 409 });
  if (!proposal.to_status) return NextResponse.json({ error: "proposal has no target status" }, { status: 422 });

  try {
    const result = db.transaction((tx) => {
      let t = null;
      if (parsed.data.decision === "accept") {
        t = transition(
          {
            vendorId: proposal.vendor_id,
            toStatus: proposal.to_status!,
            toStage: proposal.to_stage ?? undefined,
            actor: "human",
            reason: parsed.data.reason?.trim() || `accepted proposal #${proposalId}`,
            evidenceRef: proposal.interaction_id ? `interaction:${proposal.interaction_id}` : `proposal:${proposalId}`,
            payload: { proposal_id: proposalId, confidence: proposal.confidence, evidence_snippet: proposal.evidence_snippet },
          },
          tx,
        );
      }
      tx.update(proposals)
        .set({ decided_by: parsed.data.decision === "accept" ? "human:accepted" : "human:rejected", decided_at: nowIso() })
        .where(eq(proposals.proposal_id, proposalId))
        .run();
      return t;
    });
    return NextResponse.json({ ok: true, decision: parsed.data.decision, transition: result });
  } catch (err) {
    if (err instanceof TransitionError) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
