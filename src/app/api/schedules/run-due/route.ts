import { NextResponse } from "next/server";

import { findActiveRun, listSchedules, setScheduleLastRun } from "@/lib/db/queries";
import { isDue } from "@/lib/pipeline/cron";
import { createRefresh, executeRefresh } from "@/lib/pipeline/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Call from any external cron (see README). Runs every enabled schedule whose
 * cron fired since its last run, sequentially, and records last_run_id.
 */
export async function POST() {
  const now = new Date();
  const ran: { config: string; run_id: string; counts: unknown }[] = [];
  const skipped: { config: string; reason: string }[] = [];
  for (const s of listSchedules()) {
    if (!s.enabled) {
      skipped.push({ config: s.config, reason: "disabled" });
      continue;
    }
    if (!isDue(s.cron, s.last_run?.started_at ?? null, now)) {
      skipped.push({ config: s.config, reason: "not due" });
      continue;
    }
    if (findActiveRun(s.config)) {
      skipped.push({ config: s.config, reason: "run in progress" });
      continue;
    }
    try {
      const run = createRefresh(s.config);
      setScheduleLastRun(s.schedule_id, run.run_id);
      const finished = await executeRefresh(run.run_id);
      ran.push({ config: s.config, run_id: run.run_id, counts: finished.counts });
    } catch (err) {
      skipped.push({ config: s.config, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ now: now.toISOString(), ran, skipped });
}
