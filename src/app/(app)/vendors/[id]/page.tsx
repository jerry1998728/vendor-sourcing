import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { ScreenResultBadge, SourceBadgeChip, StatusBadge, badgeForEvidence } from "@/components/badges";
import { EvidenceList } from "@/components/vendors/evidence-list";
import { TagList } from "@/components/vendors/tag-list";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { UrlTabs } from "@/components/url-tabs";
import { Thread } from "@/components/vendors/thread";
import { Timeline } from "@/components/vendors/timeline";
import { getDb } from "@/lib/db";
import type { SearchParams } from "@/lib/db/filters";
import { getVendorDetail, listInteractions } from "@/lib/db/queries";
import type { EvidenceRow } from "@/lib/db/schema";
import { formatDate, formatPct } from "@/lib/format";
import { mustFieldsFor } from "@/lib/rulesets/vendor";
import { isDev } from "@/lib/shared/env";
import { singleParam as single } from "@/lib/shared/params";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const detail = getVendorDetail(decodeURIComponent(id));
  return { title: detail ? detail.vendor.name : "Vendor" };
}


/** Kept outside the component so render stays pure (React Compiler rule). */
function isOverdue(due: string | null): boolean {
  return due ? Date.parse(due) < Date.now() : false;
}

function backingEvidence(rows: EvidenceRow[], field: string, value: string): EvidenceRow | undefined {
  return rows.filter((e) => e.verified && e.field_path === field && e.value === value).sort((a, b) => b.confidence - a.confidence)[0];
}

export default async function VendorPage({ params, searchParams }: Props) {
  const { id } = await params;
  const vendorId = decodeURIComponent(id);
  const sp = await searchParams;
  const tabParam = single(sp.tab);
  const tab = tabParam === "evidence" || tabParam === "timeline" || tabParam === "thread" ? tabParam : "attributes";
  const db = getDb();
  const detail = getVendorDetail(vendorId, db);
  if (!detail) notFound();
  const { vendor, evidence, tags, events } = detail;
  const interactions = listInteractions(vendorId, db);
  const must = mustFieldsFor(vendor, db);
  const latestEventId = events.length ? events[events.length - 1].event_id : null;
  const devTools = isDev();
  const overdue = isOverdue(vendor.due_at);

  const attributeRows = Object.entries(vendor.attributes).flatMap(([field, value]) =>
    (Array.isArray(value) ? value : [value]).map((v) => ({ field, value: v, evidence: backingEvidence(evidence, field, v), must: must.some((m) => m.field_path === field) })),
  );
  const unknownMust = must.filter((m) => !attributeRows.some((r) => r.field === m.field_path));

  return (
    <>
      <PageHeader
        title={vendor.name}
        description={`${vendor.vendor_type} · ${vendor.vendor_id}`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={vendor.status} />
        {vendor.diligence_stage ? <Badge variant="secondary">{vendor.diligence_stage}</Badge> : null}
        <ScreenResultBadge result={vendor.screen_result} />
        <Badge variant="outline">coverage {formatPct(vendor.coverage_confidence)}</Badge>
        {vendor.primary_domain ? (
          <a href={`https://${vendor.primary_domain}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:underline">
            {vendor.primary_domain} <ExternalLink className="size-3" />
          </a>
        ) : null}
        <span className="text-muted-foreground">owner {vendor.owner ?? "unassigned"}</span>
        {vendor.next_action ? <span className="text-muted-foreground">next {vendor.next_action}</span> : null}
        {vendor.due_at ? <span className={overdue ? "font-medium text-destructive" : "text-muted-foreground"}>due {formatDate(vendor.due_at)}{overdue ? " · overdue" : ""}</span> : null}
        <Link href={`/database?tab=vendors&q=${encodeURIComponent(vendor.name)}`} className="ml-auto text-muted-foreground underline-offset-2 hover:underline">
          Database
        </Link>
      </div>
      <UrlTabs
        value={tab}
        items={[
          {
            value: "attributes",
            label: "Attributes",
            content: (
              <div className="flex flex-col gap-4">
                {unknownMust.length ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="text-muted-foreground">Unknown must-fields:</span>
                    {unknownMust.map((m) => (
                      <Badge key={m.id} variant="outline" className="border-warning/40 bg-warning/15 font-mono text-[11px] text-warning">{m.field_path}</Badge>
                    ))}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3 rounded-lg border bg-card p-4 text-sm sm:grid-cols-4">
                  <div><div className="text-xs text-muted-foreground">Registration</div>{vendor.registration_country ?? "unknown"}</div>
                  <div><div className="text-xs text-muted-foreground">Ownership</div>{vendor.ownership_country ?? "unknown"}</div>
                  <div><div className="text-xs text-muted-foreground">Collection</div>{vendor.collection_countries.join(", ") || "—"}</div>
                  <div><div className="text-xs text-muted-foreground">Contact</div>{vendor.contact_email ?? "—"}</div>
                </div>
                <ul className="divide-y rounded-lg border bg-card">
                  {attributeRows.map((r) => (
                    <li key={`${r.field}:${r.value}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                      <span className="w-48 font-mono text-xs text-muted-foreground">{r.field}{r.must ? " *" : ""}</span>
                      <span className="font-medium">{r.value}</span>
                      {r.evidence ? <SourceBadgeChip badge={badgeForEvidence(r.evidence)} /> : <SourceBadgeChip badge="unknown" />}
                      {r.evidence?.source_url ? (
                        <a href={r.evidence.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                          source <ExternalLink className="size-3" />
                        </a>
                      ) : null}
                    </li>
                  ))}
                  {attributeRows.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">No verified values yet.</li> : null}
                </ul>
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-semibold">Tags ({tags.length})</h3>
                  <TagList tags={tags} />
                </div>
              </div>
            ),
          },
          {
            value: "evidence",
            label: `Evidence (${evidence.length})`,
            content: <EvidenceList evidence={evidence} showIds />,
          },
          { value: "timeline", label: `Timeline (${events.length})`, content: <Timeline vendorId={vendor.vendor_id} events={events} latestEventId={latestEventId} /> },
          { value: "thread", label: `Thread (${interactions.length})`, content: <Thread vendor={vendor} interactions={interactions} devTools={devTools} /> },
        ]}
      />
    </>
  );
}
