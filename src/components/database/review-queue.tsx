"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";

import { ScreenResultBadge } from "@/components/badges";
import { EvidenceList } from "@/components/vendors/evidence-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { VendorDetail } from "@/lib/db/queries";
import type { Vendor } from "@/lib/db/schema";
import { formatPct } from "@/lib/format";
import { postJson } from "@/lib/shared/http";

export type QueueItem = Pick<Vendor, "vendor_id" | "name" | "vendor_type" | "screen_result" | "coverage_confidence">;
export type { MustField } from "@/lib/rulesets/vendor";
import type { MustField } from "@/lib/rulesets/vendor";

export const REJECT_REASONS: { code: string; label: string }[] = [
  { code: "not_a_vendor", label: "Not a vendor (aggregator, tool, unrelated)" },
  { code: "no_stereo_rig", label: "No stereo rig" },
  { code: "china_registration", label: "Registered in China" },
  { code: "china_ownership", label: "Owned from China" },
  { code: "out_of_scope", label: "Out of scope for this category" },
  { code: "duplicate", label: "Duplicate of an existing vendor" },
  { code: "inactive", label: "Inactive or defunct" },
  { code: "other", label: "Other (explain in note)" },
];

export type ReReviewItem = { vendor_id: string; name: string; status: string; screen_result: string | null };

function ReReviewList({ items }: { items: ReReviewItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const dismiss = async (vendorId: string) => {
    setBusy(vendorId);
    setError(null);
    try {
      await postJson(`/api/vendors/${encodeURIComponent(vendorId)}/next-action`, { next_action: "review" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      <p className="mb-2 font-medium">Re-review: screen result changed on refresh ({items.length})</p>
      {error ? <p className="mb-2 text-destructive">{error}</p> : null}
      <ul className="flex flex-col gap-1">
        {items.map((v) => (
          <li key={v.vendor_id} className="flex flex-wrap items-center gap-2">
            <Link href={`/vendors/${encodeURIComponent(v.vendor_id)}?tab=timeline`} className="font-medium underline-offset-2 hover:underline">{v.name}</Link>
            <span className="text-muted-foreground">{v.status}</span>
            <ScreenResultBadge result={(v.screen_result as "pass" | "fail" | "unknown" | null) ?? null} />
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void dismiss(v.vendor_id)} disabled={busy !== null}>
              Dismiss
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReviewQueue({
  queue,
  current,
  mustFields,
  reReview = [],
}: {
  queue: QueueItem[];
  current: VendorDetail | null;
  mustFields: MustField[];
  reReview?: ReReviewItem[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectCode, setRejectCode] = React.useState<string>("");
  const [rejectNote, setRejectNote] = React.useState("");

  const index = current ? queue.findIndex((q) => q.vendor_id === current.vendor.vendor_id) : -1;
  const hrefFor = (vendorId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (vendorId) params.set("vendor", vendorId);
    else params.delete("vendor");
    return `${pathname}?${params.toString()}`;
  };

  const act = async (label: string, body: Record<string, unknown>) => {
    if (!current) return;
    setBusy(label);
    setError(null);
    try {
      await postJson(`/api/vendors/${encodeURIComponent(current.vendor.vendor_id)}/transition`, body);
      setRejectOpen(false);
      setRejectCode("");
      setRejectNote("");
      const next = queue.find((q, i) => i > index) ?? queue.find((q, i) => i < index) ?? null;
      router.replace(hrefFor(next && next.vendor_id !== current.vendor.vendor_id ? next.vendor_id : null), { scroll: false });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!current) {
    return (
      <div className="flex flex-col gap-4">
        <ReReviewList items={reReview} />
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          Nothing to review. Vendors land here after screening.
        </div>
      </div>
    );
  }

  const { vendor, evidence } = current;
  const attributes = vendor.attributes;
  const valueOf = (fp: string) => {
    const v = attributes[fp];
    if (v === undefined) return null;
    return Array.isArray(v) ? v.join(", ") : v;
  };
  const mustRows = mustFields
    .map((m) => ({ ...m, value: valueOf(m.field_path), reason: vendor.screen_reasons.find((r) => r.rule_id === m.id) }))
    .sort((a, b) => Number(a.value !== null) - Number(b.value !== null));
  const otherAttributes = Object.entries(attributes).filter(([k]) => !mustFields.some((m) => m.field_path === k));
  const prev = index > 0 ? queue[index - 1] : null;
  const next = index >= 0 && index < queue.length - 1 ? queue[index + 1] : null;

  return (
    <div className="flex flex-col gap-4">
      <ReReviewList items={reReview} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            {index >= 0 ? index + 1 : "?"} of {queue.length} · sorted by coverage
          </span>
          <Button variant="outline" size="sm" asChild disabled={!prev}>
            <Link href={hrefFor(prev?.vendor_id ?? null)} aria-disabled={!prev} className={!prev ? "pointer-events-none opacity-50" : ""}>
              <ChevronLeft /> Prev
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={hrefFor(next?.vendor_id ?? null)} aria-disabled={!next} className={!next ? "pointer-events-none opacity-50" : ""}>
              Next <ChevronRight />
            </Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void act("qualify", { to_status: "Qualified", reason: "review: qualified" })} disabled={busy !== null}>
            Qualify
          </Button>
          <Button
            variant="secondary"
            onClick={() => void act("need_info", { to_status: "Qualified", reason: "review: need info", next_action: "outreach_to_verify" })}
            disabled={busy !== null}
          >
            Need info
          </Button>
          <Button variant="destructive" onClick={() => setRejectOpen(true)} disabled={busy !== null}>
            Reject
          </Button>
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{vendor.name}</h2>
          <ScreenResultBadge result={vendor.screen_result} />
          <Badge variant="outline">{vendor.vendor_type}</Badge>
          <Badge variant="outline">coverage {formatPct(vendor.coverage_confidence)}</Badge>
          {vendor.primary_domain ? (
            <a href={`https://${vendor.primary_domain}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:underline">
              {vendor.primary_domain} <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
        {vendor.next_action ? <p className="mt-1 text-sm text-muted-foreground">next action: {vendor.next_action}</p> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <section className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold">Must-fields</h3>
            <ul className="flex flex-col gap-2">
              {mustRows.map((m) => (
                <li key={m.id} className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{m.field_path}</span>
                    {m.value !== null ? (
                      <span className="text-sm font-medium">{m.value}</span>
                    ) : (
                      <Badge variant="outline" className="border-warning/40 bg-warning/15 text-warning">unknown</Badge>
                    )}
                    {m.reason ? <ScreenResultBadge result={m.reason.outcome} className="px-1.5 py-0 text-[10px]" /> : null}
                  </div>
                  <span className="text-xs text-muted-foreground">{m.reason?.detail ?? m.description}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-lg border bg-card p-4">
            <h3 className="mb-2 text-sm font-semibold">Other verified attributes</h3>
            {otherAttributes.length ? (
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5">
                {otherAttributes.map(([k, v]) => (
                  <div key={k} className="flex flex-col">
                    <dt className="font-mono text-xs text-muted-foreground">{k}</dt>
                    <dd className="text-sm">{Array.isArray(v) ? v.join(", ") : v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
          </section>
        </div>
        <section className="rounded-lg border bg-card p-4">
          <h3 className="mb-2 text-sm font-semibold">Evidence ({evidence.length})</h3>
          <EvidenceList evidence={evidence} bordered={false} />
        </section>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject {vendor.name}</DialogTitle>
            <DialogDescription>A reason is required; it is written to the event log.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reject-reason">Reason</Label>
              <Select value={rejectCode} onValueChange={setRejectCode}>
                <SelectTrigger id="reject-reason" aria-label="Reject reason">
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {REJECT_REASONS.map((r) => (
                    <SelectItem key={r.code} value={r.code}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reject-note">Note (optional)</Label>
              <Textarea id="reject-note" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!rejectCode || busy !== null}
              onClick={() => void act("reject", { to_status: "Rejected", reason: rejectNote.trim() ? `${rejectCode}: ${rejectNote.trim()}` : rejectCode })}
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
