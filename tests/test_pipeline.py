"""Offline test-suite (no network): state machine + gates + revert, screening, review actions,
outreach draft/send with FakeGmail, tracking with FakeGmail + FakeLLM/HeuristicLLM, github_org
adapter with a fake gateway, CSV export.   Run:  .venv/bin/python -m unittest -v tests/test_pipeline.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "discover"))

from adapters.github_org import GitHubOrgAdapter, OrgInfo, RepoInfo  # noqa: E402
from core import actions  # noqa: E402
from core.config import load_ruleset  # noqa: E402
from core.export import vendors_csv  # noqa: E402
from core.llm import FakeLLM  # noqa: E402
from core.models import DiscoveryQuery, Evidence, VendorCandidate  # noqa: E402
from core.screen import screen  # noqa: E402
from db import state as S  # noqa: E402
from db.init import init_db  # noqa: E402
from outreach.draft import draft_email, save_draft  # noqa: E402
from outreach.gmail_client import FakeGmail, strip_quoted_reply  # noqa: E402
from outreach.send import SendBlocked, approve_and_send  # noqa: E402
from run import upsert_vendor  # noqa: E402
from track.infer import HeuristicLLM, apply_proposal, pending_proposals, resolve_proposal  # noqa: E402
from track.poll import poll  # noqa: E402


def ev(fp, val, url="https://acme.example/about", conf=0.9, verified=True, proxy=False):
    return Evidence(fp, val, url, "llm", f"snippet about {val}", conf, proxy=proxy, verified=verified)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.conn = init_db(os.path.join(self.tmp, "t.db"))
        self.conn.execute("INSERT INTO runs (run_id, adapter, vendor_type, ruleset_version, started_at) VALUES ('r1','web_search_llm','ego_data_supplier','ego_data_supplier@v1','t')")
        self.conn.commit()
        self.rs = load_ruleset("ego_data_supplier@v1")
        os.environ["DEMO_ALLOWED_RECIPIENTS"] = "sales@acme.example"
        os.environ.pop("OUTREACH_GO_LIVE", None)

    def add_vendor(self, vid="acme.example", name="Acme", evidence=None):
        cand = VendorCandidate(name=name, vendor_type="ego_data_supplier", primary_domain=vid, source_url=f"https://{vid}/", discovered_via="web_search_llm")
        evidence = evidence if evidence is not None else [ev("capture.stereo_camera", "true"), ev("entity.hq_country", "DE"),
                                                          ev("collection.countries", "DE"), ev("collection.countries", "US")]
        return upsert_vendor(self.conn, cand, evidence, self.rs, "r1", "web_search_llm")


class TestStateMachine(Base):
    def test_gates_and_revert(self):
        out = self.add_vendor()
        self.assertEqual(out["screen_result"], "pass")
        vid = "acme.example"
        with self.assertRaises(S.GateViolation):
            S.transition(vid, "Qualified", "system", "auto", conn=self.conn)
        actions.qualify(self.conn, vid, "looks good")
        with self.assertRaises(S.IllegalTransition):
            S.transition(vid, "Replied", "human", "skip", conn=self.conn)
        S.transition(vid, "Contacted", "human", "sent", conn=self.conn)
        S.transition(vid, "Replied", "system", "inbound", conn=self.conn)
        eid = S.transition(vid, "In Discussion", "llm_inference", "engaged", confidence=0.9, conn=self.conn)
        self.assertEqual(S.current_state(vid, self.conn), ("In Discussion", "responded"))
        with self.assertRaises(S.GateViolation):
            S.revert_event(eid, actor="llm_inference", reason="x", conn=self.conn)
        S.revert_event(eid, reason="wrong call", conn=self.conn)
        self.assertEqual(S.current_state(vid, self.conn), ("Replied", None))
        self.assertEqual(S.rebuild_status(vid, self.conn), "Replied")
        # a revert of a human event is refused; only the latest event can be reverted
        with self.assertRaises(S.IllegalTransition):
            S.revert_event(eid, reason="again", conn=self.conn)
        S.transition(vid, "In Discussion", "human", "engaged after all", conn=self.conn)
        S.transition(vid, "In Discussion", "human", "quote", to_stage="quote_received", conn=self.conn)
        with self.assertRaises(S.GateViolation):
            S.transition(vid, "In Discussion", "llm_inference", "sample", to_stage="sampling", confidence=0.99, conn=self.conn)
        actions.approve(self.conn, vid, "go")
        self.assertEqual(S.rebuild_status(vid, self.conn), "Approved")

    def test_screen_verdict_from_upsert(self):
        out = self.add_vendor()
        self.assertEqual(out["screen_result"], "pass")
        v = self.conn.execute("SELECT * FROM vendors WHERE vendor_id='acme.example'").fetchone()
        self.assertEqual(v["status"], "Screened"); self.assertEqual(v["country"], "DE")
        self.assertEqual(json.loads(v["attributes"])["collection.countries"], ["DE", "US"])
        out2 = self.add_vendor(vid="beta.example", name="Beta", evidence=[ev("capture.stereo_camera", "true", verified=False)])
        self.assertEqual(out2["screen_result"], "unknown")
        self.assertEqual(self.conn.execute("SELECT next_action FROM vendors WHERE vendor_id='beta.example'").fetchone()[0], "outreach_to_verify")
        self.assertEqual(json.loads(self.conn.execute("SELECT attributes FROM vendors WHERE vendor_id='beta.example'").fetchone()[0]), {})

    def test_reject_requires_code_and_reopen(self):
        self.add_vendor()
        with self.assertRaises(ValueError):
            actions.reject(self.conn, "acme.example", "nope")
        actions.reject(self.conn, "acme.example", "in_china", "Shenzhen HQ")
        self.assertEqual(S.current_state("acme.example", self.conn)[0], "Rejected")
        with self.assertRaises(S.GateViolation):
            S.transition("acme.example", "Qualified", "system", "reopen", conn=self.conn)
        actions.reopen(self.conn, "acme.example", "new info")
        self.assertEqual(S.rebuild_status("acme.example", self.conn), "Qualified")


class TestOutreachAndTrack(Base):
    def _to_qualified(self, vid="acme.example"):
        self.add_vendor(vid=vid, name="Acme " + vid)
        actions.qualify(self.conn, vid)

    def test_template_draft_cites_evidence(self):
        self._to_qualified()
        d = draft_email(self.conn, "acme.example", None, "Jerry", "Sourcing Co")
        self.assertEqual(d["method"], "template"); self.assertTrue(d["cited_evidence_ids"])
        self.assertIn("acme.example/about", d["body"])
        iid = save_draft(self.conn, "acme.example", d)
        self.assertEqual(self.conn.execute("SELECT direction FROM interactions WHERE interaction_id=?", (iid,)).fetchone()[0], "draft")

    def test_llm_draft_validation_and_fallback(self):
        self._to_qualified()
        bad = FakeLLM(responses=[{"subject": "hi", "body": "no citations", "cited_evidence_ids": [9999]}])
        d = draft_email(self.conn, "acme.example", bad)
        self.assertEqual(d["method"], "template"); self.assertIn("fallback_reason", d)
        first_id = self.conn.execute("SELECT min(evidence_id) FROM evidence").fetchone()[0]
        good = FakeLLM(responses=[{"subject": "Stereo data", "body": "We saw your stereo rig.", "cited_evidence_ids": [first_id]}])
        d = draft_email(self.conn, "acme.example", good)
        self.assertEqual(d["method"], "llm"); self.assertEqual(d["cited_evidence_ids"], [first_id])

    def test_send_guard_and_transition(self):
        self._to_qualified()
        g = FakeGmail()
        with self.assertRaises(SendBlocked):
            approve_and_send(self.conn, "acme.example", "someone@else.example", "s", "b", g)
        out = approve_and_send(self.conn, "acme.example", "sales@acme.example", "Hello", "Body", g)
        self.assertTrue(out["thread_id"].startswith("thr_"))
        self.assertEqual(S.current_state("acme.example", self.conn)[0], "Contacted")
        row = self.conn.execute("SELECT gmail_thread_id, direction FROM interactions WHERE interaction_id=?", (out["interaction_id"],)).fetchone()
        self.assertEqual((row[0], row[1]), (out["thread_id"], "outbound"))
        with self.assertRaises(SendBlocked):  # already Contacted
            approve_and_send(self.conn, "acme.example", "sales@acme.example", "Hello", "Body", g)

    def _contacted(self, vid="acme.example"):
        self._to_qualified(vid)
        g = self.gmail = getattr(self, "gmail", FakeGmail())
        return approve_and_send(self.conn, vid, "sales@acme.example", "Hello", "Body", g)["thread_id"]

    def test_poll_auto_apply_pending_and_quote_gate(self):
        tid = self._contacted()
        # 1) substantive reply, high confidence -> Replied (auto) then In Discussion/responded (auto)
        self.gmail.inject_reply(tid, "Sam <sales@acme.example>", "Yes, happy to help.\n\n> On Mon you wrote:\n> Hello")
        llm = FakeLLM(responses=[{"summary": "engaged", "to_status": "In Discussion", "to_stage": "responded", "confidence": 0.9, "evidence_snippet": "happy to help"}])
        counts = poll(self.conn, self.gmail, llm)
        self.assertEqual((counts["inbound_new"], counts["replied"], counts["auto_applied"]), (1, 1, 1))
        self.assertEqual(S.current_state("acme.example", self.conn), ("In Discussion", "responded"))
        body = self.conn.execute("SELECT body_text FROM interactions WHERE direction='inbound'").fetchone()[0]
        self.assertEqual(body, "Yes, happy to help.")   # quoted history stripped
        self.assertIn("happy to help", llm.calls[0])
        # 2) idempotent: polling again sees no new messages
        self.assertEqual(poll(self.conn, self.gmail, FakeLLM(fail=True))["inbound_new"], 0)
        # 3) quote -> never auto, goes to review queue even at 0.99
        self.gmail.inject_reply(tid, "sales@acme.example", "Our quote is $12 per hour.")
        llm = FakeLLM(responses=[{"summary": "quote", "to_status": "In Discussion", "to_stage": "quote_received", "confidence": 0.99, "evidence_snippet": "$12 per hour"}])
        counts = poll(self.conn, self.gmail, llm)
        self.assertEqual(counts["pending"], 1)
        self.assertEqual(S.current_state("acme.example", self.conn), ("In Discussion", "responded"))
        pend = pending_proposals(self.conn); self.assertEqual(len(pend), 1)
        self.assertEqual((pend[0]["to_status"], pend[0]["to_stage"], pend[0]["decision"]), ("In Discussion", "quote_received", None))
        resolve_proposal(self.conn, pend[0]["proposal_id"], True, "confirmed quote")
        self.assertEqual(S.current_state("acme.example", self.conn), ("In Discussion", "quote_received"))
        self.assertEqual(pending_proposals(self.conn), [])
        row = self.conn.execute("SELECT decision, decided_by, event_id FROM proposals WHERE proposal_id=?", (pend[0]["proposal_id"],)).fetchone()
        self.assertEqual((row[0], row[1]), ("accepted", "human")); self.assertIsNotNone(row[2])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM proposals WHERE decision='auto_applied'").fetchone()[0], 1)
        # 4) low-confidence proposal -> pending; reject it -> no change
        self.gmail.inject_reply(tid, "sales@acme.example", "hmm")
        llm = FakeLLM(responses=[{"summary": "unclear", "to_status": "Rejected", "to_stage": None, "confidence": 0.5, "evidence_snippet": "hmm"}])
        poll(self.conn, self.gmail, llm)
        pend = pending_proposals(self.conn); self.assertEqual(len(pend), 1)
        resolve_proposal(self.conn, pend[0]["proposal_id"], False, "ignore")
        self.assertEqual(S.current_state("acme.example", self.conn), ("In Discussion", "quote_received"))
        # 5) LLM unavailable -> proposal pending with confidence 0, never auto-applied
        self.gmail.inject_reply(tid, "sales@acme.example", "sending sample data now")
        poll(self.conn, self.gmail, FakeLLM(fail=True))
        pend = pending_proposals(self.conn)
        self.assertEqual((pend[0]["confidence"], pend[0]["to_status"]), (0.0, None))
        resolve_proposal(self.conn, pend[0]["proposal_id"], True)   # accepting an empty proposal changes nothing
        self.assertEqual(S.current_state("acme.example", self.conn), ("In Discussion", "quote_received"))
        S.rebuild_status("acme.example", self.conn)

    def test_heuristic_and_dormancy(self):
        tid = self._contacted()
        self.gmail.inject_reply(tid, "sales@acme.example", "Unfortunately we are not interested at this time.")
        counts = poll(self.conn, self.gmail, HeuristicLLM())
        self.assertEqual(counts["auto_applied"], 1)
        self.assertEqual(S.current_state("acme.example", self.conn)[0], "Rejected")
        # dormancy: a second vendor contacted 11 days ago with no reply
        self._contacted("beta.example")
        self.conn.execute("UPDATE interactions SET sent_at=? WHERE vendor_id='beta.example' AND direction='outbound'",
                          ((datetime.now(timezone.utc) - timedelta(days=11)).isoformat(),)); self.conn.commit()
        counts = poll(self.conn, self.gmail, HeuristicLLM())
        self.assertEqual(counts["dormant"], 1)
        self.assertEqual(S.rebuild_status("beta.example", self.conn), "Dormant")
        csv = vendors_csv(self.conn)
        self.assertIn("beta.example", csv); self.assertIn("Dormant", csv)

    def test_strip_quoted(self):
        self.assertEqual(strip_quoted_reply("New text\n\nOn Tue, X wrote:\n> old"), "New text")


class FakeGateway:
    def __init__(self):
        self.repos = [RepoInfo("goodorg/platform", "https://github.com/goodorg/platform", "goodorg", "Organization", "main",
                               description="Payments platform", stars=900, pushed_at=(datetime.now(timezone.utc) - timedelta(days=3)).isoformat(), license="MIT"),
                      RepoInfo("goodorg/awesome-list", "https://github.com/goodorg/awesome-list", "goodorg", "Organization", "main",
                               description="Awesome links", stars=5000, pushed_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat()),
                      RepoInfo("solo/tool", "https://github.com/solo/tool", "solo", "User", "main", stars=300)]

    def search_repos(self, query, limit): return self.repos[:limit]
    def get_org(self, login): return OrgInfo(login, f"https://github.com/{login}", "Good Org", "https://www.goodorg.com", "Berlin, Germany", "hello@goodorg.com", "", 12)
    def org_repos(self, login, limit): return [r for r in self.repos if r.owner_login == login][:limit]
    def root_paths(self, repo): return [".github", "tests", "poetry.lock", "README.md"] if "platform" in repo.full_name else ["README.md"]
    def has_workflows(self, repo): return "platform" in repo.full_name
    def has_releases(self, repo): return "platform" in repo.full_name
    def merged_pr_count(self, login): return 340


class TestGitHubAdapter(Base):
    def test_discover_normalize_screen(self):
        rs = load_ruleset("repo_owner@v1")
        a = GitHubOrgAdapter(vendor_type="repo_owner", field_catalog=rs.fields, gateway=FakeGateway())
        raws = list(a.discover(DiscoveryQuery(keywords=("topic:fintech",), limit=10)))
        self.assertEqual([r.payload["org_login"] for r in raws], ["goodorg"])   # users skipped, orgs deduped
        cand, evid = a.normalize(raws[0])
        self.assertEqual(cand.vendor_id, "goodorg.com")
        by = {e.field_path: e for e in evid}
        for sig in ("ci_config", "release_tags", "test_directory", "license", "lockfile"):
            self.assertEqual(by[sig].value, "true"); self.assertTrue(by[sig].source_url.startswith("https://github.com/goodorg/platform"))
        self.assertEqual(by["is_fork_or_tutorial"].value, "false"); self.assertEqual(by["merged_prs_public"].value, "340")
        self.assertTrue(by["merged_prs_public"].proxy); self.assertEqual(by["attributable_public_entity"].value, "true")
        self.assertTrue(all(e.verified and e.source_url and e.extraction_method == "api" for e in evid))
        result, reasons = screen(cand, evid, rs)
        self.assertEqual(result, "pass")
        self.assertEqual([r["result"] for r in reasons if r["key"] == "production_grade_signals"], ["pass"])
        # a toy-only org fails not_fork_or_tutorial; a stale one fails recently_active
        stale = [Evidence(e.field_path, "400" if e.field_path == "last_commit_days" else e.value, e.source_url, "api", e.snippet, e.confidence, e.proxy, True) for e in evid]
        self.assertEqual(screen(cand, stale, rs)[0], "fail")
        toy = [Evidence(e.field_path, "true" if e.field_path == "is_fork_or_tutorial" else e.value, e.source_url, "api", e.snippet, e.confidence, e.proxy, True) for e in evid]
        self.assertEqual(screen(cand, toy, rs)[0], "fail")
        few = [e for e in evid if e.field_path not in ("ci_config", "lockfile", "license")]
        self.assertEqual([r["result"] for r in screen(cand, few, rs)[1] if r["key"] == "production_grade_signals"], ["unknown"])
        self.conn.execute("INSERT INTO runs (run_id, adapter, vendor_type, ruleset_version, started_at) VALUES ('g1','github_org','repo_owner','repo_owner@v1','t')"); self.conn.commit()
        out = upsert_vendor(self.conn, cand, evid, rs, "g1", "github_org")
        self.assertEqual(out["screen_result"], "pass")


if __name__ == "__main__":
    unittest.main()
