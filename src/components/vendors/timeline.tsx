"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Undo2 } from "lucide-react";

import { TONE_CLASS } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EventRow } from "@/lib/db/schema";
import { formatDate, formatPct } from "@/lib/format";
import { postJson } from "@/lib/shared/http";

const ACTOR_CLASS: Record<string, string> = { human: "border-border text-foreground", system: TONE_CLASS.muted, adapter: TONE_CLASS.muted, llm_inference: TONE_CLASS.warning };

export function Timeline({ vendorId, events, latestEventId }: { vendorId: string; events: EventRow[]; latestEventId: number | null }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const revert = async (eventId: number) => {
    setBusy(eventId);
    setError(null);
    try {
      await postJson(`/api/vendors/${encodeURIComponent(vendorId)}/revert`, { event_id: eventId });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (events.length === 0) return <p className="text-sm text-muted-foreground">No events.</p>;
  return (
    <div className="flex flex-col gap-2">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <ol className="flex flex-col divide-y rounded-lg border bg-card">
        {[...events].reverse().map((ev) => {
          const revertable = ev.actor === "llm_inference" && ev.event_id === latestEventId;
          return (
            <li key={ev.event_id} className="flex flex-col gap-1 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">#{ev.event_id} · {formatDate(ev.created_at)}</span>
                <span>
                  {ev.from_status ?? "—"}
                  {ev.from_stage ? <span className="text-muted-foreground"> / {ev.from_stage}</span> : null}
                  {" → "}
                  <span className="font-medium">{ev.to_status}</span>
                  {ev.to_stage ? <span className="text-muted-foreground"> / {ev.to_stage}</span> : null}
                </span>
                <Badge variant="outline" className={ACTOR_CLASS[ev.actor] ?? ""}>{ev.actor}</Badge>
                {ev.confidence !== null ? <span className="text-xs text-muted-foreground">confidence {formatPct(ev.confidence)}</span> : null}
                {revertable ? (
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => void revert(ev.event_id)} disabled={busy !== null}>
                    {busy === ev.event_id ? <LoaderCircle className="animate-spin" /> : <Undo2 />}
                    Revert
                  </Button>
                ) : null}
              </div>
              <div className="text-muted-foreground">{ev.reason}</div>
              {ev.evidence_ref ? <div className="font-mono text-[11px] text-muted-foreground">{ev.evidence_ref}</div> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
