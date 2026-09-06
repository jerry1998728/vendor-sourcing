"""Runs page: every `runs` row with its counts and ruleset_version."""
from __future__ import annotations

import json

import pandas as pd
import streamlit as st

from ui import common as c


def render() -> None:
    conn = c.get_conn()
    st.markdown('<p class="vs-title">Runs</p><p class="vs-sub">Provenance for every sourcing run: adapter, ruleset version, counts, token / rate-limit spend, raw payload path.</p>', unsafe_allow_html=True)
    runs = pd.read_sql_query("SELECT * FROM runs ORDER BY started_at DESC", conn)
    if runs.empty:
        st.info("No runs yet — use *Start a run*."); return
    rows = []
    for _, r in runs.iterrows():
        cnt = json.loads(r["counts"] or "{}")
        rows.append({"run_id": r["run_id"], "adapter": r["adapter"], "vendor_type": r["vendor_type"], "ruleset_version": r["ruleset_version"],
                     "started": c.fmt_dt(r["started_at"]), "finished": c.fmt_dt(r["finished_at"]), "discovered": cnt.get("discovered"),
                     "domains": cnt.get("unique_domains"), "new vendors": cnt.get("vendors_new"), "pass": cnt.get("pass"), "fail": cnt.get("fail"),
                     "unknown": cnt.get("unknown"), "coverage": cnt.get("must_field_coverage"), "unknown_rate": cnt.get("unknown_rate"),
                     "error": cnt.get("error")})
    k = st.columns(4)
    k[0].markdown(c.kpi("runs", len(runs)), unsafe_allow_html=True)
    k[1].markdown(c.kpi("vendors discovered", int(sum((x["new vendors"] or 0) for x in rows))), unsafe_allow_html=True)
    k[2].markdown(c.kpi("rulesets", runs["ruleset_version"].nunique()), unsafe_allow_html=True)
    k[3].markdown(c.kpi("adapters", runs["adapter"].nunique()), unsafe_allow_html=True)
    st.dataframe(pd.DataFrame(rows), hide_index=True, width="stretch",
                 column_config={"coverage": st.column_config.NumberColumn(format="%.2f"), "unknown_rate": st.column_config.NumberColumn(format="%.2f")})
    pick = st.selectbox("Run details", runs["run_id"].tolist())
    r = runs[runs["run_id"] == pick].iloc[0]
    st.markdown(f'<div class="vs-card">{c.badge(r["adapter"], "primary")} {c.badge(r["vendor_type"], "neutral")} {c.badge(r["ruleset_version"], "info")} '
                f'<span class="vs-muted">· raw payloads: {c.esc(r["raw_payload_path"])}</span></div>', unsafe_allow_html=True)
    d1, d2, d3 = st.columns(3)
    with d1:
        st.markdown("**counts**"); st.json(json.loads(r["counts"] or "{}"))
    with d2:
        st.markdown("**rate_limit_spent**"); st.json(json.loads(r["rate_limit_spent"] or "{}"))
    with d3:
        st.markdown("**query**"); st.json(json.loads(r["query"] or "{}"))
    vendors = c.vendors_df(conn, "first_seen_run_id = ?", (pick,))
    st.markdown(f"**Vendors from this run** {c.badge(len(vendors), 'neutral')}", unsafe_allow_html=True)
    st.dataframe(vendors[["name", "vendor_type", "screen_result", "status", "coverage_confidence", "next_action"]], hide_index=True, width="stretch")
