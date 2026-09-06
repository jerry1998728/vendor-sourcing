"""Approve + send (D2 AM): the human gate for Qualified -> Contacted.

do_not_send guard: unless OUTREACH_GO_LIVE=1, a recipient must be in DEMO_ALLOWED_RECIPIENTS
(comma-separated, .env) — this keeps demo sends inside inboxes the sourcer controls."""
from __future__ import annotations

import json
import os
import sqlite3
from typing import Any

from db.state import transition, utcnow


class SendBlocked(PermissionError):
    pass


def allowed_recipients() -> set[str]:
    raw = os.environ.get("DEMO_ALLOWED_RECIPIENTS") or os.environ.get("OUTREACH_ALLOWED_RECIPIENTS") or ""
    return {x.strip().lower() for x in raw.split(",") if x.strip()}


def go_live() -> bool:
    return os.environ.get("OUTREACH_GO_LIVE", "").strip().lower() in ("1", "true", "yes")


def is_allowed(to: str | None) -> bool:
    to = (to or "").strip().lower()
    return bool(to) and "@" in to and (go_live() or to in allowed_recipients())


def check_recipient(to: str) -> None:
    to = (to or "").strip().lower()
    if not to or "@" not in to:
        raise SendBlocked("recipient email is missing or invalid")
    if not is_allowed(to):
        raise SendBlocked(f"{to} is not in DEMO_ALLOWED_RECIPIENTS and OUTREACH_GO_LIVE is not set (do_not_send guard)")


def approve_and_send(conn: sqlite3.Connection, vendor_id: str, to: str, subject: str, body: str, gmail: Any,
                     draft_interaction_id: int | None = None, actor: str = "human") -> dict[str, Any]:
    """Send via the Gmail client, write interactions(direction=outbound, gmail_thread_id), transition to Contacted."""
    check_recipient(to)
    v = conn.execute("SELECT status FROM vendors WHERE vendor_id = ?", (vendor_id,)).fetchone()
    if v is None:
        raise KeyError(vendor_id)
    if v["status"] != "Qualified":
        raise SendBlocked(f"vendor is {v['status']}, only Qualified vendors can be contacted")
    if not subject.strip() or not body.strip():
        raise SendBlocked("subject and body are required")
    sent = gmail.send(to=to, subject=subject, body=body)
    meta = {"gmail_message_id": sent["message_id"], "draft_interaction_id": draft_interaction_id, "to": to}
    with conn:
        cur = conn.execute(
            "INSERT INTO interactions (vendor_id, gmail_thread_id, direction, sent_at, subject, body_text, llm_summary) "
            "VALUES (?, ?, 'outbound', ?, ?, ?, ?)",
            (vendor_id, sent["thread_id"], utcnow(), subject, body, json.dumps(meta)))
        conn.execute("UPDATE vendors SET contact_email = ?, next_action = 'await_reply', updated_at = ? WHERE vendor_id = ?",
                     (to, utcnow(), vendor_id))
    interaction_id = int(cur.lastrowid)
    event_id = transition(vendor_id, "Contacted", actor, reason=f"outreach email sent to {to}",
                          evidence_ref=interaction_id, payload={"gmail_thread_id": sent["thread_id"]}, conn=conn)
    return {"interaction_id": interaction_id, "event_id": event_id, **sent}
