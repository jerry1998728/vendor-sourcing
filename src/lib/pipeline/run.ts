/**
 * One run = discover -> normalize -> evidence -> screen for one config.
 * Every run writes a runs row with ruleset_version and persists raw payloads
 * under data/runs/<run_id>/. Status changes go through transition() only.
 */

import { getAdapter } from "@/lib/adapters";
import { DEFAULT_EXCLUDED_DOMAINS } from "@/lib/adapters/webSearchLlm";
import { getDb, nowIso, type Db } from "@/lib/db";
import { finishRun, getRun, isCancelRequested, listRuns, updateRunCounts } from "@/lib/db/queries";
import {
  runs,
  type Run,
  type RunCounts,
  type RunPhase,
} from "@/lib/db/schema";
import { emptyUsage } from "@/lib/llm/client";
import { isDev } from "@/lib/shared/env";
import { buildDiscoveryQuery, loadConfig, loadRuleset } from "@/lib/rulesets/loader";

import { mapWithConcurrency } from "./concurrency";
import { canonicalDomain, domainMatches } from "./ids";
import { appendJsonl, newRunId, persistJson, readRawRecords, relativeRunDir } from "./storage";
import {
  type AdapterContext,
  type NormalizeResult,
  type RawRecord,
} from "./types";

const NORMALIZE_CONCURRENCY = 3;

/** CLAUDE.md cost control: cap candidates by default outside a production build. */
const DEV_CANDIDATE_LIMIT = 5;

export type CreateRunOptions = {
  /** run_id whose persisted raw_records.jsonl to re-extract; skips discover(). */
  replayOf?: string;
  /** explicit candidate cap; overrides the development default, capped at the config's own limit */
  limit?: number;
};

export function createRun(configName: string, opts: CreateRunOptions = {}, db: Db = getDb()): Run {
  const config = loadConfig(configName);
  const ruleset = loadRuleset(config.ruleset);
  const adapter = getAdapter(config.adapter);
  if (!adapter.vendorTypes.includes(config.vendor_type)) {
    throw new Error(`adapter ${adapter.name} does not support vendor_type ${config.vendor_type}`);
  }
  if (ruleset.vendor_type !== config.vendor_type) {
    throw new Error(`ruleset ${ruleset.ruleset_version} is for ${ruleset.vendor_type}, config is ${config.vendor_type}`);
  }
  if (opts.replayOf) {
    const source = getRun(opts.replayOf, db);
    if (!source) throw new Error(`replay source run ${opts.replayOf} not found`);
    if (source.query.config !== configName) {
      throw new Error(`replay source ${opts.replayOf} was a run of ${String(source.query.config)}, not ${configName}`);
    }
  }
  const query = buildDiscoveryQuery(config);
  query.limit =
    opts.limit !== undefined
      ? Math.min(opts.limit, query.limit)
      : isDev()
        ? Math.min(query.limit, DEV_CANDIDATE_LIMIT)
        : query.limit;
  const run_id = newRunId();
  const dir = relativeRunDir(run_id);
  const startedAt = nowIso();
  const row = db
    .insert(runs)
    .values({
      run_id,
      input_type: query.kind === "web_search" ? "web_search" : "github",
      adapter: adapter.name,
      vendor_type: config.vendor_type,
      query: { config: config.name, replay_of: opts.replayOf, ...query },
      ruleset_version: ruleset.ruleset_version,
      started_at: startedAt,
      counts: { progress: { phase: "queued" } },
      raw_payload_path: dir,
    })
    .returning()
    .get();
  void persistJson(run_id, "config.json", { config, ruleset, query, replay_of: opts.replayOf, started_at: startedAt });
  return row;
}

/** Most recent finished run of a config, as a replay source. */
export function findReplaySource(configName: string, db: Db = getDb()): Run | undefined {
  return listRuns(db, 50).find((r) => r.query.config === configName && r.finished_at);
}

export { writeNormalizedVendor, type WriteOutcome } from "./write";
import { writeNormalizedVendor, type WriteOutcome } from "./write";

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function executeRun(runId: string, db: Db = getDb()): Promise<Run> {
  const run = getRun(runId, db);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.finished_at) return run;

  const log = (message: string) => console.log(`[run ${runId}] ${message}`);
  const persist = (name: string, payload: unknown) => persistJson(runId, name, payload);
  const progress = (phase: RunPhase, extra: Partial<RunCounts["progress"]> = {}) =>
    updateRunCounts(runId, { progress: { phase, ...extra } }, db);

  const configName = String(run.query.config);
  const replayOf = typeof run.query.replay_of === "string" ? run.query.replay_of : undefined;
  try {
    const config = loadConfig(configName);
    const ruleset = loadRuleset(config.ruleset);
    const adapter = getAdapter(config.adapter);
    const query = buildDiscoveryQuery(config);
    // Reuse the limit createRun() actually stored (may be dev-clamped), not the config's raw limit.
    if (typeof run.query.limit === "number") query.limit = run.query.limit;
    const usage = emptyUsage();
    const ctx: AdapterContext = { run_id: runId, config, ruleset, persist, log, usage };
    const excluded = [...DEFAULT_EXCLUDED_DOMAINS, ...config.exclude_domains];

    let hop1: RawRecord[];
    if (replayOf) {
      progress("discovering", { message: `replay of ${replayOf}: skipping search` });
      hop1 = (await readRawRecords(replayOf)) as RawRecord[];
      log(`replay of ${replayOf}: re-extracting ${hop1.length} candidates from disk, discovery skipped`);
    } else {
      progress("discovering", { message: `${adapter.name}: ${config.name}` });
      hop1 = await adapter.discover(query, ctx);
    }
    await appendJsonl(runId, "raw_records.jsonl", hop1);
    const rawRecords = hop1.reduce((n, r) => {
      const all = r.extra?.all_urls;
      return n + (Array.isArray(all) ? all.length : 1);
    }, 0);
    updateRunCounts(runId, { raw_records: rawRecords, discovered: hop1.length }, db);
    log(`discovered ${hop1.length} candidates (${rawRecords} raw results)`);

    const written: WriteOutcome[] = [];
    const seenDomains = new Set(hop1.map((r) => r.domain).filter((d): d is string => !!d));
    const hop2: RawRecord[] = [];
    let normalized = 0;
    let vendorSites = 0;
    let unreachable = 0;
    let total = hop1.length;

    let cancelled = false;
    const processOne = async (raw: RawRecord) => {
      if (cancelled || isCancelRequested(runId, db)) {
        cancelled = true;
        return;
      }
      let result: NormalizeResult;
      try {
        result = await adapter.normalize(raw, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`normalize failed for ${raw.domain ?? raw.url}: ${message}`);
        await persist(`normalize_${raw.domain ?? "unknown"}.json`, { record: raw, error: message });
        normalized += 1;
        progress("normalizing", { step: normalized, total });
        return;
      }
      normalized += 1;
      await persist(`normalize_${raw.domain ?? "unknown"}.json`, result);
      if (result.page_type === "unreachable") unreachable += 1;
      if (result.vendor) {
        vendorSites += 1;
        written.push(writeNormalizedVendor(db, run, ruleset, { ...result, vendor: result.vendor }));
      }
      for (const m of result.mentioned_vendors) {
        const d = canonicalDomain(m.url);
        if (!d || seenDomains.has(d) || domainMatches(d, excluded)) continue;
        seenDomains.add(d);
        hop2.push({
          source: "web_search",
          url: m.url,
          domain: d,
          title: m.name,
          snippet: null,
          query: raw.query,
          discovered_at: nowIso(),
          hop: 2,
          extra: { via: raw.domain },
        });
      }
      progress("normalizing", { step: normalized, total, message: `${vendorSites} vendor sites so far` });
    };

    progress("normalizing", { step: 0, total });
    await mapWithConcurrency(hop1, NORMALIZE_CONCURRENCY, processOne);

    const budget = Math.max(0, config.limit - hop1.length);
    if (budget > 0 && hop2.length > 0) {
      const batch = hop2.slice(0, budget);
      total += batch.length;
      log(`hop 2: ${batch.length} vendors named on list pages (${hop2.length} found, budget ${budget})`);
      await appendJsonl(runId, "raw_records.jsonl", batch);
      await mapWithConcurrency(batch, NORMALIZE_CONCURRENCY, processOne);
    }

    progress("screening", { step: normalized, total });
    const counts: RunCounts = {
      raw_records: rawRecords,
      discovered: total,
      normalized,
      vendor_sites: vendorSites,
      unreachable,
      new_vendors: written.filter((w) => w.is_new).length,
      existing_vendors: written.filter((w) => !w.is_new).length,
      pass: written.filter((w) => w.result === "pass").length,
      fail: written.filter((w) => w.result === "fail").length,
      unknown: written.filter((w) => w.result === "unknown").length,
      must_field_coverage: round3(mean(written.map((w) => w.must_field_coverage))),
      unknown_rate: round3(written.length ? written.filter((w) => w.result === "unknown").length / written.length : 0),
      llm_usage: usage,
      progress: { phase: cancelled ? "cancelled" : "done", step: normalized, total },
    };
    await persist("summary.json", { counts, vendors: written });
    finishRun(runId, counts, db);
    log(`done: ${JSON.stringify({ ...counts, progress: undefined, llm_usage: undefined })}`);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log(`FAILED: ${message}`);
    await persist("error.json", { error: message, stack: err instanceof Error ? err.stack : undefined });
    finishRun(runId, { progress: { phase: "failed", error: message } }, db);
  }
  return getRun(runId, db) as Run;
}
