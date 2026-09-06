#!/usr/bin/env python3
"""DISCOVER stage: config -> adapter.discover -> normalize -> evidence -> screen -> Screened.

    python discover/run.py --config configs/ego_data_stereo.yaml

Writes only to SQLite (vendors, evidence, events, runs) and data/runs/<run_id>/.
"""
from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
import uuid
from collections import Counter, OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(PROJECT_ROOT / ".env")

from adapters import build_adapter  # noqa: E402
from adapters.web_search_llm import AdapterFatalError, is_fatal  # noqa: E402
from core.config import load_config, load_ruleset  # noqa: E402
from core.models import DiscoveryQuery, Evidence, RawRecord, Ruleset, VendorCandidate, normalize_domain, utcnow  # noqa: E402
from core.screen import must_field_coverage, next_action_for, screen  # noqa: E402
from db.init import init_db  # noqa: E402
from db.state import INITIAL_STATUS, rebuild_status, register_vendor, transition  # noqa: E402

log = logging.getLogger("discover.run")


# --- persistence helpers -------------------------------------------------------

def insert_evidence(conn: sqlite3.Connection, vendor_id: str, evidence: list[Evidence]) -> int:
    n = 0
    with conn:
        for e in evidence:
            cur = conn.execute(
                "INSERT OR IGNORE INTO evidence (vendor_id, field_path, value, source_url, extraction_method, snippet, "
                "confidence, proxy, verified, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (vendor_id, e.field_path, e.value, e.source_url, e.extraction_method, e.snippet, e.confidence,
                 int(e.proxy), int(e.verified), e.observed_at),
            )
            n += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    return n


def load_evidence(conn: sqlite3.Connection, vendor_id: str) -> list[Evidence]:
    rows = conn.execute("SELECT * FROM evidence WHERE vendor_id = ? ORDER BY evidence_id", (vendor_id,)).fetchall()
    return [Evidence(field_path=r["field_path"], value=r["value"], source_url=r["source_url"],
                     extraction_method=r["extraction_method"], snippet=r["snippet"], confidence=r["confidence"],
                     proxy=bool(r["proxy"]), verified=bool(r["verified"]), observed_at=r["observed_at"],
                     evidence_id=r["evidence_id"], vendor_id=r["vendor_id"]) for r in rows]


def build_attributes(evidence: list[Evidence], ruleset: Ruleset) -> dict[str, Any]:
    """vendors.attributes from VERIFIED evidence only.  List-typed fields keep every
    distinct value (sorted); scalar fields keep the highest-confidence value."""
    list_fields = {f.path for f in ruleset.fields if f.is_list}
    by_field: dict[str, list[Evidence]] = {}
    for e in evidence:
        if e.verified:
            by_field.setdefault(e.field_path, []).append(e)
    attrs: dict[str, Any] = {}
    for fp, rows in sorted(by_field.items()):
        if fp in list_fields:
            attrs[fp] = sorted({r.value for r in rows})
        else:
            attrs[fp] = sorted(rows, key=lambda r: (-(r.confidence or 0.0), r.observed_at, r.value))[0].value
    return attrs


def upsert_vendor(conn: sqlite3.Connection, cand: VendorCandidate, evidence: list[Evidence],
                  ruleset: Ruleset, run_id: str, actor: str) -> dict[str, Any]:
    """Register (if new) -> merge evidence -> screen -> write verified attributes -> Identified->Screened."""
    vendor_id = cand.vendor_id
    created = register_vendor(
        {"vendor_id": vendor_id, "name": cand.name, "vendor_type": cand.vendor_type,
         "primary_domain": normalize_domain(cand.primary_domain) or normalize_domain(cand.source_url),
         "first_seen_run_id": run_id, "discovered_via": cand.discovered_via, "discovered_at": utcnow()},
        actor=actor, reason=f"discovered via {cand.discovered_via} ({cand.source_url or cand.extras.get('github_url', '')})", conn=conn,
        payload={"run_id": run_id, "source_url": cand.source_url, "page_type": cand.page_type,
                 "dedup_key": cand.extras.get("dedup_key")},
    )
    insert_evidence(conn, vendor_id, evidence)
    all_evidence = load_evidence(conn, vendor_id)
    result, reasons = screen(cand, all_evidence, ruleset)
    attrs = build_attributes(all_evidence, ruleset)
    coverage = must_field_coverage(reasons)
    country = attrs.get("entity.hq_country")
    contact_email = attrs.get("contact.email")
    with conn:
        conn.execute(
            "UPDATE vendors SET attributes = ?, screen_result = ?, screen_reasons = ?, coverage_confidence = ?, "
            "next_action = ?, country = COALESCE(?, country), contact_email = COALESCE(?, contact_email), "
            "updated_at = ? WHERE vendor_id = ?",
            (json.dumps(attrs, sort_keys=True), result, json.dumps(reasons, sort_keys=True), coverage,
             next_action_for(result), country, contact_email, utcnow(), vendor_id),
        )
    status = conn.execute("SELECT status FROM vendors WHERE vendor_id = ?", (vendor_id,)).fetchone()["status"]
    if status == INITIAL_STATUS:
        transition(vendor_id, "Screened", actor=actor, reason=f"ruleset {ruleset.version_string}: {result}",
                   payload={"run_id": run_id, "screen_result": result, "coverage_confidence": coverage}, conn=conn)
    return {"vendor_id": vendor_id, "created": created, "screen_result": result, "coverage": coverage,
            "n_evidence": len(all_evidence), "n_verified": sum(1 for e in all_evidence if e.verified)}


# --- run ----------------------------------------------------------------------

def _pick_representative(records: list[RawRecord]) -> RawRecord:
    """One URL per domain: prefer the LLM's likely-vendor hits, then the shortest path (closer to the homepage)."""
    def key(r: RawRecord) -> tuple[int, int, str]:
        pre = r.payload.get("llm_prefilter") or {}
        return (0 if pre.get("likely_vendor_site") else 1, len(r.source_url or ""), r.source_url or "")
    best = sorted(records, key=key)[0]
    best.payload = {**best.payload, "other_urls": [r.source_url for r in records if r is not best and r.source_url]}
    return best


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True, help="configs/*.yaml")
    ap.add_argument("--db", default=None, help="SQLite path (default data/vendors.db or $VENDOR_DB_PATH)")
    ap.add_argument("--limit", type=int, default=40, help="max raw search hits kept per seed query")
    ap.add_argument("--searches-per-query", type=int, default=3, help="web_search max_uses per seed query")
    ap.add_argument("--max-candidates", type=int, default=80, help="max new domains to normalize in this run")
    ap.add_argument("--workers", type=int, default=4, help="parallel normalize calls")
    ap.add_argument("--model", default=None, help="override ANTHROPIC_MODEL")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    cfg = load_config(args.config)
    ruleset = load_ruleset(cfg.ruleset)
    conn = init_db(args.db)

    run_id = f"run_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}"
    run_dir = PROJECT_ROOT / "data" / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    started_at = utcnow()
    with conn:
        conn.execute(
            "INSERT INTO runs (run_id, adapter, vendor_type, query, ruleset_version, started_at, raw_payload_path) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (run_id, cfg.adapter, cfg.vendor_type, json.dumps({"seed_queries": list(cfg.seed_queries), "limit": args.limit}),
             ruleset.version_string, started_at, str(run_dir.relative_to(PROJECT_ROOT))),
        )
    log.info("run %s: adapter=%s vendor_type=%s ruleset=%s", run_id, cfg.adapter, cfg.vendor_type, ruleset.version_string)

    adapter = build_adapter(cfg.adapter, vendor_type=cfg.vendor_type, field_catalog=ruleset.fields,
                            vendor_description=ruleset.description, run_dir=run_dir, model=args.model,
                            max_searches_per_query=args.searches_per_query)
    actor = adapter.name

    def fail_run(exc: BaseException) -> int:
        with conn:
            conn.execute("UPDATE runs SET finished_at = ?, counts = ?, rate_limit_spent = ? WHERE run_id = ?",
                         (utcnow(), json.dumps({"error": str(exc)[:500]}), json.dumps(adapter.usage, sort_keys=True), run_id))
        print(f"\nrun_id: {run_id} ABORTED: {exc}", file=sys.stderr)
        return 2

    # 1. discover -> raw records (persisted)
    q = DiscoveryQuery(keywords=cfg.seed_queries, filters={}, limit=args.limit)
    try:
        raws: list[RawRecord] = list(adapter.discover(q))
    except AdapterFatalError as exc:
        return fail_run(exc)
    with open(run_dir / "raw_records.jsonl", "w", encoding="utf-8") as fh:
        for r in raws:
            fh.write(json.dumps(r.to_json(), ensure_ascii=False, default=str) + "\n")
    log.info("discovered %d raw records", len(raws))

    # 2. group by normalized domain; skip domains already in the vendors table (no duplicates, no re-fetch)
    # Adapters may supply payload["dedup_key"] (github_org: the org login); web adapters dedup on normalized domain.
    groups: "OrderedDict[str, list[RawRecord]]" = OrderedDict()
    for r in raws:
        key = r.payload.get("dedup_key") or normalize_domain(r.source_url)
        if key:
            groups.setdefault(key, []).append(r)
    known = {row["vendor_id"] for row in conn.execute("SELECT vendor_id FROM vendors")}
    known |= {row["primary_domain"] for row in conn.execute("SELECT primary_domain FROM vendors WHERE primary_domain IS NOT NULL")}
    known |= {row[0] for row in conn.execute("SELECT json_extract(payload, '$.dedup_key') FROM events WHERE from_status IS NULL "
                                             "AND payload LIKE '%dedup_key%'")}
    skipped_known = [d for d in groups if d in known]
    todo = [d for d in groups if d not in known]
    reps = {d: _pick_representative(groups[d]) for d in todo}
    todo.sort(key=lambda d: (0 if (reps[d].payload.get("llm_prefilter") or {}).get("likely_vendor_site") else 1,
                             list(groups).index(d)))
    deferred = todo[args.max_candidates:]
    todo = todo[:args.max_candidates]
    log.info("%d unique domains: %d already known, %d to normalize, %d deferred by --max-candidates",
             len(groups), len(skipped_known), len(todo), len(deferred))

    # 3. normalize in parallel (API only; no DB access inside threads)
    normalized: dict[str, tuple[VendorCandidate, list[Evidence]] | Exception] = {}
    fatal: BaseException | None = None
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futs = {pool.submit(adapter.normalize, reps[d]): d for d in todo}
        for fut in as_completed(futs):
            d = futs[fut]
            try:
                normalized[d] = fut.result()
                cand = normalized[d][0]
                log.info("normalized %-40s page_type=%-11s evidence=%d", d, cand.page_type, len(normalized[d][1]))
            except Exception as exc:  # one bad page must not kill the run; auth/billing failures must
                log.error("normalize failed for %s: %s", d, exc)
                normalized[d] = exc
                if is_fatal(exc):
                    fatal = exc
                    pool.shutdown(wait=False, cancel_futures=True)
                    break
    if fatal is not None:
        return fail_run(fatal)

    # 4. write vendors + evidence, screen, transition (deterministic order)
    page_types: Counter[str] = Counter()
    outcomes: list[dict[str, Any]] = []
    errors = 0
    with open(run_dir / "candidates.jsonl", "w", encoding="utf-8") as fh:
        for d in todo:
            res = normalized.get(d)
            if isinstance(res, Exception) or res is None:
                errors += 1
                fh.write(json.dumps({"domain": d, "error": str(res)}) + "\n")
                continue
            cand, evidence = res
            page_types[cand.page_type] += 1
            fh.write(json.dumps({"domain": d, "candidate": cand.__dict__, "evidence": [e.__dict__ for e in evidence]},
                                ensure_ascii=False, default=str) + "\n")
            if cand.page_type != "vendor_site":
                continue
            outcome = upsert_vendor(conn, cand, evidence, ruleset, run_id, actor)
            outcomes.append(outcome)
            log.info("vendor %-40s %-7s coverage=%.2f evidence=%d verified=%d %s", outcome["vendor_id"],
                     outcome["screen_result"], outcome["coverage"], outcome["n_evidence"], outcome["n_verified"],
                     "(new)" if outcome["created"] else "(merged)")

    # 5. integrity: every touched vendor's status must be reconstructable from events
    for o in outcomes:
        rebuild_status(o["vendor_id"], conn)

    new = [o for o in outcomes if o["created"]]
    verdicts = Counter(o["screen_result"] for o in new)
    screened = len(new)
    counts = {
        "discovered": len(raws),
        "unique_domains": len(groups),
        "skipped_known": len(skipped_known),
        "deferred": len(deferred),
        "normalized": len(todo) - errors,
        "normalize_errors": errors,
        "page_types": dict(sorted(page_types.items())),
        "vendors_new": screened,
        "vendors_merged": len(outcomes) - screened,
        "pass": verdicts.get("pass", 0),
        "fail": verdicts.get("fail", 0),
        "unknown": verdicts.get("unknown", 0),
        "must_field_coverage": round(sum(o["coverage"] for o in new) / screened, 4) if screened else 0.0,
        "unknown_rate": round(verdicts.get("unknown", 0) / screened, 4) if screened else 0.0,
    }
    with conn:
        conn.execute("UPDATE runs SET finished_at = ?, counts = ?, rate_limit_spent = ? WHERE run_id = ?",
                     (utcnow(), json.dumps(counts, sort_keys=True), json.dumps(adapter.usage, sort_keys=True), run_id))

    print(f"\nrun_id: {run_id}   ruleset_version: {ruleset.version_string}   model: {adapter.model}")
    print(f"discovered: {counts['discovered']} raw hits over {counts['unique_domains']} domains "
          f"(known: {counts['skipped_known']}, deferred: {counts['deferred']}, normalized: {counts['normalized']}, "
          f"errors: {counts['normalize_errors']})")
    print(f"page_types: {counts['page_types']}")
    print(f"screened (new vendors this run): {screened}   merged into existing: {counts['vendors_merged']}")
    print(f"pass: {counts['pass']}   fail: {counts['fail']}   unknown: {counts['unknown']}")
    print(f"must_field_coverage: {counts['must_field_coverage']:.2f}   unknown_rate: {counts['unknown_rate']:.2f}")
    print(f"usage: {json.dumps(adapter.usage)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
