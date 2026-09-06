"use client";

/**
 * Dashboard visualizations (recharts through shadcn's ChartContainer). Every
 * chart is a link: clicking a bar or slice opens the filtered view behind it.
 *
 * Colour rule from docs/THEME.md: one accent plus the four grays. The accent
 * marks the series that matters; everything else is gray. The one deliberate
 * exception is pass / unknown / fail, drawn in the same three status colours
 * the badges use, because a screening outcome in any other colour would
 * contradict every badge on the page.
 *
 * Animation is off: charts paint their final state on first render, so a
 * background tab or a screenshot never shows a half-grown bar.
 */
import { useRouter } from "next/navigation";
import { Bar, BarChart, Cell, Label, LabelList, Pie, PieChart, PolarRadiusAxis, RadialBar, RadialBarChart, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { CoverageByType, FunnelStep, RunPoint } from "@/lib/db/metrics";
import { formatPct, shortRunId } from "@/lib/format";

const GRAYS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const SCREEN_COLOR = { pass: "var(--success)", unknown: "var(--warning)", fail: "var(--destructive)" } as const;

function useOpen() {
  const router = useRouter();
  return (href: string) => router.push(href);
}

// ---------------------------------------------------------------------------
// Sourcing funnel
// ---------------------------------------------------------------------------

const funnelConfig = { reached: { label: "Reached", color: "var(--primary)" } } satisfies ChartConfig;

/** Server components cannot pass functions to client components, so every clickable datum carries its href. */
export function FunnelChart({ steps }: { steps: (FunnelStep & { href: string })[] }) {
  const open = useOpen();
  return (
    <ChartContainer config={funnelConfig} className="h-64 w-full">
      <BarChart accessibilityLayer data={steps} layout="vertical" margin={{ left: 8, right: 40 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="status" width={110} tickLine={false} axisLine={false} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel formatter={(value, _name, item) => <span className="flex w-full justify-between gap-4"><span className="text-muted-foreground">{String(item.payload.status)}</span><span className="font-mono tabular-nums">{Number(value)} reached · {Number(item.payload.current)} there now</span></span>} />}
        />
        <Bar dataKey="reached" fill="var(--color-reached)" radius={4} isAnimationActive={false} className="cursor-pointer" onClick={(_, index) => open(steps[index].href)}>
          <LabelList dataKey="reached" position="right" className="fill-foreground text-xs tabular-nums" />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ---------------------------------------------------------------------------
// Screening outcome
// ---------------------------------------------------------------------------

const screenConfig = {
  pass: { label: "Pass", color: SCREEN_COLOR.pass },
  unknown: { label: "Unknown", color: SCREEN_COLOR.unknown },
  fail: { label: "Fail", color: SCREEN_COLOR.fail },
} satisfies ChartConfig;

export function ScreeningDonut({ pass, unknown, fail, hrefBase }: { pass: number; unknown: number; fail: number; hrefBase: string }) {
  const open = useOpen();
  const data = [
    { result: "pass", value: pass, fill: "var(--color-pass)" },
    { result: "unknown", value: unknown, fill: "var(--color-unknown)" },
    { result: "fail", value: fail, fill: "var(--color-fail)" },
  ];
  const screened = pass + unknown + fail;
  if (screened === 0) return <p className="flex h-64 items-center justify-center text-sm text-muted-foreground">No screened vendors yet.</p>;
  return (
    <ChartContainer config={screenConfig} className="mx-auto h-64 w-full">
      <PieChart accessibilityLayer>
        <ChartTooltip cursor={false} content={<ChartTooltipContent nameKey="result" hideLabel />} />
        <Pie data={data} dataKey="value" nameKey="result" innerRadius={62} outerRadius={92} strokeWidth={2} paddingAngle={2} isAnimationActive={false} className="cursor-pointer" onClick={(_, index) => open(`${hrefBase}${data[index].result}`)}>
          <Label
            content={({ viewBox }) => {
              if (!viewBox || !("cx" in viewBox) || !("cy" in viewBox)) return null;
              const cx = Number(viewBox.cx);
              const cy = Number(viewBox.cy);
              return (
                <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                  <tspan x={cx} y={cy - 6} className="fill-foreground text-2xl font-semibold tabular-nums">{formatPct(unknown / screened)}</tspan>
                  <tspan x={cx} y={cy + 16} className="fill-muted-foreground text-xs">unknown rate</tspan>
                </text>
              );
            }}
          />
        </Pie>
        <ChartLegend content={<ChartLegendContent nameKey="result" />} />
      </PieChart>
    </ChartContainer>
  );
}

// ---------------------------------------------------------------------------
// Must-field coverage by vendor type
// ---------------------------------------------------------------------------

const coverageConfig = { coverage: { label: "Coverage", color: "var(--primary)" } } satisfies ChartConfig;

export function CoverageChart({ rows }: { rows: (CoverageByType & { href: string })[] }) {
  const open = useOpen();
  const data = rows.map((r) => ({ vendor_type: r.vendor_type, vendors: r.vendors, coverage: Math.round((r.coverage ?? 0) * 100), href: r.href }));
  return (
    <ChartContainer config={coverageConfig} className="h-64 w-full">
      <BarChart accessibilityLayer data={data} margin={{ top: 20 }}>
        <XAxis dataKey="vendor_type" tickLine={false} axisLine={false} />
        <YAxis domain={[0, 100]} hide />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent hideLabel formatter={(value, _name, item) => <span className="flex w-full justify-between gap-4"><span className="text-muted-foreground">{String(item.payload.vendor_type)}</span><span className="font-mono tabular-nums">{Number(value)}% · {Number(item.payload.vendors)} vendors</span></span>} />}
        />
        <Bar dataKey="coverage" fill="var(--color-coverage)" radius={4} isAnimationActive={false} maxBarSize={72} className="cursor-pointer" onClick={(_, index) => open(data[index].href)}>
          <LabelList dataKey="coverage" position="top" formatter={(v: unknown) => `${Number(v)}%`} className="fill-foreground text-xs tabular-nums" />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ---------------------------------------------------------------------------
// Reply rate
// ---------------------------------------------------------------------------

const replyConfig = { rate: { label: "Reply rate", color: "var(--primary)" } } satisfies ChartConfig;

export function ReplyRateRadial({ rate, replied, contacted, caption }: { rate: number | null; replied: number; contacted: number; caption?: string }) {
  const pct = Math.round((rate ?? 0) * 100);
  return (
    <ChartContainer config={replyConfig} className="mx-auto h-64 w-full">
      <RadialBarChart data={[{ name: "rate", rate: pct, fill: "var(--color-rate)" }]} startAngle={90} endAngle={90 - 360 * (pct / 100)} innerRadius={78} outerRadius={104}>
        <RadialBar dataKey="rate" background cornerRadius={8} isAnimationActive={false} />
        <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
          <Label
            content={({ viewBox }) => {
              if (!viewBox || !("cx" in viewBox) || !("cy" in viewBox)) return null;
              const cx = Number(viewBox.cx);
              const cy = Number(viewBox.cy);
              return (
                <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
                  <tspan x={cx} y={cy - 8} className="fill-foreground text-2xl font-semibold tabular-nums">{rate === null ? "—" : `${pct}%`}</tspan>
                  <tspan x={cx} y={cy + 14} className="fill-muted-foreground text-xs">{replied} of {contacted} contacted</tspan>
                  {caption ? <tspan x={cx} y={cy + 30} className="fill-muted-foreground text-xs">{caption}</tspan> : null}
                </text>
              );
            }}
          />
        </PolarRadiusAxis>
      </RadialBarChart>
    </ChartContainer>
  );
}

// ---------------------------------------------------------------------------
// Horizontal category bars: backlog, source channel, country
// ---------------------------------------------------------------------------

export type CategoryRow = { label: string; value: number; href: string };


export function CategoryChart({ rows, accentFirst = false, valueLabel = "Vendors", height = "h-56" }: { rows: CategoryRow[]; accentFirst?: boolean; valueLabel?: string; height?: string }) {
  const open = useOpen();
  if (rows.length === 0) return <p className={`flex ${height} items-center justify-center text-sm text-muted-foreground`}>Nothing yet.</p>;
  const config = { value: { label: valueLabel, color: "var(--chart-2)" } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className={`${height} w-full`}>
      <BarChart accessibilityLayer data={rows} layout="vertical" margin={{ left: 8, right: 40 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="label" width={110} tickLine={false} axisLine={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="value" radius={4} maxBarSize={22} isAnimationActive={false} className="cursor-pointer" onClick={(_, index) => open(rows[index].href)}>
          {rows.map((row, i) => (
            <Cell key={row.label} fill={accentFirst && i === 0 ? "var(--primary)" : GRAYS[Math.min(i, GRAYS.length - 2)]} />
          ))}
          <LabelList dataKey="value" position="right" className="fill-foreground text-xs tabular-nums" />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}


// ---------------------------------------------------------------------------
// Discovery runs: pass / unknown / fail per run
// ---------------------------------------------------------------------------

const runsConfig = {
  pass: { label: "Pass", color: SCREEN_COLOR.pass },
  unknown: { label: "Unknown", color: SCREEN_COLOR.unknown },
  fail: { label: "Fail", color: SCREEN_COLOR.fail },
} satisfies ChartConfig;

export function RunsChart({ runs }: { runs: RunPoint[] }) {
  if (runs.length === 0) return <p className="flex h-64 items-center justify-center text-sm text-muted-foreground">No finished run yet.</p>;
  const data = runs.map((r) => ({ ...r, id: shortRunId(r.run_id).slice(0, 15) }));
  return (
    <ChartContainer config={runsConfig} className="h-64 w-full">
      <BarChart accessibilityLayer data={data} margin={{ top: 8 }}>
        <XAxis dataKey="id" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} angle={-20} height={40} textAnchor="end" />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(_label, payload) => { const p = payload?.[0]?.payload as RunPoint | undefined; return p ? `${p.config} · ${p.discovered} discovered · coverage ${formatPct(p.coverage)}` : null; }} />}
        />
        <Bar dataKey="pass" stackId="a" fill="var(--color-pass)" maxBarSize={40} isAnimationActive={false} />
        <Bar dataKey="unknown" stackId="a" fill="var(--color-unknown)" maxBarSize={40} isAnimationActive={false} />
        <Bar dataKey="fail" stackId="a" fill="var(--color-fail)" radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  );
}
