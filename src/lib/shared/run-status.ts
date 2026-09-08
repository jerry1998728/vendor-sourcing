/**
 * A run's status from its row alone, so client components can show it without
 * importing the database module (better-sqlite3 must stay out of the bundle).
 */
import type { Run } from "@/lib/db/schema";

export type RunStatus = "running" | "done" | "failed" | "cancelled";

export function runStatus(run: Run): RunStatus {
  if (!run.finished_at) return "running";
  const phase = run.counts.progress?.phase;
  return phase === "failed" ? "failed" : phase === "cancelled" ? "cancelled" : "done";
}
