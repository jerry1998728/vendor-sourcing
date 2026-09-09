# PRD — Vendor Sourcing & Tracking (v3.0)

Living specification: it describes the system as it stands. The original two-day build plan is in [docs/history/MVP_BUILD_PLAN.md](history/MVP_BUILD_PLAN.md).

**Stack**
- **App:** Next.js 16 (App Router) · TypeScript strict · Tailwind 4 · shadcn/ui on Radix
- **Data:** Drizzle ORM + better-sqlite3, Postgres-portable types
- **Services:** `@anthropic-ai/sdk` (extraction, drafting, inference, web search) · `@googleapis/gmail` · octokit
- **Other:** zod for every parsed payload · recharts through the shadcn chart component

---

## 1. Summary

One vendor database, several discovery channels, and one set of surfaces that follow the vendor lifecycle.

**Core rules, true everywhere in the system**
- **Every value carries evidence.** A value with no source URL and no attestation is `verified=false` and never reaches `vendors.attributes` or earns a verified badge.
- **Screening is three-valued.** pass · fail · unknown. Unknown never rejects a vendor; it becomes an outreach question.
- **Status changes only through the event log.** `transition()` validates against the §6 whitelist and appends to an append-only `events` table; the vendor row is a projection that can be replayed.

**Inputs**
- Custom web search (Anthropic web search plus extraction)
- GitHub organisations (GitHub API signals)
- Manual CSV upload
- Scheduled refresh of evidence pages

**Surfaces**, grouped by lifecycle stage in the sidebar
- **Dashboard** · **Discover** (Vendor Source, Vendor Data) · **Select** (Review Queue) · **Evaluate** (Draft & Send, Proposals) · **Manage** (Board)
- **Contract & Onboard** and **Renew or Exit** appear as planned stages, greyed, so the gap is visible rather than implied

**Shipped configs:** `ego_data_stereo` · `code_data_github_orgs` (H1a) · `code_data_brokers` (H1b). A new category is one config plus one ruleset, no code.

## 2. Problem & Assumptions

| Brief | Executable definition |
|---|---|
| All private repos, 200+ PRs, production-grade | Two equal-priority sources: **H1a** orgs whose public signals indicate production-grade private codebases (200 PRs = merged PRs across public repos, `proxy=true`; production-grade = ≥3 of {CI, release tags, tests dir, license, lockfile}, last commit <90d, not fork/tutorial); **H1b** brokers reselling licensed repo data. H1a capped at 50 ranked orgs; full coverage = ranking + batch review |
| Ego data vendors: stereo, diverse, outside China | Must: stereo camera (evidenced), **registration and ownership** outside China (collection geography is a tag, not a filter). Should: ≥3 countries or ≥3 scene classes. Unknown ⇒ outreach to verify, never rejected |
| "All vendors" | Out of scope; adding a category = 1 config + 1 ruleset, 0 code changes |

**Assumptions** made where the brief was silent, still open for confirmation

| Gap | Assumption | Applied |
|---|---|---|
| H1 primary source | Both H1a (orgs) and H1b (brokers) matter equally | Both configs shipped |
| China exclusion | Ownership and registration, not collection geography | Must-fields `registration_country`, `ownership_country`; collection = tag |
| H1a coverage | Ranked top-50 is sufficient | `github_org` cap 50, ranked by should-score |
| Sending identity | Individual sourcer's mailbox | `owner` = sender |
| Existing tracker | None to migrate | CSV import is a feature, not a migration |

Every threshold lives in a versioned ruleset file, never in code.

## 3. Scope & lifecycle coverage

### Lifecycle coverage

| Lifecycle stage | Where it lives | State |
|---|---|---|
| Identification and selection | **Discover** (Vendor Source, Vendor Data) and **Select** (Review Queue) | built |
| Evaluation and due diligence | **Evaluate** (Draft & Send, Proposals) plus the per-vendor Diligence checklist and the diligence stages | built |
| Contract negotiation and onboarding | — | planned |
| Performance management | — | planned |
| Relationship management | **Manage** (Board) with owner, next action and due date, the vendor Thread, automatic follow-ups | partly built |
| Offboarding or renewal | — | planned |

### Delivered

- **Pipeline:** eight-table schema (§5), the state machine (§6), the adapter contract and pure `screen()`
- **Inputs:** custom web search, GitHub organisations, manual CSV upload, scheduled refresh; rulesets created in the app by cloning YAML (`POST /api/rulesets`)
- **Discover and Select:** URL-driven filters, tags, the review queue, the vendor detail page
- **Evaluate and Manage:** the board, drafting and the human send gate, reply inference with proposals at the 0.85 threshold, the per-vendor diligence checklist, follow-up touchpoints at 7 and 14 days with dormancy at 10
- **Dashboard:** five linked KPI tiles and eight linked charts, every metric name explaining itself on hover
- **Operations:** run progress, cancellation and boot cleanup of interrupted runs; replay from persisted payloads; a development candidate cap; per-task model routing; CSV export; a single-password gate (`APP_PASSWORD`)
- **Verification:** the test suite, the ten-case reply set, `verify:run`, seed data (27 fictional vendors), the README and the demo runbook

### Planned

- The three later lifecycle stages named in the coverage map: contract and onboarding, performance management, renewal or exit
- The improvement list in the README: registry lookups for company facts, structured quotes, evidence expiry, self-running jobs, learning from outcomes

### Out

- Agent frameworks and autonomous send
- Multi-user accounts and roles (a single shared password exists; identity does not)
- CRM integration, embedding-based dedup, crawlers

## 4. Surfaces

### 4.1 Dashboard

- **Purpose:** five numbers that say where the pipeline stands and how much of it is grounded, each opening the view behind it; charts beneath them for shape and trend.
- **Help:** every tile and chart title carries its definition and its business impact on hover or keyboard focus.
- **Charts:** sourcing funnel (vendors that ever reached each status, from the event log) · screening outcome · coverage by vendor type · reply rate · backlog · discovery runs · source channel · country.

| Primary metric | Opens |
|---|---|
| Vendors (all discovered) | `/database/vendors` |
| Must-field coverage %, by vendor type | `/database/vendors` |
| Unknown rate | `/database/vendors?screen_result=unknown` |
| Active pipeline (contacted + in discussion), with reply rate | `/outreach/board` |
| Work backlog: review queue + proposals + overdue next actions | `/database/review` |

- **Secondary:** output by source channel · stale vendor count · last run with its counts · median time to first reply · vendors by country.

### 4.2 Discover

**Vendor Source** (the section's default page)

- **Purpose:** every way a vendor enters the database, in one section titled *Source Discovery & Channel*.
- **Channels** (a selector; the panel shows only what you decide, with settings folded into a row that summarises them):
  - *Custom web search* — vendor type, ruleset, limit, a free-text requirement, and seed queries the model proposes and you edit. Saving writes `configs/<name>.yaml`, so the search is repeatable.
  - *GitHub organisations* — languages as a multi-select, merged-PR threshold, activity window, minimum stars, exclude keywords.
  - *Manual upload* — a CSV template whose columns are field paths, an optional source URL per row, and an uploader attestation.
- **Rulesets:** a clone-and-edit dialog next to every ruleset selector writes `rulesets/<name>.<version>.yaml` after validation; it never overwrites.
- **Header panels:** *Schedules* (one cron per config, last run, Refresh now) and *Runs* (every run with its ruleset version and counts), each carrying its own summary and a dot when active.
- **Pipeline for all channels:** discover → normalize → evidence → screen → Review Queue. Disabled buttons state why.

**Vendor Data**

- **Purpose:** every vendor with its evidence, tags and screening result; the URL is the state, so any view is a shareable link.
- **Table:** columns per vendor type; row click opens the vendor sheet, then the vendor page.
- **Filters** (a side panel behind `Filters · n active`, with a removable chip per active filter): vendor type · screen result · status · owner · country (in / not in) · coverage range · source channel · stale · any tag dimension.
- **Actions:** run a saved config from the header popover, with Replay · Export CSV of the current view, one column per tag dimension.
- **Badges:** every attribute shows `verified` · `proxy` · `manual` · `unknown`.

### 4.3 Select

**Review Queue** — the human gate between discovery and outreach.

- **Order:** one vendor at a time, by coverage confidence descending; vendors a refresh flagged sit on top.
- **Layout:** must-fields and their evidence stay open; re-review and other verified attributes fold behind summaries.
- **Actions:** **Qualify** · **Reject** (reason code required, written to the event log) · **Need info** (→ Qualified with `next_action=outreach_to_verify`).

### 4.4 Evaluate

**Draft & Send**

- **Population:** Qualified vendors for first contact, plus Contacted or Dormant vendors holding a follow-up draft.
- **Draft:** cites at least one verified value and asks about every unknown must-field; subject, body and recipient are editable.
- **Send gate:** a human click, and only to an address in `DEMO_ALLOWED_RECIPIENTS`; a send moves the vendor to Contacted and stores the Gmail thread id. Follow-ups reuse the thread without a status change.
- **Status:** a *Sending* button summarises the Gmail connection and the allowlist.

**Proposals**

- **Purpose:** what inference did with inbound replies, and what needs a decision.
- **Auto-apply:** confidence ≥ 0.85 and the stage is not `quote_received` or `sampling`.
- **Always human:** quotes and sampling, and anything below the threshold, wait here for Accept or Reject.
- **Reversible:** any `llm_inference` event can be reverted in one click, which writes a human event.
- **Jobs:** Poll inbox and Run follow-ups are buttons here as well as cron endpoints.

### 4.5 Manage

**Board**

- **Columns:** by status, in lifecycle order.
- **Cards:** name, owner, next action, due date in red when overdue, the diligence stage and progress for vendors under evaluation.
- **Filters:** owner and vendor type, behind a popover that summarises what is active.

### 4.6 Vendor detail

- **Tabs:** Attributes · Evidence · Diligence · Timeline · Thread, with a Back button that returns to wherever you came from.
- **Attributes:** verified values with their source badges, the unknown must-fields called out, and tags folded behind a summary.
- **Evidence:** every row with its value, verbatim snippet, source URL and method.
- **Diligence:** the checklist from the vendor's ruleset (`diligence:`), grouped by technical / security / compliance / financial, with required items counted separately.
  - An answer is pass / fail / not applicable plus an optional note.
  - It counts only with a source URL or an attestation, the same rule as every other value; without either it is recorded and shown as unverified.
  - Every answer appends an informational event, so the Timeline shows who checked what against which source.
  - The diligence stage selector lives here for vendors In Discussion.
- **Timeline:** a vertical rail merging status milestones, stage changes, informational events and every email, oldest first, ending at the vendor's current state. Revert sits on the latest inference event.
- **Thread:** the full email history; outside production a Simulate reply box runs the same ingest path without Gmail.

## 5. Data Model

Eight tables, exactly as listed. Nothing added since: a feature that needs new facts uses evidence rows and events instead.

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

schedules    schedule_id, config, cron, last_run_id, enabled
```

**Rules**
1. No source URL and no attestation → `verified=false` → never written to `attributes`, never a verified tag badge.
2. `vendors.status` and `diligence_stage` are reconstructable from `events`.
3. Illegal transitions raise.

**Field-path conventions in `evidence`**
- `<field>` — an extracted or uploaded value, for example `sensor_rig`, `registration_country`.
- A must-field with nothing found gets a placeholder row with a null value, so the gap is recorded rather than absent.
- `diligence.<item_id>` — one checklist answer; the latest row per path wins, the note lives in `snippet`, and the answer counts only when verified.

**Migrations:** `drizzle/0000_*.sql` creates the tables; `drizzle/0001_indexes.sql` adds the query indexes and the uniqueness constraints on schedules and tags.

**Tag dimensions** (all in use)

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

**Rulesets** (`rulesets/<name>.<version>.yaml`)
- `must` — hard gates with thresholds; the only rules that decide pass, fail or unknown.
- `should` — weighted rules that rank rather than gate.
- `fields` — the extraction catalog the adapters prompt for.
- `diligence` — the human checklist for a vendor under evaluation.
- Must-fields double as tag dimensions where it makes sense, for example `sensor_rig=stereo`.

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
| Contacted → Dormant | system | no reply for 10 days |
| Any → Approved; Rejected/Dormant → Qualified (reopen, reason) | human | — |

**Rules that go with it**
- **One writer.** Only `transition()` changes `status` or `diligence_stage`; it validates the row above, appends the event and updates the vendor in one transaction. `rebuildStatus()` replays the log and throws if the projection disagrees.
- **Reasons.** Rows marked as requiring a reason reject placeholder text, so "no" and "n/a" cannot stand in for a decision.
- **Informational events.** `recordEvent()` appends an event whose `from` equals its `to`, for facts that are not transitions: refresh diffs (`tag_changed`, `screen_changed`) and diligence answers. They appear on the Timeline and never move a vendor.
- **Reversibility.** Any `llm_inference` event can be reverted, which appends a human event rather than deleting history.

## 7. Architecture

```
 INPUTS                        CORE                              SURFACES
 web_search_llm adapter ─┐                                    ┌─ Dashboard
 github_org adapter ─────┼─▶ normalize → evidence → screen ─▶ │  Discover · Select
 manual CSV ─────────────┤        SQLite: vendors · evidence   │  Evaluate · Manage
 refresh job ────────────┘        tags · events · runs ...     └─ Vendor detail
                                        ▲
 Gmail poll → infer ────────────────────┘ (interactions, proposals, events)
```

**Contracts**

```ts
interface SourceAdapter {
  name: string; vendorType: VendorType;
  discover(q: DiscoveryQuery): Promise<RawRecord[]>;
  normalize(raw: RawRecord): Promise<{ vendor: VendorCandidate; evidence: Evidence[]; tags: Tag[] }>;
  refresh?(vendor, evidence, ctx): Promise<NormalizeResult>;   // optional per adapter
}
function screen(vendor, evidence, ruleset): { result: ScreenResult; reasons: Reason[] }   // pure
```

**Code layout**
- `src/app/(app)` — `dashboard`, `database/{sources,vendors,review}`, `outreach/{board,draft,proposals}`, `vendors/[id]`
- `src/app/api` — runs, refresh, schedules, inputs, configs, rulesets, vendors, proposals, gmail, track, export
- `src/lib` — `db` (schema, state, filters, metrics, queries, export) · `pipeline` (adapter types, `screen`, `run`, `write`, `refresh`, `manual`, storage, cron) · `adapters` · `rulesets` · `llm` · `outreach` · `track`
- `src/lib/shared` — helpers safe for client components: filter params, section redirects, must-fields, run status, drafts, timeline, env, HTTP. Client code imports from here and never from `src/lib/db`, which would pull better-sqlite3 into the browser bundle.

**Models and cost**
- Routing per task: haiku for extraction and discovery, sonnet for seed queries, drafting and status inference. `ANTHROPIC_MODEL` overrides everything for testing.
- Web search uses the Anthropic built-in tool, `web_search_20250305` by default, `web_search_20260209` when `ANTHROPIC_WEB_SEARCH_TOOL` says so.
- Every run persists its raw payloads to `data/runs/<run_id>/`; `replay: true` re-extracts from disk without searching again.
- Outside a production build the candidate limit is capped at five, and refreshes at five vendors.

**Jobs and durability**
- Discovery, refresh and polling run in the request's `after()` callback inside the same process; progress lives in `runs.counts.progress`.
- Cancellation is a flag in that same object, checked between vendors; the run finishes as cancelled.
- `src/instrumentation.ts` marks every unfinished run failed at boot, so a restart cannot leave a config permanently "running".
- Nothing schedules itself: an external cron calls `POST /api/schedules/run-due`, `POST /api/track/poll` and `POST /api/track/followups`.

**Security**
- `src/proxy.ts` requires HTTP Basic auth on every page and route when `APP_PASSWORD` is set, and passes through when it is not, so local demos are unchanged.
- Gmail OAuth issues and checks a `state` cookie; `token.json` is written with owner-only permissions.
- Outreach sends only to addresses in `DEMO_ALLOWED_RECIPIENTS`, enforced server-side.
- Secrets come from `.env.local` only and are never imported into client components.

**Deployment contract**
- One long-lived Node process with a writable disk: the SQLite file, `data/runs/`, `token.json`, and the YAML written from Vendor Source.
- Not a serverless or multi-instance shape. Put `APP_PASSWORD` in front of it before it leaves localhost.

## 8. Quality & Verification

| Command | What it proves |
|---|---|
| `npm run typecheck` | `next typegen` then `tsc --noEmit`: the app and its generated route types agree |
| `npm run lint` | eslint, including the Next rules that forbid setState inside effects |
| `npm test` | 67 tests: the state machine and replay, pure screening, the write plan, grounding, filters, CSV, outreach and the send gate, reply tracking and proposals, refresh, cron, follow-ups, rulesets, navigation, metrics, the timeline builder, diligence |
| `npm run build` | a production build, which is also where server and client boundary mistakes surface |
| `npm run test:replies` | the ten-case reply set through real inference; target ≥ 8/10 (paid, so it stays out of CI) |
| `npm run verify:run [run_id]` | acceptance checks on a run: counts, evidence coverage, no unverified attributes, no duplicates, event replay |
| `npm run seed:sample` | 27 fictional vendors through the real write path, idempotent |

- **CI** runs typecheck, lint, tests and the build on every push and pull request.
- **Behaviour worth restating as acceptance:** a web search run lands its vendors in Screened under one run id and re-runs create no duplicates; every must-field has an evidence row; no unverified value reaches `attributes`; Reject without a reason is blocked; a send happens only on a click and only to an allowlisted recipient; a quote-style reply waits in Proposals; revert works; a third category needs one config and one ruleset and no code.

## 9. Metrics reported at demo

`candidates_discovered` · `screen_pass_rate` · `must_field_coverage` · `unknown_rate` (not optimised to zero) · `reply_rate` · `time_to_first_reply` · and the blind-spot list: what the adapters structurally cannot see.

## 10. Risks & Limitations

| Risk | Mitigation |
|---|---|
| Gmail OAuth friction | Testing consent screen, self as test user; manual paste as a fallback |
| Search returns aggregators | Extraction classifies page type; only a vendor site produces evidence |
| LLM invents values | Snippet-or-discard; unverified is never promoted |
| Ruleset changes underneath results | `ruleset_version` on every run; re-screen replays the raw payloads |
| Over-confident inference | 0.85 threshold, quotes and sampling always human, one-click revert |
| Test emails reaching real vendors | Recipient allowlist enforced in code |

**Known limitations**
- Single process, single writer, single shared password: no identity, no roles, no concurrent editors.
- Evidence has an observed date but no expiry, so staleness is a count rather than a rule.
- Private-repo scale is proxied by public merged PRs; ownership and collection geography are rarely on vendor sites and stay unknown until outreach.
- Anything web search does not surface is not in the table.

## 11. Trade-offs & Decisions

| Decision | Chose | Over | Reason |
|---|---|---|---|
| Architecture | Stages sharing one database, human gates | Autonomous agents | Reliability first; agents can be swapped in behind the same contract |
| Discovery | Adapter contract + pure `screen()` + versioned rulesets | Purpose-built sourcers per category | New category = config + ruleset, no code |
| Screening | Three-valued (pass / fail / unknown) | Binary | Most ego-vendor fields are absent from the open web; binary rejects good vendors |
| Field population | Wide recall, sparse evidenced fields | A full table via inference | Sparsity is fixed by outreach; contamination is not reversible |
| Status inference | Propose at 0.85; quotes and sampling always human | Auto-apply everything | Wrong auto-updates destroy trust in the tracker |
| Review Queue order | Coverage confidence descending | Ascending | The funnel must first prove it surfaces good vendors |
| Tags | All thirteen dimensions from the start | A subset with reserved schema | No migration later; filters are cheap once the table exists |
| Discovery channels | LLM web search + GitHub API + manual CSV | Crawlers, company-data APIs | Tens of vendors, not thousands; crawlers cost maintenance and company APIs do not answer qualification fields |
| Storage | SQLite via Drizzle, portable schema | Supabase or Postgres | Zero setup, runs from a clone; Postgres is a driver swap |
| UI | Next.js + shadcn, one stack | Python backend plus separate React, or Streamlit | One codebase, one process, app-grade UI |
| Diligence storage | Evidence rows and informational events | New tables | Keeps the eight-table schema and inherits the evidence rule for free |
| Compactness | Details behind buttons that summarise them | Tighter spacing | Fewer things on screen beats smaller things on screen |
| Navigation | Sidebar grouped by lifecycle stage | Grouped by data versus outreach | The app reads in the order the work happens, and the unbuilt stages become visible |
| New rulesets | Clone and edit the YAML in a dialog | A structured form builder | The YAML is the contract; a form would hide the parts that matter and cost days |
| Explanations | Hover help on titles and metric names | Grey paragraphs under headings | The page shows the work; the explanation is there when asked for |
| Access control | One shared password in front of everything | User accounts and roles | Protects a deployed demo in one env var; identity is a separate project |
