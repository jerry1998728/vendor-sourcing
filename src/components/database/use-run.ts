"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import type { RunStatus } from "@/lib/db/queries";
import type { Run } from "@/lib/db/schema";

export type RunView = { run: Run; status: RunStatus };

/** Start a run for a config and poll /api/runs/[id] until it finishes; refreshes the page when done. */
export function useRun() {
  const router = useRouter();
  const [view, setView] = React.useState<RunView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | null>(null);

  const stopPolling = React.useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  const poll = React.useCallback(
    (runId: string) => {
      stopPolling();
      setBusy(true);
      const tick = async () => {
        try {
          const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
          if (!res.ok) throw new Error(`GET /api/runs/${runId} failed (${res.status})`);
          const data = (await res.json()) as RunView;
          setView(data);
          if (data.status !== "running") {
            stopPolling();
            setBusy(false);
            router.refresh();
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          stopPolling();
          setBusy(false);
        }
      };
      void tick();
      timer.current = window.setInterval(() => void tick(), 2000);
    },
    [router, stopPolling],
  );

  React.useEffect(() => stopPolling, [stopPolling]);

  const start = React.useCallback(
    async (config: string, opts: { replay?: boolean; endpoint?: string; body?: Record<string, unknown> } = {}) => {
      setError(null);
      setBusy(true);
      setView(null);
      try {
        const res = await fetch(opts.endpoint ?? "/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config, replay: opts.replay, ...(opts.body ?? {}) }),
        });
        const data = (await res.json()) as { run_id?: string; error?: string };
        if (res.status === 409 && data.run_id) {
          poll(data.run_id);
          return;
        }
        if (!res.ok || !data.run_id) throw new Error(data.error ?? `POST /api/runs failed (${res.status})`);
        poll(data.run_id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [poll],
  );

  /** Pick up a run already in flight for this config (page reload). */
  const resume = React.useCallback(
    async (config: string) => {
      try {
        const res = await fetch("/api/runs", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { runs: (Run & { status: RunStatus })[] };
        const active = data.runs.find((r) => r.status === "running" && r.query.config === config);
        if (active) poll(active.run_id);
      } catch {
        /* nothing to resume */
      }
    },
    [poll],
  );

  return { view, error, busy, start, poll, resume, setError };
}
