"use client";

import { HelpLabel } from "@/components/help-label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Run } from "@/lib/db/schema";
import { formatDate, formatPct, shortRunId } from "@/lib/format";
import { runStatus } from "@/lib/shared/run-status";

const HELP =
  "Every discovery, upload and refresh writes a run with its ruleset version and its counts, so any result can be traced back to the rules that produced it and replayed from disk.";

function RunsTable({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Run</th>
            <th className="py-1 pr-3 font-medium">Config</th>
            <th className="py-1 pr-3 font-medium">Input</th>
            <th className="py-1 pr-3 font-medium">Ruleset</th>
            <th className="py-1 pr-3 font-medium">Status</th>
            <th className="py-1 pr-3 font-medium">Counts</th>
            <th className="py-1 pr-3 font-medium">Started</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {runs.map((r) => {
            const status = runStatus(r);
            const c = r.counts;
            return (
              <tr key={r.run_id} className="align-top">
                <td className="py-1.5 pr-3 font-mono text-xs">{shortRunId(r.run_id)}</td>
                <td className="py-1.5 pr-3">{String(r.query.config ?? "—")}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{r.input_type} · {r.adapter}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{r.ruleset_version}</td>
                <td className="py-1.5 pr-3">
                  <Badge variant="outline" className={status === "failed" ? "border-destructive/40 text-destructive" : status === "running" ? "border-primary/40 text-primary" : ""}>
                    {status}
                  </Badge>
                  {status === "failed" && c.progress?.error ? <div className="mt-1 max-w-xs truncate text-xs text-muted-foreground" title={c.progress.error}>{c.progress.error}</div> : null}
                </td>
                <td className="py-1.5 pr-3 text-xs text-muted-foreground">
                  {status === "done"
                    ? `${c.discovered ?? 0} found · ${c.vendor_sites ?? c.new_vendors ?? 0} vendors · pass ${c.pass ?? 0} / unknown ${c.unknown ?? 0} / fail ${c.fail ?? 0} · coverage ${formatPct(c.must_field_coverage)}`
                    : status === "running"
                      ? `${c.progress?.phase ?? "queued"}${c.progress?.step !== undefined ? ` ${c.progress.step}/${c.progress.total ?? "?"}` : ""}`
                      : "—"}
                </td>
                <td className="py-1.5 pr-3 font-mono text-xs">{formatDate(r.started_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** `flush` drops the card chrome, for use inside the Runs panel. */
export function RunsList({ runs, flush = false }: { runs: Run[]; flush?: boolean }) {
  if (flush) return <RunsTable runs={runs} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <HelpLabel help={HELP}>Runs</HelpLabel>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <RunsTable runs={runs} />
      </CardContent>
    </Card>
  );
}
