"""Vendors table (click-through) and the vendor detail page: Attributes / Evidence / Timeline / Thread."""
from __future__ import annotations

import json

import pandas as pd
import streamlit as st

from core.actions import REJECT_REASON_CODES, approve, qualify, reject, reopen, revert, set_plan
from db.state import GateViolation, IllegalTransition, StatusMismatch, rebuild_status
from ui import common as c


def render_table() -> None:
    conn = c.get_conn()
    st.markdown('<p class="vs-title">Vendors</p><p class="vs-sub">Every vendor in the database. Select a row to open its evidence and timeline.</p>', unsafe_allow_html=True)
    df = c.vendors_df(conn)
    f1, f2, f3, f4 = st.columns([2, 1.5, 1.5, 1.5])
    q = f1.text_input("Search", placeholder="name or domain")
    statuses = f2.multiselect("Status", c.STATUS_ORDER, default=[])
    results = f3.multiselect("Screen result", ["pass", "unknown", "fail"], default=[])
    runs = f4.multiselect("Run", sorted(df["run_id"].dropna().unique().tolist(), reverse=True), default=[])
    view = df
    if q:
        view = view[view["name"].str.contains(q, case=False, na=False) | view["vendor_id"].str.contains(q, case=False, na=False)]
    if statuses:
        view = view[view["status"].isin(statuses)]
    if results:
        view = view[view["screen_result"].isin(results)]
    if runs:
        view = view[view["run_id"].isin(runs)]
    view = view.reset_index(drop=True)
    st.caption(f"{len(view)} vendors")
    cols = ["name", "vendor_type", "screen_result", "status", "coverage_confidence", "next_action", "owner", "due_at", "run_id"]
    ev = st.dataframe(view[cols], hide_index=True, width="stretch", on_select="rerun", selection_mode="single-row",
                      column_config={"coverage_confidence": st.column_config.ProgressColumn("coverage", min_value=0, max_value=1, format="%.2f")})
    rows = getattr(getattr(ev, "selection", None), "rows", None) or []
    if rows:
        c.open_vendor(view.iloc[rows[0]]["vendor_id"])


def render_detail() -> None:
    conn = c.get_conn()
    vendor_id = c.selected_vendor()
    ids = [r[0] for r in conn.execute("SELECT vendor_id FROM vendors ORDER BY name")]
    if not ids:
        st.info("No vendors yet."); return
    pick = st.selectbox("Vendor", ids, index=ids.index(vendor_id) if vendor_id in ids else 0,
                        format_func=lambda i: f"{c.vendor_row(conn, i)['name']}  ·  {i}")
    if pick != vendor_id:
        st.session_state["vendor_id"] = pick; st.query_params["vendor"] = pick; st.rerun()
    v = c.vendor_row(conn, pick)
    stage = c.stage_of(conn, pick)
    try:
        rebuild_status(pick, conn); integrity = c.badge("events ↔ status consistent", "pass")
    except StatusMismatch as exc:
        integrity = c.badge(f"MISMATCH: {exc}", "fail")
    st.markdown(f'<div class="vs-card accent"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">'
                f'<div><span style="font-size:22px;font-weight:700">{c.esc(v["name"])}</span> &nbsp; {c.status_badge(v["status"])} '
                f'{(c.badge(stage, "info") + " ") if stage else ""}{c.result_badge(v["screen_result"])} {c.badge(v["vendor_type"], "neutral")}'
                f'<div class="vs-muted">{c.esc(v["vendor_id"])} · <a href="https://{c.esc(v["primary_domain"] or "")}" target="_blank" style="color:#ED6941">{c.esc(v["primary_domain"] or "")}</a> · '
                f'country {c.esc(v["country"] or "?")} · contact {c.esc(v["contact_email"] or "—")} · coverage {(v["coverage_confidence"] or 0):.2f}</div></div>'
                f'<div>{integrity}</div></div></div>', unsafe_allow_html=True)

    with st.expander("Plan: owner · due date · next action", expanded=False):
        with st.form(f"plan_{pick}"):
            p1, p2, p3 = st.columns(3)
            owner = p1.text_input("owner", value=v["owner"] or "")
            due = p2.text_input("due_at (YYYY-MM-DD)", value=(v["due_at"] or "")[:10])
            na = p3.text_input("next_action", value=v["next_action"] or "")
            if st.form_submit_button("Save", type="primary"):
                set_plan(conn, pick, owner, due, na); st.toast("saved"); st.rerun()

    a = st.columns(5)
    try:
        if v["status"] == "Screened" and a[0].button("✓ Qualify", type="primary", width="stretch"):
            qualify(conn, pick); st.rerun()
        if v["status"] not in ("Approved", "Rejected"):
            with a[1].popover("✗ Reject", width="stretch"):
                code = st.selectbox("Reason code", list(REJECT_REASON_CODES), key=f"drc_{pick}", format_func=lambda k: f"{k} — {REJECT_REASON_CODES[k]}")
                note = st.text_input("Note", key=f"drn_{pick}")
                if st.button("Confirm", key=f"drb_{pick}", type="primary"):
                    reject(conn, pick, code, note); st.rerun()
        if v["status"] not in ("Approved",):
            with a[2].popover("★ Approve", width="stretch"):
                note = st.text_input("Note", key=f"apn_{pick}")
                if st.button("Confirm approval", key=f"apb_{pick}", type="primary"):
                    approve(conn, pick, note); st.rerun()
        if v["status"] in ("Rejected", "Dormant"):
            with a[3].popover("↻ Reopen", width="stretch"):
                why = st.text_input("Reason (required)", key=f"ro_{pick}")
                if st.button("Reopen → Qualified", key=f"rob_{pick}", type="primary", disabled=not why.strip()):
                    reopen(conn, pick, why); st.rerun()
        if v["status"] == "Qualified" and a[4].button("✉ Draft outreach", width="stretch"):
            st.session_state["vendor_id"] = pick; st.switch_page(c.PAGES["outreach"])
    except (GateViolation, IllegalTransition) as exc:
        st.error(str(exc))

    t1, t2, t3, t4 = st.tabs(["Attributes", "Evidence", "Timeline", "Thread"])
    reasons = json.loads(v["screen_reasons"] or "[]")
    with t1:
        l, r = st.columns(2)
        with l:
            st.markdown("**Verified attributes**"); st.markdown(c.render_attributes(json.loads(v["attributes"] or "{}")), unsafe_allow_html=True)
        with r:
            html, _ = c.render_criteria(reasons)
            st.markdown("**Screening** <span class='vs-muted'>reproducible from evidence + ruleset</span>", unsafe_allow_html=True)
            st.markdown(html, unsafe_allow_html=True)
    with t2:
        rows = c.evidence_rows(conn, pick)
        st.markdown(c.render_evidence(rows), unsafe_allow_html=True)
        if rows:
            st.dataframe(pd.DataFrame([dict(r) for r in rows]), hide_index=True, width="stretch",
                         column_config={"source_url": st.column_config.LinkColumn("source_url")})
    with t3:
        events = conn.execute("SELECT * FROM events WHERE vendor_id = ? ORDER BY created_at, event_id", (pick,)).fetchall()
        last = events[-1] if events else None
        if last and last["actor"] != "human" and last["from_status"] is not None:
            if st.button(f"↶ Revert latest auto transition (#{last['event_id']}: {last['from_status']} → {last['to_status']})"):
                try:
                    revert(conn, last["event_id"]); st.toast("reverted"); st.rerun()
                except (GateViolation, IllegalTransition) as exc:
                    st.error(str(exc))
        st.markdown(c.render_timeline(events), unsafe_allow_html=True)
    with t4:
        from track.infer import proposals_by_interaction
        rows = conn.execute("SELECT * FROM interactions WHERE vendor_id = ? ORDER BY sent_at, interaction_id", (pick,)).fetchall()
        st.markdown(c.render_thread(rows, proposals_by_interaction(conn, pick)), unsafe_allow_html=True)
