"""Human-gate actions (review queue, status review, board edits).  Every status
change goes through db.state.transition / revert_event, so it lands in `events`."""
from __future__ import annotations

import sqlite3
from collections import OrderedDict

from db.state import revert_event, transition, utcnow

REJECT_REASON_CODES: "OrderedDict[str, str]" = OrderedDict([
    ("in_china", "Entity or collection geography inside China"),
    ("no_stereo", "No stereo capture capability"),
    ("not_a_vendor", "Not a vendor (aggregator, article, research page)"),
    ("not_production_grade", "Codebase is toy / not production-grade"),
    ("out_of_scope", "Out of scope for this brief"),
    ("no_response", "No response after outreach"),
    ("pricing", "Pricing / commercial terms"),
    ("duplicate", "Duplicate of another vendor"),
    ("other", "Other (see note)"),
])


def _set(conn: sqlite3.Connection, vendor_id: str, **cols: object) -> None:
    cols["updated_at"] = utcnow()
    with conn:
        conn.execute(f"UPDATE vendors SET {', '.join(f'{c} = ?' for c in cols)} WHERE vendor_id = ?",
                     (*cols.values(), vendor_id))


def qualify(conn: sqlite3.Connection, vendor_id: str, note: str = "", actor: str = "human") -> int:
    eid = transition(vendor_id, "Qualified", actor, reason=f"qualified: {note}".strip(": ") or "qualified", conn=conn)
    _set(conn, vendor_id, next_action="draft_outreach")
    return eid


def need_info(conn: sqlite3.Connection, vendor_id: str, note: str = "", actor: str = "human") -> int:
    eid = transition(vendor_id, "Qualified", actor, reason=f"need info: {note}".strip(": ") or "need info", conn=conn)
    _set(conn, vendor_id, next_action="outreach_to_verify")
    return eid


def reject(conn: sqlite3.Connection, vendor_id: str, reason_code: str, note: str = "", actor: str = "human") -> int:
    if reason_code not in REJECT_REASON_CODES:
        raise ValueError(f"reason_code must be one of {list(REJECT_REASON_CODES)}")
    reason = f"{reason_code}: {note}" if note else reason_code
    eid = transition(vendor_id, "Rejected", actor, reason=reason, conn=conn)
    _set(conn, vendor_id, next_action=None, due_at=None)
    return eid


def approve(conn: sqlite3.Connection, vendor_id: str, note: str = "", actor: str = "human") -> int:
    eid = transition(vendor_id, "Approved", actor, reason=f"approved: {note}".strip(": ") or "approved", conn=conn)
    _set(conn, vendor_id, next_action=None)
    return eid


def reopen(conn: sqlite3.Connection, vendor_id: str, reason: str, actor: str = "human") -> int:
    eid = transition(vendor_id, "Qualified", actor, reason=f"reopen: {reason}", conn=conn)
    _set(conn, vendor_id, next_action="draft_outreach")
    return eid


def revert(conn: sqlite3.Connection, event_id: int, reason: str = "reverted by human") -> int:
    return revert_event(event_id, actor="human", reason=reason, conn=conn)


def set_plan(conn: sqlite3.Connection, vendor_id: str, owner: str | None = None, due_at: str | None = None,
             next_action: str | None = None) -> None:
    _set(conn, vendor_id, owner=owner or None, due_at=due_at or None, next_action=next_action or None)
