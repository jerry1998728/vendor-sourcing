"""Shared UI plumbing: DB selection, design system (CSS), badges, evidence/timeline renderers."""
from __future__ import annotations

import html
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import streamlit as st

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"

from db.init import init_db  # noqa: E402

PAGES: dict[str, Any] = {}   # filled by ui/app.py (name -> st.Page)

STATUS_ORDER = ["Identified", "Screened", "Qualified", "Contacted", "Replied", "In Discussion", "Approved", "Rejected", "Dormant"]
STATUS_KIND = {"Identified": "neutral", "Screened": "info", "Qualified": "primary", "Contacted": "primary", "Replied": "info",
               "In Discussion": "pass", "Approved": "pass", "Rejected": "fail", "Dormant": "unknown"}

CSS = """
<style>
:root{--vs-primary:#ED6941;--vs-bg:#141414;--vs-bg2:#1A1A1A;--vs-bg3:#222224;--vs-text:#E7E7E8;--vs-muted:#8E8E93;
--vs-border:#2B2B2E;--vs-pass:#3DBB7A;--vs-fail:#E5484D;--vs-unknown:#F2B441;--vs-info:#5B9CF6}
.block-container{padding-top:1.4rem;padding-bottom:3rem;max-width:1440px}
h1,h2,h3{letter-spacing:-.01em}
div[data-testid="stSidebar"]{border-right:1px solid var(--vs-border)}
.vs-brand{display:flex;align-items:center;gap:10px;padding:4px 0 10px}
.vs-brand .dot{width:12px;height:12px;border-radius:3px;background:var(--vs-primary);box-shadow:0 0 14px rgba(237,105,65,.55)}
.vs-brand .name{font-weight:700;font-size:15px;letter-spacing:.02em}
.vs-brand .sub{color:var(--vs-muted);font-size:11px}
.vs-card{background:var(--vs-bg2);border:1px solid var(--vs-border);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.vs-card.accent{border-left:3px solid var(--vs-primary)}
.vs-kpi{background:var(--vs-bg2);border:1px solid var(--vs-border);border-radius:12px;padding:12px 14px;margin-bottom:8px}
.vs-kpi .l{color:var(--vs-muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.vs-kpi .v{font-size:26px;font-weight:700;margin-top:2px;line-height:1.1}
.vs-kpi .s{color:var(--vs-muted);font-size:12px;margin-top:2px}
.vs-badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600;letter-spacing:.03em;border:1px solid transparent;white-space:nowrap;vertical-align:middle}
.vs-badge.pass{color:var(--vs-pass);background:rgba(61,187,122,.12);border-color:rgba(61,187,122,.35)}
.vs-badge.fail{color:var(--vs-fail);background:rgba(229,72,77,.12);border-color:rgba(229,72,77,.35)}
.vs-badge.unknown{color:var(--vs-unknown);background:rgba(242,180,65,.12);border-color:rgba(242,180,65,.35)}
.vs-badge.neutral{color:#C8C8CC;background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.12)}
.vs-badge.primary{color:var(--vs-primary);background:rgba(237,105,65,.12);border-color:rgba(237,105,65,.4)}
.vs-badge.info{color:var(--vs-info);background:rgba(91,156,246,.12);border-color:rgba(91,156,246,.35)}
.vs-muted{color:var(--vs-muted);font-size:12px}
.vs-title{font-size:22px;font-weight:700;margin:0} .vs-sub{color:var(--vs-muted);font-size:13px;margin-top:2px}
.vs-ev{border:1px solid var(--vs-border);border-left:3px solid var(--vs-border);border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--vs-bg2)}
.vs-ev.verified{border-left-color:var(--vs-pass)} .vs-ev.unverified{border-left-color:var(--vs-unknown)}
.vs-ev .f{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--vs-muted)}
.vs-ev .v{font-weight:600;font-size:14px;margin:2px 0;word-break:break-word}
.vs-ev .q{color:#BDBDC2;font-size:13px;font-style:italic;margin:4px 0}
.vs-ev a{color:var(--vs-primary);text-decoration:none;font-size:12px;word-break:break-all}
.vs-crit{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--vs-border);border-radius:10px;margin:6px 0;background:var(--vs-bg2)}
.vs-crit.unknown{border-color:rgba(242,180,65,.45);background:rgba(242,180,65,.05)}
.vs-crit.fail{border-color:rgba(229,72,77,.4)}
.vs-crit .k{font-weight:600;font-size:13.5px} .vs-crit .d{color:var(--vs-muted);font-size:12px;margin-top:1px}
.vs-attr{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px dashed var(--vs-border);font-size:13px}
.vs-attr .k{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--vs-muted);font-size:12px}
.vs-col{background:var(--vs-bg2);border:1px solid var(--vs-border);border-radius:12px;padding:10px;min-height:140px;margin-bottom:8px}
.vs-col .h{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:13px;padding:2px 4px 8px;border-bottom:1px solid var(--vs-border);margin-bottom:8px}
.vs-mini{background:var(--vs-bg3);border:1px solid var(--vs-border);border-radius:10px;padding:8px 10px;margin:6px 0}
.vs-mini .n{font-weight:600;font-size:13px;word-break:break-word} .vs-mini .m{color:var(--vs-muted);font-size:11.5px;margin-top:3px;line-height:1.5}
.vs-mini .overdue{color:var(--vs-fail);font-weight:600}
.vs-tl{border-left:2px solid var(--vs-border);margin-left:8px;padding-left:18px;margin-top:6px}
.vs-tl .it{position:relative;margin:0 0 14px}
.vs-tl .it:before{content:"";position:absolute;left:-25px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--vs-muted);border:2px solid var(--vs-bg)}
.vs-tl .it.human:before{background:var(--vs-primary)} .vs-tl .it.auto:before{background:var(--vs-info)} .vs-tl .it.revert:before{background:var(--vs-fail)}
.vs-tl .t{color:var(--vs-muted);font-size:11.5px} .vs-tl .h{font-weight:600;font-size:13.5px} .vs-tl .r{font-size:13px;color:#C8C8CC}
.vs-msg{border:1px solid var(--vs-border);border-radius:12px;padding:10px 14px;margin:8px 0;max-width:88%}
.vs-msg.outbound{background:rgba(237,105,65,.08);border-color:rgba(237,105,65,.3);margin-left:auto}
.vs-msg.inbound{background:var(--vs-bg2)} .vs-msg.draft{border-style:dashed;background:transparent}
.vs-msg .h{font-size:11.5px;color:var(--vs-muted);margin-bottom:4px} .vs-msg pre{white-space:pre-wrap;font-family:inherit;font-size:13px;margin:0;color:var(--vs-text)}
.vs-prop{border:1px solid rgba(91,156,246,.35);background:rgba(91,156,246,.06);border-radius:10px;padding:10px 12px;margin:8px 0;font-size:13px}
.vs-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--vs-muted)}
</style>
"""


def esc(s: Any) -> str:
    return html.escape("" if s is None else str(s))


def inject_css() -> None:
    st.markdown(CSS, unsafe_allow_html=True)


def default_db() -> str:
    return os.environ.get("VENDOR_DB_PATH") or str(DATA_DIR / "vendors.db")


def available_dbs() -> list[str]:
    DATA_DIR.mkdir(exist_ok=True)
    paths = sorted(str(p) for p in DATA_DIR.glob("*.db"))
    if default_db() not in paths:
        paths.insert(0, default_db())
    return paths


def current_db() -> str:
    """Selected database: sidebar choice for the session; `?db=<name>` deep-links / survives reloads."""
    if "db_path" not in st.session_state:
        qp = st.query_params.get("db")
        st.session_state["db_path"] = (qp if os.path.isabs(qp) else str(DATA_DIR / qp)) if qp else default_db()
    return st.session_state["db_path"]


def is_demo() -> bool:
    return "demo" in Path(current_db()).name.lower()


@st.cache_resource(show_spinner=False)
def _conn_for(path: str) -> sqlite3.Connection:
    return init_db(path)


def get_conn() -> sqlite3.Connection:
    return _conn_for(current_db())


def badge(text: Any, kind: str = "neutral") -> str:
    return f'<span class="vs-badge {kind}">{esc(text)}</span>'


def status_badge(status: str | None) -> str:
    return badge(status or "-", STATUS_KIND.get(status or "", "neutral"))


def result_badge(result: str | None) -> str:
    return badge(result or "unscreened", result if result in ("pass", "fail", "unknown") else "neutral")


def kpi(label: str, value: Any, sub: str = "") -> str:
    return f'<div class="vs-kpi"><div class="l">{esc(label)}</div><div class="v">{esc(value)}</div><div class="s">{esc(sub)}</div></div>'


def fmt_dt(iso: str | None) -> str:
    if not iso:
        return "-"
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return iso[:16]


def is_overdue(due_at: str | None) -> bool:
    if not due_at:
        return False
    try:
        return datetime.fromisoformat(due_at).date() < datetime.now(timezone.utc).date()
    except ValueError:
        return False


def open_vendor(vendor_id: str) -> None:
    st.session_state["vendor_id"] = vendor_id
    st.query_params["vendor"] = vendor_id
    if "vendor" in PAGES:
        st.switch_page(PAGES["vendor"])


def selected_vendor() -> str | None:
    return st.query_params.get("vendor") or st.session_state.get("vendor_id")


def vendor_row(conn: sqlite3.Connection, vendor_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM vendors WHERE vendor_id = ?", (vendor_id,)).fetchone()


def stage_of(conn: sqlite3.Connection, vendor_id: str) -> str | None:
    r = conn.execute("SELECT to_status, to_stage FROM events WHERE vendor_id = ? ORDER BY created_at DESC, event_id DESC LIMIT 1",
                     (vendor_id,)).fetchone()
    return r["to_stage"] if r and r["to_status"] == "In Discussion" else None


def evidence_rows(conn: sqlite3.Connection, vendor_id: str) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM evidence WHERE vendor_id = ? ORDER BY field_path, verified DESC, confidence DESC",
                        (vendor_id,)).fetchall()


def render_evidence(rows: list[sqlite3.Row], pinned_fields: tuple[str, ...] = ()) -> str:
    def order(r: sqlite3.Row) -> tuple:
        return (0 if r["field_path"] in pinned_fields else 1, r["field_path"], -(r["confidence"] or 0))
    parts = []
    for r in sorted(rows, key=order):
        cls = "verified" if r["verified"] else "unverified"
        flags = badge("verified", "pass") if r["verified"] else badge("unverified", "unknown")
        if r["proxy"]:
            flags += " " + badge("proxy", "neutral")
        flags += " " + badge(r["extraction_method"], "neutral")
        conf = f'<span class="vs-muted">conf {r["confidence"]:.2f}</span>' if r["confidence"] is not None else ""
        link = f'<a href="{esc(r["source_url"])}" target="_blank">{esc(r["source_url"])}</a>' if r["source_url"] else '<span class="vs-muted">no source_url</span>'
        q = f'<div class="q">“{esc(r["snippet"])}”</div>' if r["snippet"] else ""
        parts.append(f'<div class="vs-ev {cls}"><div class="f">{esc(r["field_path"])} &nbsp; {flags} &nbsp; {conf}</div>'
                     f'<div class="v">{esc(r["value"])}</div>{q}<div>{link}</div></div>')
    return "".join(parts) or '<div class="vs-muted">No evidence rows.</div>'


def render_criteria(reasons: list[dict[str, Any]]) -> tuple[str, tuple[str, ...]]:
    """Must/should criteria as rows; unknown must-criteria pinned to the top.  Returns (html, unknown field paths)."""
    must = [r for r in reasons if r["kind"] == "must"]
    should = [r for r in reasons if r["kind"] == "should"]
    must.sort(key=lambda r: {"unknown": 0, "fail": 1, "pass": 2}.get(r["result"], 3))
    unknown_fields = tuple(rule["field"] for r in must if r["result"] == "unknown" for rule in r["rules"])

    def row(r: dict[str, Any]) -> str:
        obs = "; ".join(f'{rule["field"]} = {", ".join(map(str, rule["observed"])) or "—"}' for rule in r["rules"])
        return (f'<div class="vs-crit {r["result"]}"><div><div class="k">{esc(r["key"])} '
                f'{badge(r["kind"], "primary" if r["kind"] == "must" else "neutral")}</div><div class="d">{esc(obs)}</div></div>'
                f'{result_badge(r["result"])}</div>')
    parts = [row(r) for r in must] + [row(r) for r in should]
    return "".join(parts) or '<div class="vs-muted">Not screened yet.</div>', unknown_fields


def render_attributes(attrs: dict[str, Any]) -> str:
    if not attrs:
        return '<div class="vs-muted">No verified attributes yet — every value here must be backed by verified evidence.</div>'
    parts = []
    for k, v in attrs.items():
        val = ", ".join(map(str, v)) if isinstance(v, list) else str(v)
        parts.append(f'<div class="vs-attr"><span class="k">{esc(k)}</span><span>{esc(val)} {badge("evidenced", "pass")}</span></div>')
    return "".join(parts)


def render_timeline(events: list[sqlite3.Row]) -> str:
    parts = []
    for e in reversed(events):
        payload = json.loads(e["payload"]) if e["payload"] else {}
        cls = "human" if e["actor"] == "human" else "auto"
        if payload.get("reverts"):
            cls = "revert"
        move = f'{esc(e["from_status"] or "∅")} → {esc(e["to_status"])}'
        if e["to_stage"]:
            move += f' <span class="vs-muted">/ {esc(e["to_stage"])}</span>'
        conf = f' · conf {e["confidence"]:.2f}' if e["confidence"] is not None else ""
        parts.append(f'<div class="it {cls}"><div class="t">{esc(fmt_dt(e["created_at"]))} · {badge(e["actor"], "primary" if cls == "human" else "info")}{conf} · #{e["event_id"]}</div>'
                     f'<div class="h">{move}</div><div class="r">{esc(e["reason"])}</div></div>')
    return f'<div class="vs-tl">{"".join(parts)}</div>' if parts else '<div class="vs-muted">No events.</div>'


def render_thread(rows: list[sqlite3.Row], proposals: dict[int, list[dict[str, Any]]] | None = None) -> str:
    proposals = proposals or {}
    parts = []
    for r in rows:
        who = {"outbound": "you → vendor", "inbound": "vendor → you", "draft": "draft (not sent)"}[r["direction"]]
        extra = ""
        for p in proposals.get(int(r["interaction_id"]), []):
            state = p["decision"] or "pending"
            extra += (f'<div class="vs-prop">proposal #{p["proposal_id"]}: <b>{esc(p["to_status"] or "no change")}</b>'
                      f'{(" / " + esc(p["to_stage"])) if p["to_stage"] else ""} · conf {float(p["confidence"] or 0):.2f} · '
                      f'{badge(state, "pass" if state in ("auto_applied", "accepted") else ("fail" if state == "rejected" else "unknown"))}'
                      f'{(" by " + esc(p["decided_by"])) if p["decided_by"] else ""}<br><span class="vs-muted">{esc(p["summary"])}</span></div>')
        parts.append(f'<div class="vs-msg {r["direction"]}"><div class="h">{esc(who)} · {esc(fmt_dt(r["sent_at"]))} · '
                     f'<b>{esc(r["subject"])}</b>{(" · thread " + esc(r["gmail_thread_id"])) if r["gmail_thread_id"] else ""}</div>'
                     f'<pre>{esc(r["body_text"])}</pre>{extra}</div>')
    return "".join(parts) or '<div class="vs-muted">No emails yet.</div>'


def vendors_df(conn: sqlite3.Connection, where: str = "", params: tuple = ()) -> pd.DataFrame:
    df = pd.read_sql_query(
        "SELECT vendor_id, name, vendor_type, screen_result, status, coverage_confidence, next_action, owner, due_at, "
        "country, primary_domain, contact_email, first_seen_run_id AS run_id, updated_at FROM vendors "
        + (f"WHERE {where} " if where else "") + "ORDER BY coverage_confidence DESC, name", conn, params=params)
    text_cols = [c for c in df.columns if c != "coverage_confidence"]
    df[text_cols] = df[text_cols].astype(object).where(pd.notna(df[text_cols]), None)   # NULL -> None, never NaN
    return df


def sidebar() -> None:
    conn = get_conn()
    with st.sidebar:
        st.markdown('<div class="vs-brand"><div class="dot"></div><div><div class="name">VENDOR SOURCING</div>'
                    '<div class="sub">discover · outreach · track</div></div></div>', unsafe_allow_html=True)
        counts = {r["status"]: r["c"] for r in conn.execute("SELECT status, count(*) c FROM vendors GROUP BY status")}
        pending = conn.execute("SELECT count(*) FROM proposals WHERE decision IS NULL").fetchone()[0]
        for key, label, icon, n in [
            ("queue", "Review queue", "📥", counts.get("Screened", 0)),
            ("board", "Pipeline board", "🗂️", sum(counts.values())),
            ("vendors", "Vendors", "📋", None),
            ("run", "Start a run", "🚀", None),
            ("runs", "Runs", "🧾", None),
            ("outreach", "Outreach", "✉️", counts.get("Qualified", 0)),
            ("status", "Status review", "🔎", pending),
            ("export", "Export", "⬇️", None),
        ]:
            if key in PAGES:
                st.page_link(PAGES[key], label=f"{label}" + (f"  ·  {n}" if n else ""), icon=icon,
                             query_params={"db": Path(current_db()).name})
        st.divider()
        dbs = available_dbs()
        pick = st.selectbox("Database", dbs, index=dbs.index(current_db()) if current_db() in dbs else 0,
                            format_func=lambda p: Path(p).name)
        if pick != current_db():
            st.session_state["db_path"] = pick
            st.query_params["db"] = Path(pick).name
            st.rerun()
        if is_demo():
            st.markdown(badge("demo mode · fake Gmail · heuristic inference", "unknown"), unsafe_allow_html=True)
        st.caption(f"{sum(counts.values())} vendors · {conn.execute('SELECT count(*) FROM evidence').fetchone()[0]} evidence rows")
