import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { CategoryChart, CoverageChart, FunnelChart, ReplyRateRadial, RunsChart, ScreeningDonut } from "@/components/dashboard/charts";
import { METRIC_HELP, type MetricId } from "@/components/dashboard/metric-help";
import { MetricLabel } from "@/components/dashboard/metric-label";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/lib/db";
import { backlog, coverageByType, funnel, funnelReached, pipeline, runHistory, secondary } from "@/lib/db/metrics";
import { formatDate, formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const VENDORS = "/database/vendors";

/** A primary number: the name explains itself on hover, the value opens the view behind it. */
function Kpi({ id, label, value, href, sub }: { id: MetricId; label: string; value: string; href: string; sub?: string }) {
  return (
    <Card className="h-full gap-1 py-4">
      <CardHeader className="gap-1">
        <CardDescription>
          <MetricLabel label={label} help={METRIC_HELP[id]} />
        </CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums">
          <Link href={href} className="inline-flex items-center gap-1 underline-offset-4 hover:underline" aria-label={`${label}: ${value}. Open the view behind it`}>
            {value}
            <ArrowUpRight className="size-4 text-muted-foreground" />
          </Link>
        </CardTitle>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </CardHeader>
    </Card>
  );
}

function ChartCard({ id, title, className, children }: { id: MetricId; title: string; className?: string; children: React.ReactNode }) {
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle className="text-base">
          <MetricLabel label={title} help={METRIC_HELP[id]} />
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function formatHours(h: number | null): string {
  if (h === null) return "—";
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
}

export default function DashboardPage() {
  const db = getDb();
  const f = funnel(db);
  const steps = funnelReached(db);
  const coverage = coverageByType(db);
  const pipe = pipeline(db);
  const back = backlog(db);
  const sec = secondary(db);
  const runs = runHistory(10, db);
  const screened = f.pass + f.unknown + f.fail;
  const unknownRate = screened ? f.unknown / screened : null;
  const meanCoverage = coverage.length ? coverage.reduce((a, c) => a + (c.coverage ?? 0) * c.vendors, 0) / Math.max(1, coverage.reduce((a, c) => a + c.vendors, 0)) : null;
  const status = (s: string) => `${VENDORS}?status=${encodeURIComponent(s)}`;
  const lastRun = sec.last_run;

  return (
    <>
      <PageHeader title="Dashboard" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Kpi id="vendors" label="Vendors" value={String(f.discovered)} href={VENDORS} />
        <Kpi id="coverage" label="Must-field coverage" value={formatPct(meanCoverage)} href={VENDORS} />
        <Kpi id="unknown_rate" label="Unknown rate" value={formatPct(unknownRate)} href={`${VENDORS}?screen_result=unknown`} sub={`${f.unknown} of ${screened} screened`} />
        <Kpi id="pipeline" label="Active pipeline" value={String(pipe.contacted + pipe.in_discussion)} href="/outreach/board" sub={`${pipe.contacted} contacted · ${pipe.in_discussion} in discussion`} />
        <Kpi id="backlog" label="Work backlog" value={String(back.review_queue + back.proposals + back.overdue)} href="/database/review" sub={`${back.review_queue} to review · ${back.proposals} proposals · ${back.overdue} overdue`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard id="funnel" title="Sourcing funnel" className="xl:col-span-2">
          <FunnelChart steps={steps.map((s) => ({ ...s, href: s.status === "Identified" ? VENDORS : status(s.status) }))} />
        </ChartCard>
        <ChartCard id="screening" title="Screening outcome">
          <ScreeningDonut pass={f.pass} unknown={f.unknown} fail={f.fail} hrefBase={`${VENDORS}?screen_result=`} />
        </ChartCard>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ChartCard id="coverage_by_type" title="Must-field coverage by vendor type">
          <CoverageChart rows={coverage.map((c) => ({ ...c, href: `${VENDORS}?vendor_type=${encodeURIComponent(c.vendor_type)}` }))} />
        </ChartCard>
        <ChartCard id="reply_rate" title="Reply rate">
          <ReplyRateRadial rate={pipe.reply_rate} replied={pipe.ever_replied} contacted={pipe.ever_contacted} caption={sec.median_hours_to_first_reply === null ? undefined : `median first reply ${formatHours(sec.median_hours_to_first_reply)}`} />
        </ChartCard>
        <ChartCard id="backlog_chart" title="Work backlog">
          <CategoryChart
            rows={[
              { label: "Review queue", value: back.review_queue, href: "/database/review" },
              { label: "Proposals", value: back.proposals, href: "/outreach/proposals" },
              { label: "Overdue", value: back.overdue, href: "/outreach/board" },
              { label: "Stale (30d)", value: sec.stale, href: `${VENDORS}?stale=1` },
            ]}
            accentFirst
            valueLabel="Items"
            height="h-64"
          />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard id="runs" title="Discovery runs" className="xl:col-span-2">
          <RunsChart runs={runs} />
          {lastRun ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Last run{" "}
              <Link href="/database/sources" className="underline-offset-2 hover:underline">
                {String(lastRun.query.config ?? lastRun.adapter)}
              </Link>{" "}
              · {formatDate(lastRun.finished_at)} · {lastRun.counts.discovered ?? 0} discovered · coverage {formatPct(lastRun.counts.must_field_coverage)}
            </p>
          ) : null}
        </ChartCard>
        <ChartCard id="source" title="Vendors by source">
          <CategoryChart rows={sec.by_source.map((s) => ({ label: s.source, value: s.n, href: `${VENDORS}?source_channel=${encodeURIComponent(s.source)}` }))} height="h-64" />
        </ChartCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard id="country" title="Vendors by country" className="xl:col-span-2">
          <CategoryChart rows={sec.by_country.map((c) => ({ label: c.country, value: c.n, href: `${VENDORS}?country=${encodeURIComponent(c.country)}` }))} height="h-64" />
        </ChartCard>
      </div>
    </>
  );
}
