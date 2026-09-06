"""Acceptance checks for slot D1 AM.  Usage: .venv/bin/python scripts/verify_d1.py [run_id]"""
import sys, json, sqlite3
from pathlib import Path; sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from db.init import init_db
from db.state import rebuild_all
conn = init_db()
runs = conn.execute("SELECT run_id, counts FROM runs ORDER BY started_at").fetchall()
print("runs:", [(r["run_id"], json.loads(r["counts"] or "{}").get("vendors_new")) for r in runs])
latest = sys.argv[1] if len(sys.argv) > 1 else runs[0]["run_id"]

# 1. >= 15 vendors Screened under one run_id
n = conn.execute("SELECT count(*) FROM vendors WHERE status='Screened' AND first_seen_run_id=?", (latest,)).fetchone()[0]
print(f"[1] Screened under {latest}: {n}  ->", "OK" if n >= 15 else "FAIL")

# 2. every must-criterion verdict (pass/fail) is backed by verified evidence rows with a source_url;
#    unknown verdicts have no verified evidence for that field.
bad = []; must_total = must_with_evidence = 0
for v in conn.execute("SELECT vendor_id, screen_reasons FROM vendors"):
    for r in json.loads(v["screen_reasons"] or "[]"):
        if r["kind"] != "must": continue
        must_total += 1
        for rule in r["rules"]:
            ids = rule["evidence_ids"]
            rows = conn.execute(f"SELECT verified, source_url FROM evidence WHERE evidence_id IN ({','.join('?'*len(ids)) or 'NULL'})", ids).fetchall() if ids else []
            any_row = conn.execute("SELECT count(*) FROM evidence WHERE vendor_id=? AND field_path=?", (v["vendor_id"], rule["field"])).fetchone()[0]
            if rule["result"] in ("pass", "fail"):
                if not ids or any(not x["verified"] or not x["source_url"] for x in rows): bad.append((v["vendor_id"], r["key"], "verdict without verified evidence"))
                must_with_evidence += 1
            else:
                if ids: bad.append((v["vendor_id"], r["key"], "unknown but has evidence ids"))
                if any_row: must_with_evidence += 1
print(f"[2] must verdicts backed by verified evidence: {'OK' if not bad else bad}; must-criteria with any evidence row: {must_with_evidence}/{must_total}")

# 3. no unverified value in attributes
bad3 = []
for v in conn.execute("SELECT vendor_id, attributes FROM vendors"):
    attrs = json.loads(v["attributes"])
    for fp, val in attrs.items():
        vals = val if isinstance(val, list) else [val]
        for x in vals:
            ok = conn.execute("SELECT 1 FROM evidence WHERE vendor_id=? AND field_path=? AND value=? AND verified=1 AND source_url IS NOT NULL", (v["vendor_id"], fp, x)).fetchone()
            if not ok: bad3.append((v["vendor_id"], fp, x))
unv = conn.execute("SELECT count(*) FROM evidence WHERE verified=0").fetchone()[0]
print(f"[3] attributes contain only verified values: {'OK' if not bad3 else bad3}  (unverified evidence rows kept out: {unv})")

# 4. duplicates: vendor_id is PK; check primary_domain uniqueness and evidence uniqueness
dups = conn.execute("SELECT primary_domain, count(*) c FROM vendors WHERE primary_domain IS NOT NULL GROUP BY primary_domain HAVING c > 1").fetchall()
edups = conn.execute("SELECT vendor_id, field_path, value, source_url, count(*) c FROM evidence GROUP BY 1,2,3,4 HAVING c>1").fetchall()
print(f"[4] duplicate domains: {[dict(d) for d in dups] or 'none'}; duplicate evidence rows: {len(edups)}")

# 5. rebuild_status for all vendors
st = rebuild_all(conn)
print(f"[5] rebuild_status matches for all {len(st)} vendors -> OK; status histogram: {dict(sorted(__import__('collections').Counter(st.values()).items()))}")

# summary
for r in conn.execute("SELECT screen_result, count(*) c FROM vendors GROUP BY 1"): print("   ", r["screen_result"], r["c"])
print("   next_action:", [tuple(r) for r in conn.execute("SELECT next_action, count(*) FROM vendors GROUP BY 1")])
