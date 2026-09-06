/**
 * Pure three-valued screening. No IO, no DB. Only verified evidence counts.
 *
 *   must-field with verified evidence failing its threshold  -> fail
 *   must-field missing or only unverified evidence            -> unknown
 *   every must-field passes                                    -> pass
 */
import type { ScreenReason, ScreenResult } from "@/lib/db/schema";
import type { VendorType } from "./types";

export const RULE_OPS = [
  "eq",
  "neq",
  "in",
  "not_in",
  "gte",
  "lte",
  "count_gte",
  "present",
  "is_true",
  "is_false",
] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export type FieldRule = {
  field_path: string;
  op: RuleOp;
  value?: string | number | readonly string[];
  description?: string;
};

export type MustRule = FieldRule & { id: string };

export type ShouldRule = {
  id: string;
  weight: number;
  description?: string;
  /** satisfied when any listed rule passes */
  any_of: FieldRule[];
};

export type ExtractField = {
  path: string;
  description: string;
  type: "string" | "country" | "list" | "enum" | "number" | "boolean";
  values?: readonly string[];
};

export type Ruleset = {
  name: string;
  version: string;
  /** "<name>@<version>", stored on runs.ruleset_version */
  ruleset_version: string;
  vendor_type: VendorType;
  description: string;
  must: MustRule[];
  should: ShouldRule[];
  /** extraction catalog the adapters prompt for */
  fields: ExtractField[];
};

export type EvidenceLike = {
  evidence_id?: number;
  field_path: string;
  value: string | null;
  verified: boolean;
  confidence: number;
  proxy?: boolean;
};

export type VendorLike = {
  vendor_id: string;
  name: string;
  vendor_type: string;
};

export type ScreenOutcome = {
  result: ScreenResult;
  reasons: ScreenReason[];
  /** mean over must-fields of the best verified confidence (0 when uncovered) */
  coverageConfidence: number;
  /** share of must-fields that have any verified evidence */
  mustFieldCoverage: number;
  /** weighted share of should-rules satisfied */
  shouldScore: number;
  unknownMustFields: string[];
};

const norm = (v: string) => v.trim().toLowerCase();

function numeric(v: string): number | null {
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function asList(v: FieldRule["value"]): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return (v as readonly string[]).map((x) => norm(String(x)));
  return [norm(String(v))];
}

function verifiedRows(rule: FieldRule, evidence: EvidenceLike[]): EvidenceLike[] {
  return evidence.filter(
    (e) =>
      e.field_path === rule.field_path &&
      e.verified &&
      e.value !== null &&
      e.value.trim() !== "",
  );
}

type Evaluation = { outcome: ScreenResult; detail: string; observed: string[]; rows: EvidenceLike[] };

export function evaluateRule(rule: FieldRule, evidence: EvidenceLike[]): Evaluation {
  const rows = verifiedRows(rule, evidence);
  const observed = [...new Set(rows.map((r) => norm(r.value as string)))];
  const fp = rule.field_path;
  const done = (outcome: ScreenResult, detail: string): Evaluation => ({
    outcome,
    detail,
    observed,
    rows,
  });

  if (observed.length === 0) {
    return done("unknown", `no verified evidence for ${fp}`);
  }
  const expected = asList(rule.value);
  const shown = observed.slice(0, 5).join(", ");

  switch (rule.op) {
    case "eq":
      return observed.includes(expected[0] ?? "")
        ? done("pass", `${fp} = ${expected[0]}`)
        : done("fail", `${fp} is ${shown}, expected ${expected[0]}`);
    case "neq":
      return observed.includes(expected[0] ?? "")
        ? done("fail", `${fp} = ${expected[0]}`)
        : done("pass", `${fp} is ${shown}, not ${expected[0]}`);
    case "in":
      return observed.some((v) => expected.includes(v))
        ? done("pass", `${fp} in [${expected.join(", ")}]`)
        : done("fail", `${fp} is ${shown}, not in [${expected.join(", ")}]`);
    case "not_in":
      return observed.some((v) => expected.includes(v))
        ? done("fail", `${fp} is ${shown}, which is in [${expected.join(", ")}]`)
        : done("pass", `${fp} is ${shown}, not in [${expected.join(", ")}]`);
    case "gte":
    case "lte": {
      const nums = observed.map(numeric).filter((n): n is number => n !== null);
      if (nums.length === 0) return done("unknown", `${fp} has no numeric value (${shown})`);
      const threshold = Number(rule.value);
      const ok = rule.op === "gte" ? nums.some((n) => n >= threshold) : nums.some((n) => n <= threshold);
      return ok
        ? done("pass", `${fp} ${rule.op} ${threshold} (${nums.join(", ")})`)
        : done("fail", `${fp} is ${nums.join(", ")}, needs ${rule.op} ${threshold}`);
    }
    case "count_gte": {
      const need = Number(rule.value);
      return observed.length >= need
        ? done("pass", `${fp} has ${observed.length} distinct values (need ${need})`)
        : done("fail", `${fp} has ${observed.length} distinct values, need ${need}`);
    }
    case "present":
      return done("pass", `${fp} present: ${shown}`);
    case "is_true":
      return observed.some((v) => ["true", "yes", "1"].includes(v))
        ? done("pass", `${fp} is true`)
        : done("fail", `${fp} is ${shown}, expected true`);
    case "is_false":
      return observed.some((v) => ["false", "no", "0"].includes(v))
        ? done("pass", `${fp} is false`)
        : done("fail", `${fp} is ${shown}, expected false`);
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Weighted share of should-rules satisfied (0..1). Used for ranking, never for pass/fail. */
export function scoreShould(evidence: EvidenceLike[], ruleset: Ruleset): number {
  let weightSum = 0;
  let scoreSum = 0;
  for (const should of ruleset.should) {
    weightSum += should.weight;
    if (should.any_of.some((r) => evaluateRule(r, evidence).outcome === "pass")) scoreSum += should.weight;
  }
  return round3(weightSum ? scoreSum / weightSum : 0);
}

export function screen(
  vendor: VendorLike,
  evidence: EvidenceLike[],
  ruleset: Ruleset,
): ScreenOutcome {
  if (vendor.vendor_type !== ruleset.vendor_type) {
    throw new Error(
      `ruleset ${ruleset.ruleset_version} is for ${ruleset.vendor_type}, vendor ${vendor.vendor_id} is ${vendor.vendor_type}`,
    );
  }

  const reasons: ScreenReason[] = [];
  const unknownMustFields: string[] = [];
  let anyFail = false;
  let anyUnknown = false;
  let covered = 0;
  let confidenceSum = 0;

  for (const rule of ruleset.must) {
    const ev = evaluateRule(rule, evidence);
    reasons.push({
      rule_id: rule.id,
      kind: "must",
      field_path: rule.field_path,
      outcome: ev.outcome,
      detail: ev.detail,
      observed: ev.observed,
      evidence_ids: ev.rows
        .map((r) => r.evidence_id)
        .filter((id): id is number => typeof id === "number"),
    });
    if (ev.rows.length > 0) {
      covered += 1;
      confidenceSum += Math.max(...ev.rows.map((r) => r.confidence));
    }
    if (ev.outcome === "fail") anyFail = true;
    else if (ev.outcome === "unknown") {
      anyUnknown = true;
      unknownMustFields.push(rule.field_path);
    }
  }

  let weightSum = 0;
  let scoreSum = 0;
  for (const should of ruleset.should) {
    const evals = should.any_of.map((r) => evaluateRule(r, evidence));
    const outcome: ScreenResult = evals.some((e) => e.outcome === "pass")
      ? "pass"
      : evals.every((e) => e.outcome === "unknown")
        ? "unknown"
        : "fail";
    weightSum += should.weight;
    if (outcome === "pass") scoreSum += should.weight;
    reasons.push({
      rule_id: should.id,
      kind: "should",
      field_path: should.any_of.map((r) => r.field_path).join("|"),
      outcome,
      detail: evals.map((e) => e.detail).join("; "),
      observed: [...new Set(evals.flatMap((e) => e.observed))],
      evidence_ids: [
        ...new Set(
          evals.flatMap((e) =>
            e.rows
              .map((r) => r.evidence_id)
              .filter((id): id is number => typeof id === "number"),
          ),
        ),
      ],
    });
  }

  const mustCount = ruleset.must.length;
  return {
    result: anyFail ? "fail" : anyUnknown ? "unknown" : "pass",
    reasons,
    coverageConfidence: round3(mustCount ? confidenceSum / mustCount : 1),
    mustFieldCoverage: round3(mustCount ? covered / mustCount : 1),
    shouldScore: round3(weightSum ? scoreSum / weightSum : 0),
    unknownMustFields,
  };
}
