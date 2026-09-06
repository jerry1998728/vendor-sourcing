import { NextResponse } from "next/server";
import { z } from "zod";

import { TransitionError } from "@/lib/db/state";
import { ProposalError, decideProposal, proposalErrorStatus } from "@/lib/track/proposals";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ decision: z.enum(["accept", "reject"]), reason: z.string().trim().max(500).optional() });

/** Validation and HTTP mapping only; the decision lives in src/lib/track/proposals.ts. */
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
  try {
    const result = decideProposal(proposalId, parsed.data.decision, parsed.data.reason);
    return NextResponse.json({ ok: true, decision: parsed.data.decision, transition: result.transition });
  } catch (err) {
    if (err instanceof ProposalError) return NextResponse.json({ error: err.message, code: err.code }, { status: proposalErrorStatus(err.code) });
    if (err instanceof TransitionError) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
