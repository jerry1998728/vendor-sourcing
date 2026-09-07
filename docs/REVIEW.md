# First-pass codebase review

> **Status (2026-09-06):** every item in the ordered list at the end was addressed on `fix/review-pass-1` (six batches, CI green at each). What stayed open by design: the schema notes (`gmail_message_id`, `proposals.decision`), evidence expiry, and the single-process deployment shape, now documented in the README. Demo-fix pass 1 (sidebar sections with sub-pages, Vendor Source usability, Dashboard charts, vendor Timeline, metric tooltips) followed on `demo/ui-pass-1`, PR #2.

Branch `review/cto-assessment`, 2026-09-06. Written as a CTO's first look: what a new engineer hits, one feature traced end to end, then problems by category with file and line references. Line numbers refer to this branch.

## Verdict

The domain core is the strong part: an eight-table schema with an append-only event log, a transition whitelist that is actually enforced (`src/lib/db/state.ts:171`), three-valued screening as a pure function (`src/lib/pipeline/screen.ts`), and 30 tests that cover those pieces. The weak parts are the edges: two 600-line adapters built around 200 to 300-line functions, business rules living in route handlers, small helpers copied across files, background jobs that run inside the request lifecycle with no durability, and no authentication on sixteen mutating endpoints. It is a credible MVP with the right seams in the middle and rough seams at the boundaries. And nothing built this week is committed.

## Step 1. Onboarding

**Clone reality.** `git ls-files` returns README, CLAUDE.md, `.gitignore`, `docs/`, `configs/`, `rulesets/` and the reply fixtures. `src/`, `package.json`, `tsconfig.json`, `drizzle/`, `scripts/`, the tests and `.env.example` are all untracked (45 paths in `git status`). A new engineer cloning the remote today gets a product spec and no application. Committing is the first task, before any of what follows.

**Fresh-copy test.** I copied the working tree without `node_modules`, `data/`, `.env*` and tokens, then ran the README's four commands. `npm ci` installs 817 packages in 28 seconds with one deprecation notice (eslint 9). `npm run seed:sample` works with no API keys and creates the database and 27 vendors. `npm test` passes 30 of 30. `npm run build` completes (exit 0, every page and route dynamic) with seven Turbopack warnings, all the same class: `path.resolve(process.cwd(), <dynamic>)` in `src/lib/db/index.ts:27`, `src/lib/outreach/gmail.ts:20`, `src/lib/pipeline/storage.ts` and the ruleset loader makes the bundler trace the whole project into the server output. Harmless locally, a deployment-size problem later; the fix is statically scoped roots such as `path.join(process.cwd(), "data", file)`. So the four-command path in the README is true once the code is committed; the only prerequisite it fails to state is the Node version.

**README gaps** (`README.md:52-80`):
- No Node version anywhere; `package.json` has no `engines`. `test:replies` uses `--env-file-if-exists`, which needs Node 22.9 or later, and `better-sqlite3` needs a prebuilt binary for the running Node version or a C++ toolchain. State `node >= 22` and say so.
- The app also reads `.env` (Next default) and the developer's real keys currently live there; the README only mentions `.env.local`. Harmless, undocumented.
- Migrations run implicitly on first database open (`src/lib/db/index.ts:35`). The README never says where the database file appears or that there is no explicit migrate step.
- `docs/BUILD_PROMPTS.md` is the sequence of prompts used to build the app with an AI assistant. It is process history, not product documentation; move it to `docs/history/` or drop it.

**Does the folder structure communicate the app?** Mostly yes. `src/lib/{db,pipeline,adapters,rulesets,llm,outreach,track}` maps one to one onto the PRD's architecture and `configs/` and `rulesets/` are self-explanatory. Three wobbles:
- `src/lib/vendor-filters.ts` sits at the lib root because it must be safe for the browser bundle; the reason exists only as a comment (`src/lib/vendor-filters.ts:1-4`) and `src/lib/db/filters.ts` re-exports it. A `src/lib/shared/` directory would say why.
- `src/components/database/` holds the run UI (`run-config-button`, `run-progress`, `runs-list`, `schedule-card`, `use-run`) which has nothing to do with the database page.
- `src/lib/rulesets/vendor.ts` says nothing about its content ("which ruleset judged this vendor").

## Step 2. Trace: "Run config" to vendors in the Review Queue

1. **Entry.** `src/components/database/run-config-button.tsx:63` calls `start()` from `src/components/database/use-run.ts:55-79`, which POSTs `/api/runs` and then polls `GET /api/runs/[id]` every two seconds (`use-run.ts:26-50`), calling `router.refresh()` when the run leaves `running` (`use-run.ts:39`).
2. **Route.** `src/app/api/runs/route.ts:18-68`: zod validation (9-15), refuse if a run for this config is active (34), resolve a replay source (42-49), `createRun` (53), schedule `executeRun` with Next's `after()` (59-65), return 202.
3. **Create.** `src/lib/pipeline/run.ts:56-101` loads config and ruleset, checks the adapter supports the vendor type, applies the development cap, inserts the `runs` row and writes `config.json` without awaiting it (98).
4. **Execute.** `src/lib/pipeline/run.ts:330-455`: discover (360) or read persisted candidates (356), normalize with concurrency three, `writeNormalizedVendor` for each vendor site (395), a second hop for mentioned vendors, counts, `finishRun`.
5. **Write.** `src/lib/pipeline/run.ts:144-325`, one transaction: upsert vendor, dedupe and insert evidence, drop placeholders, upsert tags by badge rank, build attributes from verified rows, call the pure `screen()`, then `transition(Identified -> Screened)` through `src/lib/db/state.ts:171`.
6. **Read.** `src/app/(app)/database/page.tsx:34` re-queries `listVendorsFiltered`; the Review Queue is `listReviewQueue` in `src/lib/db/filters.ts:98`.

**Where state lives.** SQLite is the only durable state. Job progress is a JSON column, `runs.counts.progress`, updated through `updateRunCounts` (`src/lib/db/queries.ts:95`). The execution itself lives in the Next process via `after()`: no queue, no lock, no resumption. If the process restarts mid-run (it happened twice during this build) the row stays `running` and `findActiveRun` (`src/lib/db/queries.ts:82-90`) blocks that config for thirty minutes. There is no cancel. Client state is the polling timer and last view in `useRun`; filters live only in the URL, which is the right call.

**Errors.** Routes answer 400 and 409 correctly. `executeRun` has a catch-all that marks the run failed; per-vendor normalize failures are counted and skipped. Two holes: `useRun.tick` stops polling on the first transient fetch error (`use-run.ts:41-45`), leaving the button idle while the server keeps running; and the four `void persistJson` calls never surface a disk failure (`run.ts:98`, `refresh.ts:66`, `manual.ts:256`, `manual.ts:298`).

**Tangling.** The pure parts really are pure: `screen.ts`, `decideAction` (`src/lib/track/infer.ts`), `checkDraft` (`src/lib/outreach/draft.ts`), `diffSnapshots` (`src/lib/pipeline/refresh.ts`), `cron.ts`, `ids.ts`, `allowlist.ts`. The tangled parts: `writeNormalizedVendor` makes every decision (tag ranking, attribute promotion, placeholder cleanup, screening, transition) inside the transaction; `normalize()` in `src/lib/adapters/webSearchLlm.ts:310-598` is one 290-line function that fetches, calls the model, grounds every value and assembles evidence and tags; and route handlers own business rules that belong in the domain layer (below).

## Step 3. Problems

### Secrets and exposure
- Nothing sensitive is tracked. `.gitignore:34-36` covers `.env*`, `credentials.json`, `token.json` and `data/`; the token file is written with mode 600 (`src/lib/outreach/gmail.ts:53-54`).
- Every mutating endpoint is unauthenticated: sixteen `POST` handlers under `src/app/api/`, including sending email (`vendors/[id]/send`), reverting events, writing YAML to disk (`configs/route.ts:45`) and exporting the whole database (`export/route.ts`). The PRD puts auth out of scope, so this is a decision, but the moment `npm run start` is reachable beyond localhost it is an open email-sending API. A shared-secret header on `/api/*` is a two-file change and should precede any deployment.
- The OAuth flow has no `state` parameter (`gmail.ts:72` builds the URL without one; `gmail/callback/route.ts:9` reads only `code`), so account linking is open to CSRF. Local use mitigates it; it is still wrong.
- `POST /api/track/simulate` and the `as_of` time override are gated only by `NODE_ENV` (`track/simulate/route.ts:18`, `track/followups/route.ts:21`).

### Error handling
- `src/lib/rulesets/vendor.ts:16-17` returns `null` for any ruleset load error. A broken YAML silently makes drafts stop asking questions and the vendor page show no must-fields; it should throw or at least log.
- `src/components/database/review-queue.tsx:53-59`: `dismiss` has `try/finally` and no `catch`, so a failed request is an unhandled rejection with no UI feedback. `use-run.ts:91` and `draft-sheet.tsx` (status fetch) swallow errors on purpose; acceptable, but undocumented.
- `src/lib/db/index.ts:35` runs migrations on every open with no lock. Fine for one process; two instances race.
- `src/lib/pipeline/run.ts:356` casts disk JSON straight to `RawRecord[]`; replay trusts whatever is in `data/runs`.
- `src/app/api/vendors/[id]/send/route.ts` sends the email before the database write. A failed write leaves the email sent and the vendor Qualified. It logs loudly, which is the right minimum, but there is no reconciliation path.

### Duplication with small mutations
- `DEFAULT_RULESET` three times: `src/app/api/inputs/manual/template/route.ts:9`, `src/components/database/inputs-tab.tsx:34`, `src/lib/rulesets/vendor.ts:8`.
- The development-environment check four times: `src/lib/pipeline/run.ts:45`, `src/lib/pipeline/refresh.ts:29`, `src/app/api/track/followups/route.ts:21`, `src/app/(app)/vendors/[id]/page.tsx:55`.
- `single()` for search params three times: `src/lib/vendor-filters.ts:44`, `src/app/(app)/outreach/page.tsx:17`, `src/app/(app)/vendors/[id]/page.tsx:31`.
- Screen-result colour classes in four files with two different opacities: `src/components/badges.tsx:7` (`/15`), `src/components/database/vendors-table.tsx:31` (`/10`), `vendors-tab.tsx:39`, `run-progress.tsx:48`, `inputs-tab.tsx:382`.
- Email normalisation twice: `src/lib/outreach/allowlist.ts:9` and `src/components/outreach/draft-sheet.tsx:25`.
- A JSON POST helper twice (`inputs-tab.tsx:36`, `proposals-tab.tsx:14`) plus five hand-written fetches elsewhere.
- **Three definitions of "unknown must-field" that can disagree:** `src/components/outreach/draft-sheet.tsx:30` derives it from `screen_reasons`, `src/lib/outreach/draft.ts:34` from the ruleset against verified evidence rows, `src/lib/track/poll.ts:61` from the ruleset against attribute keys. The chip in the UI, the questions in the draft and the context given to inference can each name a different set. This is a correctness problem, not style; one function in `src/lib/rulesets/vendor.ts` should own it.

### Size and responsibility
- `src/lib/adapters/webSearchLlm.ts`, 629 lines: `discover()` 93-309, `normalize()` 310-598.
- `src/lib/adapters/githubOrg.ts`, 612 lines: `collectSignals` 245-382.
- `src/lib/pipeline/run.ts`, 455 lines: `writeNormalizedVendor` 144-325, `executeRun` 330-455.
- `src/lib/db/state.ts`, 440 lines: `transition()` 171-336 handles validation, revert resolution, stage rules, the insert and the update in one body.
- `src/components/database/inputs-tab.tsx`, 421 lines: three forms with their fetch logic inside the components.
- `src/app/api/vendors/[id]/send/route.ts`, 130 lines: follow-up detection (58-62), the seven-day due date (20), owner assignment and contact backfill are business rules in a route. Same pattern in `transition/route.ts:35` (the minimum reject-reason rule) and `proposals/[id]/route.ts:50` (decision encoding).
- `src/lib/db/queries.ts`, 244 lines across vendors, runs, interactions, proposals and schedules; the section banners at 110, 141 and 208 are the tell that it wants to be four files.
- `scripts/seed-sample.ts`, 456 lines of fixture data and write logic together.

### Comments
Mostly explain why, with file headers that state the rule being enforced; that is the right habit. Section banners such as `// Base columns` and `// Runs list` are labels rather than explanations, and a few restate the code (`src/components/outreach/draft-sheet.tsx:59`). Not a real problem.

### Boundary between I/O and decisions
Present where it matters most (screening, inference policy, draft validation, refresh diff, cron) and absent in the write and ingest paths: `writeNormalizedVendor` decides inside the transaction, `ingestInbound` (`src/lib/track/poll.ts`) mixes database, LLM and transitions and needs a test seam (`inferFn`) to be testable at all, `generateDraft` calls the model and inserts in one function, and `normalize()` does network, model and grounding together. The fix is the same shape each time: a pure `plan(existing, incoming)` that returns what to write, and a thin applier.

### Deployment shape
The app assumes one long-lived process with a writable disk: the SQLite file, `data/runs/`, `token.json` written by the OAuth callback, and YAML configs written from the Inputs tab (`src/app/api/configs/route.ts:45`). Background work runs in the request lifecycle through `after()`. None of that survives a serverless or multi-instance deployment, and the tracing warnings above are the first symptom. This is fine for a single-box MVP and should be written down as the deployment contract so nobody discovers it on a Vercel dashboard.

### Dependencies
- `shadcn` is listed as a runtime dependency (`package.json:32`); it is a CLI and belongs in `devDependencies`.
- `googleapis` pulls the entire Google API surface for one Gmail client; `@googleapis/gmail` with `google-auth-library` is the same code at a fraction of the install.
- `@tanstack/react-table` is pinned to 8.21 while 9.2 is current (a deliberate pin during the build; note the upgrade cost). `@types/node` is 20 on Node 24. `eslint` 9 prints a deprecation notice at install; TypeScript 5.9 versus 7.0 is a major jump not worth rushing.
- `cn` is a one-line utility installed as a package (18 imports), a shadcn preset choice; harmless.
- No `engines` field, no CI configuration. All 17 UI components are imported; nothing dead there.

### Tests
Thirty tests give real coverage of the state machine, screening, the write path, filters, CSV, outreach helpers, tracking, cron and refresh. Gaps: nothing exercises the web adapter's grounding (`findSnippet`) or any route handler; `test:replies` costs money and cannot run in CI as is; there is no CI at all.

## What I would do first, in order

1. Commit the tree. Everything else is moot until it is in git.
2. Shared-secret auth on `/api/*` and a `state` parameter on the OAuth flow.
3. One `unknownMustFields()` in `src/lib/rulesets/vendor.ts`, used by the sheet, the draft and inference.
4. Split `normalize()` and `writeNormalizedVendor` into plan and apply; then `ingestInbound` and `generateDraft`.
5. Move the business rules out of the send, transition and proposal routes into `state.ts` and `outreach/`.
6. Job durability: mark `running` runs failed on boot, add cancel, drop the thirty-minute heuristic.
7. Fold the duplicated helpers into one place each.
8. `engines`, `shadcn` to devDependencies, and a CI job that runs `npm test` and `next build`.
