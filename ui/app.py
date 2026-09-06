"""Streamlit entry point.  `.venv/bin/streamlit run ui/app.py`"""
from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(PROJECT_ROOT / ".env")

import streamlit as st  # noqa: E402

from ui import common  # noqa: E402
from ui.views import board, export, outreach, review_queue, run, runs, status_review, vendors  # noqa: E402

st.set_page_config(page_title="Vendor Sourcing", page_icon="🟠", layout="wide", initial_sidebar_state="expanded")

common.PAGES.update({
    "queue": st.Page(review_queue.render, title="Review queue", icon="📥", url_path="queue", default=True),
    "board": st.Page(board.render, title="Pipeline board", icon="🗂️", url_path="board"),
    "vendors": st.Page(vendors.render_table, title="Vendors", icon="📋", url_path="vendors"),
    "vendor": st.Page(vendors.render_detail, title="Vendor detail", icon="🔍", url_path="vendor"),
    "run": st.Page(run.render, title="Start a run", icon="🚀", url_path="run"),
    "runs": st.Page(runs.render, title="Runs", icon="🧾", url_path="runs"),
    "outreach": st.Page(outreach.render, title="Outreach", icon="✉️", url_path="outreach"),
    "status": st.Page(status_review.render, title="Status review", icon="🔎", url_path="status"),
    "export": st.Page(export.render, title="Export", icon="⬇️", url_path="export"),
})

page = st.navigation(list(common.PAGES.values()), position="hidden")
common.inject_css()
common.sidebar()
page.run()
