"use client";

import * as React from "react";
import { LoaderCircle, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConfigSummary } from "@/lib/rulesets/loader";

import { RunProgress } from "./run-progress";
import { useRun } from "./use-run";

export function RunConfigButton({
  configs,
  defaultConfig,
}: {
  configs: ConfigSummary[];
  defaultConfig: string;
}) {
  const [config, setConfig] = React.useState(defaultConfig);
  const [replay, setReplay] = React.useState(false);
  const { view, error, busy, start, resume, cancel } = useRun();

  React.useEffect(() => {
    void resume(config);
  }, [config, resume]);

  // A new deep link (?config=...) replaces the current selection.
  const lastDefault = React.useRef(defaultConfig);
  React.useEffect(() => {
    if (lastDefault.current !== defaultConfig) {
      lastDefault.current = defaultConfig;
      setConfig(defaultConfig);
    }
  }, [defaultConfig]);

  const selected = configs.find((c) => c.name === config);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={config} onValueChange={setConfig} disabled={busy}>
          <SelectTrigger className="w-64" aria-label="Config">
            <SelectValue placeholder="Config" />
          </SelectTrigger>
          <SelectContent>
            {configs.map((c) => (
              <SelectItem key={c.name} value={c.name} disabled={!c.valid}>
                {c.name}
                {c.valid ? "" : " (invalid)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => void start(config, { replay })} disabled={busy || !selected?.valid}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Play />}
          Run config
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Checkbox id="run-replay" checked={replay} onCheckedChange={(c) => setReplay(c === true)} disabled={busy} />
        <Label htmlFor="run-replay" className="text-xs text-muted-foreground">
          Replay latest run (re-extract from disk, skip search)
        </Label>
      </div>
      {selected && !selected.valid ? (
        <p className="max-w-md text-right text-xs text-destructive">{selected.error}</p>
      ) : null}
      {selected?.valid && selected.description ? (
        <p className="max-w-md text-right text-xs text-muted-foreground">{selected.adapter} · {selected.ruleset}</p>
      ) : null}
      {view ? <RunProgress view={view} onCancel={() => void cancel()} /> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
