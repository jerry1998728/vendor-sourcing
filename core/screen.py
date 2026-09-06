"""Pure screening: screen(vendor, evidence, ruleset) -> (result, reasons).

Three-valued.  For every must-criterion:
  * verified evidence present and rule evaluates false  -> fail
  * no verified evidence for the field                  -> unknown
  * verified evidence present and rule evaluates true   -> pass
Vendor-level: any must fail -> fail; else any must unknown -> unknown; else pass.
Should-criteria are evaluated and recorded but never reject.
Only evidence with verified=True is consulted.  Reasons are plain dicts with
sorted, deterministic contents so the same inputs always give the same output.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from core.models import Criterion, Evidence, Reason, Rule, Ruleset, ScreenResult, VendorCandidate

_TRUE = frozenset({"true", "yes", "y", "1"})
_FALSE = frozenset({"false", "no", "n", "0"})


def _norm(v: object) -> str:
    return str(v).strip().casefold()


def _expected(rule: Rule) -> object:
    if rule.op in ("in", "not_in", "none_in", "any_in"):
        return sorted(rule.values)
    if rule.op in ("count_gte", "gte"):
        return rule.min
    if rule.op == "lte":
        return rule.max
    if rule.op == "eq":
        return rule.value
    return None


def _eval_rule(rule: Rule, rows: list[Evidence]) -> dict:
    # highest confidence first, then oldest, then value — deterministic
    rows = sorted(rows, key=lambda e: (-(e.confidence or 0.0), e.observed_at, e.value))
    observed = sorted({e.value for e in rows})
    out: dict = {
        "field": rule.field,
        "op": rule.op,
        "expected": _expected(rule),
        "observed": observed,
        "evidence_ids": sorted(e.evidence_id for e in rows if e.evidence_id is not None),
        "result": "unknown",
    }
    if not rows:
        return out
    top = _norm(rows[0].value)
    vals = {_norm(v) for v in observed}
    exp = {_norm(v) for v in rule.values}
    res: bool | None
    op = rule.op
    if op == "exists":
        res = True
    elif op == "is_true":
        res = (top in _TRUE) if (top in _TRUE or top in _FALSE) else None
    elif op == "is_false":
        res = (top in _FALSE) if (top in _TRUE or top in _FALSE) else None
    elif op == "eq":
        res = top == _norm(rule.value)
    elif op == "in":
        res = top in exp
    elif op == "not_in":
        res = top not in exp
    elif op == "none_in":
        res = vals.isdisjoint(exp)
    elif op == "any_in":
        res = not vals.isdisjoint(exp)
    elif op == "count_gte":
        res = len(vals) >= float(rule.min or 0)
    elif op == "gte":
        try:
            res = float(top.replace(",", "")) >= float(rule.min or 0)
        except ValueError:
            res = None
    elif op == "lte":
        try:
            res = float(top.replace(",", "")) <= float(rule.max if rule.max is not None else 0)
        except ValueError:
            res = None
    else:
        raise ValueError(f"unknown rule op {op!r}")
    out["result"] = "unknown" if res is None else ("pass" if res else "fail")
    return out


def _combine(results: list[str], mode: str, min_pass: int | None = None) -> ScreenResult:
    if mode == "min_pass":
        need = int(min_pass or 1)
        n_pass, n_unknown = results.count("pass"), results.count("unknown")
        if n_pass >= need:
            return "pass"
        return "unknown" if n_pass + n_unknown >= need else "fail"
    if mode == "any":
        if "pass" in results:
            return "pass"
        return "unknown" if "unknown" in results else "fail"
    if "fail" in results:
        return "fail"
    return "unknown" if "unknown" in results else "pass"


def _eval_criterion(crit: Criterion, by_field: dict[str, list[Evidence]]) -> Reason:
    rules = [_eval_rule(r, by_field.get(r.field, [])) for r in crit.rules]
    return {
        "key": crit.key,
        "kind": crit.kind,
        "combine": crit.combine if crit.combine != "min_pass" else f"min_pass:{crit.min_pass}",
        "result": _combine([r["result"] for r in rules], crit.combine, crit.min_pass),
        "rules": rules,
    }


def screen(vendor: VendorCandidate, evidence: Iterable[Evidence], ruleset: Ruleset) -> tuple[ScreenResult, list[Reason]]:
    """Pure function of (evidence, ruleset).  `vendor` is accepted for the PRD
    contract but no vendor field is consulted, so verdicts are reproducible from
    the evidence table alone."""
    by_field: dict[str, list[Evidence]] = defaultdict(list)
    for e in evidence:
        if e.verified:
            by_field[e.field_path].append(e)
    reasons = [_eval_criterion(c, by_field) for c in (*ruleset.must, *ruleset.should)]
    must = [r["result"] for r in reasons if r["kind"] == "must"]
    result: ScreenResult = "fail" if "fail" in must else ("unknown" if "unknown" in must else "pass")
    return result, reasons


def must_field_coverage(reasons: Iterable[Reason]) -> float:
    """verified must-fields / total must-fields (a field counts as verified when
    verified evidence exists for it, whatever the verdict)."""
    fields: dict[str, bool] = {}
    for r in reasons:
        if r["kind"] != "must":
            continue
        for rule in r["rules"]:
            fields[rule["field"]] = fields.get(rule["field"], False) or rule["result"] != "unknown"
    if not fields:
        return 1.0
    return round(sum(fields.values()) / len(fields), 4)


def next_action_for(result: ScreenResult) -> str:
    return "outreach_to_verify" if result == "unknown" else "review"
