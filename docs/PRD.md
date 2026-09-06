# PRD — Vendor Sourcing & Tracking (MVP v2.0)

**Build window:** 2 days · **Stack:** Next.js (App Router, TypeScript) · Drizzle + SQLite · Tailwind + shadcn/ui · @anthropic-ai/sdk · googleapis (Gmail) · octokit

---

## 1. Summary

One vendor database with three data inputs and three operating surfaces.

- **Inputs:** manual CSV upload · scheduled refresh · custom web search (web vendors, GitHub orgs)
- **Surfaces (sidebar):** Dashboard · Database · Outreach Tracking
- **Core:** every field value carries evidence; screening is three-valued (pass / fail / unknown); status changes only via an append-only event log.

Three configs, all P0: `ego_data_stereo`, `code_data_github_orgs` (H1a), `code_data_brokers` (H1b).

## 2. Problem & Assumptions

| Brief | Executable definition |
|---|---|
| All private repos, 200+ PRs, production-grade | Two equal-priority sources: **H1a** orgs whose public signals indicate production-grade private codebases (200 PRs = merged PRs across public repos, `proxy=true`; production-grade = ≥3 of {CI, release tags, tests dir, license, lockfile}, last commit <90d, not fork/tutorial); **H1b** brokers reselling licensed repo data. H1a capped at 50 ranked orgs for MVP; full coverage = ranking + batch review (Phase 2) |
| Ego data vendors: stereo, diverse, outside China | Must: stereo camera (evidenced), **registration and ownership** outside China (collection geography is a tag, not a filter). Should: ≥3 countries or ≥3 scene classes. Unknown ⇒ `needs_outreach`, never rejected |
| "All vendors" | Out of scope; adding a category = 1 config + 1 ruleset, 0 code changes |

**Assumed decisions** (not stated in the brief; assumed and flagged for confirmation)

| Gap | Assumption | Applied |
|---|---|---|
| H1 primary source | Both H1a (orgs) and H1b (brokers) matter equally | Both configs P0 |
| China exclusion | Ownership and registration, not collection geography | Must-fields `registration_country`, `ownership_country`; collection = tag |
| H1a coverage | Ranked top-50 is sufficient for MVP | `github_org` cap 50, ranked by should-score |
| Sending identity | Individual sourcer's mailbox | `owner` = sender |
| Existing tracker | None to migrate | CSV import is a feature, not a migration |

Every threshold lives in a versioned ruleset file, not code.

## 3. Scope

**P0**
- Schema (§5), state machine (§6), adapter contract + pure `screen()`
- Inputs: custom web search (both adapters), manual CSV upload
- Database page with filters, tags, review queue tab, vendor detail
- Outreach page: board, draft & send (human gate), proposals (LLM inference, threshold 0.85)
- Dashboard with 5 clickable primary metrics
- Seed data: ≥15 ego vendors, ≥15 repo orgs
- Reply test set (10 cases), README, demo script

**P1**
- Scheduled refresh job + `schedules` table + stale flag
- Follow-up touchpoints (7d, 14d) and dormancy
- CSV export

**Out:** agent frameworks, autonomous send, auth/multi-user, CRM integration, embedding dedup, crawlers.

## 4. Pages

### 4.1 Dashboard
Primary metrics — each number is a link to the corresponding filtered view.

| Metric | Links to |
|---|---|
| Sourcing funnel (discovered → pass/unknown/fail → qualified → contacted → in discussion → approved) | Database filtered by stage |
| Must-field coverage % (by vendor_type) | Database, coverage column |
| Unknown rate | Database, `screen_result=unknown` |
| Active pipeline (contacted + in discussion) and reply rate | Outreach board |
| Work backlog: review queue + proposals + overdue next_action | Respective queues |

Secondary: output by source channel · stale vendor count · last run (time, counts) · median time-to-first-reply · vendors by country.

### 4.2 Database
**Tabs:** Vendors · Review Queue · Inputs

**Vendors tab** — table with configurable columns; filters: vendor_type, screen_result, status, owner, country (in / not in), coverage_confidence range, source channel, stale, any tag dimension (multi-select). Row click → Vendor Detail (Attributes / Evidence / Timeline / Thread). Each attribute shows a source badge: `verified` · `proxy` · `manual` · `unknown`.

**Review Queue tab** — one vendor at a time, sorted by coverage_confidence desc. Left: attributes; right: evidence (value, snippet, URL). Unknown must-fields pinned on top. Actions: **Qualify** · **Reject** (reason code required) · **Need info** (→ Qualified, `next_action=outreach_to_verify`).

**Inputs tab**
| Input | UI | Pipeline |
|---|---|---|
| Custom web search | vendor_type + free-text requirement + limit → LLM generates editable seed queries → Run. GitHub variant: languages, PR threshold, activity window, exclude keywords | adapter → normalize → evidence → screen → Review Queue |
| Manual upload | CSV template, columns = field_path; optional source_url per row; uploader attestation checkbox | `extraction_method=manual`; `verified=true` only with URL or attestation |
| Scheduled refresh (P1) | Schedule picker, last run, diff count, **Refresh now** | Re-fetch evidence URLs → re-extract → diff → new evidence + `tag_changed` event; screen_result change → Review Queue |

### 4.3 Outreach Tracking
**Tabs:** Board · Draft & Send · Proposals

**Board** — columns by status; cards show name, owner, next_action, due_at (overdue red), diligence_stage for in-discussion. Filter by owner, vendor_type.

**Draft & Send** — Qualified vendors; LLM draft cites ≥1 verified evidence and asks about each unknown must-field; editable subject/body/recipient; `do_not_send` unless recipient ∈ `DEMO_ALLOWED_RECIPIENTS`; Send → Gmail → `Contacted`.

**Proposals** — LLM-inferred transitions from inbound replies. Auto-applied if confidence ≥ 0.85 and stage ∉ {quote_received, sampling}; otherwise listed here. Accept / Reject / Revert (any `llm_inference` event).

## 5. Data Model

```
vendors      vendor_id PK (normalized domain | slug(name)+type), name, vendor_type,
             primary_domain, contact_email, registration_country, ownership_country, parent_entity,
             collection_countries JSON,
             attributes JSON (verified values only), screen_result, screen_reasons JSON,
             status, diligence_stage, status_confidence, coverage_confidence,
             next_action, owner, due_at, first_seen_run_id FK, discovered_via,
             last_verified_at, discovered_at, updated_at

evidence     evidence_id, vendor_id, field_path, value, source_url, snippet,
             extraction_method (api|llm|manual), confidence, proxy BOOL, verified BOOL,
             attested_by, observed_at

tags         tag_id, vendor_id, dimension, value, source_badge (verified|proxy|manual|unknown),
             evidence_id FK nullable, updated_at

interactions interaction_id, vendor_id, gmail_thread_id, direction (draft|outbound|inbound),
             sent_at, subject, body_text, llm_summary

events       event_id, vendor_id, from_status, to_status, from_stage, to_stage,
             actor (system|adapter|llm_inference|human), reason, confidence,
             evidence_ref, payload JSON, created_at        -- append-only

proposals    proposal_id, vendor_id, interaction_id, to_status, to_stage, confidence,
             evidence_snippet, decided_by, decided_at

runs         run_id, input_type (web_search|github|manual|refresh), adapter, vendor_type,
             query JSON, ruleset_version, started_at, finished_at, counts JSON,
             raw_payload_path

schedules    schedule_id, config, cron, last_run_id, enabled            -- P1
```

**Rules**
1. No `source_url` (or attestation) → `verified=false` → never written to `attributes` or `tags` with `verified` badge.
2. `vendors.status` and `diligence_stage` are reconstructable from `events`.
3. Illegal transitions raise.

**Tag dimensions** (all in MVP)

| Dimension | Values | Types |
|---|---|---|
| modality | video, image, lidar, audio, text, code, multimodal | all |
| collection_type | egocentric, exocentric, simulation, synthetic, scraped, licensed_existing | all |
| sensor_rig | stereo, mono, depth, lidar, imu, gps, eye_tracking | ego |
| scene_class | urban, suburban, highway, indoor, night, adverse_weather | ego |
| scale | hours, frames, repos, prs (numeric, proxy allowed) | all |
| licensing_model | exclusive, non_exclusive, per_hour, per_dataset, subscription | all |
| compliance | consent_documented, pii_handling, gdpr, release_forms | ego |
| annotation | none, box_2d, box_3d, segmentation, temporal | ego |
| code_language | free | code |
| code_license | permissive, copyleft, proprietary, unknown | code |
| org_type | company, foundation, individual, broker | all |
| delivery | api, bulk, on_prem | all |
| source_channel | web_search, github, manual, directory, referral | all |

**Rulesets** (`rulesets/*.v1.yaml`): `must` and `should` lists of field_paths with thresholds. Must-fields are also tag dimensions where applicable (e.g. `sensor_rig=stereo`).

## 6. State Machine

```
Identified ─auto─▶ Screened ─fail─▶ Rejected
                      │ pass|unknown
                      ▼
                  Qualified ─▶ Contacted ─▶ Replied ─▶ In Discussion ─▶ Approved
                      │             │          │             │
                  Rejected       Dormant    Rejected      Rejected
                                 diligence_stage: responded → technical_review → quote_received → sampling
```

| Transition | Actor | Gate |
|---|---|---|
| Identified → Screened | system | auto |
| Screened → Qualified / Rejected | human | Review Queue |
| Qualified → Contacted | human | Send click |
| Contacted → Replied | system | auto on first inbound |
| Replied → In Discussion / Rejected; stage → responded / technical_review | llm_inference | auto ≥0.85, else Proposals |
| stage → quote_received / sampling | human | always Proposals |
| Contacted → Dormant | system | no reply 10d (P1) |
| Any → Approved; Rejected/Dormant → Qualified (reopen, reason) | human | — |

## 7. Architecture

```
 INPUTS                        CORE                              SURFACES
 web_search_llm adapter ─┐                                    ┌─ Dashboard
 github_org adapter ─────┼─▶ normalize → evidence → screen ─▶ │  Database (Vendors · Review Queue · Inputs)
 manual CSV ─────────────┤        SQLite: vendors · evidence   │  Outreach (Board · Draft&Send · Proposals)
 refresh job (P1) ───────┘        tags · events · runs ...     └─ Vendor Detail
                                        ▲
 Gmail poll → infer ────────────────────┘ (interactions, proposals, events)
```

```ts
interface SourceAdapter {
  name: string; vendorType: VendorType;
  discover(q: DiscoveryQuery): Promise<RawRecord[]>;
  normalize(raw: RawRecord): Promise<{ vendor: VendorCandidate; evidence: Evidence[]; tags: Tag[] }>;
}
function screen(vendor, evidence, ruleset): { result: ScreenResult; reasons: Reason[] }   // pure
```

Layout: `src/app/(app)/{dashboard,database,outreach,vendors/[id]}` pages · `src/app/api/*` route handlers · `src/lib/{db,pipeline,adapters,rulesets,outreach,track}`. Web search uses the Anthropic built-in `web_search_20250305` tool via the SDK. All DB access through Drizzle in `src/lib/db`; schema kept Postgres-portable. Long-running jobs (runs, polls) execute in route handlers with progress rows in `runs`.

## 8. Acceptance Criteria

- **Inputs:** web search run lands ≥15 vendors per config in Screened under one run_id; manual CSV of 5 rows lands with correct badges; re-runs create no duplicates.
- **Evidence:** every must-field has an evidence row; no unverified value in `attributes`; `rebuild_status()` matches for all vendors.
- **Database:** filters on every listed dimension work; Review Queue actions write events; Reject without reason is blocked.
- **Outreach:** send only via click and only to allowlisted recipients; reply from second inbox → Replied within one poll; quote-style reply → Proposals, not auto-applied; Revert works.
- **Dashboard:** all 5 primary numbers navigate to the correct filtered view.
- **Tests:** `tests/run_replies.py` ≥ 8/10.
- **Config generality:** third category = 1 config + 1 ruleset, 0 code changes.

## 9. Metrics reported at demo
`candidates_discovered` · `screen_pass_rate` · `must_field_coverage` · `unknown_rate` (not optimized to zero) · `reply_rate` · `time_to_first_reply` · blind-spot list (what adapters structurally cannot see).

## 10. 2-Day Plan

| Slot | Deliverable | Cut if behind |
|---|---|---|
| D1 AM | Drizzle schema (8 tables), state machine, config/ruleset loader, `screen()`, `web_search_llm` adapter, ego config, `/api/runs` route, app shell with sidebar + Vendors table | 8 vendors |
| D1 PM | `github_org` adapter, repo_owner ruleset, H1b config, tags population, filters, Review Queue tab, Inputs tab (web search form, manual upload) | Drop manual upload, then tag filters; both H1 configs stay |
| D2 AM | Gmail OAuth (googleapis), draft generation, Draft & Send, Board (kanban) | Manual paste to Gmail, still store thread_id |
| D2 PM | Poll, inference, Proposals, Vendor Detail (4 tabs), Dashboard with links, reply tests, README + demo script | Drop secondary dashboard metrics |
| P1 (if time) | Refresh job + schedules + stale flag, follow-ups, CSV export | — |

Hard rule: end of D1 = `npm run dev` shows the Database page populated from a config, with Review Queue working.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Gmail OAuth friction | Testing consent screen, self as test user; fallback in plan |
| Search returns aggregators | Extraction classifies page_type; only `vendor_site` produces evidence |
| LLM invents values | Snippet-or-discard; unverified never promoted |
| Ruleset changes mid-build | `ruleset_version` on every run; re-screen replays raw payloads |
| Over-confident inference | 0.85 threshold, quote/sample always human, one-click revert |
| Test emails reach real vendors | Recipient allowlist enforced in code |

## 12. Trade-offs & Decisions

**Design trade-offs**

| Decision | Chose | Over | Reason |
|---|---|---|---|
| Architecture | Stages sharing one DB, human gates | Autonomous agents | Reliability in 2 days; agents can be swapped in behind the same DB contract later |
| Discovery | Adapter contract + pure `screen()` + versioned rulesets | Purpose-built sourcers per category | New category = config + ruleset, no code |
| Screening | Three-valued (pass/fail/unknown) | Binary | Most ego-vendor fields are absent from the open web; binary rejects good vendors |
| Field population | Wide recall, sparse evidenced fields | Fully populated table via inference | Sparsity is fixed by outreach; contamination is not reversible |
| Status inference | Propose with 0.85 threshold; quote/sample always human | Auto-apply all | Wrong auto-updates destroy trust in the tracker |
| Review Queue order | coverage_confidence desc | asc | Demo must first prove the funnel surfaces good vendors |
| Tags | All 13 dimensions in MVP | Subset with reserved schema | No migration later; filters are cheap once the table exists |
| Discovery channels | LLM web search + GitHub API + manual CSV | Crawlers, company-data APIs | Tens of vendors, not thousands; crawlers cost maintenance and company APIs don't answer qualification fields |
| Storage | SQLite via Drizzle, portable schema | Supabase/Postgres | Zero setup, runs from `git clone`; Postgres is a driver swap |
| UI | Next.js + shadcn single stack | Python backend + separate React, or Streamlit | One codebase, one process, app-grade UI; Streamlit reads as a notebook |

**Assumed stakeholder decisions** — listed in §2; each is reversible via config and should be confirmed with the hiring manager before Phase 2.
