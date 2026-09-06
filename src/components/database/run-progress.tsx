"use client";

import { Badge } from "@/components/ui/badge";
import { formatPct, shortRunId } from "@/lib/format";

import type { RunView } from "./use-run";

export function RunProgress({ view, align = "end" }: { view: RunView; align?: "start" | "end" }) {
  const { run, status } = view;
  const c = run.counts;
  const p = c.progress;
  const justify = align === "end" ? "justify-end text-right" : "justify-start";
  if (status === "running") {
    const step = p?.step !== undefined && p?.total !== undefined ? ` ${p.step}/${p.total}` : "";
    return (
      <p className={`text-sm text-muted-foreground ${align === "end" ? "text-right" : ""}`}>
        <span className="font-mono text-xs">{shortRunId(run.run_id)}</span> · {p?.phase ?? "queued"}
        {step}
        {p?.message ? ` · ${p.message}` : ""}
      </p>
    );
  }
  if (status === "failed") {
    return (
      <p className={`max-w-xl text-sm text-destructive ${align === "end" ? "text-right" : ""}`}>
        Run {shortRunId(run.run_id)} failed: {p?.error ?? "unknown error"}
      </p>
    );
  }
  if (run.input_type === "refresh") {
    return (
      <div className={`flex flex-wrap items-center gap-1.5 text-sm ${justify}`}>
        <span className="mr-1 font-mono text-xs text-muted-foreground">{shortRunId(run.run_id)}</span>
        <Badge variant="secondary">{c.refreshed ?? 0} refreshed</Badge>
        <Badge variant="outline">{c.changed ?? 0} changed</Badge>
        <Badge variant="outline" className={(c.screen_changed ?? 0) > 0 ? "border-warning/40 bg-warning/15 text-warning" : ""}>{c.screen_changed ?? 0} screen changes</Badge>
        {(c.unreachable ?? 0) > 0 ? <Badge variant="outline">{c.unreachable} unreachable</Badge> : null}
        {(c.errors ?? 0) > 0 ? <Badge variant="outline" className="border-destructive/40 text-destructive">{c.errors} errors</Badge> : null}
      </div>
    );
  }
  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-sm ${justify}`}>
      <span className="mr-1 font-mono text-xs text-muted-foreground">{shortRunId(run.run_id)}</span>
      <Badge variant="secondary">{c.discovered ?? 0} discovered</Badge>
      <Badge variant="secondary">{c.vendor_sites ?? 0} vendor sites</Badge>
      <Badge variant="secondary">{c.new_vendors ?? 0} new</Badge>
      <Badge variant="outline" className="border-success/40 bg-success/15 text-success">{c.pass ?? 0} pass</Badge>
      <Badge variant="outline" className="border-warning/40 bg-warning/15 text-warning">{c.unknown ?? 0} unknown</Badge>
      <Badge variant="outline" className="border-destructive/40 bg-destructive/15 text-destructive">{c.fail ?? 0} fail</Badge>
      <Badge variant="outline">coverage {formatPct(c.must_field_coverage)}</Badge>
      <Badge variant="outline">unknown rate {formatPct(c.unknown_rate)}</Badge>
    </div>
  );
}
