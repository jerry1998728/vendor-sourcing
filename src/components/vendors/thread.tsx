"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoaderCircle, RefreshCw, MessageSquarePlus } from "lucide-react";

import { TONE_CLASS } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { InteractionRow, Vendor } from "@/lib/db/schema";
import { formatDate } from "@/lib/format";
import { postJson } from "@/lib/shared/http";

const DIRECTION_CLASS: Record<string, string> = { draft: TONE_CLASS.muted, outbound: "border-border text-foreground", inbound: TONE_CLASS.success };

export function Thread({ vendor, interactions, devTools }: { vendor: Vendor; interactions: InteractionRow[]; devTools: boolean }) {
  const router = useRouter();
  const [polling, setPolling] = React.useState(false);
  const [simulating, setSimulating] = React.useState(false);
  const [subject, setSubject] = React.useState("Re: your email");
  const [body, setBody] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const hasThread = interactions.some((i) => i.direction === "outbound" && i.gmail_thread_id);
  const canReceive = ["Contacted", "Replied", "In Discussion"].includes(vendor.status);

  const poll = async () => {
    setPolling(true);
    setError(null);
    try {
      const data = await postJson<{ new_inbound?: number; applied?: number; proposals?: number; errors?: string[] }>("/api/track/poll", { vendor_id: vendor.vendor_id });
      setNote(`Polled: ${data.new_inbound ?? 0} new inbound, ${data.applied ?? 0} applied, ${data.proposals ?? 0} proposals${data.errors?.length ? `; ${data.errors.join("; ")}` : ""}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPolling(false);
    }
  };

  const simulate = async () => {
    setSimulating(true);
    setError(null);
    try {
      const data = await postJson<{ applied?: boolean; proposal_id?: number | null; replied?: boolean; inference?: { summary: string; action: string; reason: string } | null }>("/api/track/simulate", { vendor_id: vendor.vendor_id, subject, body });
      setNote(`${data.replied ? "Contacted → Replied. " : ""}${data.inference ? `${data.inference.summary} [${data.inference.action}: ${data.inference.reason}]` : "no inference"}${data.proposal_id ? ` → proposal #${data.proposal_id}` : ""}`);
      setBody("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimulating(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void poll()} disabled={polling || !hasThread}>
          {polling ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Poll inbox
        </Button>
        {!hasThread ? <span className="text-xs text-muted-foreground">No Gmail thread yet.</span> : null}
        {vendor.status === "Qualified" ? (
          <Button asChild size="sm" variant="outline">
            <Link href="/outreach/draft">Draft &amp; Send</Link>
          </Button>
        ) : null}
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <ol className="flex flex-col gap-2">
        {interactions.map((i) => (
          <li key={i.interaction_id} className="rounded-lg border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={DIRECTION_CLASS[i.direction] ?? ""}>{i.direction}</Badge>
              <span className="font-medium">{i.subject ?? "(no subject)"}</span>
              <span className="font-mono text-xs text-muted-foreground">#{i.interaction_id} · {formatDate(i.sent_at)}</span>
              {i.gmail_thread_id ? <span className="font-mono text-[11px] text-muted-foreground">thread {i.gmail_thread_id}</span> : null}
            </div>
            {i.body_text ? <pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-foreground/90">{i.body_text}</pre> : null}
            {i.llm_summary ? <p className="mt-2 text-xs text-muted-foreground">{i.llm_summary}</p> : null}
          </li>
        ))}
        {interactions.length === 0 ? <li className="text-sm text-muted-foreground">No interactions yet.</li> : null}
      </ol>

      {devTools && canReceive ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3">
          <p className="text-xs text-muted-foreground">Development only: inject an inbound reply without Gmail. It runs the same ingest → infer → apply/propose path.</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-subject">Subject</Label>
            <Input id="sim-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-body">Body</Label>
            <Textarea id="sim-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Thanks, happy to talk next week..." />
          </div>
          <div>
            <Button size="sm" onClick={() => void simulate()} disabled={simulating || body.trim().length === 0}>
              {simulating ? <LoaderCircle className="animate-spin" /> : <MessageSquarePlus />}
              Simulate reply
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
