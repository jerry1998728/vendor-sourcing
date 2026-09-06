"""Pipeline board: columns by status; cards show diligence stage, next_action / owner / due_at (overdue in red)."""
from __future__ import annotations

import streamlit as st

from ui import common as c

COLUMNS = ["Screened", "Qualified", "Contacted", "Replied", "In Discussion", "Approved", "Rejected", "Dormant"]


def render() -> None:
    conn = c.get_conn()
    st.markdown('<p class="vs-title">Pipeline board</p><p class="vs-sub">Where is every vendor right now. Overdue follow-ups are red.</p>', unsafe_allow_html=True)
    f1, f2 = st.columns([1, 3])
    vtype = f1.selectbox("Vendor type", ["(all)", "ego_data_supplier", "repo_owner"])
    hide_rejected = f2.toggle("Hide Rejected", value=False)
    where = "vendor_type = ?" if vtype != "(all)" else ""
    df = c.vendors_df(conn, where, (vtype,) if where else ())
    stages = {r["vendor_id"]: r["to_stage"] for r in conn.execute(
        "SELECT e.vendor_id, e.to_stage FROM events e JOIN (SELECT vendor_id, max(event_id) mid FROM events GROUP BY vendor_id) l "
        "ON e.event_id = l.mid WHERE e.to_status = 'In Discussion'")}
    cols = [s for s in COLUMNS if not (hide_rejected and s == "Rejected")]
    kp = st.columns(len(cols))
    for i, s in enumerate(cols):
        kp[i].markdown(c.kpi(s, int((df["status"] == s).sum())), unsafe_allow_html=True)
    grid = st.columns(len(cols))
    for i, s in enumerate(cols):
        sub = df[df["status"] == s]
        with grid[i]:
            st.markdown(f'<div class="vs-col"><div class="h"><span>{c.esc(s)}</span>{c.badge(len(sub), c.STATUS_KIND.get(s, "neutral"))}</div>', unsafe_allow_html=True)
            for _, r in sub.head(40).iterrows():
                meta = []
                if s == "In Discussion" and stages.get(r["vendor_id"]):
                    meta.append(f"stage: {stages[r['vendor_id']]}")
                if r["next_action"]:
                    meta.append(f"next: {r['next_action']}")
                if r["owner"]:
                    meta.append(f"owner: {r['owner']}")
                if r["due_at"]:
                    due = f"due {r['due_at'][:10]}"
                    meta.append(f'<span class="overdue">⚠ {due}</span>' if c.is_overdue(r["due_at"]) else due)
                st.markdown(f'<div class="vs-mini"><div class="n">{c.esc(r["name"])}</div><div class="m">{c.badge(r["vendor_type"].replace("_", " "), "neutral")} '
                            f'{c.result_badge(r["screen_result"])}<br>{" · ".join(meta)}</div></div>', unsafe_allow_html=True)
                if st.button("open", key=f"open_{r['vendor_id']}", width="stretch"):
                    c.open_vendor(r["vendor_id"])
            st.markdown("</div>", unsafe_allow_html=True)
