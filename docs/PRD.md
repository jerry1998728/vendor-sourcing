# PRD — Vendor Sourcing & Pipeline Tracking System (MVP)

**Status:** Draft v1.1 · **Author:** Jerry · **Date:** 2026-09-05 · **Build window:** 2 days · **Format:** Lean PRD
**v1.1 change:** merged Design Spec v0.3 (evidence-first data model, three-valued screening, adapter/ruleset split, run provenance, queue-first UI). See Change Log.

---

## 1. Summary

**One-liner:** A criteria-driven system that collapses heterogeneous sources into a single evidenced vendor object, runs human-approved email outreach, and tracks each vendor through an auditable state machine whose status is inferred from reply threads.

**Answer first:** The MVP is three pipeline stages (Discover → Outreach → Track) sharing one database as the single source of truth, with a human approval gate at each stage. Discovery is one skeleton with pluggable source adapters and swappable rulesets; the two test cases (private-repo code data, ego-collection data) are two adapters plus two rulesets, not two products.

**Two rules that govern everything below**
1. **No evidence, no value.** A field without a `source_url` is never written to the vendor record.
2. **Unknown is not failure.** A criterion the open web cannot answer routes the vendor to outreach; it never auto-rejects.

**What is being judged (per hiring manager):** problem definition, trade-offs, and behavior under incomplete information. Sections 2, 3, 5 and 13 record each explicitly.

---

## 2. Problem Statement

### The problem
Vendor sourcing today is two manual jobs that break in different ways:

| Job | What breaks manually |
|---|---|
| **A. Discovery** — find every vendor that meets a spec | Coverage is bounded by search hours; qualification evidence lives in browser tabs; the same spec gets re-researched by the next person |
| **B. Tracking** — know where every vendor stands | Status lives in inboxes, not a system; it drifts the moment someone stops updating a spreadsheet |

### Why one system
Both jobs share the same entity (Vendor) and the same failure (information exists but is not structured). A shared vendor record that is populated by discovery and mutated by communication solves both.

### Reframing the brief as stated
| As stated | Why it cannot be executed literally | How this system defines it |
|---|---|---|
| Source **all** private repos with 200+ PRs | Private repos are not discoverable; "all" is not measurable | Source **organizations that own production-grade private codebases** via public-signal proxies; report coverage as a funnel plus an explicit blind-spot list |
| 200+ PRs | Unverifiable on private repos | Demoted to a **proxy** (merged PRs across the org's public repos), stored with `proxy=true`, confirmable only via outreach |
| Ego-data vendors: stereo + diverse + outside China | No structured source; many fields do not exist on the open web | Three-valued screening (pass / fail / **unknown**); unknown → `needs_outreach` |

### Non-goals
- Autonomous sending without human approval
- Negotiation or pricing logic
- Replacing the sourcer's judgment on final selection
- Exhaustive market coverage in 2 days (see Success Metrics for the defensible claim)

---

## 3. Assumptions (incomplete information, resolved by decision)

| # | Gap in brief | Decision taken | Reversible? |
|---|---|---|---|
| A1 | "Private repos with 200+ PRs" cannot be enumerated | Two config variants: **H1a** orgs whose public GitHub activity signals a large private codebase; **H1b** code-data vendors/brokers who resell repo access | Yes — config |
| A2 | "Production-grade, not toy" is undefined | Proxies: CI config, release tags, test directory, license, dependency lockfile — **≥3 hits = production-grade**; plus not fork/tutorial/awesome-list, last commit <90 days | Yes — ruleset |
| A3 | "Diverse scenes" is undefined | ≥3 collection countries **or** ≥3 environment classes of {urban, suburban, highway, night, adverse weather, indoor} | Yes — ruleset |
| A4 | "Not in China" — HQ vs. collection? | **Both** entity registration and collection geography must be outside China (must-criteria); either unknown → `needs_outreach` | Yes — ruleset |
| A5 | Which mailbox sends outreach | Dedicated Gmail account owned by the sourcer, via Gmail API | Yes |
| A6 | "All vendors" end-state | Out of MVP scope; MVP proves adding a category = one adapter config + one ruleset, no schema change | — |

**Rule:** every assumption lives in a config or ruleset file, versioned per run, so it can be overturned without a rebuild and prior verdicts stay interpretable.

---

## 4. Users

**Primary — Vendor Sourcer.** Owns a sourcing brief, drains a review queue, sends outreach under their own name, and needs to answer "where is vendor X" without opening email. **This user is not browsing a vendor library; they are draining a queue.** The home screen is a work queue, not a table.

**Secondary — Data/Procurement lead.** Reads the pipeline board and timelines; never touches discovery.

---

## 5. Scope & Trade-offs

### P0 — must ship (defines "end-to-end")
1. Adapter contract + two adapters (`github_org`, `web_search_llm`) + two rulesets (`repo_owner`, `ego_data_supplier`)
2. Discovery: adapter → normalize → evidence → screen (pass/fail/unknown) → review queue; every run recorded with `ruleset_version`
3. Review queue: one vendor at a time, evidence side-by-side, Qualify / Reject (reason code) / Need info
4. Outreach: LLM-drafted email → human approves/edits → Gmail send → thread ID stored
5. Tracking: poll Gmail threads → LLM proposes transition with confidence + evidence → auto-apply above threshold, else review queue
6. Vendor detail with Timeline tab rendered from the event log; pipeline board by status; CSV export
7. Seed run: ≥15 H2 vendors and ≥15 H1 candidates with evidence

### P1 — ship if time remains
- Dormancy: `Contacted` with no reply in 10 days → `Dormant`
- Contact-email discovery (find sales@ / contact form)
- `next_action / owner / due_at` on the pipeline board with overdue highlighting

### Out of scope (and why)
| Item | Reason |
|---|---|
| Multi-agent orchestration framework | Highest risk to a 2-day end-to-end demo; DB-mediated stages give the same behavior with no coordination bugs |
| Fully autonomous send | Reputational and legal risk; cannot be demoed safely against real vendors |
| Crawling private repos, anti-bot evasion | Not possible / not appropriate |
| Auth, multi-user, deployment, scheduling, CRM integration | Single-user local run proves the product |
| Embedding-based entity resolution | Dedup on normalized domain + slug(name) is sufficient at n≈50 |

### Trade-offs made
| Decision | Chose | Over | Because |
|---|---|---|---|
| Architecture | 3 stages + shared DB + human gates | 3 autonomous agents | Reliability > autonomy for MVP; agents can be swapped in behind the same DB contract |
| Discovery generality | Adapter contract + pure `screen()` with swappable rulesets | Two purpose-built sourcers | Boss's end goal is "all vendors"; the split proves it |
| Field population | **Wide recall, sparse but evidenced fields** | Fully populated table built on inference | Sparsity is fixable by outreach; contamination is not reversible |
| Screening | Three-valued (pass/fail/unknown) | Binary | Most H2 fields are absent from the open web; binary would reject the good vendors |
| Status inference | Propose + confidence threshold | Auto-apply everything | Wrong auto-updates destroy trust faster than manual entry |
| Review queue order | Confidence **descending** | Ascending | A 2-day demo must first prove the funnel surfaces good vendors; low-confidence records are better resolved by outreach than by staring |
| Storage / UI | SQLite / Streamlit | Postgres / React | 2-day budget; the queue and board are the product |

---

## 6. Data Model (four tables + config)

### 6.1 `vendors` — current-state snapshot
`vendor_id (PK: normalized domain, fallback slug(name)+type), name, vendor_type (repo_owner | ego_data_supplier), primary_domain, country, contact_email, attributes (JSON — verified values only), screen_result (pass | fail | unknown), screen_reasons (JSON, reproducible), status, status_confidence, coverage_confidence (verified must-fields / total must-fields), next_action, owner, due_at, first_seen_run_id (FK), discovered_via, discovered_at, updated_at`

### 6.2 `evidence` — field-level provenance (the anti-hallucination core)
`evidence_id, vendor_id, field_path, value, source_url, extraction_method (api | llm | manual), snippet, confidence, proxy (bool), verified (bool), observed_at`

**Hard rule:** a value without `source_url` may only land here with `verified=false`; it is never promoted to `vendors.attributes`. LLM extraction must return the supporting snippet with the value or the extraction is discarded.

### 6.3 `interactions` — one row per email in/out
`interaction_id, vendor_id, gmail_thread_id, direction (draft | outbound | inbound), sent_at, subject, body_text, llm_summary`

### 6.4 `events` — append-only audit log
`event_id, vendor_id, from_status, to_status, from_stage, to_stage, actor (system | adapter_name | llm_inference | human), reason, confidence, evidence_ref (interaction_id or evidence_id), payload, created_at`

State changes happen **only** by writing an event. `vendors.status` must be reconstructable from `events`.

### 6.5 `runs` — sourcing run provenance
`run_id, adapter, vendor_type, query, ruleset_version, started_at, finished_at, counts (JSON), rate_limit_spent, raw_payload_path`

Raw adapter payloads are persisted so a run is replayable without re-fetching, and every screening verdict is tied to the ruleset version that produced it.

### 6.6 Config files (YAML, versioned)
```yaml
# configs/ego_data_stereo.yaml
adapter: web_search_llm
vendor_type: ego_data_supplier
ruleset: ego_data_supplier@v1
seed_queries: ["ego-centric data collection vendor stereo camera", ...]

# rulesets/ego_data_supplier.v1.yaml
must:
  - key: stereo_camera                # requires source_url
  - key: entity_outside_china
  - key: collection_outside_china
should:
  - key: scene_diversity              # >=3 countries OR >=3 env classes
  - key: dataset_size_claimed
```

---

## 7. Vendor State Machine

```
Identified ─screen(auto)─▶ Screened ──fail──▶ Rejected
                              │ pass | unknown  (unknown ⇒ next_action = outreach_to_verify)
                              ▼
                          Qualified ─▶ Contacted ─▶ Replied ─▶ In Discussion ─▶ Approved
                              │            │           │              │
                          Rejected      Dormant     Rejected       Rejected
                                                    diligence_stage (within In Discussion):
                                                    responded → technical_review → quote_received → sampling
```

| Transition | Trigger | Gate |
|---|---|---|
| Identified → Screened | Ruleset executed | Auto — **the only fully automatic transition in discovery** |
| Screened → Rejected | `screen_result = fail` | Human confirms in review queue; reason code required |
| Screened → Qualified | `pass` or `unknown` | Human clicks Qualify (or Need info, which qualifies with `next_action = outreach_to_verify`) |
| Qualified → Contacted | Email sent | Human approves each email |
| Contacted → Replied | Inbound email on thread | Auto (deterministic) |
| Replied → In Discussion / Rejected | LLM reads reply | Auto if confidence ≥ 0.85, else review queue |
| `diligence_stage` advance | LLM detects quote / sample / technical language | `quote_received` and `sampling` always via review queue; `responded` and `technical_review` auto ≥ 0.85 |
| Contacted → Dormant | No reply in 10 days | Auto (P1) |
| Any → Approved / Rejected | Human only | Human |
| Rejected / Dormant → Qualified (reopen) | Human only, reason required | Human |

**Why sub-stages rather than more top-level states:** a top-level state changes who owns the next action; `responded / technical_review / quote_received / sampling` all sit in the same owner's court. Keeping them as `diligence_stage` keeps the transition whitelist to 8 states and makes adding a stage a data change, not a schema migration. Illegal transitions raise.

---

## 8. Architecture

```
  configs/*.yaml + rulesets/*.yaml
        │
        ▼
 ┌────────────────────┐  review queue  ┌─────────────┐   sent mail    ┌─────────────┐
 │      DISCOVER      │───────────────▶│  OUTREACH   │───────────────▶│   TRACK     │
 │ adapter.discover() │ [human gate]   │ draft→send  │  [human gate]  │ poll→infer  │
 │ adapter.normalize()│                │ Gmail API   │                │ [gate <0.85]│
 │ screen(v, ruleset) │                └──────┬──────┘                └──────┬──────┘
 └─────────┬──────────┘                       │                              │
           └──────────────────────────────────▼──────────────────────────────┘
                              SQLite (single source of truth)
                     vendors · evidence · interactions · events · runs
                                          │
                                   Streamlit UI
                 review queue · pipeline board · vendor detail (timeline) · export
```

### Adapter contract (the one interface kept strict)
```python
class SourceAdapter(Protocol):
    name: str
    vendor_type: str
    def discover(self, q: DiscoveryQuery) -> Iterable[RawRecord]: ...
    def normalize(self, raw: RawRecord) -> tuple[VendorCandidate, list[Evidence]]: ...

def screen(vendor: VendorCandidate, evidence: list[Evidence], ruleset: Ruleset) -> tuple[ScreenResult, list[Reason]]: ...
```
- `DiscoveryQuery(keywords, filters, limit)`; `RawRecord(payload, source_url, fetched_at)` — persisted per run.
- **Screening does not live in the adapter.** `screen()` is a pure function; both use cases share it and swap only the ruleset.
- Stages read rows in one status and write rows to the next; no stage calls another directly. This is what makes stages swappable for agents later.

**Adapters**
| Adapter | Source | Structure | Used by |
|---|---|---|---|
| `github_org` | GitHub GraphQL/REST | Structured | H1a |
| `web_search_llm` | Anthropic built-in web search + LLM JSON extraction with snippets | Unstructured | H1b, H2 |

**Stack:** Python 3.11 · SQLite · Streamlit · Claude API (search, extraction, drafting, status inference) · Gmail API · PyGithub · YAML.

---

## 9. User Flow & UI

| Screen | Purpose | Key behavior |
|---|---|---|
| **Start a run** | Pick config → execute adapter → N candidates land in `Screened` under one `run_id` | Run summary shows counts and ruleset version |
| **Review queue** (highest-frequency) | Drain candidates one at a time | Field values left, evidence right (value + snippet + clickable URL). **Unknown fields pinned to top.** Actions: Qualify / Reject (reason code) / Need info. Sorted by `coverage_confidence` desc |
| **Outreach** | Approve drafts | Editable draft citing ≥1 evidenced fact; recipient field; Send button; nothing sends without the click |
| **Status review queue** | Resolve LLM proposals <0.85 and all quote/sample proposals | Accept / reject proposal; one-click revert on any auto-applied transition |
| **Pipeline board** | Answer "where are we" in 10 s | Columns by status; cards show `next_action / owner / due_at`, overdue in red (P1 fields) |
| **Vendor detail** | Audit one vendor | Tabs: Attributes (evidence badge per value) / Evidence (full table) / Timeline (from `events`) / Thread (interactions) |
| **Export** | Exit | CSV of vendors + current status |

**Demo path (5 min):** Start a run → clear three from the queue (qualify, reject, need-info) → approve and send one email → reply from a second inbox → watch status advance to Replied / In Discussion → open Timeline → export CSV. That path is the definition of end-to-end.

---

## 10. User Stories & Acceptance Criteria

**S1 — Run discovery from a config**
- [ ] Given `configs/ego_data_stereo.yaml`, running discovery lands ≥15 vendors in `Screened` under one `run_id` with `ruleset_version` recorded
- [ ] Every must-criterion has an `evidence` row; values without `source_url` are stored `verified=false` and never appear in `attributes`
- [ ] `screen_result` is pass/fail/unknown; unknown vendors carry `next_action = outreach_to_verify`
- [ ] Re-running creates no duplicates (dedup on normalized domain, fallback slug(name)+type)

**S2 — Drain the review queue**
- [ ] One vendor per screen, evidence side-by-side, unknown fields pinned
- [ ] Qualify / Reject / Need info each write an `events` row with `actor=human`; Reject requires a reason code

**S3 — Approve and send outreach**
- [ ] Draft cites ≥1 fact from `evidence`; nothing sends without a click; send stores `gmail_thread_id`; status → `Contacted`

**S4 — Auto-track status from replies**
- [ ] Inbound reply on a tracked thread → `Replied` within one poll cycle
- [ ] LLM proposal includes `to_status / to_stage, confidence, evidence_snippet`; ≥0.85 auto-applies except quote/sample; every auto-applied transition is revertible in one click
- [ ] `vendors.status` reconstructed from `events` matches stored status for every vendor

**S5 — See the pipeline**
- [ ] Board by status; vendor detail Timeline shows every transition with actor and reason; CSV export works

---

## 11. Success Metrics (what the demo proves)

| Metric | Target | Why |
|---|---|---|
| End-to-end completion | 1 vendor traverses Screened → Qualified → Contacted → Replied → In Discussion live | The stated bar |
| Discovery precision (H2) | ≥70% of `Qualified` confirmed correct on manual spot-check of 10 | Scoring isn't noise |
| Evidence coverage | 100% of must-criterion values carry a `source_url` | Claims are auditable |
| **Must-field coverage %** | Reported per run, not targeted | Honest picture of what the open web can answer |
| **Unknown rate** | Reported per run; **not optimized to zero** | The most honest number the system produces |
| Status inference accuracy | ≥8/10 on a hand-built reply test set | Tracker can be trusted |
| Config generality | Third category = 1 config + 1 ruleset, 0 code changes | Path to "all vendors" |
| Reported at demo | `candidates_discovered · screen_pass_rate · must_field_coverage · unknown_rate · time_to_first_contact` + blind-spot list | |

**Not claimed:** exhaustive coverage. The blind-spot report (what the adapters structurally cannot see, e.g., private-repo scale) is presented alongside results.

---

## 12. 2-Day Build Plan

| Slot | Deliverable | Cut if behind |
|---|---|---|
| D1 AM | Schema (5 tables) + config/ruleset loader + pure `screen()` + `web_search_llm` adapter → ≥15 H2 vendors screened with evidence; minimal vendor table | Reduce to 8 vendors |
| D1 PM | `github_org` adapter (H1a) + H1b config; dedup; review queue screen with Qualify/Reject/Need info; `runs` provenance | Drop H1b, keep H1a |
| D2 AM | Gmail OAuth; draft generation; approval + Send; thread storage | Manual paste into Gmail, still store thread ID |
| D2 PM | Inbox poll; inference + threshold + status review queue; Timeline tab; board; CSV; 10-case reply test set; README + demo script | Drop board; keep Timeline and CSV |

Hard rule: end of D1 must show a review queue populated from a config with evidence side-by-side. Discovery is the fallback demo if outreach slips.

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Gmail OAuth friction | Blocks D2 AM | Personal Gmail, "testing" consent screen, self as test user; fallback in build plan |
| Web search returns aggregators, not vendors | Low-quality queue | Extraction prompt classifies page type; only `vendor_site` pages produce evidence |
| LLM invents field values | Contaminated records | Snippet-or-discard rule; unverified values never reach `attributes` |
| Ruleset changes mid-build invalidate earlier verdicts | Uninterpretable results | `ruleset_version` pinned per run; re-screen is a replay from raw payloads |
| GitHub rate limits | Slow H1a | Authenticated token; cap 50 orgs |
| LLM status inference over-confident | Wrong auto-updates | 0.85 threshold + events log + one-click revert; quote/sample always human |
| Real vendors receive test emails | Reputational | Demo sends only to a second inbox the sourcer controls; real contacts flagged `do_not_send` until go-live |

---

## 14. Open Questions for the Hiring Manager

1. **H1 intent:** licensing private code from companies (H1a) or buying from brokers (H1b)? Both built; which is primary?
2. **China exclusion:** entity registration, collection geography, or corporate ownership? (Default: first two, both required.)
3. **Sending identity:** shared team mailbox or individual sourcer's?
4. **Volume:** tens per category (current design) or thousands (needs queueing + cheaper scoring)?
5. **Existing tracker:** spreadsheet/CRM to import from or export to?

---

## Appendix

**Glossary** — *Must-criterion:* rejects on `fail`, routes to outreach on `unknown`. *Should-criterion:* ranks, never rejects. *Proxy:* a measurable public signal standing in for an unverifiable private fact. *Review queue:* candidates or proposed transitions awaiting a human. *Ruleset:* versioned YAML of must/should criteria. *Adapter:* source connector implementing `discover()` + `normalize()`.

**Change log**
| Version | Change |
|---|---|
| 1.0 | Initial PRD: 3 stages, human gates, state machine, 2-day plan |
| 1.1 | Merged Design Spec v0.3: brief reframing table (§2); production-grade proxies + "both outside China" (§3); queue-first user premise (§4); recall-over-inference and three-valued screening trade-offs (§5); `evidence` with extraction_method/proxy/verified + `runs` with ruleset_version + `coverage_confidence`/`next_action` fields (§6); Screened state, unknown→outreach, diligence sub-stages, reopen with reason (§7); adapter contract and pure `screen()` (§8); review queue / pipeline board / Timeline / CSV screens and demo path (§9); must-field coverage, unknown rate, blind-spot report (§11) |
