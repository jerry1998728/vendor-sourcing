import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/lib/db";
import { backlog, coverageByType, funnel, pipeline, secondary } from "@/lib/db/metrics";
import { formatDate, formatPct } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

function Metric({ title, description, value, href, children }: { title: string; description: string; value: string; href: string; children?: React.ReactNode }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardDescription>{description}</CardDescription>
        <CardTitle className="flex items-baseline justify-between gap-2">
          <span>{title}</span>
          <Link href={href} className="inline-flex items-center gap-1 text-3xl font-semibold tabular-nums underline-offset-4 hover:underline" aria-label={`${title}: ${value}`}>
            {value}
            <ArrowUpRight className="size-4 text-muted-foreground" />
          </Link>
        </CardTitle>
      </CardHeader>
      {children ? <CardContent className="text-sm">{children}</CardContent> : null}
    </Card>
  );
}

function Row({ label, value, href }: { label: string; value: string | number; href: string }) {
  return (
    <li className="flex items-center justify-between gap-2 py-1">
      <Link href={href} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{label}</Link>
      <Link href={href} className="font-medium tabular-nums underline-offset-2 hover:underline">{value}</Link>
    </li>
  );
}

const db = "/database?tab=vendors";

export default function DashboardPage() {
  const conn = getDb();
  const f = funnel(conn);
  const coverage = coverageByType(conn);
  const pipe = pipeline(conn);
  const back = backlog(conn);
  const sec = secondary(conn);
  const screened = f.pass + f.unknown + f.fail;
  const unknownRate = screened ? f.unknown / screened : null;
  const status = (s: string) => `${db}&status=${encodeURIComponent(s)}`;

  return (
    <>
      <PageHeader title="Dashboard" description="Five primary numbers; every one opens the view behind it." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Metric title="Sourcing funnel" description="discovered → screened → qualified → contacted → in discussion → approved" value={String(f.discovered)} href={db}>
          <ul className="divide-y">
            <Row label="pass" value={f.pass} href={`${db}&screen_result=pass`} />
            <Row label="unknown" value={f.unknown} href={`${db}&screen_result=unknown`} />
            <Row label="fail" value={f.fail} href={`${db}&screen_result=fail`} />
            <Row label="Qualified" value={f.byStatus.Qualified ?? 0} href={status("Qualified")} />
            <Row label="Contacted" value={f.byStatus.Contacted ?? 0} href={status("Contacted")} />
            <Row label="In Discussion" value={f.byStatus["In Discussion"] ?? 0} href={status("In Discussion")} />
            <Row label="Approved" value={f.byStatus.Approved ?? 0} href={status("Approved")} />
          </ul>
        </Metric>
        <Metric
          title="Must-field coverage"
          description="mean coverage confidence by vendor type"
          value={formatPct(coverage.length ? coverage.reduce((a, c) => a + (c.coverage ?? 0) * c.vendors, 0) / Math.max(1, coverage.reduce((a, c) => a + c.vendors, 0)) : null)}
          href={db}
        >
          <ul className="divide-y">
            {coverage.map((c) => (
              <Row key={c.vendor_type} label={`${c.vendor_type} (${c.vendors})`} value={formatPct(c.coverage)} href={`${db}&vendor_type=${c.vendor_type}`} />
            ))}
          </ul>
        </Metric>
        <Metric title="Unknown rate" description="screened vendors with an unknown must-field, never optimised to zero" value={formatPct(unknownRate)} href={`${db}&screen_result=unknown`}>
          <p className="text-muted-foreground">{f.unknown} of {screened} screened vendors need outreach to verify a must-field.</p>
        </Metric>
        <Metric title="Active pipeline" description="contacted + in discussion, with reply rate" value={String(pipe.contacted + pipe.in_discussion)} href="/outreach?tab=board">
          <ul className="divide-y">
            <Row label="Contacted" value={pipe.contacted} href="/outreach?tab=board" />
            <Row label="In Discussion" value={pipe.in_discussion} href="/outreach?tab=board" />
            <Row label={`reply rate (${pipe.ever_replied} of ${pipe.ever_contacted} contacted)`} value={formatPct(pipe.reply_rate)} href="/outreach?tab=board" />
          </ul>
        </Metric>
        <Metric title="Work backlog" description="review queue + proposals + overdue next actions" value={String(back.review_queue + back.proposals + back.overdue)} href="/database?tab=review">
          <ul className="divide-y">
            <Row label="Review queue" value={back.review_queue} href="/database?tab=review" />
            <Row label="Proposals" value={back.proposals} href="/outreach?tab=proposals" />
            <Row label="Overdue next action" value={back.overdue} href="/outreach?tab=board" />
          </ul>
        </Metric>
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold text-muted-foreground">Secondary</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="gap-2">
          <CardHeader><CardTitle className="text-base">By source channel</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <ul className="divide-y">
              {sec.by_source.map((s) => <Row key={s.source} label={s.source} value={s.n} href={`${db}&source_channel=${encodeURIComponent(s.source)}`} />)}
            </ul>
          </CardContent>
        </Card>
        <Card className="gap-2">
          <CardHeader><CardTitle className="text-base">Freshness</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <ul className="divide-y">
              <Row label="stale vendors (30d)" value={sec.stale} href={`${db}&stale=1`} />
              <Row label="median time to first reply" value={sec.median_hours_to_first_reply === null ? "—" : sec.median_hours_to_first_reply < 48 ? `${sec.median_hours_to_first_reply.toFixed(1)} h` : `${(sec.median_hours_to_first_reply / 24).toFixed(1)} d`} href="/outreach?tab=board" />
            </ul>
          </CardContent>
        </Card>
        <Card className="gap-2">
          <CardHeader><CardTitle className="text-base">Last run</CardTitle></CardHeader>
          <CardContent className="text-sm">
            {sec.last_run ? (
              <ul className="divide-y">
                <Row label={String(sec.last_run.query.config ?? sec.last_run.adapter)} value={formatDate(sec.last_run.finished_at)} href="/database?tab=inputs" />
                <Row label="discovered / pass / unknown / fail" value={`${sec.last_run.counts.discovered ?? 0} / ${sec.last_run.counts.pass ?? 0} / ${sec.last_run.counts.unknown ?? 0} / ${sec.last_run.counts.fail ?? 0}`} href="/database?tab=inputs" />
                <Row label="must-field coverage" value={formatPct(sec.last_run.counts.must_field_coverage)} href="/database?tab=inputs" />
              </ul>
            ) : (
              <p className="text-muted-foreground">No finished run yet.</p>
            )}
          </CardContent>
        </Card>
        <Card className="gap-2">
          <CardHeader><CardTitle className="text-base">Vendors by country</CardTitle></CardHeader>
          <CardContent className="text-sm">
            <ul className="divide-y">
              {sec.by_country.map((c) => <Row key={c.country} label={c.country} value={c.n} href={`${db}&country=${c.country}`} />)}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
