#!/usr/bin/env python3
"""OUTREACH stage CLI.

    python outreach/run.py --auth                      # one-time Gmail OAuth
    python outreach/run.py --draft-all [--no-llm]      # draft for Qualified vendors without a draft
    python outreach/run.py --send <vendor_id> --to a@b # approve + send the latest draft
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(PROJECT_ROOT / ".env")

from core.llm import LLM  # noqa: E402
from db.init import init_db  # noqa: E402
from outreach.draft import draft_all, latest_draft  # noqa: E402
from outreach.gmail_client import GmailClient  # noqa: E402
from outreach.send import approve_and_send  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=None)
    ap.add_argument("--auth", action="store_true", help="run the Gmail OAuth flow")
    ap.add_argument("--draft-all", action="store_true")
    ap.add_argument("--no-llm", action="store_true", help="template drafts only")
    ap.add_argument("--send", metavar="VENDOR_ID")
    ap.add_argument("--to", metavar="EMAIL")
    ap.add_argument("--sender-name", default=os.environ.get("OUTREACH_SENDER_NAME", "Jerry"))
    ap.add_argument("--sender-org", default=os.environ.get("OUTREACH_SENDER_ORG", "the sourcing team"))
    args = ap.parse_args(argv)
    conn = init_db(args.db)
    if args.auth:
        print("authorized as", GmailClient().authorize())
        return 0
    if args.draft_all:
        drafts = draft_all(conn, None if args.no_llm else LLM(), args.sender_name, args.sender_org)
        for d in drafts:
            print(f"draft #{d['interaction_id']} for {d['vendor_id']} ({d['method']}{': ' + d['fallback_reason'] if d.get('fallback_reason') else ''})")
        print(f"{len(drafts)} drafts written")
        return 0
    if args.send:
        if not args.to:
            ap.error("--send requires --to")
        d = latest_draft(conn, args.send)
        if d is None:
            ap.error(f"no draft for {args.send}; run --draft-all first")
        out = approve_and_send(conn, args.send, args.to, d["subject"], d["body_text"], GmailClient(), d["interaction_id"])
        print(f"sent: thread {out['thread_id']} interaction #{out['interaction_id']} event #{out['event_id']}")
        return 0
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
