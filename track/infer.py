"""Status inference from reply threads (D2 PM).

For each new inbound interaction Claude returns strict JSON
{to_status, to_stage, confidence, evidence_snippet, summary} given the PRD Section 7 state
machine and the vendor's current status/stage.  The proposal is applied through
db.state.transition with actor=llm_inference when confidence >= 0.85 and to_stage is not
quote_received / sampling; otherwise it is stored as a pending row in `proposals` for the
status review queue.  Every proposal (auto-applied or not) is recorded in `proposals`.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from core.llm import LLM, LLMUnavailable
from db.state import (GateViolation, IllegalTransition, HUMAN_ONLY_STAGES, LLM_AUTO_THRESHOLD, STAGES, current_state,
                      transition, utcnow)

INFER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "to_status": {"type": "string", "enum": ["In Discussion", "Rejected", "none"]},
        "to_stage": {"type": ["string", "null"], "enum": [*STAGES, None]},
        "confidence": {"type": "number"},
        "evidence_snippet": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["to_status", "to_stage", "confidence", "evidence_snippet", "summary"],
    "additionalProperties": False,
}

STATE_MACHINE = """Identified -screen(auto)-> Screened -human-> Qualified -email sent-> Contacted -inbound(auto)-> Replied
Replied -> In Discussion (vendor engages) | Rejected (vendor declines)
In Discussion -> Approved | Rejected (human only)
diligence_stage inside In Discussion, forward only: responded -> technical_review -> quote_received -> sampling
quote_received and sampling are never applied automatically: they always go to a human.
Contacted -> Dormant after 10 days without a reply (system)."""

INFER_PROMPT = """You are tracking a vendor sourcing conversation and must propose the vendor's next pipeline transition.

STATE MACHINE
{state_machine}

Current status: {status} (diligence_stage: {stage})

Propose to_status:
  "In Discussion" - the vendor engages: answers questions, asks for a call, requests an NDA, offers specs, a quote or a sample
  "Rejected"      - the vendor declines, cannot supply, or is out of scope
  "none"          - no status change: auto-reply, bounce, wrong contact / forwarded, or too ambiguous
When to_status is "In Discussion", set to_stage to the furthest stage the email supports:
  responded        = a substantive reply (including call requests, NDA requests, partial answers)
  technical_review = technical details, specs or data formats are discussed
  quote_received   = pricing or a quote is provided
  sampling         = a sample / trial dataset is offered, being prepared or delivered
Stages only move forward; if the current stage is already further, keep the current stage.
confidence: your 0-1 belief. evidence_snippet: a short verbatim quote from the newest email that supports the proposal.
summary: one sentence for the sourcer.

THREAD (oldest first; OUT = our messages, IN = vendor messages)
{thread}

NEWEST INBOUND EMAIL:
{latest}
"""


class HeuristicLLM:
    """Keyword stand-in for Claude: offline demo + baseline for tests/run_replies.py.
    Reads the 'NEWEST INBOUND EMAIL:' section of the inference prompt."""
    model = "heuristic"

    RULES = [
        (("out of office", "auto-reply", "automatic reply", "autoreply", "delivery failed", "undeliverable", "mailbox unavailable",
          "no longer monitored", "away from the office"), "none", None, 0.95, "auto-reply or bounce"),
        (("not the right person", "wrong contact", "wrong person", "no longer with", "not responsible for", "have forwarded",
          "forwarded your", "please reach out to", "please contact"), "none", None, 0.85, "wrong contact / forwarded"),
        (("not interested", "unfortunately", "unable to", "decline", "not to pursue", "decided not", "cannot help", "do not offer",
          "only license", "cannot support", "won't be able", "will not be able"), "Rejected", None, 0.9, "vendor declines"),
        (("sample dataset", "sample data", "trial dataset", "pilot dataset", "sending you a sample", "share a sample", "sample set",
          "evaluation set"), "In Discussion", "sampling", 0.9, "sample offered"),
        (("quote", "quotation", "pricing", "price", "per hour", "per recorded hour", "$", "usd", "eur", "€", "cost"), "In Discussion",
         "quote_received", 0.9, "pricing provided"),
        (("nda", "non-disclosure", "mutual confidentiality"), "In Discussion", "responded", 0.86, "NDA requested"),
        (("spec", "resolution", "fps", "format", "technical", "calibration", "sensor", "baseline", "annotation", "schema", "imu"),
         "In Discussion", "technical_review", 0.88, "technical details"),
        (("happy to", "glad to", "yes", "we can", "call", "let's", "interested", "more information", "headquartered", "we collect",
          "will check", "get back to you"), "In Discussion", "responded", 0.86, "substantive reply"),
    ]

    def json(self, prompt: str, schema: dict[str, Any], **_: Any) -> dict[str, Any]:
        latest = prompt.split("NEWEST INBOUND EMAIL:")[-1].strip()
        low = latest.lower()
        for keys, status, stage, conf, why in self.RULES:
            hit = next((k for k in keys if k in low), None)
            if hit:
                i = low.find(hit)
                return {"summary": why, "to_status": status, "to_stage": stage, "confidence": conf,
                        "evidence_snippet": latest[max(0, i - 40): i + 60].strip()}
        return {"summary": "ambiguous reply", "to_status": "In Discussion", "to_stage": "responded", "confidence": 0.6,
                "evidence_snippet": latest[:80]}


def propose(llm: LLM | None, status: str, stage: str | None, thread: list[dict[str, str]],
            latest_body: str) -> dict[str, Any]:
    unavailable = {"summary": "no LLM proposal; read the reply and set the status manually", "to_status": "none",
                   "to_stage": None, "confidence": 0.0, "evidence_snippet": "", "llm_unavailable": True}
    if llm is None:
        return unavailable
    thread_txt = "\n".join(f"[{m['direction'].upper()}] {m['date']} {m['subject']}\n{m['body'][:1200]}\n" for m in thread) or "(no earlier messages)"
    try:
        data = llm.json(INFER_PROMPT.format(state_machine=STATE_MACHINE, status=status, stage=stage or "-",
                                            thread=thread_txt, latest=latest_body[:4000]), INFER_SCHEMA, effort="medium")
    except LLMUnavailable as exc:
        unavailable["summary"] = f"LLM unavailable ({exc}); read the reply and set the status manually"
        return unavailable
    data["confidence"] = max(0.0, min(1.0, float(data.get("confidence") or 0.0)))
    if data.get("to_stage") not in STAGES:
        data["to_stage"] = None
    if data.get("to_status") not in ("In Discussion", "Rejected", "none"):
        data["to_status"] = "none"
    return data


def _target(status: str, stage: str | None, proposal: dict[str, Any]) -> tuple[str | None, str | None]:
    """Translate a proposal into (to_status, to_stage) for transition(); (None, None) when nothing changes."""
    to_status, to_stage = proposal.get("to_status"), proposal.get("to_stage")
    if to_status == "none":
        return None, None
    if to_status == "Rejected":
        return "Rejected", None
    if status == "In Discussion":
        if to_stage and STAGES.index(to_stage) > (STAGES.index(stage) if stage in STAGES else -1):
            return "In Discussion", to_stage
        return None, None
    return "In Discussion", to_stage or STAGES[0]


def would_auto_apply(proposal: dict[str, Any]) -> bool:
    """Pure policy check used by tests/run_replies.py: threshold + never quote/sample."""
    return (not proposal.get("llm_unavailable") and float(proposal.get("confidence") or 0) >= LLM_AUTO_THRESHOLD
            and proposal.get("to_stage") not in HUMAN_ONLY_STAGES and proposal.get("to_status") != "none")


def record_proposal(conn: sqlite3.Connection, vendor_id: str, interaction_id: int | None, proposal: dict[str, Any],
                    to_status: str | None, to_stage: str | None, decision: str | None = None,
                    decided_by: str | None = None, event_id: int | None = None) -> int:
    now = utcnow()
    with conn:
        cur = conn.execute(
            "INSERT INTO proposals (vendor_id, interaction_id, to_status, to_stage, confidence, evidence_snippet, summary, "
            "decision, decided_by, decided_at, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (vendor_id, interaction_id, to_status, to_stage, proposal.get("confidence"), proposal.get("evidence_snippet"),
             proposal.get("summary"), decision, decided_by, now if decision else None, event_id, now))
        if interaction_id is not None:
            conn.execute("UPDATE interactions SET llm_summary = ? WHERE interaction_id = ?", (proposal.get("summary"), interaction_id))
    return int(cur.lastrowid)


def apply_proposal(conn: sqlite3.Connection, vendor_id: str, interaction_id: int | None, proposal: dict[str, Any]) -> dict[str, Any]:
    status, stage = current_state(vendor_id, conn)
    to_status, to_stage = _target(status, stage, proposal)
    if proposal.get("llm_unavailable"):
        pid = record_proposal(conn, vendor_id, interaction_id, proposal, None, None)
        return {"state": "pending", "proposal_id": pid, "reason": "no LLM proposal; human must read the reply"}
    if to_status is None:
        pid = record_proposal(conn, vendor_id, interaction_id, proposal, None, None, decision="no_change", decided_by="system")
        return {"state": "no_change", "proposal_id": pid, "reason": "proposal implies no transition"}
    if proposal["confidence"] >= LLM_AUTO_THRESHOLD and to_stage not in HUMAN_ONLY_STAGES:
        try:
            eid = transition(vendor_id, to_status, "llm_inference", reason=proposal.get("summary") or "llm proposal",
                             confidence=proposal["confidence"], evidence_ref=interaction_id, to_stage=to_stage,
                             payload={"proposal": proposal, "interaction_id": interaction_id}, conn=conn)
            pid = record_proposal(conn, vendor_id, interaction_id, proposal, to_status, to_stage, decision="auto_applied",
                                  decided_by="llm_inference", event_id=eid)
            return {"state": "auto_applied", "proposal_id": pid, "event_id": eid, "to_status": to_status, "to_stage": to_stage}
        except (GateViolation, IllegalTransition) as exc:
            reason = str(exc)
    else:
        reason = ("confidence below threshold" if proposal["confidence"] < LLM_AUTO_THRESHOLD
                  else f"stage {to_stage} always needs a human")
    pid = record_proposal(conn, vendor_id, interaction_id, proposal, to_status, to_stage)
    return {"state": "pending", "proposal_id": pid, "reason": reason, "to_status": to_status, "to_stage": to_stage}


def pending_proposals(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT p.*, v.name, v.status, i.subject, i.body_text, i.sent_at FROM proposals p JOIN vendors v USING (vendor_id) "
        "LEFT JOIN interactions i USING (interaction_id) WHERE p.decision IS NULL ORDER BY p.created_at DESC").fetchall()
    return [dict(r) for r in rows]


def proposals_by_interaction(conn: sqlite3.Connection, vendor_id: str) -> dict[int, list[dict[str, Any]]]:
    out: dict[int, list[dict[str, Any]]] = {}
    for r in conn.execute("SELECT * FROM proposals WHERE vendor_id = ? ORDER BY proposal_id", (vendor_id,)):
        if r["interaction_id"] is not None:
            out.setdefault(int(r["interaction_id"]), []).append(dict(r))
    return out


def resolve_proposal(conn: sqlite3.Connection, proposal_id: int, accept: bool, note: str = "",
                     actor: str = "human") -> dict[str, Any]:
    p = conn.execute("SELECT * FROM proposals WHERE proposal_id = ?", (proposal_id,)).fetchone()
    if p is None:
        raise KeyError(proposal_id)
    if p["decision"] is not None:
        raise ValueError("proposal is not pending")
    now = utcnow()
    if not accept:
        with conn:
            conn.execute("UPDATE proposals SET decision = 'rejected', decided_by = ?, decided_at = ? WHERE proposal_id = ?",
                         (actor, now, proposal_id))
        return {"state": "rejected"}
    status, stage = current_state(p["vendor_id"], conn)
    to_status, to_stage = _target(status, stage, {"to_status": p["to_status"] or "none", "to_stage": p["to_stage"]})
    if to_status is None:
        with conn:
            conn.execute("UPDATE proposals SET decision = 'no_change', decided_by = ?, decided_at = ? WHERE proposal_id = ?",
                         (actor, now, proposal_id))
        return {"state": "no_change"}
    eid = transition(p["vendor_id"], to_status, actor, reason=f"accepted proposal #{proposal_id}: {p['summary'] or ''} {note}".strip(),
                     confidence=p["confidence"], evidence_ref=p["interaction_id"], to_stage=to_stage,
                     payload={"proposal_id": proposal_id}, conn=conn)
    with conn:
        conn.execute("UPDATE proposals SET decision = 'accepted', decided_by = ?, decided_at = ?, event_id = ? WHERE proposal_id = ?",
                     (actor, now, eid, proposal_id))
    return {"state": "accepted", "event_id": eid, "to_status": to_status, "to_stage": to_stage}
