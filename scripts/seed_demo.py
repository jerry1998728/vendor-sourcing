#!/usr/bin/env python3
"""Seed data/demo.db with fictional vendors across every pipeline state so the UI can be
exercised without API access.  All domains are *.example (reserved), nothing is real.

    .venv/bin/python scripts/seed_demo.py [--db data/demo.db]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "discover"))

from core import actions  # noqa: E402
from core.config import load_ruleset  # noqa: E402
from core.models import Evidence, VendorCandidate  # noqa: E402
from db.init import init_db  # noqa: E402
from db.state import rebuild_all, utcnow  # noqa: E402
from outreach.draft import draft_email, save_draft  # noqa: E402
from outreach.gmail_client import FakeGmail  # noqa: E402
from outreach.send import approve_and_send  # noqa: E402
from run import upsert_vendor  # noqa: E402
from track.infer import HeuristicLLM  # noqa: E402
from track.poll import poll  # noqa: E402


def E(fp, val, url, snippet, conf=0.9, proxy=False, verified=True):
    return Evidence(fp, val, url, "llm", snippet, conf, proxy=proxy, verified=verified)


EGO = [
    ("northlight-ego.example", "Northlight Ego Labs", "DE", True, ["DE", "FR", "ES"], ["urban", "indoor", "night"], "12,000 hours of stereo egocentric video", "sales@northlight-ego.example"),
    ("wearablesense.example", "WearableSense Data", "US", True, ["US", "CA"], ["indoor", "suburban"], "3,400 sessions across 40 kitchens", "hello@wearablesense.example"),
    ("tokyo-povdata.example", "Tokyo POV Data", "JP", True, None, ["urban", "indoor", "highway", "night"], "20,000+ clips", None),
    ("ganges-vision.example", "Ganges Vision", "IN", None, ["IN"], ["indoor"], "5M hours (all modalities)", "contact@ganges-vision.example"),
    ("shenzhen-egocam.example", "Shenzhen EgoCam", "CN", True, ["CN"], ["indoor"], "50,000 hours", "sales@shenzhen-egocam.example"),
    ("firstperson-collective.example", "FirstPerson Collective", None, None, None, None, None, None),
    ("andes-fieldcapture.example", "Andes FieldCapture", "CL", False, ["CL", "AR"], ["highway", "adverse_weather"], "800 hours monocular dashcam", "ops@andes-fieldcapture.example"),
    ("nordic-egostream.example", "Nordic EgoStream", "SE", True, ["SE", "NO", "FI", "DK"], ["urban", "night", "adverse_weather", "indoor"], "6,000 hours", "sales@nordic-egostream.example"),
]
REPO = [
    ("ledgerforge.example", "LedgerForge", 5, 4, "true", 1240, 38, "Berlin, Germany"),
    ("robostack-labs.example", "RoboStack Labs", 3, 12, "true", 210, 9, "Austin, TX"),
    ("tinydemos.example", "TinyDemos", 1, 2, "false", 4, 3, None),
    ("stalecorp.example", "StaleCorp", 4, 400, "true", 900, 22, "London"),
]


def seed(db: str) -> None:
    if os.path.exists(db):
        os.remove(db)
    conn = init_db(db)
    ego, repo = load_ruleset("ego_data_supplier@v1"), load_ruleset("repo_owner@v1")
    now = utcnow()
    for rid, adapter, vt, rs in (("run_demo_ego_01", "web_search_llm", "ego_data_supplier", ego), ("run_demo_repo_01", "github_org", "repo_owner", repo)):
        conn.execute("INSERT INTO runs (run_id, adapter, vendor_type, query, ruleset_version, started_at, finished_at, counts, rate_limit_spent, raw_payload_path) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (rid, adapter, vt, json.dumps({"seed_queries": ["demo"]}), rs.version_string, now, now,
                                                            json.dumps({"discovered": 40, "vendors_new": 8, "pass": 3, "fail": 2, "unknown": 3, "must_field_coverage": 0.62, "unknown_rate": 0.375}),
                                                            json.dumps({"api_calls": 12}), f"data/runs/{rid}"))
    conn.commit()
    for dom, name, hq, stereo, countries, envs, size, email in EGO:
        url = f"https://{dom}/"
        ev = []
        if stereo is not None:
            ev.append(E("capture.stereo_camera", "true" if stereo else "false", url, "our head-mounted dual-lens rig" if stereo else "single forward-facing camera", 0.92, proxy=not stereo))
        if hq:
            ev.append(E("entity.hq_country", hq, url + "about", f"Headquartered in {hq}", 0.85, proxy=True))
        for cc in countries or []:
            ev.append(E("collection.countries", cc, url + "coverage", f"collection teams in {cc}", 0.8))
        for e_ in envs or []:
            ev.append(E("collection.environment_classes", e_, url, f"scenes: {e_}", 0.7, proxy=True))
        if size:
            ev.append(E("dataset.size_claimed", size, url, size, 0.9))
        if email:
            ev.append(E("contact.email", email, url + "contact", email, 0.95))
        if dom.startswith("firstperson"):
            ev.append(E("capture.stereo_camera", "true", None, None, 0.4, verified=False))  # unverified lead
        cand = VendorCandidate(name=name, vendor_type="ego_data_supplier", primary_domain=dom, source_url=url, discovered_via="web_search_llm")
        upsert_vendor(conn, cand, ev, ego, "run_demo_ego_01", "web_search_llm")
    for dom, name, hits, days, toy, prs, repos, loc in REPO:
        url = f"https://github.com/{dom.split('.')[0]}"
        sigs = ("ci_config", "release_tags", "test_directory", "license", "lockfile")
        ev = [Evidence(sig, "true" if i < hits else "false", url + "/platform", "api", f"platform: {sig} = {i < hits}", 0.9, proxy=True, verified=True)
              for i, sig in enumerate(sigs)]
        ev += [Evidence("last_commit_days", str(days), url + "/platform", "api", f"last push {days} days ago", 0.95, verified=True),
               Evidence("is_fork_or_tutorial", "false" if toy == "true" else "true", url + "/platform", "api", "tutorial/demo markers checked", 0.75, proxy=True, verified=True),
               Evidence("merged_prs_public", str(prs), url, "api", f"is:pr is:merged -> {prs}", 0.9, proxy=True, verified=True),
               Evidence("attributable_public_entity", "true", url, "api", f"GitHub organization with name and website", 0.85, proxy=True, verified=True),
               Evidence("org.public_repos", str(repos), url, "api", f"public_repos = {repos}", 0.95, verified=True)]
        if loc:
            ev.append(Evidence("entity.location", loc, url, "api", f"profile location: {loc}", 0.8, proxy=True, verified=True))
        upsert_vendor(conn, VendorCandidate(name=name, vendor_type="repo_owner", primary_domain=dom, source_url=url, discovered_via="github_org"), ev, repo, "run_demo_repo_01", "github_org")

    # move some vendors along the pipeline via the human gates + fake Gmail + heuristic inference
    gmail = FakeGmail()
    os.environ["OUTREACH_GO_LIVE"] = "1"
    for vid in ("northlight-ego.example", "wearablesense.example", "nordic-egostream.example", "tokyo-povdata.example", "ledgerforge.example", "robostack-labs.example"):
        actions.qualify(conn, vid, "demo")
    actions.need_info(conn, "ganges-vision.example", "stereo capture, collection countries")
    actions.reject(conn, "shenzhen-egocam.example", "in_china", "HQ Guangdong")
    actions.reject(conn, "tinydemos.example", "not_production_grade")
    actions.reject(conn, "stalecorp.example", "not_production_grade", "last commit 400 days ago")
    threads = {}
    for vid in ("northlight-ego.example", "wearablesense.example", "nordic-egostream.example", "ledgerforge.example", "tokyo-povdata.example"):
        d = draft_email(conn, vid, None, "Jerry", "Sourcing Co"); save_draft(conn, vid, d)
        v = conn.execute("SELECT contact_email FROM vendors WHERE vendor_id=?", (vid,)).fetchone()
        threads[vid] = approve_and_send(conn, vid, v["contact_email"] or f"sales@{vid}", d["subject"], d["body"], gmail)["thread_id"]
    gmail.inject_reply(threads["northlight-ego.example"], "anna@northlight-ego.example", "Thanks Jerry — happy to talk. We capture with ZED X stereo rigs at 1080p/30fps; calibration files ship with every session. Specs attached.")
    gmail.inject_reply(threads["wearablesense.example"], "sam@wearablesense.example", "Sure. Our quote is $9.50 per recorded hour with annotation, minimum 500 hours.")
    gmail.inject_reply(threads["nordic-egostream.example"], "lars@nordic-egostream.example", "Unfortunately we are fully booked through Q2 and cannot help at this time.")
    gmail.inject_reply(threads["ledgerforge.example"], "cto@ledgerforge.example", "hmm, maybe. what exactly do you need")
    conn.execute("UPDATE interactions SET sent_at=? WHERE vendor_id='tokyo-povdata.example' AND direction='outbound'",
                 ((datetime.now(timezone.utc) - timedelta(days=12)).isoformat(),)); conn.commit()
    counts = poll(conn, gmail, HeuristicLLM())
    actions.set_plan(conn, "northlight-ego.example", "Jerry", (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d"), "schedule technical call")
    actions.set_plan(conn, "wearablesense.example", "Jerry", (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%d"), "review quote")
    actions.approve(conn, "robostack-labs.example", "pilot approved")
    os.environ.pop("OUTREACH_GO_LIVE", None)
    rebuild_all(conn)
    hist = {r[0]: r[1] for r in conn.execute("SELECT status, count(*) FROM vendors GROUP BY status")}
    print(f"seeded {db}: {hist}; poll={counts}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--db", default=str(ROOT / "data" / "demo.db"))
    seed(ap.parse_args().db)
