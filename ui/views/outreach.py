"""Outreach: LLM/template draft citing evidence → human edits → Send via Gmail → thread stored → Contacted."""
from __future__ import annotations

import json

import streamlit as st

from core.llm import LLM
from outreach.draft import draft_email, latest_draft, save_draft
from outreach.gmail_client import FakeGmail, GmailClient
from outreach.send import SendBlocked, allowed_recipients, approve_and_send, go_live, is_allowed
from ui import common as c


def gmail_client():
    if c.is_demo():
        if "fake_gmail" not in st.session_state:
            st.session_state["fake_gmail"] = FakeGmail()
        return st.session_state["fake_gmail"]
    return GmailClient()


def render() -> None:
    conn = c.get_conn()
    st.markdown('<p class="vs-title">Outreach</p><p class="vs-sub">Nothing sends without the button. Drafts must cite at least one evidenced fact.</p>', unsafe_allow_html=True)
    gmail = gmail_client()
    g1, g2 = st.columns([3, 1])
    try:
        authorized = gmail.is_authorized()
    except Exception:
        authorized = False
    with g1:
        guard = "OUTREACH_GO_LIVE=1 — real sends enabled" if go_live() else f"do_not_send guard on — DEMO_ALLOWED_RECIPIENTS: {', '.join(sorted(allowed_recipients())) or 'none set in .env'}"
        st.markdown(f'<div class="vs-card">{c.badge("Gmail authorized" if authorized else "Gmail not authorized", "pass" if authorized else "fail")} '
                    f'{c.badge("fake Gmail (demo)", "unknown") if c.is_demo() else ""}<div class="vs-muted" style="margin-top:6px">{c.esc(guard)}</div></div>', unsafe_allow_html=True)
    with g2:
        if not authorized and st.button("Authorize Gmail", width="stretch"):
            try:
                st.success(f"authorized as {gmail.authorize()}")
            except Exception as exc:
                st.error(str(exc))

    qualified = conn.execute("SELECT vendor_id, name, contact_email, next_action FROM vendors WHERE status = 'Qualified' ORDER BY name").fetchall()
    if not qualified:
        st.info("No Qualified vendors. Qualify candidates in the review queue first."); return
    ids = [r["vendor_id"] for r in qualified]
    pre = c.selected_vendor()
    vendor_id = st.selectbox("Qualified vendor", ids, index=ids.index(pre) if pre in ids else 0,
                             format_func=lambda i: f"{c.vendor_row(conn, i)['name']}  ·  {i}  ·  {c.vendor_row(conn, i)['next_action'] or ''}")
    v = c.vendor_row(conn, vendor_id)

    left, right = st.columns([1.3, 1])
    with right:
        st.markdown("**Evidence available to cite**")
        rows = [r for r in c.evidence_rows(conn, vendor_id) if r["verified"]]
        st.markdown(c.render_evidence(rows), unsafe_allow_html=True)
    with left:
        d = latest_draft(conn, vendor_id)
        b1, b2 = st.columns(2)
        sender_name = st.session_state.get("sender_name", "Jerry")
        sender_org = st.session_state.get("sender_org", "the sourcing team")
        if b1.button("✨ Draft with Claude", width="stretch", disabled=c.is_demo()):
            dd = draft_email(conn, vendor_id, LLM(), sender_name, sender_org)
            save_draft(conn, vendor_id, dd)
            if dd.get("fallback_reason"):
                st.warning(f"LLM unavailable → template draft ({dd['fallback_reason']})")
            st.rerun()
        if b2.button("📝 Template draft", width="stretch"):
            save_draft(conn, vendor_id, draft_email(conn, vendor_id, None, sender_name, sender_org)); st.rerun()
        with st.expander("Sender identity"):
            st.session_state["sender_name"] = st.text_input("name", sender_name)
            st.session_state["sender_org"] = st.text_input("organisation", sender_org)
        subject = st.text_input("Subject", value=d["subject"] if d else "")
        body = st.text_area("Body", value=d["body_text"] if d else "", height=320)
        to = st.text_input("Recipient", value=v["contact_email"] or "", placeholder="sales@vendor.com (manual entry when contact_email is empty)")
        allowed = is_allowed(to)
        do_not_send = st.checkbox("do_not_send — recipient is not in DEMO_ALLOWED_RECIPIENTS" if not allowed else "do_not_send",
                                  value=not allowed, key=f"dns_{vendor_id}_{to}",
                                  help="Defaults to on for any address outside the demo allowlist; the backend blocks those sends too.")
        if d:
            meta = json.loads(d["llm_summary"] or "{}")
            st.markdown(f'<div class="vs-muted">draft #{d["interaction_id"]} · method {c.esc(meta.get("method"))} · cites evidence {c.esc(meta.get("cited_evidence_ids"))}</div>', unsafe_allow_html=True)
        if st.button("📨 Send via Gmail", type="primary", width="stretch", disabled=do_not_send or not (subject and body and to)):
            try:
                out = approve_and_send(conn, vendor_id, to, subject, body, gmail, d["interaction_id"] if d else None)
                st.success(f"sent — thread {out['thread_id']} · status → Contacted (event #{out['event_id']})")
                st.rerun()
            except SendBlocked as exc:
                st.error(str(exc))
            except Exception as exc:
                st.error(f"send failed: {exc}")
