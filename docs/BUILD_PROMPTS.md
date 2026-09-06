# Build prompts — paste one per slot, in order

## Prompt 1 — D1 AM
Read CLAUDE.md and docs/PRD.md. Implement slot D1 AM only.

Deliver:
1. db/schema.sql + db/init.py: the eight tables in PRD §5 with the exact fields. db/state.py: transition whitelist from PRD §6; transition(vendor_id, to_status, actor, reason, confidence=None, evidence_ref=None, to_stage=None) validates, inserts an events row, updates vendors; rebuild_status(vendor_id) replays events and asserts equality.
2. core/models.py: DiscoveryQuery, RawRecord, VendorCandidate, Evidence, Tag dataclasses; SourceAdapter Protocol per PRD §7.
3. core/screen.py: pure screen(vendor, evidence, ruleset) -> (result, reasons). Must-field with verified evidence failing threshold -> fail; missing or unverified -> unknown; all pass -> pass. Reasons JSON-serializable. Also compute coverage_confidence = verified must-fields / total must-fields.
4. core/config.py: loads configs/*.yaml and rulesets/*.yaml. Create configs/ego_data_stereo.yaml (adapter web_search_llm, ruleset ego_data_supplier@v1, 6–8 seed queries) and rulesets/ego_data_supplier.v1.yaml (must: sensor_rig=stereo, registration_country != CN, ownership_country != CN; should: scene_diversity >= 3 collection countries or >= 3 scene classes, scale).
5. adapters/web_search_llm.py: discover() runs seed queries via the Anthropic web_search tool; normalize() asks Claude for strict JSON {page_type, name, primary_domain, registration_country, ownership_country, parent_entity, collection_countries, fields:[{field_path, value, source_url, snippet, confidence, proxy}], tags:[{dimension, value, source_url, snippet}]} using the tag dimensions in PRD §5. Only page_type == "vendor_site" produces evidence. No source_url or snippet -> verified=false.
6. inputs/run.py --config: creates runs row (input_type=web_search), persists raw payloads, normalizes, dedups on normalized domain (fallback slug(name)+type), writes vendors/evidence/tags, screens, writes attributes from verified evidence only, transitions Identified->Screened, prints counts: discovered, pass, fail, unknown, must_field_coverage, unknown_rate.
7. ui/app.py with sidebar pages Dashboard (placeholder), Database, Outreach (placeholder). Database page: Vendors tab with columns name, vendor_type, screen_result, status, coverage_confidence, last_verified_at, run_id; row click shows that vendor's evidence and tags. Add .streamlit/config.toml from docs/THEME.md.

Acceptance: `python inputs/run.py --config configs/ego_data_stereo.yaml` lands >= 15 vendors in Screened under one run_id; every must-field has an evidence row; no unverified value in attributes; re-run creates no duplicates; rebuild_status matches for all. Stop and show me the printed counts and three sample vendors with evidence and tags.

## Prompt 2 — D1 PM
D1 AM is accepted. Implement slot D1 PM only.

Deliver:
1. adapters/github_org.py implementing SourceAdapter with PyGithub: one VendorCandidate per org; evidence rows for merged_prs_public (proxy=true), ci_config, release_tags, test_directory, license, lockfile, last_commit_days, is_fork_or_tutorial; tags for code_language, code_license, org_type, modality=code, collection_type=licensed_existing. Cap 50 orgs.
2. rulesets/repo_owner.v1.yaml per PRD §2. configs/code_data_github_orgs.yaml (github_org) and configs/code_data_brokers.yaml (web_search_llm, broker seed queries). inputs/run.py dispatches on config.adapter with no change to the web path.
3. Database page filters: vendor_type, screen_result, status, owner, country in/not in, coverage_confidence range, source_channel, stale (last_verified_at > 30d), and multi-select on every tag dimension in PRD §5. Configurable columns.
4. Database page Review Queue tab: one vendor per screen, sorted by coverage_confidence desc; attributes left, evidence right (value, snippet, clickable URL); unknown must-fields pinned on top; buttons Qualify / Reject (reason code dropdown required) / Need info (Qualified + next_action=outreach_to_verify). All call db/state.transition with actor=human.
5. Database page Inputs tab: (a) Custom web search form: vendor_type, free-text requirement, limit -> Claude generates seed queries shown in an editable box -> Run button calls inputs/run.py logic; GitHub variant form: languages, min merged PRs, activity window days, exclude keywords. (b) Manual upload: CSV template download (columns = field_path + tag dimensions + source_url + attestation), upload -> goes through normalize -> evidence (extraction_method=manual, verified=true only with source_url or attestation) -> screen -> Review Queue; runs row with input_type=manual. (c) Runs list with counts and ruleset_version.

Acceptance: all three configs run and both H1 configs are required (no cut); github_org yields >= 15 candidates ranked by should-score; a 5-row CSV lands with correct badges; every filter works; queue actions write events; Reject without reason is blocked; adding a fourth web-search config needs no code change. Stop and report.

## Prompt 3 — D2 AM
D1 is accepted. Implement slot D2 AM only. credentials.json is in the repo root (gitignored).

Deliver:
1. outreach/gmail_client.py: OAuth desktop flow persisting token.json; send_message(to, subject, body) -> thread_id; list_thread_messages(thread_id) -> [{message_id, from, date, subject, body_text}].
2. outreach/draft.py: for each Qualified vendor, Claude drafts an email citing >= 1 verified evidence row (field_path + value in prompt) and, if next_action == outreach_to_verify, asking about each unknown must-field. Store as interactions direction=draft.
3. Outreach page, Draft & Send tab: Qualified vendors; editable subject/body/recipient (prefilled from contact_email); do_not_send enforced unless recipient in DEMO_ALLOWED_RECIPIENTS; Send -> gmail_client -> interactions row direction=outbound with gmail_thread_id -> transition Contacted actor=human.
4. Outreach page, Board tab: one column per status; cards show name, owner, next_action, due_at (overdue red), diligence_stage; filters owner, vendor_type.

Acceptance: I edit a draft, send to my second inbox, see it in Gmail Sent; vendor shows Contacted with thread_id and an events row; non-allowlisted recipient is blocked; Board renders. Stop and report.

## Prompt 4 — D2 PM
D2 AM is accepted. Implement slot D2 PM only.

Deliver:
1. track/poll.py: for vendors with gmail_thread_id, fetch messages not yet in interactions, insert direction=inbound, on first inbound transition Contacted->Replied actor=system.
2. track/infer.py: for each new inbound, Claude returns strict JSON {to_status, to_stage, confidence, evidence_snippet, summary} given PRD §6 and current status/stage. Apply via db/state.transition actor=llm_inference if confidence >= 0.85 and to_stage not in {quote_received, sampling}; otherwise insert into proposals.
3. Outreach page, Proposals tab: pending proposals with Accept / Reject; Revert button on any events row with actor=llm_inference (reverse transition, actor=human, reason=revert).
4. Vendor Detail (reachable from Database and Board): tabs Attributes (source badge per value), Evidence, Timeline (from events with actor and reason), Thread (interactions).
5. Dashboard page: five primary metrics per PRD §4.1, each rendered as a clickable element that navigates to the matching filtered Database or Outreach view (use st.session_state to carry filters); secondary metrics below.
6. tests/replies/: 10 inbound emails (accept, decline, ask-for-call, send-quote, out-of-office, request-NDA, wrong-contact, partial answer to unknown fields, pricing question, sample offer) with expected to_status/to_stage; tests/run_replies.py reports accuracy and which cases went to proposals.
7. README.md: setup, .env keys, cron line for a future refresh job, and the 5-minute demo script.

Acceptance: run_replies.py >= 8/10; a reply from my second inbox advances the vendor within one poll; a quote reply lands in proposals; Revert works; all five dashboard numbers navigate correctly; Timeline shows every transition. Stop and report.

## Prompt 5 — P1 (only if time remains)
Implement P1: inputs/refresh.py --config re-fetches each vendor's evidence URLs, re-extracts, diffs against attributes/tags, writes new evidence + tag_changed events (actor=system), sends screen_result changes to Review Queue, updates last_verified_at; schedules table + Inputs tab schedule picker + Refresh now button; follow-up drafts at 7d/14d without reply and Dormant at 10d; CSV export on Database page. Stop and report.
