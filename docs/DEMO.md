# Demo runbook (about 8 minutes live, 5 without email)

## Before you start (5 minutes, once)

1. `npm run dev`, open http://localhost:3000/dashboard in your own browser. Open a second tab on the Outreach page and a third on your hotmail inbox (`jerryxie1998@hotmail.com`).
2. Check the Draft & Send tab shows **Gmail connected** and the allowlist line lists your hotmail address. If not: `.env.local` needs `DEMO_ALLOWED_RECIPIENTS`, and **Connect Gmail** writes `token.json`.
3. Decide live or rehearsal for the two paid steps. Live discovery costs cents (five candidates on haiku, about a minute); a draft is one sonnet call, a few seconds. Both are safe to run in front of people.
4. Optional clean slate: `rm data/vendor-sourcing.db*` then `npm run seed:sample` gives you 27 fictional vendors. Keep the current database if you want the real GitHub organisations and the real ego vendors in the table; they demo better.

Vendors picked for this database: Review Queue **Verity POV**, **Helix**, **Quill** (fictional, pass). Draft & Send **WearCapture** (ownership unknown, so the draft asks about it) or **Northlight Ego Labs** (everything known, so the draft asks for a call). Real vendors from live discovery: **Shaip**, **iMerit**, **Claru**, **Unidata**.

## The story in one line

Every vendor value carries evidence; screening says pass, fail or unknown instead of guessing; unknown becomes an outreach question; every status change is a human click or a logged, revertible inference.

## Steps

**1. Dashboard, 30 seconds.** Point at the five cards: funnel, coverage by type, unknown rate, active pipeline with reply rate, work backlog. Click the unknown-rate number: the Database opens filtered to unknown vendors and the URL carries the filter. Say: unknown is not optimised to zero, it is the outreach queue.

**2. Discovery, 90 seconds.** Database → Vendors. Pick `ego_data_stereo` in the config selector, press **Run config**. While it runs (five candidates, haiku), open Database → Inputs and show the Custom web search form: a new category is a requirement plus editable seed queries, saved as a YAML config, no code. When the run finishes the badges show discovered, vendor sites, pass / unknown / fail, coverage and unknown rate; the Runs list at the bottom of Inputs shows the `ruleset_version`.
Fallback with no budget: tick **Replay latest run** first; it re-extracts the last run's candidates from disk without searching.

**3. Evidence, 60 seconds.** Click **Shaip** or **iMerit** in the table. Evidence rows with verbatim snippets and source links; tags with source badges; the timeline. Point out a `proxy` badge on a GitHub vendor (merged public PRs stand in for private scale) versus `verified`. Press **Export CSV** to show the filtered export.

**4. Review Queue, 60 seconds.** One vendor at a time, unknown must-fields pinned on top. **Qualify** Verity POV, **Reject** Helix and show the reason selector is required, **Need info** on an unknown vendor: it becomes Qualified with `outreach_to_verify`.

**5. Draft & Send, 90 seconds.** Outreach → Draft & Send → **WearCapture** → **Generate draft**. Read the draft: it cites the stereo glasses and Austin registration and asks who owns the company. Set the recipient to your hotmail address, edit a line, **Send**. Vendor becomes Contacted with the Gmail thread id; open its page to show the human event on the Timeline.

**6. Reply and inference, 90 seconds.** In hotmail, reply to the email with "Happy to talk, can we set up a call next week?". Outreach → Proposals → **Poll inbox**: Contacted → Replied is a system event, then inference applies In Discussion / responded at 0.9 confidence. Show the vendor Timeline, press **Revert** on the inference event, show it reversed with a human event.
Then reply again with a quote ("USD 1,800 per hour, minimum 200 hours") and poll: this time it waits in Proposals because quotes are always a human decision; **Accept** it.
Fallback without email: on the vendor page, Thread tab, the **Simulate reply** box runs the same path.

**7. Board and follow-ups, 45 seconds.** Outreach → Board: columns by status, an overdue due date in red, the diligence stage on In Discussion cards. Proposals → **Run follow-ups**: silent vendors get a 7-day draft and become Dormant after 10 days (Alpine Egocentric already shows this).

**8. Refresh, 30 seconds, optional.** Inputs → Scheduled refresh → **Refresh now** on `code_data_github_orgs` (GitHub API only, free). Open a refreshed vendor's Timeline: `tag_changed` with the diff, and the schedule row now shows the last run.

## Numbers to quote

From the last run card and the Dashboard: candidates discovered, screen pass rate, must-field coverage, unknown rate, reply rate, median time to first reply. Then the blind spots: private-repo scale is proxied by public merged PRs; ownership and collection geography are rarely on vendor sites, so they stay unknown until outreach; anything web search does not surface is not in the table.

## If something goes wrong

- A run fails with a credit message: replay instead, or show the failed run in the Runs list to make the point that every run is recorded.
- Send is disabled: the recipient must be exactly the allowlisted address and Gmail must show connected.
- Poll finds nothing: give Gmail a minute, or use Simulate reply.
- The page looks stale after an action: it refreshes on its own; a browser reload is safe, the URL carries all state.
