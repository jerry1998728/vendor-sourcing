"""TRACK stage, step 1 (D2 PM): poll Gmail threads.

For every vendor with a stored gmail_thread_id, fetch messages that are not yet in
`interactions`, insert them with direction='inbound', and on the first inbound message move
Contacted -> Replied with actor=system.  Each new inbound then goes through track.infer.
P1 dormancy: Contacted with no reply for N days -> Dormant (system).
"""
from __future__ import annotations

import email.utils
import json
import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from core.llm import LLM
from db.state import current_state, transition, utcnow
from outreach.gmail_client import strip_quoted_reply
from track.infer import apply_proposal, propose

log = logging.getLogger("track.poll")
TRACKED = ("Contacted", "Replied", "In Discussion")


def _addr(s: str) -> str:
    return (email.utils.parseaddr(s or "")[1] or s or "").strip().lower()


def thread_for_prompt(conn: sqlite3.Connection, thread_id: str) -> list[dict[str, str]]:
    rows = conn.execute("SELECT direction, sent_at, subject, body_text FROM interactions WHERE gmail_thread_id = ? "
                        "AND direction IN ('outbound', 'inbound') ORDER BY sent_at, interaction_id", (thread_id,)).fetchall()
    return [{"direction": "out" if r["direction"] == "outbound" else "in", "date": r["sent_at"] or "",
             "subject": r["subject"] or "", "body": r["body_text"] or ""} for r in rows]


def poll(conn: sqlite3.Connection, gmail: Any, llm: LLM | None, dormant_days: int = 10,
         now: datetime | None = None) -> dict[str, int]:
    now = now or datetime.now(timezone.utc)
    own = _addr(gmail.profile_email())
    counts = {"threads": 0, "inbound_new": 0, "replied": 0, "auto_applied": 0, "pending": 0, "no_change": 0, "dormant": 0}
    threads = conn.execute(
        "SELECT DISTINCT i.vendor_id, i.gmail_thread_id FROM interactions i JOIN vendors v USING (vendor_id) "
        "WHERE i.direction = 'outbound' AND i.gmail_thread_id IS NOT NULL AND v.status IN (?, ?, ?)", TRACKED).fetchall()
    for t in threads:
        counts["threads"] += 1
        vendor_id, thread_id = t["vendor_id"], t["gmail_thread_id"]
        known = {r[0] for r in conn.execute(
            "SELECT json_extract(payload, '$.gmail_message_id') FROM events WHERE vendor_id = ? AND payload LIKE '%gmail_message_id%'",
            (vendor_id,))}
        known |= {r[0] for r in conn.execute(
            "SELECT json_extract(llm_summary, '$.gmail_message_id') FROM interactions WHERE gmail_thread_id = ? AND direction = 'inbound' "
            "AND json_valid(llm_summary)", (thread_id,))}
        known.discard(None)
        try:
            messages = gmail.list_thread_messages(thread_id)
        except Exception as exc:  # network / auth: keep polling the other threads
            log.error("thread %s: %s", thread_id, exc)
            continue
        for m in messages:
            mid = m["message_id"]
            if mid in known or _addr(m["from"]) == own:
                continue
            body = strip_quoted_reply(m["body_text"])
            with conn:
                cur = conn.execute(
                    "INSERT INTO interactions (vendor_id, gmail_thread_id, direction, sent_at, subject, body_text, llm_summary) "
                    "VALUES (?, ?, 'inbound', ?, ?, ?, ?)",
                    (vendor_id, thread_id, m["date"], m["subject"], body, json.dumps({"gmail_message_id": mid, "from": m["from"]})))
            interaction_id = int(cur.lastrowid)
            known.add(mid)
            counts["inbound_new"] += 1
            status, stage = current_state(vendor_id, conn)
            if status == "Contacted":
                transition(vendor_id, "Replied", "system", reason=f"inbound email from {m['from']}", evidence_ref=interaction_id,
                           payload={"gmail_message_id": mid}, conn=conn)
                counts["replied"] += 1
                status, stage = "Replied", None
            proposal = propose(llm, status, stage, thread_for_prompt(conn, thread_id), body)
            decision = apply_proposal(conn, vendor_id, interaction_id, proposal)
            with conn:  # keep the message id retrievable for dedup on the next poll
                conn.execute("UPDATE interactions SET llm_summary = ? WHERE interaction_id = ?",
                             (json.dumps({"gmail_message_id": mid, "from": m["from"], "summary": proposal.get("summary"),
                                          "proposal_id": decision.get("proposal_id"), "state": decision["state"]}), interaction_id))
            counts[decision["state"] if decision["state"] in counts else "no_change"] += 1
            with conn:
                conn.execute("UPDATE vendors SET next_action = ?, updated_at = ? WHERE vendor_id = ?",
                             ("review_proposal" if decision["state"] == "pending" else "follow_up", utcnow(), vendor_id))
    cutoff = (now - timedelta(days=dormant_days)).isoformat(timespec="seconds")
    for v in conn.execute("SELECT vendor_id FROM vendors WHERE status = 'Contacted'"):
        last_out = conn.execute("SELECT max(sent_at) FROM interactions WHERE vendor_id = ? AND direction = 'outbound'",
                                (v["vendor_id"],)).fetchone()[0]
        if last_out and last_out < cutoff:
            transition(v["vendor_id"], "Dormant", "system", reason=f"no reply in {dormant_days} days", conn=conn)
            with conn:
                conn.execute("UPDATE vendors SET next_action = 'follow_up_or_close', updated_at = ? WHERE vendor_id = ?",
                             (utcnow(), v["vendor_id"]))
            counts["dormant"] += 1
    return counts
