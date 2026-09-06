/**
 * Runs once when the server starts. Runs execute inside the process (after()),
 * so anything still unfinished at boot was interrupted; mark it failed so
 * findActiveRun() never blocks a config on a ghost.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getDb } = await import("@/lib/db");
  const { markInterruptedRuns } = await import("@/lib/db/queries");
  const n = markInterruptedRuns(getDb());
  if (n > 0) console.log(`[boot] marked ${n} interrupted run(s) as failed`);
}
