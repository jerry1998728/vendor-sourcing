"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, RefreshCw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ScheduleWithRun } from "@/lib/db/queries";
import { SCHEDULE_PRESETS } from "@/lib/pipeline/cron";
import type { ConfigSummary } from "@/lib/rulesets/loader";
import { formatDate } from "@/lib/format";
import { postJson } from "@/lib/shared/http";

import { RunProgress } from "./run-progress";
import { useRun } from "./use-run";

function ScheduleRow({ config, schedule }: { config: ConfigSummary; schedule: ScheduleWithRun | undefined }) {
  const router = useRouter();
  const [cron, setCron] = React.useState(schedule?.cron ?? SCHEDULE_PRESETS[1].cron);
  const [enabled, setEnabled] = React.useState(schedule?.enabled ?? false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = useRun();
  const last = schedule?.last_run ?? null;
  const lastCounts = last?.counts;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await postJson("/api/schedules", { config: config.name, cron, enabled });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-56 font-medium">{config.name}</span>
        <Select value={cron} onValueChange={setCron}>
          <SelectTrigger className="w-60" aria-label={`Schedule for ${config.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULE_PRESETS.map((p) => (
              <SelectItem key={p.cron} value={p.cron}>{p.label}</SelectItem>
            ))}
            {!SCHEDULE_PRESETS.some((p) => p.cron === cron) ? <SelectItem value={cron}>{cron}</SelectItem> : null}
          </SelectContent>
        </Select>
        <span className="flex items-center gap-1.5">
          <Checkbox id={`sched-${config.name}`} checked={enabled} onCheckedChange={(c) => setEnabled(c === true)} />
          <Label htmlFor={`sched-${config.name}`} className="text-xs text-muted-foreground">enabled</Label>
        </span>
        <Button size="sm" variant="outline" onClick={() => void save()} disabled={saving}>
          {saving ? <LoaderCircle className="animate-spin" /> : <Save />} Save
        </Button>
        <Button size="sm" onClick={() => void run.start(config.name, { endpoint: "/api/refresh" })} disabled={run.busy}>
          {run.busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} Refresh now
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {last ? (
          <span>
            last refresh {formatDate(last.finished_at ?? last.started_at)} · {lastCounts?.refreshed ?? 0} refreshed, {lastCounts?.changed ?? 0} changed, {lastCounts?.screen_changed ?? 0} screen changes
          </span>
        ) : (
          <span>no scheduled refresh yet</span>
        )}
        <span className="font-mono">{cron}</span>
      </div>
      {run.view ? <RunProgress view={run.view} align="start" onCancel={() => void run.cancel()} /> : null}
      {error || run.error ? <p className="text-sm text-destructive">{error ?? run.error}</p> : null}
    </li>
  );
}

export function ScheduleCard({ configs, schedules }: { configs: ConfigSummary[]; schedules: ScheduleWithRun[] }) {
  const byConfig = new Map(schedules.map((s) => [s.config, s]));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduled refresh</CardTitle>
        <CardDescription>
          Re-fetches the evidence pages of each vendor, re-extracts, and diffs attributes and tags. Changes land on the vendor Timeline; a changed screen result goes back to the Review Queue.
          Schedules run when an external cron calls <code className="font-mono">POST /api/schedules/run-due</code> (see README). Development refreshes are capped at 5 vendors.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {configs.filter((c) => c.valid).map((c) => (
            <ScheduleRow key={c.name} config={c} schedule={byConfig.get(c.name)} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
