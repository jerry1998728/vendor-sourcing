"""Start a run: pick a config, execute the DISCOVER stage as a subprocess, show the run summary."""
from __future__ import annotations

import json
import subprocess
import sys

import pandas as pd
import streamlit as st

from core.config import load_all_configs, load_ruleset
from ui import common as c


def render() -> None:
    conn = c.get_conn()
    st.markdown('<p class="vs-title">Start a run</p><p class="vs-sub">Config → adapter → normalize → evidence → screen. Candidates land in Screened under one run_id.</p>', unsafe_allow_html=True)
    configs = load_all_configs()
    if not configs:
        st.warning("No configs in configs/*.yaml"); return
    left, right = st.columns([1, 1])
    with left:
        name = st.selectbox("Config", list(configs), format_func=lambda k: f"{k}  ·  {configs[k].adapter} → {configs[k].vendor_type}")
        cfg = configs[name]
        rs = load_ruleset(cfg.ruleset)
        st.markdown(f'<div class="vs-card"><div><b>adapter</b> {c.badge(cfg.adapter, "primary")} &nbsp; <b>vendor_type</b> {c.badge(cfg.vendor_type, "neutral")} &nbsp; '
                    f'<b>ruleset</b> {c.badge(rs.version_string, "info")}</div><div class="vs-muted" style="margin-top:6px">{c.esc(rs.description)}</div>'
                    f'<div style="margin-top:8px"><b>must</b>: {", ".join(c.esc(x.key) for x in rs.must)}<br><b>should</b>: {", ".join(c.esc(x.key) for x in rs.should)}</div></div>', unsafe_allow_html=True)
        st.markdown("**Seed queries**")
        st.markdown("".join(f'<div class="vs-attr"><span>{c.esc(q)}</span></div>' for q in cfg.seed_queries), unsafe_allow_html=True)
    with right:
        o1, o2, o3 = st.columns(3)
        limit = o1.number_input("hits per query", 5, 100, 40)
        maxc = o2.number_input("max candidates", 5, 300, 80)
        workers = o3.number_input("workers", 1, 8, 4)
        st.caption("Requires ANTHROPIC_API_KEY (web_search_llm) or GITHUB_TOKEN (github_org) in .env. Runs in-process; watch the log below.")
        if st.button("▶ Run discovery", type="primary", width="stretch"):
            cmd = [sys.executable, str(c.PROJECT_ROOT / "discover" / "run.py"), "--config", cfg.path, "--db", c.current_db(),
                   "--limit", str(limit), "--max-candidates", str(maxc), "--workers", str(workers)]
            box = st.empty(); lines: list[str] = []
            with st.status("running discovery…", expanded=True) as status:
                proc = subprocess.Popen(cmd, cwd=c.PROJECT_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                for line in proc.stdout:  # type: ignore[union-attr]
                    if "httpx" in line:
                        continue
                    lines.append(line.rstrip()); box.code("\n".join(lines[-40:]), language="text")
                rc = proc.wait()
                status.update(label=f"finished (exit {rc})", state="complete" if rc == 0 else "error")
            c._conn_for.clear(); st.rerun()

    recent = pd.read_sql_query("SELECT run_id, adapter, ruleset_version, finished_at, counts FROM runs ORDER BY started_at DESC LIMIT 5", conn)
    st.markdown("**Recent runs** <span class='vs-muted'>(full provenance on the Runs page)</span>", unsafe_allow_html=True)
    if recent.empty:
        st.caption("No runs yet.")
    else:
        for _, r in recent.iterrows():
            cnt = json.loads(r["counts"] or "{}")
            st.markdown(f'<div class="vs-card" style="margin-bottom:6px"><b>{c.esc(r["run_id"])}</b> {c.badge(r["adapter"], "primary")} {c.badge(r["ruleset_version"], "info")} '
                        f'<span class="vs-muted">· {c.esc(c.fmt_dt(r["finished_at"]))} · discovered {cnt.get("discovered", "-")} · new {cnt.get("vendors_new", "-")} · '
                        f'pass {cnt.get("pass", "-")} / fail {cnt.get("fail", "-")} / unknown {cnt.get("unknown", "-")}{(" · " + c.esc(cnt["error"])) if cnt.get("error") else ""}</span></div>', unsafe_allow_html=True)
    st.page_link(c.PAGES["runs"], label="Open the Runs page", icon="🧾")
