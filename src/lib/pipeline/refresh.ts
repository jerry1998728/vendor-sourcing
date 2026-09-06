/**
 * P1 scheduled refresh (PRD §4.2): re-fetch each vendor's sources through the
 * adapter's refresh(), re-extract, write new evidence through the same write
 * path, diff attributes / tags / screen_result, and record tag_changed and
 * screen_changed events (actor=system). A changed screen_result on a vendor
 * past Screened sets next_action=re_review so the Review Queue surfaces it.
 */
import { and, eq, inArray } from "drizzle-orm";

import { getAdapter } from "@/lib/adapters";
import { getDb, nowIso, type Db } from "@/lib/db";
import { RE_REVIEW } from "@/lib/db/filters";
import { finishRun, getRun, updateRunCounts } from "@/lib/db/queries";
import { evidence, runs, tags, vendors, type Run, type RunCounts, type RunPhase, type Vendor } from "@/lib/db/schema";
import { recordEvent } from "@/lib/db/state";
import { emptyUsage } from "@/lib/llm/client";
import { loadConfig, loadRuleset } from "@/lib/rulesets/loader";

import { mapWithConcurrency } from "./concurrency";
import { writeNormalizedVendor } from "./run";
import { newRunId, persistJson, relativeRunDir } from "./storage";
import type { AdapterContext, SourceAdapter } from "./types";

const DEV_REFRESH_LIMIT = 5;
const REFRESH_CONCURRENCY = 2;

export type RefreshOptions = { vendorIds?: string[]; limit?: number };

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Vendors a config's refresh covers: same vendor_type, discovered by the config's adapter. */
export function refreshTargets(configName: string, opts: RefreshOptions = {}, db: Db = getDb()): Vendor[] {
  const config = loadConfig(configName);
  const adapter = getAdapter(config.adapter);
  if (!adapter.refresh) throw new Error(`adapter ${adapter.name} does not support refresh`);
  const rows = opts.vendorIds?.length
    ? db.select().from(vendors).where(inArray(vendors.vendor_id, opts.vendorIds)).all()
    : db.select().from(vendors).where(and(eq(vendors.vendor_type, config.vendor_type), eq(vendors.discovered_via, adapter.name))).all();
  const limit = opts.limit ?? (isDev() ? DEV_REFRESH_LIMIT : rows.length);
  return rows.sort((a, b) => (a.last_verified_at ?? "").localeCompare(b.last_verified_at ?? "")).slice(0, Math.max(0, limit));
}

export function createRefresh(configName: string, opts: RefreshOptions = {}, db: Db = getDb()): Run {
  const config = loadConfig(configName);
  const ruleset = loadRuleset(config.ruleset);
  const targets = refreshTargets(configName, opts, db);
  const run_id = newRunId();
  const startedAt = nowIso();
  const row = db
    .insert(runs)
    .values({
      run_id,
      input_type: "refresh",
      adapter: config.adapter,
      vendor_type: config.vendor_type,
      query: { config: config.name, refresh: true, vendor_ids: targets.map((v) => v.vendor_id) },
      ruleset_version: ruleset.ruleset_version,
      started_at: startedAt,
      counts: { progress: { phase: "queued" } },
      raw_payload_path: relativeRunDir(run_id),
    })
    .returning()
    .get();
  void persistJson(run_id, "config.json", { config, ruleset, refresh: true, vendor_ids: targets.map((v) => v.vendor_id), started_at: startedAt });
  return row;
}

type Snapshot = { attributes: Record<string, string[]>; tags: Record<string, string[]>; screen_result: string | null; status: string };

function snapshot(vendorId: string, db: Db): Snapshot | null {
  const v = db.select().from(vendors).where(eq(vendors.vendor_id, vendorId)).get();
  if (!v) return null;
  const attributes: Record<string, string[]> = {};
  for (const [k, val] of Object.entries(v.attributes)) attributes[k] = (Array.isArray(val) ? val : [val]).map(String).sort();
  const tagMap: Record<string, string[]> = {};
  for (const t of db.select().from(tags).where(eq(tags.vendor_id, vendorId)).all()) (tagMap[t.dimension] ??= []).push(t.value);
  for (const k of Object.keys(tagMap)) tagMap[k].sort();
  return { attributes, tags: tagMap, screen_result: v.screen_result, status: v.status };
}

export type Diff = { attributes: Record<string, { added: string[]; removed: string[] }>; tags: Record<string, { added: string[]; removed: string[] }>; screen: { from: string | null; to: string | null } | null };

export function diffSnapshots(before: Snapshot, after: Snapshot): Diff {
  const diffMap = (a: Record<string, string[]>, b: Record<string, string[]>) => {
    const out: Record<string, { added: string[]; removed: string[] }> = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = new Set(a[key] ?? []);
      const y = new Set(b[key] ?? []);
      const added = [...y].filter((v) => !x.has(v));
      const removed = [...x].filter((v) => !y.has(v));
      if (added.length || removed.length) out[key] = { added, removed };
    }
    return out;
  };
  return {
    attributes: diffMap(before.attributes, after.attributes),
    tags: diffMap(before.tags, after.tags),
    screen: before.screen_result !== after.screen_result ? { from: before.screen_result, to: after.screen_result } : null,
  };
}

export function describeDiff(d: Diff): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d.tags)) parts.push(`${k}${v.added.length ? " +" + v.added.join(",") : ""}${v.removed.length ? " -" + v.removed.join(",") : ""}`);
  for (const [k, v] of Object.entries(d.attributes)) if (!d.tags[k]) parts.push(`${k}${v.added.length ? " +" + v.added.join(",") : ""}${v.removed.length ? " -" + v.removed.join(",") : ""}`);
  return parts.join("; ");
}

export async function executeRefresh(runId: string, db: Db = getDb(), seams: { adapter?: SourceAdapter } = {}): Promise<Run> {
  const run = getRun(runId, db);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.finished_at) return run;
  const log = (m: string) => console.log(`[refresh ${runId}] ${m}`);
  const persist = (name: string, payload: unknown) => persistJson(runId, name, payload);
  const progress = (phase: RunPhase, extra: Partial<RunCounts["progress"]> = {}) => updateRunCounts(runId, { progress: { phase, ...extra } }, db);

  const counts: RunCounts = { refreshed: 0, changed: 0, screen_changed: 0, unreachable: 0, skipped: 0, errors: 0 };
  const changes: Record<string, unknown>[] = [];
  try {
    const config = loadConfig(String(run.query.config));
    const ruleset = loadRuleset(config.ruleset);
    const adapter = seams.adapter ?? getAdapter(config.adapter);
    if (!adapter.refresh) throw new Error(`adapter ${adapter.name} does not support refresh`);
    const ctx: AdapterContext = { run_id: runId, config, ruleset, persist, log, usage: emptyUsage() };
    const ids = Array.isArray(run.query.vendor_ids) ? (run.query.vendor_ids as string[]) : [];
    let done = 0;
    progress("refreshing", { step: 0, total: ids.length });

    await mapWithConcurrency(ids, REFRESH_CONCURRENCY, async (vendorId) => {
      const vendor = db.select().from(vendors).where(eq(vendors.vendor_id, vendorId)).get();
      const before = snapshot(vendorId, db);
      if (!vendor || !before) {
        counts.skipped = (counts.skipped ?? 0) + 1;
        return;
      }
      const rows = db.select().from(evidence).where(eq(evidence.vendor_id, vendorId)).all();
      try {
        const result = await adapter.refresh!(vendor, rows, ctx);
        await persist(`refresh_${vendorId}.json`, result);
        if (!result.vendor) {
          counts.unreachable = (counts.unreachable ?? 0) + 1;
          log(`${vendorId}: ${result.page_type}, nothing to write`);
          return;
        }
        writeNormalizedVendor(db, run, ruleset, { ...result, vendor: result.vendor });
        counts.refreshed = (counts.refreshed ?? 0) + 1;
        const after = snapshot(vendorId, db)!;
        const diff = diffSnapshots(before, after);
        const changed = Object.keys(diff.attributes).length > 0 || Object.keys(diff.tags).length > 0;
        if (changed) {
          counts.changed = (counts.changed ?? 0) + 1;
          recordEvent({ vendorId, actor: "system", reason: `tag_changed: ${describeDiff(diff)}`, evidenceRef: `run:${runId}`, payload: { kind: "tag_changed", run_id: runId, changes: { attributes: diff.attributes, tags: diff.tags } } }, db);
        }
        if (diff.screen) {
          counts.screen_changed = (counts.screen_changed ?? 0) + 1;
          recordEvent({ vendorId, actor: "system", reason: `screen_changed: ${diff.screen.from ?? "none"} -> ${diff.screen.to ?? "none"}`, evidenceRef: `run:${runId}`, payload: { kind: "screen_changed", run_id: runId, ...diff.screen } }, db);
          if (after.status !== "Screened") {
            db.update(vendors).set({ next_action: RE_REVIEW, updated_at: nowIso() }).where(eq(vendors.vendor_id, vendorId)).run();
          }
        }
        if (changed || diff.screen) changes.push({ vendor_id: vendorId, ...diff });
        log(`${vendorId}: ${changed ? describeDiff(diff) : "no change"}${diff.screen ? ` · screen ${diff.screen.from} -> ${diff.screen.to}` : ""}`);
      } catch (err) {
        counts.errors = (counts.errors ?? 0) + 1;
        const message = err instanceof Error ? err.message : String(err);
        log(`${vendorId}: failed (${message})`);
        await persist(`refresh_${vendorId}.json`, { error: message });
      } finally {
        done += 1;
        progress("refreshing", { step: done, total: ids.length });
      }
    });

    await persist("summary.json", { counts, changes });
    finishRun(runId, { ...counts, discovered: ids.length, normalized: counts.refreshed, llm_usage: ctx.usage, progress: { phase: "done", step: ids.length, total: ids.length } }, db);
    log(`done: ${JSON.stringify(counts)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FAILED: ${message}`);
    finishRun(runId, { ...counts, progress: { phase: "failed", error: message } }, db);
  }
  return getRun(runId, db) as Run;
}
