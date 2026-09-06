/**
 * Human decisions on inferred transitions (PRD §4.3 Proposals). Accept applies
 * the proposed transition as a human; reject only records the decision. The
 * decision is encoded in decided_by ("human:accepted" / "human:rejected") to
 * keep the eight-table schema exactly as specified.
 */
import { eq } from "drizzle-orm";

import { getDb, nowIso, proposals, type Db } from "@/lib/db";
import type { ProposalRow } from "@/lib/db/schema";
import { transition, type TransitionResult } from "@/lib/db/state";

export type ProposalDecision = "accept" | "reject";

export class ProposalError extends Error {
  constructor(
    public readonly code: "not_found" | "already_decided" | "no_target",
    message: string,
  ) {
    super(message);
  }
}

export function proposalErrorStatus(code: ProposalError["code"]): number {
  return code === "not_found" ? 404 : code === "already_decided" ? 409 : 422;
}

export function decideProposal(
  proposalId: number,
  decision: ProposalDecision,
  reason: string | undefined,
  db: Db = getDb(),
): { proposal: ProposalRow; transition: TransitionResult | null } {
  const proposal = db.select().from(proposals).where(eq(proposals.proposal_id, proposalId)).get();
  if (!proposal) throw new ProposalError("not_found", `proposal ${proposalId} not found`);
  if (proposal.decided_at) throw new ProposalError("already_decided", `proposal ${proposalId} was already decided (${proposal.decided_by})`);
  if (!proposal.to_status) throw new ProposalError("no_target", "proposal has no target status");
  const toStatus = proposal.to_status;

  return db.transaction((tx) => {
    const t =
      decision === "accept"
        ? transition(
            {
              vendorId: proposal.vendor_id,
              toStatus,
              toStage: proposal.to_stage ?? undefined,
              actor: "human",
              reason: reason?.trim() || `accepted proposal #${proposalId}`,
              evidenceRef: proposal.interaction_id ? `interaction:${proposal.interaction_id}` : `proposal:${proposalId}`,
              payload: { proposal_id: proposalId, confidence: proposal.confidence, evidence_snippet: proposal.evidence_snippet },
            },
            tx,
          )
        : null;
    const decided = tx
      .update(proposals)
      .set({ decided_by: decision === "accept" ? "human:accepted" : "human:rejected", decided_at: nowIso() })
      .where(eq(proposals.proposal_id, proposalId))
      .returning()
      .get();
    return { proposal: decided, transition: t };
  });
}
