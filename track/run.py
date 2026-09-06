#!/usr/bin/env python3
"""TRACK stage CLI: poll Gmail -> inbound interactions -> Contacted->Replied -> infer -> gate.

    python track/run.py [--no-llm] [--dormant-days 10] [--db PATH]
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(PROJECT_ROOT / ".env")

from core.llm import LLM  # noqa: E402
from db.init import init_db  # noqa: E402
from outreach.gmail_client import GmailClient  # noqa: E402
from track.poll import poll  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=None)
    ap.add_argument("--no-llm", action="store_true", help="skip inference; every reply becomes a pending proposal")
    ap.add_argument("--dormant-days", type=int, default=10)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    conn = init_db(args.db)
    print(json.dumps(poll(conn, GmailClient(), None if args.no_llm else LLM(), args.dormant_days)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
