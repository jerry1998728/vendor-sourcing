# Vendor Sourcing & Pipeline Tracking (MVP)

Criteria-driven vendor discovery, human-approved outreach, and reply-driven status tracking,
sharing one SQLite database. See `docs/PRD.md` (v1.1) for the design; `docs/DEMO.md` for the 5-minute path.

```
configs/*.yaml + rulesets/*.yaml
        │
   DISCOVER (discover/run.py)  →  OUTREACH (outreach/run.py)  →  TRACK (track/run.py)
   adapter.discover/normalize     draft → approve → Gmail        poll → infer → gate ≥0.85
   pure screen(vendor, ev, rs)    [human gate]                   [human gate <0.85, quote/sample]
        └──────────────── SQLite: vendors · evidence · interactions · events · runs ────────────────┘
                                          Streamlit UI (ui/app.py)
```

## Setup

```bash
/opt/homebrew/bin/python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

`.env` (never committed):

```
ANTHROPIC_API_KEY=...          # web search (web_search_20250305), extraction, drafting, status inference
GITHUB_TOKEN=...               # github_org adapter
GMAIL_CREDENTIALS_PATH=credentials.json
DEMO_ALLOWED_RECIPIENTS=you+test@gmail.com   # do_not_send guard: only these addresses can receive mail
# OUTREACH_GO_LIVE=1           # lifts the guard (real vendors)
# ANTHROPIC_MODEL=claude-opus-5
# VENDOR_DB_PATH=data/vendors.db
```

## Run it

```bash
.venv/bin/python discover/run.py --config configs/ego_data_stereo.yaml     # H2: ego-data vendors
.venv/bin/python discover/run.py --config configs/code_data_github_orgs.yaml  # H1a: GitHub orgs (GITHUB_TOKEN)
.venv/bin/python discover/run.py --config configs/code_data_brokers.yaml   # H1b: code-data brokers
.venv/bin/python outreach/run.py --auth                                     # one-time Gmail OAuth
.venv/bin/python outreach/run.py --draft-all                                # drafts for Qualified vendors
.venv/bin/python track/run.py                                               # poll replies, infer, gate
.venv/bin/streamlit run ui/app.py                                           # the UI
```

Offline (no API keys): `.venv/bin/python scripts/seed_demo.py` builds `data/demo.db` with fictional
`*.example` vendors in every state; pick it in the UI sidebar. Demo mode swaps in a fake Gmail and a
keyword inference stand-in so the whole path (queue → outreach → reply → status → revert → export) runs locally.

## Checks

```bash
.venv/bin/python -m unittest -v tests/test_pipeline.py     # state machine, gates, revert, screening, outreach, tracking, github adapter
.venv/bin/python scripts/verify_d1.py                       # acceptance checks against the real DB after a discovery run
.venv/bin/python tests/run_replies.py [--heuristic]         # 10-case reply set (PRD target ≥ 8/10) + which cases route to proposals
```

## Invariants (enforced in code, not by convention)

- Status changes only through `db.state.transition` / `revert_event`; illegal moves raise; `rebuild_status`
  replays `events` and must equal `vendors.status`.
- Non-human actors may only make Identified→Screened, Contacted→Replied, Contacted→Dormant, and LLM proposals
  at confidence ≥ 0.85 for Replied→In Discussion / Rejected and the `responded` / `technical_review` stages.
  `quote_received` and `sampling` are always human.
- `evidence.verified = 1` requires `source_url` (DB CHECK). LLM values are verified only when the snippet is a
  verbatim quote of the fetched page. `vendors.attributes` is rebuilt from verified rows only.
- Screening is a pure function of (evidence, ruleset); unknown never rejects, it sets `next_action = outreach_to_verify`.
- Every run writes `runs` with `ruleset_version` and persists raw payloads to `data/runs/<run_id>/`.
- LLM status proposals are recorded in `proposals`; only confidence ≥ 0.85 outside `quote_received` / `sampling`
  auto-applies (actor `llm_inference`), everything else waits for Accept / Reject; auto-applied events revert in one click.

## 5-minute demo (PRD §9)

1. **Start a run** → pick a config → *Run discovery*; the Runs page shows `run_id`, `ruleset_version`, counts.
2. **Review queue** → clear three: Qualify a `pass`, Reject a `fail` (reason code required), Need info an `unknown`.
3. **Outreach** → draft (Claude or template, cites an evidence id) → edit → recipient → *Send via Gmail* → Contacted.
4. Reply from your second inbox → **Status review** → *Poll inbox* → Replied → In Discussion (auto ≥ 0.85) or a pending
   proposal (quotes / samples always) → Accept / Reject / Revert.
5. **Vendor detail → Timeline** shows every transition with actor and reason; **Export** downloads `vendors.csv`.

Offline rehearsal: `scripts/seed_demo.py` + pick `demo.db` in the sidebar (fake Gmail, heuristic inference).

## Layout

| Path | What |
|---|---|
| `db/schema.sql`, `db/init.py`, `db/state.py` | five tables, connection, state machine + gates + revert + replay |
| `core/models.py`, `core/screen.py`, `core/config.py` | dataclasses + adapter Protocol, pure screen(), YAML loaders |
| `core/actions.py`, `core/llm.py`, `core/export.py` | human-gate actions, Claude wrapper (+FakeLLM), CSV |
| `adapters/web_search_llm.py`, `adapters/github_org.py` | the two adapters |
| `configs/`, `rulesets/` | H2 / H1a / H1b configs, two rulesets |
| `discover/run.py`, `outreach/`, `track/` | the three stages (CLI + library) |
| `ui/app.py`, `ui/views/` | review queue, board, vendors + detail, run, outreach, status review, export |
| `tests/`, `tests/replies/`, `scripts/` | offline tests, 10 reply cases + runner, acceptance checker, demo seeder |
