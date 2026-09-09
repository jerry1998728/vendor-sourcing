# MVP build plan (historical)

The original two-day plan from PRD v2.0, kept for the record. The build is complete and everything below shipped, so the live specification is [docs/PRD.md](../PRD.md); this file is not maintained.

**Build window:** 2 days · **Stack at the time:** Next.js (App Router, TypeScript) · Drizzle + SQLite · Tailwind + shadcn/ui · @anthropic-ai/sdk · googleapis (Gmail) · octokit

## Scope as planned

**P0**
- Schema (§5), state machine (§6), adapter contract + pure `screen()`
- Inputs: custom web search (both adapters), manual CSV upload
- Database section with filters, tags, review queue, vendor detail
- Outreach page: board, draft & send (human gate), proposals (LLM inference, threshold 0.85)
- Dashboard with 5 clickable primary metrics and linked charts
- Seed data: ≥15 ego vendors, ≥15 repo orgs
- Reply test set (10 cases), README, demo script

**P1**
- Scheduled refresh job + `schedules` table + stale flag
- Follow-up touchpoints (7d, 14d) and dormancy
- CSV export

## Slot plan

| Slot | Deliverable | Cut if behind |
|---|---|---|
| D1 AM | Drizzle schema (8 tables), state machine, config/ruleset loader, `screen()`, `web_search_llm` adapter, ego config, `/api/runs` route, app shell with sidebar + Vendors table | 8 vendors |
| D1 PM | `github_org` adapter, repo_owner ruleset, H1b config, tags population, filters, Review Queue tab, Inputs tab (web search form, manual upload) | Drop manual upload, then tag filters; both H1 configs stay |
| D2 AM | Gmail OAuth (googleapis), draft generation, Draft & Send, Board (kanban) | Manual paste to Gmail, still store thread_id |
| D2 PM | Poll, inference, Proposals, Vendor Detail (4 tabs), Dashboard with links, reply tests, README + demo script | Drop secondary dashboard metrics |
| P1 (if time) | Refresh job + schedules + stale flag, follow-ups, CSV export | — |

Hard rule: end of D1 = `npm run dev` shows the Database page populated from a config, with Review Queue working.

## What happened after

Everything in P0 and P1 shipped inside the window. Four later passes added the review fixes, the demo fixes, the lifecycle grouping and the diligence checklist; the prompts that drove the original slots are in [BUILD_PROMPTS.md](BUILD_PROMPTS.md).
