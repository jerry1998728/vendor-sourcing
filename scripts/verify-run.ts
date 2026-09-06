/**
 * Acceptance check for one run against the live database.
 *   npm run verify:run [run_id]
 * Defaults to the latest finished run. Exit code 1 when a check fails.
 */
import { asc, desc, eq, isNotNull } from "drizzle-orm";

import { events, evidence, getDb, runs, tags, vendors } from "@/lib/db";
import { rebuildStatus } from "@/lib/db/state";
import { registrableDomain } from "@/lib/pipeline/ids";
import { loadRuleset } from "@/lib/rulesets/loader";

const db = getDb();
const runId = process.argv[2];
const run = runId
  ? db.select().from(runs).where(eq(runs.run_id, runId)).get()
  : db.select().from(runs).where(isNotNull(runs.finished_at)).orderBy(desc(runs.started_at)).get();
if (!run) {
  console.error("no finished run found");
  process.exit(1);
}
const ruleset = loadRuleset(run.ruleset_version);
const failures: string[] = [];
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
};

console.log(`run ${run.run_id}  config=${String(run.query.config)}  ruleset=${run.ruleset_version}`);
console.log(`started ${run.started_at}  finished ${run.finished_at}`);
const { progress, llm_usage, ...counts } = run.counts;
console.log("counts:", JSON.stringify(counts));
if (llm_usage) console.log("llm_usage:", JSON.stringify(llm_usage));
if (progress?.phase !== "done") console.log("progress:", JSON.stringify(progress));
console.log();

const inRun = db.select().from(vendors).where(eq(vendors.first_seen_run_id, run.run_id)).all();
const screened = inRun.filter((v) => v.status === "Screened");
check(screened.length >= 15, `>= 15 vendors in Screened under ${run.run_id} (got ${screened.length} of ${inRun.length})`);

// every must-field has an evidence row, for every vendor touched by this run
let missing = 0;
for (const v of inRun) {
  const rows = db.select({ field_path: evidence.field_path }).from(evidence).where(eq(evidence.vendor_id, v.vendor_id)).all();
  const paths = new Set(rows.map((r) => r.field_path));
  for (const m of ruleset.must) if (!paths.has(m.field_path)) missing += 1;
}
check(missing === 0, `every must-field has an evidence row (${missing} missing across ${inRun.length} vendors)`);

// attributes hold verified values only
let unverifiedAttrs = 0;
for (const v of db.select().from(vendors).all()) {
  const rows = db.select().from(evidence).where(eq(evidence.vendor_id, v.vendor_id)).all();
  for (const [field, value] of Object.entries(v.attributes)) {
    for (const val of Array.isArray(value) ? value : [value]) {
      if (!rows.some((r) => r.field_path === field && r.value === val && r.verified)) unverifiedAttrs += 1;
    }
  }
}
check(unverifiedAttrs === 0, `no unverified value in vendors.attributes (${unverifiedAttrs} offending values)`);

// no duplicates
const all = db.select().from(vendors).all();
const domains = all.map((v) => registrableDomain(v.primary_domain)).filter(Boolean);
const dupDomains = domains.length - new Set(domains).size;
const evRows = db.select().from(evidence).all();
const evKeys = evRows.map((e) => `${e.vendor_id}|${e.field_path}|${e.value}|${e.source_url}`);
const dupEvidence = evKeys.length - new Set(evKeys).size;
const runCount = db.select().from(runs).all().length;
check(dupDomains === 0 && dupEvidence === 0, `no duplicates (vendors: ${all.length}, duplicate domains: ${dupDomains}, duplicate evidence rows: ${dupEvidence}, runs so far: ${runCount})`);

// rebuildStatus for all vendors
let mismatches = 0;
for (const v of all) {
  try {
    rebuildStatus(v.vendor_id, db);
  } catch (err) {
    mismatches += 1;
    console.log("   ", err instanceof Error ? err.message : String(err));
  }
}
check(mismatches === 0, `rebuildStatus passes for all ${all.length} vendors`);

// samples: best pass, best unknown, best fail (fallback: top coverage)
const pick = (result: string) => screened.filter((v) => v.screen_result === result).sort((a, b) => (b.coverage_confidence ?? 0) - (a.coverage_confidence ?? 0))[0];
const samples = [pick("pass"), pick("unknown"), pick("fail")].filter(Boolean);
for (const v of screened.sort((a, b) => (b.coverage_confidence ?? 0) - (a.coverage_confidence ?? 0))) {
  if (samples.length >= 3) break;
  if (!samples.includes(v)) samples.push(v);
}
console.log();
for (const v of samples.slice(0, 3)) {
  console.log(`== ${v.name}  (${v.vendor_id})  screen=${v.screen_result}  status=${v.status}  coverage=${v.coverage_confidence}  next_action=${v.next_action}`);
  console.log(`   registration=${v.registration_country ?? "?"} ownership=${v.ownership_country ?? "?"} collection=[${v.collection_countries.join(",")}] contact=${v.contact_email ?? "-"}`);
  console.log(`   attributes: ${JSON.stringify(v.attributes)}`);
  const rows = db.select().from(evidence).where(eq(evidence.vendor_id, v.vendor_id)).orderBy(desc(evidence.verified), asc(evidence.field_path)).all();
  for (const e of rows) {
    const badge = e.verified ? (e.proxy ? "proxy" : "verified") : "unknown";
    const snippet = e.snippet ? ` — "${e.snippet.slice(0, 90)}${e.snippet.length > 90 ? "…" : ""}"` : "";
    console.log(`   [${badge.padEnd(8)}] ${e.field_path} = ${e.value ?? "(not found)"} (${e.extraction_method}, ${e.confidence})${e.source_url ? ` <${e.source_url}>` : ""}${snippet}`);
  }
  const t = db.select().from(tags).where(eq(tags.vendor_id, v.vendor_id)).orderBy(asc(tags.dimension)).all();
  console.log(`   tags: ${t.map((x) => `${x.dimension}=${x.value}[${x.source_badge}]`).join(", ") || "-"}`);
  const evs = db.select().from(events).where(eq(events.vendor_id, v.vendor_id)).all();
  console.log(`   events: ${evs.map((e) => `${e.from_status}->${e.to_status} (${e.actor}, ${e.reason})`).join("; ")}`);
  console.log();
}

if (failures.length) {
  console.log(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
