#!/usr/bin/env python3
"""Status-inference accuracy on tests/replies/*.json (PRD S4 target: >= 8/10) and which cases route to proposals.

    .venv/bin/python tests/run_replies.py              # Claude (needs ANTHROPIC_API_KEY)
    .venv/bin/python tests/run_replies.py --heuristic  # offline keyword baseline
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")
from core.llm import LLM  # noqa: E402
from track.infer import HeuristicLLM, propose, would_auto_apply  # noqa: E402


def route_of(p: dict) -> str:
    if p.get("to_status") == "none" and not p.get("llm_unavailable"):
        return "none"
    return "auto" if would_auto_apply(p) else "proposal"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--heuristic", action="store_true")
    args = ap.parse_args()
    llm = HeuristicLLM() if args.heuristic else LLM()
    cases = [json.loads(p.read_text()) for p in sorted((ROOT / "tests" / "replies").glob("*.json"))]
    ok = 0
    to_proposals: list[str] = []
    for case in cases:
        exp = case["expect"]
        thread = [{"direction": "out", "date": "", "subject": "sourcing enquiry", "body": "Hello, we are sourcing data..."}]
        p = propose(llm, case["current_status"], case["current_stage"], thread, case["body"])
        got = (p["to_status"], p["to_stage"])
        hit = got == (exp["to_status"], exp["to_stage"])
        if not hit and exp["to_status"] == "In Discussion" == p["to_status"] and exp["to_stage"] == case["current_stage"] and p["to_stage"] in (None, case["current_stage"]):
            hit = True  # keeping the current stage counts as correct when that is the expectation
        route = route_of(p)
        if route == "proposal":
            to_proposals.append(case["name"])
        ok += hit
        print(f"[{'ok ' if hit else 'MISS'}] #{case['id']:>2} {case['name']:<16} got {p['to_status']}/{p['to_stage']} conf={p['confidence']:.2f} "
              f"route={route:<8} expected {exp['to_status']}/{exp['to_stage']} route={case['expect_route']}")
    print(f"\naccuracy: {ok}/{len(cases)}  ({getattr(llm, 'model', '?')})")
    print(f"routed to proposals (human review): {to_proposals or 'none'}")
    return 0 if ok >= 8 else 1


if __name__ == "__main__":
    sys.exit(main())
