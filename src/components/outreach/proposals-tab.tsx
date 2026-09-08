"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, RefreshCw, Undo2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { HelpLabel } from "@/components/help-label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LlmEvent, PendingProposal } from "@/lib/db/queries";
import { formatDate, formatPct } from "@/lib/format";
import { postJson } from "@/lib/shared/http";

export function ProposalsTab({ proposals, llmEvents, activeThreads }: { proposals: PendingProposal[]; llmEvents: LlmEvent[]; activeThreads: number }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    try {
      setNote(await fn());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const followUps = () =>
    run("followups", async () => {
      const d = await postJson("/api/track/followups", {});
      return `Follow-ups: ${d.checked} checked, ${d.drafted_7d} drafted (7d), ${d.drafted_14d} drafted (14d), ${d.dormant} dormant.`;
    });
  const poll = () =>
    run("poll", async () => {
      const d = await postJson("/api/track/poll", {});
      const errs = Array.isArray(d.errors) ? (d.errors as string[]) : [];
      return `Polled ${d.threads} thread(s): ${d.new_inbound} new inbound, ${d.replied} replied, ${d.applied} applied, ${d.proposals} proposals${errs.length ? `; ${errs.join("; ")}` : ""}`;
    });
  const decide = (p: PendingProposal, decision: "accept" | "reject") =>
    run(`p${p.proposal_id}`, async () => {
      await postJson(`/api/proposals/${p.proposal_id}`, { decision });
      return `Proposal #${p.proposal_id} ${decision === "accept" ? "accepted" : "rejected"}.`;
    });
  const revert = (e: LlmEvent) =>
    run(`e${e.event_id}`, async () => {
      await postJson(`/api/vendors/${encodeURIComponent(e.vendor_id)}/revert`, { event_id: e.event_id });
      return `Reverted event #${e.event_id} for ${e.vendor_name}.`;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => void poll()} disabled={busy !== null}>
          {busy === "poll" ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Poll inbox
        </Button>
        <Button size="sm" variant="outline" onClick={() => void followUps()} disabled={busy !== null}>
          {busy === "followups" ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Run follow-ups
        </Button>
        <span className="text-sm text-muted-foreground">{activeThreads} active Gmail thread{activeThreads === 1 ? "" : "s"}</span>
        {note ? <span className="text-sm text-muted-foreground">{note}</span> : null}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>
            <HelpLabel help="Inferred from inbound replies but not auto-applied: confidence below 0.85, or a quote / sample stage, which is always a human decision.">
              Pending proposals ({proposals.length})
            </HelpLabel>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {proposals.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing pending.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {proposals.map((p) => (
                <li key={p.proposal_id} className="flex flex-col gap-1.5 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/vendors/${encodeURIComponent(p.vendor_id)}?tab=thread`} className="font-medium underline-offset-2 hover:underline">{p.vendor_name}</Link>
                    <span className="text-muted-foreground">
                      {p.vendor_status}{p.vendor_stage ? ` / ${p.vendor_stage}` : ""} →{" "}
                      <span className="font-medium text-foreground">{p.to_status}{p.to_stage ? ` / ${p.to_stage}` : ""}</span>
                    </span>
                    <Badge variant="outline">confidence {formatPct(p.confidence)}</Badge>
                    <span className="ml-auto flex items-center gap-1.5">
                      <Button size="sm" onClick={() => void decide(p, "accept")} disabled={busy !== null}>
                        {busy === `p${p.proposal_id}` ? <LoaderCircle className="animate-spin" /> : <Check />} Accept
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void decide(p, "reject")} disabled={busy !== null}>
                        <X /> Reject
                      </Button>
                    </span>
                  </div>
                  {p.evidence_snippet ? <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground">“{p.evidence_snippet}”</blockquote> : null}
                  {p.interaction_summary ? <p className="text-xs text-muted-foreground">{p.interaction_summary}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <HelpLabel help="Transitions applied by inference at confidence ≥ 0.85. Revert reverses the latest one for a vendor with a human event.">
              Automatic changes ({llmEvents.length})
            </HelpLabel>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {llmEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {llmEvents.map((e) => (
                <li key={e.event_id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">#{e.event_id} · {formatDate(e.created_at)}</span>
                  <Link href={`/vendors/${encodeURIComponent(e.vendor_id)}?tab=timeline`} className="font-medium underline-offset-2 hover:underline">{e.vendor_name}</Link>
                  <span className="text-muted-foreground">
                    {e.from_status}{e.from_stage ? ` / ${e.from_stage}` : ""} → <span className="text-foreground">{e.to_status}{e.to_stage ? ` / ${e.to_stage}` : ""}</span>
                  </span>
                  {e.confidence !== null ? <Badge variant="outline">{formatPct(e.confidence)}</Badge> : null}
                  <span className="max-w-md truncate text-xs text-muted-foreground" title={e.reason ?? ""}>{e.reason}</span>
                  <span className="ml-auto">
                    {e.revertable ? (
                      <Button size="sm" variant="outline" onClick={() => void revert(e)} disabled={busy !== null}>
                        {busy === `e${e.event_id}` ? <LoaderCircle className="animate-spin" /> : <Undo2 />} Revert
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">superseded</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
