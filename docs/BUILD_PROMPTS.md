# Build prompts — paste one per slot, in order

## Prompt 0 — Scaffold (10 min, before D1 AM)
Read CLAUDE.md. Scaffold the app only: `npx create-next-app@latest . --typescript --tailwind --app --src-dir --eslint`, install drizzle-orm better-sqlite3 drizzle-kit @anthropic-ai/sdk googleapis octokit zod js-yaml, init shadcn and add sidebar, table, sheet, dialog, badge, tabs, card, button, input, select, textarea, checkbox. Create the (app) layout with a left sidebar linking Dashboard, Database, Outreach, each rendering a placeholder. Apply docs/THEME.md colors as CSS variables in globals.css. Create .env.example listing ANTHROPIC_API_KEY, GITHUB_TOKEN, GMAIL_CREDENTIALS_PATH, DEMO_ALLOWED_RECIPIENTS. Add data/ and .env.local, credentials.json, token.json to .gitignore. Acceptance: `npm run dev` renders the shell with three working sidebar links. Stop.

## Prompt 1 — D1 AM
Scaffold is accepted. Implement slot D1 AM only.

Deliver:
1. src/lib/db/schema.ts: the eight tables in PRD §5 with exact fields; drizzle config + migration; src/lib/db/index.ts client. src/lib/db/state.ts: transition({vendorId, toStatus, actor, reason, confidence?, evidenceRef?, toStage?}) validating the PRD §6 whitelist, inserting events, updating vendors; rebuildStatus(vendorId) replays events and throws on mismatch.
2. src/lib/pipeline/types.ts: DiscoveryQuery, RawRecord, VendorCandidate, Evidence, Tag, SourceAdapter (PRD §7). Zod schemas for all LLM outputs.
3. src/lib/pipeline/screen.ts: pure screen(vendor, evidence, ruleset) -> {result, reasons, coverageConfidence}. Must-field with verified evidence failing threshold -> fail; missing or unverified -> unknown; all pass -> pass.
4. src/lib/rulesets/loader.ts loading configs/*.yaml and rulesets/*.yaml. Create configs/ego_data_stereo.yaml (adapter web_search_llm, ruleset ego_data_supplier@v1, 6–8 seed queries) and rulesets/ego_data_supplier.v1.yaml (must: sensor_rig=stereo, registration_country != CN, ownership_country != CN; should: scene_diversity >= 3 collection countries or >= 3 scene classes, scale).
5. src/lib/adapters/webSearchLlm.ts: discover() runs seed queries via the Anthropic web_search tool; normalize() asks Claude for strict JSON {page_type, name, primary_domain, registration_country, ownership_country, parent_entity, collection_countries, fields:[{field_path, value, source_url, snippet, confidence, proxy}], tags:[{dimension, value, source_url, snippet}]} using PRD §5 tag dimensions, parsed with zod. Only page_type == "vendor_site" produces evidence. Missing source_url or snippet -> verified=false.
6. src/lib/pipeline/run.ts + POST /api/runs {config}: creates a runs row (input_type=web_search), persists raw payloads, normalizes, dedups on normalized domain (fallback slug(name)+type), writes vendors/evidence/tags, screens, writes attributes from verified evidence only, transitions Identified->Screened, updates runs.counts {discovered, pass, fail, unknown, must_field_coverage, unknown_rate}. GET /api/runs/[id] returns progress.
7. Database page: Vendors tab as a shadcn DataTable (name, vendor_type, screen_result, status, coverage_confidence, last_verified_at, run_id); row click opens a Sheet with evidence and tags. A "Run config" button on the page triggers POST /api/runs for ego_data_stereo and polls progress.

Acceptance: running the ego config from the UI lands >= 15 vendors in Screened under one run_id; every must-field has an evidence row; no unverified value in attributes; re-run creates no duplicates; rebuildStatus passes for all. Stop and show me the run counts and three sample vendors with evidence and tags.

## Prompt 2 — D1 PM
D1 AM is accepted. Implement slot D1 PM only.

Deliver:
1. src/lib/adapters/githubOrg.ts (octokit): one VendorCandidate per org; evidence rows for merged_prs_public (proxy=true), ci_config, release_tags, test_directory, license, lockfile, last_commit_days, is_fork_or_tutorial; tags for code_language, code_license, org_type, modality=code, collection_type=licensed_existing. Cap 50 orgs, ranked by should-score.
2. rulesets/repo_owner.v1.yaml per PRD §2. configs/code_data_github_orgs.yaml (githubOrg) and configs/code_data_brokers.yaml (webSearchLlm, broker seed queries). run.ts dispatches on config.adapter with no change to the web path.
3. Database Vendors tab filters (URL-synced search params so the Dashboard can deep-link): vendor_type, screen_result, status, owner, country in/not in, coverage_confidence range, source_channel, stale (last_verified_at > 30d), multi-select on every PRD §5 tag dimension. Column visibility toggle.
4. Database Review Queue tab: one vendor per screen sorted by coverage_confidence desc; attributes left, evidence right (value, snippet, link); unknown must-fields pinned on top; buttons Qualify / Reject (reason Select required) / Need info (Qualified + next_action=outreach_to_verify) via POST /api/vendors/[id]/transition with actor=human.
5. Database Inputs tab: (a) Custom web search form: vendor_type, free-text requirement, limit -> POST /api/seed-queries returns editable seed queries -> Run. GitHub variant form: languages, min merged PRs, activity window days, exclude keywords. (b) Manual upload: CSV template download (field_paths + tag dimensions + source_url + attestation), upload -> POST /api/inputs/manual -> normalize -> evidence (extraction_method=manual, verified only with source_url or attestation) -> screen -> Review Queue; runs row input_type=manual. (c) Runs list with counts and ruleset_version.

Acceptance: all three configs run from the UI; githubOrg yields >= 15 candidates ranked; a 5-row CSV lands with correct badges; every filter works and is reflected in the URL; queue actions write events; Reject without reason is blocked; a fourth web-search config needs no code change. Stop and report.

## Prompt 3 — D2 AM
D1 is accepted. Implement slot D2 AM only. credentials.json is in the repo root (gitignored).

Deliver:
1. src/lib/outreach/gmail.ts (googleapis): OAuth desktop flow via GET /api/gmail/auth + /api/gmail/callback persisting token.json; sendMessage(to, subject, body) -> threadId; listThreadMessages(threadId).
2. src/lib/outreach/draft.ts + POST /api/vendors/[id]/draft: Claude drafts an email citing >= 1 verified evidence row and, if next_action == outreach_to_verify, asking about each unknown must-field. Stored as interactions direction=draft.
3. Outreach page, Draft & Send tab: list of Qualified vendors; Sheet with editable subject/body/recipient (prefilled from contact_email); Send disabled unless recipient in DEMO_ALLOWED_RECIPIENTS (checked server-side in POST /api/vendors/[id]/send); Send -> gmail -> interactions row direction=outbound with gmail_thread_id -> transition Contacted actor=human.
4. Outreach page, Board tab: kanban with one column per status; cards show name, owner, next_action, due_at (overdue red), diligence_stage; filters owner, vendor_type; card click opens vendor detail.

Acceptance: I edit a draft, send to my second inbox, see it in Gmail Sent; vendor shows Contacted with thread_id and an events row; non-allowlisted recipient is rejected server-side; Board renders. Stop and report.

## Prompt 4 — D2 PM
D2 AM is accepted. Implement slot D2 PM only.

Deliver:
1. src/lib/track/poll.ts + POST /api/track/poll: for vendors with gmail_thread_id, fetch messages not yet in interactions, insert direction=inbound, on first inbound transition Contacted->Replied actor=system.
2. src/lib/track/infer.ts: for each new inbound, Claude returns zod-validated {to_status, to_stage, confidence, evidence_snippet, summary} given PRD §6 and current status/stage. Apply via transition() actor=llm_inference if confidence >= 0.85 and to_stage not in {quote_received, sampling}; otherwise insert into proposals.
3. Outreach page, Proposals tab: pending proposals with Accept / Reject; Revert button on any events row with actor=llm_inference (reverse transition, actor=human, reason=revert).
4. /vendors/[id] page: tabs Attributes (source badge per value), Evidence, Timeline (events with actor and reason), Thread (interactions).
5. Dashboard page: five primary metrics per PRD §4.1 as Cards, each a Link to the matching filtered Database or Outreach URL; secondary metrics below.
6. tests/replies/*.json: 10 inbound emails (accept, decline, ask-for-call, send-quote, out-of-office, request-NDA, wrong-contact, partial answer to unknown fields, pricing question, sample offer) with expected to_status/to_stage; `npm run test:replies` reports accuracy and which cases went to proposals.
7. README.md: setup, .env.local keys, Gmail auth steps, cron/route note for a future refresh job, and the 5-minute demo script.

Acceptance: test:replies >= 8/10; a reply from my second inbox advances the vendor within one poll; a quote reply lands in proposals; Revert works; all five dashboard cards navigate to the correct filtered view; Timeline shows every transition. Stop and report.

## Prompt 5 — P1 (only if time remains)
Implement P1: src/lib/pipeline/refresh.ts + POST /api/refresh {config} re-fetches each vendor's evidence URLs, re-extracts, diffs against attributes/tags, writes new evidence + tag_changed events (actor=system), sends screen_result changes to Review Queue, updates last_verified_at; schedules table + Inputs tab schedule picker + Refresh now button; follow-up drafts at 7d/14d without reply and Dormant at 10d; CSV export on the Database page. Stop and report.
