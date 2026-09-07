"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";

import { SCREEN_CLASS } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { VendorFilterOptions } from "@/lib/db/filters";
import type { ScreenResult, Vendor } from "@/lib/db/schema";
import { formatPct } from "@/lib/format";
import type { ConfigSummary } from "@/lib/rulesets/loader";
import { cn } from "@/lib/utils";
import { applyFiltersToParams, type VendorFilters as Filters } from "@/lib/shared/vendor-filters";

import { RunConfigButton } from "./run-config-button";
import { VendorFilters } from "./vendor-filters";
import { VendorSheet } from "./vendor-sheet";
import { VendorsTable } from "./vendors-table";

/** Quick views: each one replaces the filter set (keeping the vendor type) and lives in the URL like any filter. */
const PRESETS: { label: string; filters: Filters }[] = [
  { label: "Needs outreach", filters: { screen_result: ["unknown"], status: ["Screened", "Qualified"] } },
  { label: "Ready to contact", filters: { status: ["Qualified"] } },
  { label: "In pipeline", filters: { status: ["Contacted", "Replied", "In Discussion"] } },
  { label: "Failed screen", filters: { screen_result: ["fail"] } },
  { label: "Stale", filters: { stale: true } },
];

function canonical(f: Filters): string {
  const entries = Object.entries(f)
    .filter(([k, v]) => k !== "vendor_type" && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

export function VendorsTab({
  vendors,
  total,
  filters,
  options,
  configs,
  defaultConfig,
}: {
  vendors: Vendor[];
  total: number;
  filters: Filters;
  options: VendorFilterOptions;
  configs: ConfigSummary[];
  defaultConfig: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = React.useState<string | null>(null);
  const exportHref = `/api/export?${searchParams.toString()}`;
  const vendorType = filters.vendor_type?.length === 1 ? filters.vendor_type[0] : undefined;

  const push = (next: Filters) => {
    const params = applyFiltersToParams(next, new URLSearchParams());
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const current = canonical(filters);

  const summary = React.useMemo(() => {
    const counts: Record<ScreenResult, number> = { pass: 0, unknown: 0, fail: 0 };
    let sum = 0;
    let n = 0;
    for (const v of vendors) {
      if (v.screen_result) counts[v.screen_result] += 1;
      if (v.coverage_confidence !== null) {
        sum += v.coverage_confidence;
        n += 1;
      }
    }
    return { ...counts, coverage: n ? sum / n : null };
  }, [vendors]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Views</span>
            {PRESETS.map((p) => {
              const active = canonical(p.filters) === current;
              return (
                <Button
                  key={p.label}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => push(active ? { vendor_type: filters.vendor_type } : { vendor_type: filters.vendor_type, ...p.filters })}
                >
                  {p.label}
                </Button>
              );
            })}
          </div>
          <VendorFilters filters={filters} options={options} />
        </div>
        <RunConfigButton configs={configs} defaultConfig={defaultConfig} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="mr-1">{vendors.length === total ? `${total} vendors` : `${vendors.length} of ${total} vendors`}</span>
          {(["pass", "unknown", "fail"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={cn("rounded-md border px-2 py-0.5 text-xs tabular-nums transition-colors hover:brightness-110", SCREEN_CLASS[r], filters.screen_result?.length === 1 && filters.screen_result[0] === r && "ring-1 ring-ring")}
              onClick={() => push({ ...filters, screen_result: filters.screen_result?.length === 1 && filters.screen_result[0] === r ? undefined : [r] })}
              title={`Show only ${r}`}
            >
              {summary[r]} {r}
            </button>
          ))}
          <Badge variant="outline">coverage {formatPct(summary.coverage)}</Badge>
          {vendorType ? <span className="text-xs text-muted-foreground">· {vendorType} columns shown</span> : null}
        </div>
        <Button asChild size="sm" variant="outline">
          <a href={exportHref} download>
            <Download /> Export CSV{vendors.length !== total ? " (filtered)" : ""}
          </a>
        </Button>
      </div>

      <VendorsTable vendors={vendors} vendorType={vendorType} onSelect={setSelected} />
      <VendorSheet vendorId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
