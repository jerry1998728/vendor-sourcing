"""SQLite bootstrap: connection helpers and schema initialisation.

Usage:
    python db/init.py            # creates data/vendors.db with the five PRD tables
    from db.init import get_conn # shared connection for the process
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = Path(__file__).with_name("schema.sql")
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "vendors.db"


def db_path() -> Path:
    """Database location; override with VENDOR_DB_PATH (useful for tests)."""
    return Path(os.environ.get("VENDOR_DB_PATH", str(DEFAULT_DB_PATH)))


def connect(path: str | os.PathLike | None = None) -> sqlite3.Connection:
    target = Path(path) if path else db_path()
    if str(target) != ":memory:":
        target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if str(target) != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db(path: str | os.PathLike | None = None) -> sqlite3.Connection:
    """Create the five tables (idempotent) and return an open connection."""
    conn = connect(path)
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    conn.commit()
    return conn


_default_conn: sqlite3.Connection | None = None


def get_conn() -> sqlite3.Connection:
    """Process-wide connection to the default database (schema ensured)."""
    global _default_conn
    if _default_conn is None:
        _default_conn = init_db()
    return _default_conn


if __name__ == "__main__":
    init_db()
    print(f"initialised {db_path()}")
