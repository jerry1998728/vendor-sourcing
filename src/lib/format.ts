/** "2026-09-05 21:14" in UTC; identical on server and client. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export function formatPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function shortRunId(runId: string | null | undefined): string {
  if (!runId) return "—";
  return runId.replace(/^run_/, "");
}
