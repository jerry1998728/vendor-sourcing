"""Vendor state machine (PRD Section 7).

Status changes happen ONLY through `transition()`, which validates the move
against the whitelist, enforces the human/LLM gates, appends an `events` row
and then mirrors the new status onto `vendors.status`.  `rebuild_status()`
replays the event log and asserts that the mirror is faithful.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from db.init import get_conn

# --- vocabulary ---------------------------------------------------------------

STATUSES: tuple[str, ...] = (
    "Identified", "Screened", "Qualified", "Contacted", "Replied",
    "In Discussion", "Approved", "Rejected", "Dormant",
)
INITIAL_STATUS = "Identified"

# diligence_stage lives inside "In Discussion" and only ever moves forward
STAGES: tuple[str, ...] = ("responded", "technical_review", "quote_received", "sampling")
HUMAN_ONLY_STAGES = frozenset({"quote_received", "sampling"})
LLM_AUTO_STAGES = frozenset({"responded", "technical_review"})

# Transition whitelist (from -> allowed to).  "Any -> Approved / Rejected" is
# human-only; "Rejected / Dormant -> Qualified" is the human reopen path.
TRANSITIONS: dict[str, frozenset[str]] = {
    "Identified":    frozenset({"Screened", "Approved", "Rejected"}),
    "Screened":      frozenset({"Qualified", "Rejected", "Approved"}),
    "Qualified":     frozenset({"Contacted", "Rejected", "Approved"}),
    "Contacted":     frozenset({"Replied", "Dormant", "Rejected", "Approved"}),
    "Replied":       frozenset({"In Discussion", "Rejected", "Approved"}),
    "In Discussion": frozenset({"Approved", "Rejected"}),
    "Approved":      frozenset({"Rejected"}),
    "Rejected":      frozenset({"Qualified"}),
    "Dormant":       frozenset({"Qualified", "Approved", "Rejected"}),
}

# Gates.  Everything not listed here requires actor == "human".
AUTOMATIC: frozenset[tuple[str, str]] = frozenset({
    ("Identified", "Screened"),   # ruleset executed
    ("Contacted", "Replied"),     # inbound email, deterministic
    ("Contacted", "Dormant"),     # no reply in 10 days (P1)
})
LLM_ALLOWED: frozenset[tuple[str, str]] = frozenset({
    ("Replied", "In Discussion"),
    ("Replied", "Rejected"),
})
LLM_AUTO_THRESHOLD = 0.85
REOPEN: frozenset[tuple[str, str]] = frozenset({("Rejected", "Qualified"), ("Dormant", "Qualified")})


class IllegalTransition(ValueError):
    """Raised when a status/stage move is not in the whitelist."""


class GateViolation(PermissionError):
    """Raised when the actor is not allowed to perform an otherwise-legal move."""


class StatusMismatch(AssertionError):
    """Raised by rebuild_status when the event log disagrees with vendors.status."""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


# --- helpers ------------------------------------------------------------------

def _is_legal(from_status: str | None, to_status: str, from_stage: str | None, to_stage: str | None) -> bool:
    if from_status is None:
        return to_status == INITIAL_STATUS and to_stage is None
    if from_status == to_status:
        # stage-only advance inside In Discussion
        if from_status != "In Discussion" or to_stage is None:
            return False
        if to_stage not in STAGES:
            return False
        cur = STAGES.index(from_stage) if from_stage in STAGES else -1
        return STAGES.index(to_stage) > cur
    if to_status not in TRANSITIONS.get(from_status, frozenset()):
        return False
    if to_stage is not None:
        # a stage may only be set when landing in In Discussion
        return to_status == "In Discussion" and to_stage in STAGES
    return True


def _check_gate(from_status: str, to_status: str, to_stage: str | None,
                actor: str, confidence: float | None, reason: str) -> None:
    if not reason or not str(reason).strip():
        raise GateViolation("a non-empty reason is required for every transition")
    if actor == "human":
        return
    pair = (from_status, to_status)
    if pair in REOPEN:
        raise GateViolation(f"{from_status} -> Qualified (reopen) is human-only")
    if to_stage in HUMAN_ONLY_STAGES:
        raise GateViolation(f"diligence_stage '{to_stage}' is always via the review queue (human)")
    confident = confidence is not None and float(confidence) >= LLM_AUTO_THRESHOLD
    if from_status == to_status:  # stage-only advance
        if actor == "llm_inference" and to_stage in LLM_AUTO_STAGES and confident:
            return
        raise GateViolation(
            f"stage advance to '{to_stage}' by '{actor}' requires human or llm_inference with confidence >= {LLM_AUTO_THRESHOLD}")
    if pair in AUTOMATIC:
        return
    if actor == "llm_inference" and pair in LLM_ALLOWED and confident:
        return
    raise GateViolation(
        f"{from_status} -> {to_status} by '{actor}' (confidence={confidence}) requires a human")


def current_state(vendor_id: str, conn: sqlite3.Connection | None = None) -> tuple[str, str | None]:
    """(status, diligence_stage) as recorded on vendors + the latest event."""
    conn = conn or get_conn()
    row = conn.execute("SELECT status FROM vendors WHERE vendor_id = ?", (vendor_id,)).fetchone()
    if row is None:
        raise KeyError(f"unknown vendor_id {vendor_id!r}")
    ev = conn.execute(
        "SELECT to_status, to_stage FROM events WHERE vendor_id = ? ORDER BY created_at DESC, event_id DESC LIMIT 1",
        (vendor_id,),
    ).fetchone()
    stage = ev["to_stage"] if ev is not None and ev["to_status"] == "In Discussion" else None
    return row["status"], stage


# --- public API ---------------------------------------------------------------

def register_vendor(vendor: dict[str, Any], actor: str, reason: str = "discovered",
                    conn: sqlite3.Connection | None = None, payload: dict | None = None) -> bool:
    """Insert a vendor in status Identified together with its creation event.

    Returns False (and changes nothing) if the vendor_id already exists.
    `vendor` holds the vendors columns except status/discovered_at/updated_at.
    """
    conn = conn or get_conn()
    if conn.execute("SELECT 1 FROM vendors WHERE vendor_id = ?", (vendor["vendor_id"],)).fetchone():
        return False
    now = utcnow()
    cols = {
        "vendor_id": vendor["vendor_id"],
        "name": vendor["name"],
        "vendor_type": vendor["vendor_type"],
        "primary_domain": vendor.get("primary_domain"),
        "country": vendor.get("country"),
        "contact_email": vendor.get("contact_email"),
        "attributes": json.dumps(vendor.get("attributes") or {}, sort_keys=True),
        "screen_result": vendor.get("screen_result"),
        "screen_reasons": json.dumps(vendor["screen_reasons"], sort_keys=True) if vendor.get("screen_reasons") is not None else None,
        "status": INITIAL_STATUS,
        "status_confidence": vendor.get("status_confidence"),
        "coverage_confidence": vendor.get("coverage_confidence"),
        "next_action": vendor.get("next_action"),
        "owner": vendor.get("owner"),
        "due_at": vendor.get("due_at"),
        "first_seen_run_id": vendor.get("first_seen_run_id"),
        "discovered_via": vendor.get("discovered_via"),
        "discovered_at": vendor.get("discovered_at") or now,
        "updated_at": now,
    }
    with conn:
        conn.execute(
            f"INSERT INTO vendors ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
            tuple(cols.values()),
        )
        conn.execute(
            "INSERT INTO events (vendor_id, from_status, to_status, from_stage, to_stage, actor, reason, "
            "confidence, evidence_ref, payload, created_at) VALUES (?, NULL, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?)",
            (vendor["vendor_id"], INITIAL_STATUS, actor, reason,
             json.dumps(payload, sort_keys=True) if payload else None, now),
        )
    return True


def transition(vendor_id: str, to_status: str, actor: str, reason: str,
               confidence: float | None = None, evidence_ref: str | int | None = None,
               to_stage: str | None = None, payload: dict[str, Any] | None = None,
               conn: sqlite3.Connection | None = None) -> int:
    """Move a vendor to `to_status` (and/or `to_stage`) by appending an events row.

    Raises IllegalTransition for moves outside PRD Section 7 and GateViolation
    when the actor may not perform the move.  Returns the new event_id.
    """
    conn = conn or get_conn()
    if to_status not in STATUSES:
        raise IllegalTransition(f"unknown status {to_status!r}")
    if to_stage is not None and to_stage not in STAGES:
        raise IllegalTransition(f"unknown diligence_stage {to_stage!r}")
    from_status, from_stage = current_state(vendor_id, conn)
    if to_status == "In Discussion" and to_stage is None and from_status != "In Discussion":
        to_stage = STAGES[0]  # entering In Discussion starts at 'responded'
    if not _is_legal(from_status, to_status, from_stage, to_stage):
        raise IllegalTransition(
            f"{vendor_id}: {from_status}/{from_stage} -> {to_status}/{to_stage} is not in the whitelist")
    _check_gate(from_status, to_status, to_stage, actor, confidence, reason)
    now = utcnow()
    with conn:
        cur = conn.execute(
            "INSERT INTO events (vendor_id, from_status, to_status, from_stage, to_stage, actor, reason, "
            "confidence, evidence_ref, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (vendor_id, from_status, to_status, from_stage, to_stage, actor, reason, confidence,
             str(evidence_ref) if evidence_ref is not None else None,
             json.dumps(payload, sort_keys=True) if payload else None, now),
        )
        conn.execute(
            "UPDATE vendors SET status = ?, status_confidence = ?, updated_at = ? WHERE vendor_id = ?",
            (to_status, confidence, now, vendor_id),
        )
    return int(cur.lastrowid)


def revert_event(event_id: int, actor: str = "human", reason: str = "reverted",
                 conn: sqlite3.Connection | None = None) -> int:
    """One-click revert of an auto-applied transition (PRD S4).

    Only the vendor's latest event can be reverted, only if it was not made by a
    human, and only by a human.  The revert is itself an events row (payload
    {"reverts": event_id}) so the log stays append-only and replayable.
    """
    conn = conn or get_conn()
    if actor != "human":
        raise GateViolation("reverts are human-only")
    if not reason or not str(reason).strip():
        raise GateViolation("a non-empty reason is required for a revert")
    ev = conn.execute("SELECT * FROM events WHERE event_id = ?", (event_id,)).fetchone()
    if ev is None:
        raise KeyError(f"unknown event_id {event_id}")
    latest = conn.execute(
        "SELECT event_id FROM events WHERE vendor_id = ? ORDER BY created_at DESC, event_id DESC LIMIT 1",
        (ev["vendor_id"],)).fetchone()
    if latest["event_id"] != event_id:
        raise IllegalTransition(f"event {event_id} is not the latest event for {ev['vendor_id']}; cannot revert")
    if ev["actor"] == "human":
        raise GateViolation("only auto-applied (non-human) transitions can be reverted")
    if ev["from_status"] is None:
        raise IllegalTransition("the creation event cannot be reverted")
    now = utcnow()
    with conn:
        cur = conn.execute(
            "INSERT INTO events (vendor_id, from_status, to_status, from_stage, to_stage, actor, reason, "
            "confidence, evidence_ref, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
            (ev["vendor_id"], ev["to_status"], ev["from_status"], ev["to_stage"], ev["from_stage"], actor, reason,
             ev["evidence_ref"], json.dumps({"reverts": event_id}), now),
        )
        conn.execute("UPDATE vendors SET status = ?, status_confidence = NULL, updated_at = ? WHERE vendor_id = ?",
                     (ev["from_status"], now, ev["vendor_id"]))
    return int(cur.lastrowid)


def _reverts(payload: str | None) -> int | None:
    if not payload:
        return None
    try:
        data = json.loads(payload)
    except ValueError:
        return None
    return data.get("reverts") if isinstance(data, dict) else None


def rebuild_status(vendor_id: str, conn: sqlite3.Connection | None = None) -> str:
    """Replay the event log for one vendor and assert it matches vendors.status."""
    conn = conn or get_conn()
    stored = conn.execute("SELECT status FROM vendors WHERE vendor_id = ?", (vendor_id,)).fetchone()
    if stored is None:
        raise KeyError(f"unknown vendor_id {vendor_id!r}")
    rows = conn.execute(
        "SELECT event_id, from_status, to_status, from_stage, to_stage, payload FROM events "
        "WHERE vendor_id = ? ORDER BY created_at, event_id", (vendor_id,)).fetchall()
    if not rows:
        raise StatusMismatch(f"{vendor_id}: no events, cannot reconstruct status")
    by_id = {ev["event_id"]: ev for ev in rows}
    status: str | None = None
    stage: str | None = None
    for ev in rows:
        if ev["from_status"] != status:
            raise StatusMismatch(
                f"{vendor_id}: event {ev['event_id']} starts from {ev['from_status']!r} but replay is at {status!r}")
        ref_id = _reverts(ev["payload"])
        if ref_id is not None:
            ref = by_id.get(ref_id)
            legal = (ref is not None and ref["to_status"] == ev["from_status"] and ref["from_status"] == ev["to_status"]
                     and ref["to_stage"] == ev["from_stage"] and ref["from_stage"] == ev["to_stage"])
        else:
            legal = _is_legal(status, ev["to_status"], stage, ev["to_stage"])
        if not legal:
            raise StatusMismatch(
                f"{vendor_id}: event {ev['event_id']} {status} -> {ev['to_status']} is illegal")
        status = ev["to_status"]
        stage = ev["to_stage"] if status == "In Discussion" else None
    if status != stored["status"]:
        raise StatusMismatch(f"{vendor_id}: replayed {status!r} != stored {stored['status']!r}")
    return status


def history(vendor_id: str, conn: sqlite3.Connection | None = None) -> list[sqlite3.Row]:
    conn = conn or get_conn()
    return conn.execute("SELECT * FROM events WHERE vendor_id = ? ORDER BY created_at, event_id", (vendor_id,)).fetchall()


def rebuild_all(conn: sqlite3.Connection | None = None) -> dict[str, str]:
    conn = conn or get_conn()
    ids = [r["vendor_id"] for r in conn.execute("SELECT vendor_id FROM vendors ORDER BY vendor_id")]
    return {vid: rebuild_status(vid, conn) for vid in ids}
