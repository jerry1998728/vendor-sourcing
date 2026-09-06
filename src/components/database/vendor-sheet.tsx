"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { ScreenResultBadge, StatusBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { EvidenceList } from "@/components/vendors/evidence-list";
import { TagList } from "@/components/vendors/tag-list";
import type { VendorDetail } from "@/lib/db/queries";
import { formatDate, formatPct, shortRunId } from "@/lib/format";

export function VendorSheet({
  vendorId,
  onClose,
}: {
  vendorId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = React.useState<VendorDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/vendors/${encodeURIComponent(vendorId)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`GET /api/vendors/${vendorId} failed (${res.status})`);
        const data = (await res.json()) as VendorDetail;
        if (!cancelled) {
          setDetail(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  const open = vendorId !== null;
  const showing = detail && detail.vendor.vendor_id === vendorId ? detail : null;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        {showing ? (
          <VendorDetailView detail={showing} />
        ) : (
          <SheetHeader>
            <SheetTitle>{vendorId ?? ""}</SheetTitle>
            <SheetDescription>{error ?? "Loading vendor…"}</SheetDescription>
            {!error ? (
              <div className="mt-4 flex flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : null}
          </SheetHeader>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function VendorDetailView({ detail }: { detail: VendorDetail }) {
  const { vendor, evidence, tags, events } = detail;
  const attributes = Object.entries(vendor.attributes);
  const mustReasons = vendor.screen_reasons.filter((r) => r.kind === "must");
  const shouldReasons = vendor.screen_reasons.filter((r) => r.kind === "should");

  return (
    <div className="flex flex-col gap-6 pb-8">
      <SheetHeader className="gap-2">
        <SheetTitle className="flex flex-wrap items-center gap-2">
          {vendor.name}
          <ScreenResultBadge result={vendor.screen_result} />
          <StatusBadge status={vendor.status} />
        </SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-2">
          {vendor.primary_domain ? (
            <a
              href={`https://${vendor.primary_domain}/`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              {vendor.primary_domain}
              <ExternalLink className="size-3" />
            </a>
          ) : null}
          <span>· {vendor.vendor_type}</span>
          <span className="font-mono text-xs">· {vendor.vendor_id}</span>
          <Link href={`/vendors/${encodeURIComponent(vendor.vendor_id)}`} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
            Open page <ExternalLink className="size-3" />
          </Link>
        </SheetDescription>
      </SheetHeader>

      <div className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-3">
        <Field label="Coverage confidence">{formatPct(vendor.coverage_confidence)}</Field>
        <Field label="Next action">{vendor.next_action ?? "—"}</Field>
        <Field label="Owner">{vendor.owner ?? "—"}</Field>
        <Field label="Registration country">{vendor.registration_country ?? "unknown"}</Field>
        <Field label="Ownership country">{vendor.ownership_country ?? "unknown"}</Field>
        <Field label="Parent entity">{vendor.parent_entity ?? "—"}</Field>
        <Field label="Collection countries">
          {vendor.collection_countries.length ? vendor.collection_countries.join(", ") : "—"}
        </Field>
        <Field label="Contact">{vendor.contact_email ?? "—"}</Field>
        <Field label="First seen run">
          <span className="font-mono text-xs">{shortRunId(vendor.first_seen_run_id)}</span>
        </Field>
        <Field label="Last verified">{formatDate(vendor.last_verified_at)}</Field>
        <Field label="Discovered">{formatDate(vendor.discovered_at)}</Field>
        <Field label="Updated">{formatDate(vendor.updated_at)}</Field>
      </div>

      <div className="px-4">
        <Section title="Screening">
          <ul className="flex flex-col gap-1.5">
            {mustReasons.map((r) => (
              <li key={r.rule_id} className="flex items-start gap-2 text-sm">
                <ScreenResultBadge result={r.outcome} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-medium">{r.rule_id}</span>
                  <span className="text-muted-foreground"> · {r.detail}</span>
                </span>
              </li>
            ))}
            {shouldReasons.map((r) => (
              <li key={r.rule_id} className="flex items-start gap-2 text-sm">
                <Badge variant="outline" className="mt-0.5 shrink-0 text-muted-foreground">
                  should · {r.outcome}
                </Badge>
                <span>
                  <span className="font-medium">{r.rule_id}</span>
                  <span className="text-muted-foreground"> · {r.detail}</span>
                </span>
              </li>
            ))}
            {vendor.screen_reasons.length === 0 ? (
              <li className="text-sm text-muted-foreground">Not screened yet.</li>
            ) : null}
          </ul>
        </Section>
      </div>

      <div className="px-4">
        <Section title="Attributes (verified values only)">
          {attributes.length ? (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {attributes.map(([k, v]) => (
                <div key={k} className="flex flex-col">
                  <dt className="font-mono text-xs text-muted-foreground">{k}</dt>
                  <dd className="text-sm">{Array.isArray(v) ? v.join(", ") : v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No verified values yet.</p>
          )}
        </Section>
      </div>

      <div className="px-4">
        <Section title={`Evidence (${evidence.length})`}>
          <EvidenceList evidence={evidence} />
        </Section>
      </div>

      <div className="px-4">
        <Section title={`Tags (${tags.length})`}>
          <TagList tags={tags} />
        </Section>
      </div>

      <div className="px-4">
        <Section title="Timeline">
          <ol className="flex flex-col gap-1.5">
            {events.map((ev) => (
              <li key={ev.event_id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{formatDate(ev.created_at)}</span>
                <span>
                  {ev.from_status ?? "—"} → <span className="font-medium">{ev.to_status}</span>
                  {ev.to_stage ? <span className="text-muted-foreground"> / {ev.to_stage}</span> : null}
                </span>
                <Badge variant="outline">{ev.actor}</Badge>
                <span className="text-muted-foreground">{ev.reason}</span>
              </li>
            ))}
            {events.length === 0 ? <li className="text-sm text-muted-foreground">No events.</li> : null}
          </ol>
        </Section>
      </div>
    </div>
  );
}
