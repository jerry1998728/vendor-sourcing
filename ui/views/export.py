"""Export: CSV of vendors + current status."""
from __future__ import annotations

import pandas as pd
import streamlit as st

from core.export import vendors_csv
from ui import common as c


def render() -> None:
    conn = c.get_conn()
    st.markdown('<p class="vs-title">Export</p><p class="vs-sub">CSV of every vendor with its current status, diligence stage and verified attributes.</p>', unsafe_allow_html=True)
    status = st.selectbox("Status filter", ["(all)"] + c.STATUS_ORDER)
    csv = vendors_csv(conn, None if status == "(all)" else status)
    n = max(0, csv.count("\n") - 1)
    st.markdown(c.kpi("rows", n), unsafe_allow_html=True)
    st.download_button("⬇ Download vendors.csv", csv, file_name="vendors.csv", mime="text/csv", type="primary")
    if n:
        import io
        st.dataframe(pd.read_csv(io.StringIO(csv)), hide_index=True, width="stretch")
