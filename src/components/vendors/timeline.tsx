"use client";

/**
 * Vertical milestone rail: status changes, stage changes, informational
 * events (tag / screen changes) and every email (draft, sent, received)
 * merged in time order, oldest at the top, ending at the vendor's current
 * state. The Thread tab keeps the full email bodies.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, LoaderCircle, Reply, Send, Undo2 } from "lucide-react";

import { StatusBadge, TONE_CLASS } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EventRow, InteractionRow, Vendor } from "@/lib/db/schema";
import { formatDate, formatPct } from "@/lib/format";
import { postJson } from "@/lib/shared/http";
import { buildTimeline } from "@/lib/shared/timeline";
import { cn } from "@/lib/utils";

const ACTOR_CLASS: Record<string, string> = { human: "border-border text-foreground", system: TONE_CLASS.muted, adapter: TONE_CLASS.muted, llm_inference: TONE_CLASS.warning };
/** Dot colour on the rail: the accent marks human decisions; inference is amber; the machine is gray. */
const ACTOR_DOT: Record<string, string> = { human: "bg-primary", system: "bg-muted-foreground", adapter: "bg-muted-foreground", llm_inference: "bg-warning" };

const EMAIL_LABEL: Record<InteractionRow["direction"], string> = { draft: "Draft prepared", outbound: "Email sent", inbound: "Reply received" };
const EMAIL_ICON: Record<InteractionRow["direction"], React.ComponentType<{ className?: string }>> = { draft: FileText, outbound: Send, inbound: Reply };

function Marker({ className, children }: { className: string; children?: React.ReactNode }) {
  return (
    <span aria-hidden className={cn("absolute top-1 flex items-center justify-center rounded-full ring-4 ring-background", className)}>
      {children}
    </span>
  );
}

export function Timeline({ vendor, events, interactions, latestEventId }: { vendor: Vendor; events: EventRow[]; interactions: InteractionRow[]; latestEventId: number | null }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const revert = async (eventId: number) => {
    setBusy(eventId);
    setError(null);
    try {
      await postJson(`/api/vendors/${encodeURIComponent(vendor.vendor_id)}/revert`, { event_id: eventId });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const items = buildTimeline(events, interactions);
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No events.</p>;
  const threadHref = `/vendors/${encodeURIComponent(vendor.vendor_id)}?tab=thread`;

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <ol className="relative ml-3 border-l border-border pl-7">
        {items.map((item) => {
          if (item.kind === "email") {
            const i = item.interaction;
            const Icon = EMAIL_ICON[i.direction];
            const preview = i.body_text?.replace(/\s+/g, " ").trim();
            return (
              <li key={`i${i.interaction_id}`} className="relative pb-7">
                <Marker className={cn("-left-[43px] size-7 border bg-card", i.direction === "inbound" ? "border-success/60 text-success" : "border-border text-muted-foreground")}>
                  <Icon className="size-3.5" />
                </Marker>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{formatDate(i.sent_at)}</span>
                  <span className="font-medium">{EMAIL_LABEL[i.direction]}</span>
                  {i.subject ? <span className="text-muted-foreground">{i.subject}</span> : null}
                  <Link href={threadHref} className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:underline">
                    open in Thread
                  </Link>
                </div>
                {i.llm_summary ? <p className="mt-1 text-sm text-muted-foreground">{i.llm_summary}</p> : null}
                {preview && i.direction !== "draft" ? <p className="mt-1 line-clamp-2 text-sm text-foreground/80">{preview}</p> : null}
              </li>
            );
          }

          const ev = item.event;
          const revertable = ev.actor === "llm_inference" && ev.event_id === latestEventId;
          if (item.kind === "note") {
            return (
              <li key={`e${ev.event_id}`} className="relative pb-6">
                <Marker className="-left-[33px] size-2 bg-muted-foreground/70" />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{formatDate(ev.created_at)}</span>
                  <span className="text-muted-foreground">{ev.reason}</span>
                  <Badge variant="outline" className={cn("ml-auto", ACTOR_CLASS[ev.actor])}>{ev.actor}</Badge>
                </div>
                {ev.evidence_ref ? <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{ev.evidence_ref}</p> : null}
              </li>
            );
          }

          return (
            <li key={`e${ev.event_id}`} className="relative pb-7">
              <Marker className={cn(item.kind === "status" ? "-left-[36px] size-3.5" : "-left-[34px] size-2.5", ACTOR_DOT[ev.actor] ?? "bg-muted-foreground")} />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{formatDate(ev.created_at)}</span>
                {item.kind === "status" ? <StatusBadge status={ev.to_status} /> : <span className="font-medium">{ev.to_status}</span>}
                {ev.to_stage ? <Badge variant="secondary">{ev.to_stage}</Badge> : null}
                <span className="text-xs text-muted-foreground">
                  {item.kind === "status" ? `from ${ev.from_status ?? "—"}` : `stage from ${ev.from_stage ?? "—"}`}
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
              {ev.reason ? <p className="mt-1 text-sm text-muted-foreground">{ev.reason}</p> : null}
              {ev.evidence_ref ? <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{ev.evidence_ref}</p> : null}
            </li>
          );
        })}
        <li className="relative">
          <Marker className="-left-[38px] size-4 bg-primary shadow-[0_0_0_4px_var(--accent)]" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Now</span>
            <StatusBadge status={vendor.status} />
            {vendor.diligence_stage ? <Badge variant="secondary">{vendor.diligence_stage}</Badge> : null}
            {vendor.next_action ? <span className="text-muted-foreground">next {vendor.next_action}</span> : null}
            {vendor.due_at ? <span className="text-muted-foreground">due {formatDate(vendor.due_at)}</span> : null}
          </div>
        </li>
      </ol>
    </div>
  );
}
