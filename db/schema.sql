-- Vendor Sourcing & Pipeline Tracking — SQLite schema (PRD v1.1 Section 6).
-- PRD 6.1–6.5 tables: vendors, evidence, interactions, events, runs — plus `proposals` (D2 PM slot):
-- LLM status proposals that did not auto-apply, awaiting a human decision.
-- All timestamps are ISO-8601 UTC strings. JSON columns hold serialized JSON text.

PRAGMA foreign_keys = ON;

-- 6.5 runs — sourcing run provenance (created before vendors so the FK resolves)
CREATE TABLE IF NOT EXISTS runs (
    run_id            TEXT PRIMARY KEY,
    adapter           TEXT NOT NULL,
    vendor_type       TEXT NOT NULL,
    query             TEXT,                 -- JSON: seed queries / DiscoveryQuery
    ruleset_version   TEXT NOT NULL,        -- e.g. ego_data_supplier@v1
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    counts            TEXT,                 -- JSON
    rate_limit_spent  TEXT,                 -- JSON: tokens / server tool requests
    raw_payload_path  TEXT                  -- data/runs/<run_id>/
);

-- 6.1 vendors — current-state snapshot
CREATE TABLE IF NOT EXISTS vendors (
    vendor_id            TEXT PRIMARY KEY,  -- normalized domain, fallback slug(name)+type
    name                 TEXT NOT NULL,
    vendor_type          TEXT NOT NULL CHECK (vendor_type IN ('repo_owner', 'ego_data_supplier')),
    primary_domain       TEXT,
    country              TEXT,
    contact_email        TEXT,
    attributes           TEXT NOT NULL DEFAULT '{}',  -- JSON: verified values only
    screen_result        TEXT CHECK (screen_result IN ('pass', 'fail', 'unknown')),
    screen_reasons       TEXT,              -- JSON, reproducible
    status               TEXT NOT NULL,     -- reconstructable from events
    status_confidence    REAL,
    coverage_confidence  REAL,              -- verified must-fields / total must-fields
    next_action          TEXT,
    owner                TEXT,
    due_at               TEXT,
    first_seen_run_id    TEXT REFERENCES runs(run_id),
    discovered_via       TEXT,
    discovered_at        TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

-- 6.2 evidence — field-level provenance (the anti-hallucination core)
CREATE TABLE IF NOT EXISTS evidence (
    evidence_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id          TEXT NOT NULL REFERENCES vendors(vendor_id),
    field_path         TEXT NOT NULL,
    value              TEXT NOT NULL,
    source_url         TEXT,
    extraction_method  TEXT NOT NULL CHECK (extraction_method IN ('api', 'llm', 'manual')),
    snippet            TEXT,
    confidence         REAL,
    proxy              INTEGER NOT NULL DEFAULT 0 CHECK (proxy IN (0, 1)),
    verified           INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
    observed_at        TEXT NOT NULL,
    -- Hard rule: a value without source_url may only exist with verified = 0.
    CHECK (verified = 0 OR source_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_evidence_vendor ON evidence(vendor_id);
-- Re-runs must not duplicate evidence rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_dedup
    ON evidence(vendor_id, field_path, value, COALESCE(source_url, ''));

-- 6.3 interactions — one row per email in/out
CREATE TABLE IF NOT EXISTS interactions (
    interaction_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id        TEXT NOT NULL REFERENCES vendors(vendor_id),
    gmail_thread_id  TEXT,
    direction        TEXT NOT NULL CHECK (direction IN ('draft', 'outbound', 'inbound')),
    sent_at          TEXT,
    subject          TEXT,
    body_text        TEXT,
    llm_summary      TEXT
);
CREATE INDEX IF NOT EXISTS idx_interactions_vendor ON interactions(vendor_id);

-- 6.4 events — append-only audit log; status changes happen ONLY here
CREATE TABLE IF NOT EXISTS events (
    event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id     TEXT NOT NULL REFERENCES vendors(vendor_id),
    from_status   TEXT,                     -- NULL only for the creation event
    to_status     TEXT NOT NULL,
    from_stage    TEXT,
    to_stage      TEXT,
    actor         TEXT NOT NULL,            -- system | <adapter_name> | llm_inference | human
    reason        TEXT,
    confidence    REAL,
    evidence_ref  TEXT,                     -- interaction_id or evidence_id
    payload       TEXT,                     -- JSON
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_vendor ON events(vendor_id, created_at, event_id);

-- proposals — LLM transition proposals (D2 PM).  decision NULL = pending in the status review queue.
CREATE TABLE IF NOT EXISTS proposals (
    proposal_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id         TEXT NOT NULL REFERENCES vendors(vendor_id),
    interaction_id    INTEGER REFERENCES interactions(interaction_id),
    to_status         TEXT,
    to_stage          TEXT,
    confidence        REAL,
    evidence_snippet  TEXT,
    summary           TEXT,
    decision          TEXT CHECK (decision IN ('auto_applied', 'accepted', 'rejected', 'no_change')),
    decided_by        TEXT,                  -- llm_inference (auto) | system | human
    decided_at        TEXT,
    event_id          INTEGER REFERENCES events(event_id),
    created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_vendor ON proposals(vendor_id, created_at);
