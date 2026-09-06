"""CSV export of vendors + current status (PRD S5)."""
from __future__ import annotations

import csv
import io
import sqlite3

COLUMNS = ["vendor_id", "name", "vendor_type", "primary_domain", "country", "contact_email", "screen_result",
           "status", "diligence_stage", "status_confidence", "coverage_confidence", "next_action", "owner", "due_at",
           "first_seen_run_id", "discovered_via", "discovered_at", "updated_at", "attributes"]


def vendors_csv(conn: sqlite3.Connection, status: str | None = None) -> str:
    rows = conn.execute(
        "SELECT v.*, (SELECT e.to_stage FROM events e WHERE e.vendor_id = v.vendor_id AND e.to_status = 'In Discussion' "
        "ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS diligence_stage FROM vendors v "
        + ("WHERE v.status = ? " if status else "") + "ORDER BY v.status, v.name",
        (status,) if status else ()).fetchall()
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=COLUMNS, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        d = dict(r)
        if d["status"] != "In Discussion":
            d["diligence_stage"] = None
        w.writerow(d)
    return buf.getvalue()
