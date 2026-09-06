"""Outreach drafting: an LLM draft that must cite >=1 evidenced fact, with a deterministic
template fallback so the stage works without API access.  Drafts are stored as
`interactions` rows with direction='draft'; nothing is sent from here."""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from core.llm import LLM, LLMUnavailable
from db.state import utcnow

DRAFT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "body": {"type": "string"},
        "cited_evidence_ids": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["subject", "body", "cited_evidence_ids"],
    "additionalProperties": False,
}

DRAFT_PROMPT = """Write a short, professional first-contact email from {sender_name} ({sender_org}) to the vendor below.
Goal: {goal}
Cite at least one specific fact from the EVIDENCE list (quote or paraphrase it and reference it by evidence_id in
cited_evidence_ids). Do not claim anything about the vendor that is not in the evidence.
{ask}
Plain text, under 180 words, no placeholders like [Name]. Sign off as {sender_name}.

VENDOR: {name} ({vendor_id}), type {vendor_type}, website {primary_domain}
EVIDENCE (verified; field_path = value):
{evidence}
"""

ASK_VERIFY = """This vendor is flagged next_action = outreach_to_verify: ask explicitly, one question each, about these
unknown must-fields so the reply can settle them:
{questions}"""
ASK_GENERAL = "Ask for an overview of their offering, typical volumes and commercial model, and propose a short call."

QUESTIONS = {
    "stereo_camera": "Do you collect with stereo (dual-lens) camera rigs, and which hardware?",
    "entity_outside_china": "Where is your company registered / headquartered?",
    "collection_outside_china": "In which countries do you collect data?",
    "attributable_public_entity": "Which legal entity would we be contracting with?",
    "merged_prs_public": "Roughly how many merged pull requests does your production codebase carry?",
    "not_fork_or_tutorial": "Is this a production codebase rather than a demo, tutorial or fork?",
    "recently_active": "Is the codebase under active development today?",
}

GOALS = {
    "ego_data_supplier": "start a conversation about licensing or commissioning egocentric (first-person) video data "
                         "collected with stereo camera rigs, and confirm entity location and collection geography.",
    "repo_owner": "explore licensing production-grade code data (private repositories with substantial merged PR "
                  "history) for AI training, and confirm scale and ownership.",
}


def vendor_context(conn: sqlite3.Connection, vendor_id: str) -> dict[str, Any]:
    v = conn.execute("SELECT * FROM vendors WHERE vendor_id = ?", (vendor_id,)).fetchone()
    if v is None:
        raise KeyError(vendor_id)
    ev = conn.execute("SELECT * FROM evidence WHERE vendor_id = ? AND verified = 1 ORDER BY confidence DESC, evidence_id",
                      (vendor_id,)).fetchall()
    reasons = json.loads(v["screen_reasons"] or "[]")
    unknown = [r["key"] for r in reasons if r["kind"] == "must" and r["result"] == "unknown"]
    created = conn.execute("SELECT payload FROM events WHERE vendor_id = ? AND from_status IS NULL", (vendor_id,)).fetchone()
    src = None
    if created and created["payload"]:
        src = json.loads(created["payload"]).get("source_url")
    return {"vendor": dict(v), "evidence": [dict(e) for e in ev], "unknown_must": unknown, "source_url": src,
            "ask_unknowns": (v["next_action"] == "outreach_to_verify") and bool(unknown)}


def template_draft(ctx: dict[str, Any], sender_name: str, sender_org: str) -> dict[str, Any]:
    v, ev = ctx["vendor"], ctx["evidence"]
    facts = [e for e in ev if e["field_path"] not in ("contact.email",)]
    cited: list[int] = []
    if facts:
        f = facts[0]
        fact_line = f'I noticed on {f["source_url"]} that "{(f["snippet"] or f["value"])[:160]}".'
        cited = [f["evidence_id"]]
    else:
        fact_line = f"I came across your site at {ctx.get('source_url') or v['primary_domain']}."
    qs = [QUESTIONS.get(k, f"Could you tell us more about: {k.replace('_', ' ')}?") for k in ctx["unknown_must"]] \
        if ctx["ask_unknowns"] else []
    if not qs:
        qs = ["Could you share an overview of your offering, typical volumes and commercial model?"]
    body = (f"Hello {v['name']} team,\n\n"
            f"I'm {sender_name} at {sender_org}. {fact_line}\n\n"
            f"We are sourcing {'egocentric video data collected with stereo camera rigs' if v['vendor_type'] == 'ego_data_supplier' else 'production-grade code data'} "
            f"for AI training and would like to learn more. A few quick questions:\n"
            + "".join(f"- {q}\n" for q in qs)
            + f"\nIf this is of interest, I'd be glad to set up a short call.\n\nBest regards,\n{sender_name}\n{sender_org}")
    subject = f"{sender_org} — sourcing enquiry for {v['name']}"
    return {"subject": subject, "body": body, "cited_evidence_ids": cited, "method": "template"}


def llm_draft(ctx: dict[str, Any], llm: LLM, sender_name: str, sender_org: str) -> dict[str, Any]:
    v, ev = ctx["vendor"], ctx["evidence"]
    if not ev:
        raise LLMUnavailable("no verified evidence to cite")
    evidence_txt = "\n".join(f"- evidence_id={e['evidence_id']} {e['field_path']} = {e['value']} "
                             f"(source {e['source_url']}) snippet: \"{(e['snippet'] or '')[:200]}\"" for e in ev)
    if ctx["ask_unknowns"]:
        ask = ASK_VERIFY.format(questions="\n".join(
            f"- {k}: {QUESTIONS.get(k, 'ask about ' + k.replace('_', ' '))}" for k in ctx["unknown_must"]))
    else:
        ask = ASK_GENERAL
    prompt = DRAFT_PROMPT.format(sender_name=sender_name, sender_org=sender_org,
                                 goal=GOALS.get(v["vendor_type"], "start a sourcing conversation"),
                                 name=v["name"], vendor_id=v["vendor_id"], vendor_type=v["vendor_type"],
                                 primary_domain=v["primary_domain"], evidence=evidence_txt, ask=ask)
    data = llm.json(prompt, DRAFT_SCHEMA, effort="medium")
    valid_ids = {e["evidence_id"] for e in ev}
    cited = [int(i) for i in data.get("cited_evidence_ids", []) if int(i) in valid_ids]
    if not cited or not data.get("body", "").strip() or not data.get("subject", "").strip():
        raise LLMUnavailable("draft did not cite verified evidence")
    return {"subject": data["subject"].strip(), "body": data["body"].strip(), "cited_evidence_ids": cited, "method": "llm"}


def draft_email(conn: sqlite3.Connection, vendor_id: str, llm: LLM | None = None,
                sender_name: str = "Jerry", sender_org: str = "the sourcing team") -> dict[str, Any]:
    ctx = vendor_context(conn, vendor_id)
    if llm is not None:
        try:
            return llm_draft(ctx, llm, sender_name, sender_org)
        except LLMUnavailable as exc:
            d = template_draft(ctx, sender_name, sender_org)
            d["fallback_reason"] = str(exc)
            return d
    return template_draft(ctx, sender_name, sender_org)


def save_draft(conn: sqlite3.Connection, vendor_id: str, draft: dict[str, Any]) -> int:
    meta = {"cited_evidence_ids": draft.get("cited_evidence_ids", []), "method": draft.get("method"),
            "fallback_reason": draft.get("fallback_reason")}
    with conn:
        cur = conn.execute(
            "INSERT INTO interactions (vendor_id, gmail_thread_id, direction, sent_at, subject, body_text, llm_summary) "
            "VALUES (?, NULL, 'draft', ?, ?, ?, ?)",
            (vendor_id, utcnow(), draft["subject"], draft["body"], json.dumps(meta)))
    return int(cur.lastrowid)


def draft_all(conn: sqlite3.Connection, llm: LLM | None = None, sender_name: str = "Jerry",
              sender_org: str = "the sourcing team", redo: bool = False) -> list[dict[str, Any]]:
    """Draft for every Qualified vendor without a draft (or all, with redo).  Stored as direction='draft'."""
    out = []
    for v in conn.execute("SELECT vendor_id FROM vendors WHERE status = 'Qualified' ORDER BY coverage_confidence DESC, name"):
        if not redo and latest_draft(conn, v["vendor_id"]):
            continue
        d = draft_email(conn, v["vendor_id"], llm, sender_name, sender_org)
        d["interaction_id"] = save_draft(conn, v["vendor_id"], d)
        d["vendor_id"] = v["vendor_id"]
        out.append(d)
    return out


def latest_draft(conn: sqlite3.Connection, vendor_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM interactions WHERE vendor_id = ? AND direction = 'draft' "
                        "ORDER BY interaction_id DESC LIMIT 1", (vendor_id,)).fetchone()
