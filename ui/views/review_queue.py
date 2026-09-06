"""Review queue: one Screened vendor at a time, evidence side-by-side, unknown fields pinned,
Qualify / Reject (reason code) / Need info — each writes an events row with actor=human."""
from __future__ import annotations

import json

import streamlit as st

from core.actions import REJECT_REASON_CODES, need_info, qualify, reject
from db.state import GateViolation, IllegalTransition
from ui import common as c


def render() -> None:
    conn = c.get_conn()
    st.markdown('<p class="vs-title">Review queue</p><p class="vs-sub">Drain Screened candidates: evidence on the right, verdict on the left. Sorted by coverage confidence.</p>', unsafe_allow_html=True)

    runs = [r[0] for r in conn.execute("SELECT DISTINCT first_seen_run_id FROM vendors WHERE status='Screened' ORDER BY 1 DESC") if r[0]]
    f1, f2, f3 = st.columns([2, 1, 1])
    run_pick = f1.selectbox("Run", ["(all)"] + runs)
    vtype = f2.selectbox("Vendor type", ["(all)", "ego_data_supplier", "repo_owner"])
    res = f3.multiselect("Screen result", ["pass", "unknown", "fail"], default=["pass", "unknown", "fail"])

    where, params = ["status = 'Screened'"], []
    if run_pick != "(all)":
        where.append("first_seen_run_id = ?"); params.append(run_pick)
    if vtype != "(all)":
        where.append("vendor_type = ?"); params.append(vtype)
    if res:
        where.append(f"screen_result IN ({','.join('?' * len(res))})"); params.extend(res)
    queue = conn.execute(f"SELECT vendor_id, name, screen_result, coverage_confidence FROM vendors WHERE {' AND '.join(where)} "
                         "ORDER BY coverage_confidence DESC, name", params).fetchall()

    k1, k2, k3, k4 = st.columns(4)
    counts = {r["screen_result"]: 0 for r in queue}
    for r in queue:
        counts[r["screen_result"]] = counts.get(r["screen_result"], 0) + 1
    k1.markdown(c.kpi("in queue", len(queue)), unsafe_allow_html=True)
    k2.markdown(c.kpi("pass", counts.get("pass", 0), "ready to qualify"), unsafe_allow_html=True)
    k3.markdown(c.kpi("unknown", counts.get("unknown", 0), "needs outreach to verify"), unsafe_allow_html=True)
    k4.markdown(c.kpi("fail", counts.get("fail", 0), "confirm rejection"), unsafe_allow_html=True)

    if not queue:
        st.info("Queue is empty. Start a run to add candidates.")
        return

    idx = st.session_state.get("queue_idx", 0) % len(queue)
    nav1, nav2, nav3 = st.columns([1, 6, 1])
    if nav1.button("◀ prev", width="stretch"):
        st.session_state["queue_idx"] = (idx - 1) % len(queue); st.rerun()
    nav2.markdown(f'<div style="text-align:center" class="vs-muted">{idx + 1} of {len(queue)}</div>', unsafe_allow_html=True)
    if nav3.button("next ▶", width="stretch"):
        st.session_state["queue_idx"] = (idx + 1) % len(queue); st.rerun()

    vendor_id = queue[idx]["vendor_id"]
    v = c.vendor_row(conn, vendor_id)
    reasons = json.loads(v["screen_reasons"] or "[]")
    attrs = json.loads(v["attributes"] or "{}")
    crit_html, unknown_fields = c.render_criteria(reasons)

    st.markdown(f'<div class="vs-card accent"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">'
                f'<div><span style="font-size:20px;font-weight:700">{c.esc(v["name"])}</span> &nbsp; {c.result_badge(v["screen_result"])} {c.status_badge(v["status"])} '
                f'{c.badge(v["vendor_type"], "neutral")}<div class="vs-muted">{c.esc(v["vendor_id"])} · {c.esc(v["primary_domain"] or "")} · country {c.esc(v["country"] or "?")} · '
                f'coverage {(v["coverage_confidence"] or 0):.2f} · next: {c.esc(v["next_action"] or "-")}</div></div>'
                f'<div class="vs-muted">run {c.esc(v["first_seen_run_id"])}</div></div></div>', unsafe_allow_html=True)

    left, right = st.columns([1, 1.25])
    with left:
        st.markdown("**Criteria** <span class='vs-muted'>(unknown pinned to top)</span>", unsafe_allow_html=True)
        st.markdown(crit_html, unsafe_allow_html=True)
        st.markdown("**Attributes** <span class='vs-muted'>(verified values only)</span>", unsafe_allow_html=True)
        st.markdown(c.render_attributes(attrs), unsafe_allow_html=True)
    with right:
        rows = c.evidence_rows(conn, vendor_id)
        st.markdown(f"**Evidence** <span class='vs-muted'>({sum(1 for r in rows if r['verified'])} verified / {len(rows)} rows)</span>", unsafe_allow_html=True)
        st.markdown(c.render_evidence(rows, unknown_fields), unsafe_allow_html=True)

    st.divider()
    a1, a2, a3, a4 = st.columns([1.2, 1.2, 1.2, 1])
    note = st.session_state.get("queue_note", "")
    try:
        if a1.button("✓ Qualify", type="primary", width="stretch", help="Screened → Qualified (human)"):
            qualify(conn, vendor_id, note); st.toast(f"Qualified {v['name']}"); st.rerun()
        with a2.popover("? Need info", width="stretch"):
            n = st.text_input("What must outreach verify?", value=", ".join(unknown_fields) or "", key=f"ni_{vendor_id}")
            if st.button("Qualify with next_action = outreach_to_verify", key=f"nib_{vendor_id}", type="primary"):
                need_info(conn, vendor_id, n); st.toast(f"Need info → {v['name']}"); st.rerun()
        with a3.popover("✗ Reject", width="stretch"):
            code = st.selectbox("Reason code (required)", list(REJECT_REASON_CODES), format_func=lambda k: f"{k} — {REJECT_REASON_CODES[k]}", key=f"rc_{vendor_id}")
            rn = st.text_input("Note", key=f"rn_{vendor_id}")
            if st.button("Confirm rejection", key=f"rb_{vendor_id}", type="primary"):
                reject(conn, vendor_id, code, rn); st.toast(f"Rejected {v['name']} ({code})"); st.rerun()
        if a4.button("Open detail", width="stretch"):
            c.open_vendor(vendor_id)
    except (GateViolation, IllegalTransition) as exc:
        st.error(str(exc))
