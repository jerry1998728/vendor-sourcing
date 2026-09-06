/**
 * Status inference from inbound replies (PRD §4.3 Proposals, §6). Claude
 * (sonnet, CLAUDE.md routing) proposes the next status/stage; decideAction()
 * turns that into apply / propose / none against the PRD §6 rules, and
 * transition() remains the final gate.
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { DILIGENCE_STAGES, type DiligenceStage, type VendorStatus } from "@/lib/db/enums";
import { HUMAN_ONLY_STAGES, LLM_AUTO_APPLY_THRESHOLD, isLegalTransition } from "@/lib/db/state";
import { getAnthropic, modelFor, supportsEffort } from "@/lib/llm/client";
import { StatusInferenceOutput } from "@/lib/pipeline/types";

export type CurrentState = { status: VendorStatus; stage: DiligenceStage | null };

export type InferenceInput = {
  vendor: { name: string; vendor_type: string } & CurrentState;
  message: { from?: string | null; subject?: string | null; body: string; date?: string | null };
  lastOutbound?: { subject?: string | null; body: string } | null;
  unknownMustFields?: string[];
};

export type InferenceAction = "apply" | "propose" | "none" | "illegal";

export type Decision = {
  to_status: VendorStatus;
  to_stage: DiligenceStage | null;
  action: InferenceAction;
  reason: string;
};

export type Inference = Decision & {
  confidence: number;
  evidence_snippet: string;
  summary: string;
  model: string;
  raw: StatusInferenceOutput;
};

const stageIndex = (s: DiligenceStage | null) => (s ? DILIGENCE_STAGES.indexOf(s) : -1);

/**
 * Pure PRD §6 policy: normalise the model's answer, then
 *   no change                                  -> none
 *   not even a human could make it             -> illegal
 *   >= 0.85, stage not human-only, llm-legal   -> apply
 *   otherwise                                  -> propose
 */
export function decideAction(current: CurrentState, out: { to_status: VendorStatus; to_stage: DiligenceStage | null; confidence: number }): Decision {
  let to_status = out.to_status;
  let to_stage: DiligenceStage | null = out.to_stage ?? null;
  if (to_stage && to_status !== "In Discussion") to_status = "In Discussion";
  if (to_status === "In Discussion" && !to_stage) to_stage = current.status === "In Discussion" ? current.stage : "responded";
  if (to_status !== "In Discussion") to_stage = null;

  const noChange = to_status === current.status && (to_stage ?? null) === (current.stage ?? null);
  if (noChange) return { to_status, to_stage, action: "none", reason: "no status change" };
  if (current.status === "In Discussion" && to_status === "In Discussion" && stageIndex(to_stage) <= stageIndex(current.stage)) {
    return { to_status, to_stage, action: "none", reason: `stage ${to_stage} does not advance past ${current.stage}` };
  }
  if (!isLegalTransition(current.status, to_status, "human")) {
    return { to_status, to_stage, action: "illegal", reason: `${current.status} -> ${to_status} is not a legal transition` };
  }
  if (to_stage && HUMAN_ONLY_STAGES.includes(to_stage)) {
    return { to_status, to_stage, action: "propose", reason: `stage ${to_stage} is always a human decision` };
  }
  if (out.confidence < LLM_AUTO_APPLY_THRESHOLD) {
    return { to_status, to_stage, action: "propose", reason: `confidence ${out.confidence.toFixed(2)} is below ${LLM_AUTO_APPLY_THRESHOLD}` };
  }
  if (!isLegalTransition(current.status, to_status, "llm_inference")) {
    return { to_status, to_stage, action: "propose", reason: `${current.status} -> ${to_status} needs a human` };
  }
  return { to_status, to_stage, action: "apply", reason: `confidence ${out.confidence.toFixed(2)} >= ${LLM_AUTO_APPLY_THRESHOLD}` };
}

const SYSTEM = `You classify inbound emails from data vendors for a sourcing tracker and propose the vendor's next status.

State machine (only these moves are possible from the states you will see):
- Replied -> In Discussion (with a stage) or Rejected
- In Discussion -> a later stage, or Rejected
- Stages inside In Discussion, in order: responded -> technical_review -> quote_received -> sampling. Never move backwards.
- Approved, Contacted, Qualified, Screened, Identified and Dormant are never proposed by you.

Decision guide:
- Agrees to talk, asks for a call, asks clarifying questions, answers our questions (even partially), asks for an NDA, asks about our budget or volume -> In Discussion / responded
- Sends technical details, spec sheets, capture setups, integration or evaluation specifics -> In Discussion / technical_review
- Sends a quote, price list, rate card or commercial proposal with numbers -> In Discussion / quote_received
- Offers or sends a sample dataset for evaluation -> In Discussion / sampling
- Declines, does not offer this, asks not to be contacted -> Rejected
- Out-of-office, auto-reply, bounce, wrong contact / redirect to someone else, empty or purely social content -> keep the current status and stage exactly as given (no change)

Fields:
- to_status, to_stage: the target state (to_stage null unless In Discussion; for no change repeat the current values).
- confidence: 0-1 that the email supports exactly this state. 0.9+ only for explicit statements; 0.6-0.85 when implied; below 0.6 when unsure.
- evidence_snippet: a verbatim quote (max 200 characters) from the email that supports the decision.
- summary: one sentence for the analyst, plain language, present tense.
Answer only with the JSON object required by the schema.`;

export function buildInferencePrompt(input: InferenceInput): string {
  const v = input.vendor;
  const lines = [
    `Vendor: ${v.name} (${v.vendor_type})`,
    `Current status: ${v.status}${v.stage ? ` / stage ${v.stage}` : ""}`,
  ];
  if (input.unknownMustFields?.length) lines.push(`Questions we asked them about: ${input.unknownMustFields.join(", ")}`);
  if (input.lastOutbound) {
    lines.push("", "Our last email:", `Subject: ${input.lastOutbound.subject ?? ""}`, input.lastOutbound.body.slice(0, 600));
  }
  lines.push(
    "",
    "Inbound email:",
    `From: ${input.message.from ?? "unknown"}`,
    `Date: ${input.message.date ?? "unknown"}`,
    `Subject: ${input.message.subject ?? ""}`,
    "",
    input.message.body.slice(0, 3000),
  );
  return lines.join("\n");
}

export async function inferStatus(input: InferenceInput): Promise<Inference> {
  const model = modelFor("status_inference");
  const res = await getAnthropic().messages.parse({
    model,
    max_tokens: 1000,
    output_config: {
      ...(supportsEffort(model) ? { effort: "medium" as const } : {}),
      format: zodOutputFormat(StatusInferenceOutput),
    },
    system: SYSTEM,
    messages: [{ role: "user", content: buildInferencePrompt(input) }],
  });
  const raw = res.parsed_output ? StatusInferenceOutput.parse(res.parsed_output) : null;
  if (!raw) throw new Error(`inference returned no parseable output (${res.stop_reason})`);
  const confidence = Math.max(0, Math.min(1, raw.confidence));
  const decision = decideAction({ status: input.vendor.status, stage: input.vendor.stage }, { to_status: raw.to_status, to_stage: raw.to_stage, confidence });
  return { ...decision, confidence, evidence_snippet: raw.evidence_snippet.slice(0, 300), summary: raw.summary.trim(), model, raw };
}
