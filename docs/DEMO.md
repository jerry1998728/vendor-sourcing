# Demo script (5 minutes)

**Offline rehearsal** (no keys): `python scripts/seed_demo.py`, start the UI, pick `demo.db` in the sidebar.

1. **Start a run** — pick `ego_data_stereo`, show adapter / ruleset / seed queries; the runs table shows
   `run_id`, `ruleset_version`, discovered / pass / fail / unknown, must-field coverage, unknown rate.
   (Live: press *Run discovery*; needs API credit.)
2. **Review queue** — one vendor per screen. Left: must-criteria with unknowns pinned; right: evidence with
   verbatim snippets and clickable source URLs. Clear three: **Qualify** one `pass`, **Reject** one `fail`
   with a reason code (required), **Need info** one `unknown` (→ Qualified with `next_action = outreach_to_verify`).
3. **Outreach** — pick a Qualified vendor. *Template draft* (or *Draft with Claude*) cites an evidence row by id.
   Edit, set recipient, **Send via Gmail** → thread id stored, status → Contacted. The do_not_send guard only
   allows addresses in `OUTREACH_ALLOWED_RECIPIENTS`.
4. **Status review** — *Poll inbox* (live) or *Simulate an inbound reply* (demo). Contacted → Replied is automatic;
   the inference proposal auto-applies at ≥ 0.85 (see *Auto-applied transitions*, one-click **Revert**);
   quotes / samples and low-confidence proposals wait for **Accept / Reject**.
5. **Vendor detail → Timeline** — every transition with actor, reason, confidence, event id; the header shows
   `events ↔ status consistent` from `rebuild_status`.
6. **Pipeline board** — columns by status, cards with stage / next_action / owner / due date (overdue red).
7. **Export** — download `vendors.csv`.

Reported at the demo: `candidates_discovered · screen_pass_rate · must_field_coverage · unknown_rate` from the
runs table, plus the blind-spot list: private-repo scale (proxied by public merged PRs), collection geography
(rarely stated on vendor sites → unknown → outreach), and anything web search does not surface.
