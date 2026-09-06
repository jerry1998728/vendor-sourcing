"""Status review: poll the inbox, resolve LLM proposals below threshold (and all quote/sample
proposals), and revert auto-applied transitions in one click."""
from __future__ import annotations

import json
import subprocess
import sys

import streamlit as st

from core.actions import revert
from core.llm import LLM
from db.state import GateViolation, IllegalTransition
from track.infer import HeuristicLLM, pending_proposals, resolve_proposal
from track.poll import poll
from ui import common as c
from ui.views.outreach import gmail_client


def render() -> None:
    conn = c.get_conn()
    st.markdown('<p class="vs-title">Status review</p><p class="vs-sub">Replies advance status automatically above 0.85 confidence — except quotes and samples, which always stop here.</p>', unsafe_allow_html=True)
    p1, p2 = st.columns([1, 3])
    if p1.button("📡 Poll inbox now", type="primary", width="stretch"):
        if c.is_demo():
            counts = poll(conn, gmail_client(), HeuristicLLM())
            st.success(json.dumps(counts))
        else:
            with st.status("polling…", expanded=True):
                out = subprocess.run([sys.executable, str(c.PROJECT_ROOT / "track" / "run.py"), "--db", c.current_db()],
                                     cwd=c.PROJECT_ROOT, capture_output=True, text=True)
                st.code((out.stdout + out.stderr)[-3000:], language="text")
        st.rerun()
    if c.is_demo():
        with p2.expander("Simulate an inbound reply (demo mode)"):
            tracked = [dict(r) for r in conn.execute(
                "SELECT DISTINCT i.vendor_id, i.gmail_thread_id, v.name FROM interactions i JOIN vendors v USING (vendor_id) "
                "WHERE i.direction='outbound' AND i.gmail_thread_id IS NOT NULL AND v.status IN ('Contacted','Replied','In Discussion')")]
            if tracked:
                t = st.selectbox("thread", tracked, format_func=lambda r: f"{r['name']} · {r['gmail_thread_id']}")
                text = st.text_area("reply text", "Thanks for reaching out. Yes, we capture with a ZED stereo rig and are headquartered in Berlin. Happy to share specs.")
                if st.button("Inject reply and poll"):
                    gmail_client().inject_reply(t["gmail_thread_id"], f"sales@{t['vendor_id']}", text)
                    counts = poll(conn, gmail_client(), HeuristicLLM()); st.success(json.dumps(counts)); st.rerun()
            else:
                st.caption("No tracked threads — send an outreach email first.")

    pend = pending_proposals(conn)
    st.markdown(f"**Pending proposals** {c.badge(len(pend), 'unknown')}", unsafe_allow_html=True)
    if not pend:
        st.caption("Nothing waiting for a decision.")
    for p in pend:
        with st.container(border=True):
            h1, h2 = st.columns([3, 1])
            target = (c.badge(p["to_status"], "info") + (" " + c.badge(p["to_stage"], "info") if p["to_stage"] else "")) if p["to_status"] else c.badge("no LLM proposal — set status manually", "unknown")
            h1.markdown(f'<b style="font-size:16px">{c.esc(p["name"])}</b> &nbsp; {c.status_badge(p["status"])} → {target} '
                        f'&nbsp; conf {float(p["confidence"] or 0):.2f} &nbsp; <span class="vs-muted">proposal #{p["proposal_id"]}</span>', unsafe_allow_html=True)
            if h2.button("open vendor", key=f"ov_{p['proposal_id']}", width="stretch"):
                c.open_vendor(p["vendor_id"])
            st.markdown(f'<div class="vs-prop"><b>summary</b> {c.esc(p["summary"])}<br><b>evidence</b> “{c.esc(p["evidence_snippet"])}”</div>', unsafe_allow_html=True)
            with st.expander("email"):
                st.markdown(f'<div class="vs-msg inbound"><div class="h">{c.esc(p["subject"])} · {c.esc(c.fmt_dt(p["sent_at"]))}</div><pre>{c.esc(p["body_text"])}</pre></div>', unsafe_allow_html=True)
            b1, b2, _ = st.columns([1, 1, 3])
            try:
                if b1.button("✓ Accept", key=f"acc_{p['proposal_id']}", type="primary", width="stretch", disabled=not p["to_status"]):
                    resolve_proposal(conn, p["proposal_id"], True); st.toast("applied"); st.rerun()
                if b2.button("✗ Reject", key=f"rej_{p['proposal_id']}", width="stretch"):
                    resolve_proposal(conn, p["proposal_id"], False); st.toast("dismissed"); st.rerun()
            except (GateViolation, IllegalTransition, ValueError) as exc:
                st.error(str(exc))

    st.markdown("**Auto-applied transitions** <span class='vs-muted'>(latest event per vendor made by system / llm_inference — one click to revert)</span>", unsafe_allow_html=True)
    auto = conn.execute(
        "SELECT e.*, v.name FROM events e JOIN vendors v USING (vendor_id) JOIN (SELECT vendor_id, max(event_id) mid FROM events GROUP BY vendor_id) l "
        "ON e.event_id = l.mid WHERE e.actor IN ('llm_inference', 'system') AND e.from_status IS NOT NULL ORDER BY e.created_at DESC LIMIT 50").fetchall()
    if not auto:
        st.caption("None.")
    for e in auto:
        r1, r2 = st.columns([4, 1])
        conf = f" · conf {e['confidence']:.2f}" if e["confidence"] is not None else ""
        r1.markdown(f'<div class="vs-card" style="margin-bottom:4px"><b>{c.esc(e["name"])}</b> &nbsp; {c.esc(e["from_status"])} → {c.esc(e["to_status"])}'
                    f'{(" / " + c.esc(e["to_stage"])) if e["to_stage"] else ""} &nbsp; {c.badge(e["actor"], "info")}{conf} '
                    f'<span class="vs-muted">· {c.esc(c.fmt_dt(e["created_at"]))} · {c.esc(e["reason"])}</span></div>', unsafe_allow_html=True)
        if r2.button("↶ Revert", key=f"rv_{e['event_id']}", width="stretch"):
            try:
                revert(conn, e["event_id"], f"revert of event #{e['event_id']}"); st.toast("reverted"); st.rerun()
            except (GateViolation, IllegalTransition) as exc:
                st.error(str(exc))
