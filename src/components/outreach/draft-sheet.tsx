"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, LoaderCircle, Mail, Sparkles, Send } from "lucide-react";

import { ScreenResultBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { InteractionRow, Vendor } from "@/lib/db/schema";
import { formatDate, formatPct } from "@/lib/format";

export type GmailState = { configured: boolean; connected: boolean; email?: string | null; error?: string | null };

const normalize = (e: string) => {
  const m = /<([^>]+)>/.exec(e);
  return (m ? m[1] : e).trim().toLowerCase();
};

export function unknownMustFields(vendor: Vendor): string[] {
  return vendor.screen_reasons.filter((r) => r.kind === "must" && r.outcome === "unknown").map((r) => r.field_path);
}

export function DraftSheet({
  vendor,
  draft,
  gmail,
  allowlist,
  onClose,
}: {
  vendor: Vendor | null;
  draft: InteractionRow | undefined;
  gmail: GmailState;
  allowlist: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [to, setTo] = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [draftId, setDraftId] = React.useState<number | null>(null);
  const [draftMeta, setDraftMeta] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<GmailState>(gmail);
  const [generating, setGenerating] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<{ thread_id: string; sender: string } | null>(null);

  // Reset the form whenever a different vendor is opened.
  const vendorId = vendor?.vendor_id ?? null;
  React.useEffect(() => {
    if (!vendorId) return;
    const load = async () => {
      setTo(vendor?.contact_email ?? "");
      setSubject(draft?.subject ?? "");
      setBody(draft?.body_text ?? "");
      setDraftId(draft?.interaction_id ?? null);
      setDraftMeta(draft?.llm_summary ?? null);
      setError(null);
      setSent(null);
      try {
        const res = await fetch("/api/gmail/status", { cache: "no-store" });
        if (res.ok) setStatus((await res.json()) as GmailState);
      } catch {
        /* keep the server-rendered state */
      }
    };
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the vendor changes
  }, [vendorId]);

  const generate = async () => {
    if (!vendor) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/vendors/${encodeURIComponent(vendor.vendor_id)}/draft`, { method: "POST" });
      const data = (await res.json()) as { draft?: InteractionRow; model?: string; error?: string };
      if (!res.ok || !data.draft) throw new Error(data.error ?? `draft failed (${res.status})`);
      setSubject(data.draft.subject ?? "");
      setBody(data.draft.body_text ?? "");
      setDraftId(data.draft.interaction_id);
      setDraftMeta(data.draft.llm_summary ?? null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const recipientAllowed = allowlist.includes(normalize(to));
  const canSend = Boolean(vendor) && recipientAllowed && status.connected && subject.trim().length > 0 && body.trim().length > 0 && !sending && !sent;

  const send = async () => {
    if (!vendor) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/vendors/${encodeURIComponent(vendor.vendor_id)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: to.trim(), subject: subject.trim(), body: body.trim(), draft_interaction_id: draftId ?? undefined }),
      });
      const data = (await res.json()) as { thread_id?: string; sender?: string; error?: string };
      if (!res.ok || !data.thread_id) throw new Error(data.error ?? `send failed (${res.status})`);
      setSent({ thread_id: data.thread_id, sender: data.sender ?? "" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const unknown = vendor ? unknownMustFields(vendor) : [];

  return (
    <Sheet open={vendor !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {vendor ? (
          <div className="flex flex-col gap-5 pb-8">
            <SheetHeader className="gap-2">
              <SheetTitle className="flex flex-wrap items-center gap-2">
                {vendor.name}
                <ScreenResultBadge result={vendor.screen_result} />
                <Badge variant="outline">coverage {formatPct(vendor.coverage_confidence)}</Badge>
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                {vendor.primary_domain ? (
                  <a href={`https://${vendor.primary_domain}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                    {vendor.primary_domain} <ExternalLink className="size-3" />
                  </a>
                ) : null}
                <span>· {vendor.next_action ?? "no next action"}</span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-3 px-4">
              {unknown.length ? (
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="text-muted-foreground">Still unknown:</span>
                  {unknown.map((f) => (
                    <Badge key={f} variant="outline" className="border-warning/40 bg-warning/15 font-mono text-[11px] text-warning">
                      {f}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Every must-field is evidenced; the draft asks for a call.</p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 text-sm">
                <span className="inline-flex items-center gap-2">
                  <Mail className="size-4 text-muted-foreground" />
                  {status.connected ? (
                    <span>Gmail connected{status.email ? ` as ${status.email}` : ""}</span>
                  ) : status.configured ? (
                    <span className="text-muted-foreground">Gmail not connected{status.error ? ` (${status.error})` : ""}</span>
                  ) : (
                    <span className="text-destructive">credentials.json missing (GMAIL_CREDENTIALS_PATH)</span>
                  )}
                </span>
                {!status.connected && status.configured ? (
                  <Button asChild size="sm" variant="outline">
                    <a href="/api/gmail/auth">Connect Gmail</a>
                  </Button>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void generate()} disabled={generating || sending || Boolean(sent)}>
                  {generating ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                  {draftId ? "Regenerate draft" : "Generate draft"}
                </Button>
                {draftMeta ? <span className="max-w-md truncate text-xs text-muted-foreground" title={draftMeta}>{draftMeta}</span> : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="draft-to">Recipient</Label>
                <Input id="draft-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@vendor.com" disabled={Boolean(sent)} />
                <p className="text-xs text-muted-foreground">
                  {allowlist.length
                    ? `Sending is limited to: ${allowlist.join(", ")}`
                    : "DEMO_ALLOWED_RECIPIENTS is empty; add your test inbox to .env.local to enable sending."}
                  {to && !recipientAllowed && allowlist.length ? " This recipient is not allowed." : ""}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="draft-subject">Subject</Label>
                <Input id="draft-subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={Boolean(sent)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="draft-body">Body</Label>
                <Textarea id="draft-body" value={body} onChange={(e) => setBody(e.target.value)} rows={14} className="font-mono text-xs" disabled={Boolean(sent)} />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={() => void send()} disabled={!canSend}>
                  {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
                  Send
                </Button>
                {!status.connected ? <span className="text-xs text-muted-foreground">Connect Gmail to send.</span> : null}
                {status.connected && to && !recipientAllowed ? <span className="text-xs text-muted-foreground">Recipient must be in the allowlist.</span> : null}
              </div>

              {sent ? (
                <div className="rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
                  Sent from {sent.sender || "your Gmail"} · thread <span className="font-mono text-xs">{sent.thread_id}</span>. Vendor is now Contacted.
                  <Button variant="link" size="sm" className="ml-1 h-auto p-0" onClick={onClose}>Close</Button>
                </div>
              ) : null}
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              {draft && !sent ? <p className="text-xs text-muted-foreground">Draft #{draft.interaction_id} · {formatDate(vendor.updated_at)}</p> : null}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
