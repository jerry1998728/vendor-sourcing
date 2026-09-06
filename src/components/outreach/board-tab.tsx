"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { ScreenResultBadge } from "@/components/badges";
import { MultiSelect } from "@/components/database/vendor-filters";
import { VendorSheet } from "@/components/database/vendor-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { VendorFilterOptions } from "@/lib/db/filters";
import { OWNER_UNASSIGNED, VENDOR_STATUSES, type VendorFilters, type VendorStatus } from "@/lib/vendor-filters";
import type { Vendor } from "@/lib/db/schema";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

function BoardCard({ vendor, now, onClick }: { vendor: Vendor; now: number; onClick: () => void }) {
  const overdue = vendor.due_at ? Date.parse(vendor.due_at) < now : false;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-1 rounded-lg border bg-card p-3 text-left text-sm shadow-xs transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium leading-tight">{vendor.name}</span>
        <ScreenResultBadge result={vendor.screen_result} className="shrink-0 px-1.5 py-0 text-[10px]" />
      </div>
      <span className="truncate text-xs text-muted-foreground">{vendor.primary_domain ?? vendor.vendor_id}</span>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <span className="text-muted-foreground">{vendor.owner ?? "unassigned"}</span>
        {vendor.next_action ? <span>{vendor.next_action}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {vendor.due_at ? (
          <span className={cn("font-mono", overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
            due {formatDate(vendor.due_at)}
            {overdue ? " · overdue" : ""}
          </span>
        ) : null}
        {vendor.status === "In Discussion" && vendor.diligence_stage ? (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{vendor.diligence_stage}</Badge>
        ) : null}
      </div>
    </button>
  );
}

export function BoardTab({
  vendors,
  options,
  filters,
}: {
  vendors: Vendor[];
  options: VendorFilterOptions;
  filters: Pick<VendorFilters, "owner" | "vendor_type">;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = React.useState<string | null>(null);
  // Captured once per mount so render stays pure; the page re-renders on every navigation anyway.
  const [now] = React.useState(() => Date.now());

  const setList = (key: "owner" | "vendor_type", values: string[]) => {
    const params = new URLSearchParams(searchParams.toString());
    if (values.length) params.set(key, values.join(","));
    else params.delete(key);
    params.set("tab", "board");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const active = (filters.owner?.length ?? 0) + (filters.vendor_type?.length ?? 0);

  const byStatus = new Map<VendorStatus, Vendor[]>();
  for (const s of VENDOR_STATUSES) byStatus.set(s, []);
  for (const v of vendors) byStatus.get(v.status)?.push(v);
  for (const list of byStatus.values()) {
    list.sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9") || a.name.localeCompare(b.name));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelect
          label="Owner"
          options={[OWNER_UNASSIGNED, ...options.owners]}
          selected={filters.owner ?? []}
          onChange={(v) => setList("owner", v)}
          render={(o) => (o === OWNER_UNASSIGNED ? <span className="text-muted-foreground">unassigned</span> : o)}
        />
        <MultiSelect label="Type" options={options.vendor_types} selected={filters.vendor_type ?? []} onChange={(v) => setList("vendor_type", v)} />
        {active ? (
          <Button variant="ghost" size="sm" onClick={() => { setList("owner", []); setList("vendor_type", []); }}>
            <X /> Clear
          </Button>
        ) : null}
        <span className="ml-auto text-sm text-muted-foreground">{vendors.length} vendors</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {VENDOR_STATUSES.map((status) => {
          const list = byStatus.get(status) ?? [];
          return (
            <section key={status} className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-muted/40 p-2">
              <header className="flex items-center justify-between px-1">
                <h3 className="text-sm font-semibold">{status}</h3>
                <Badge variant="secondary">{list.length}</Badge>
              </header>
              <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
                {list.map((v) => (
                  <BoardCard key={v.vendor_id} vendor={v} now={now} onClick={() => setSelected(v.vendor_id)} />
                ))}
                {list.length === 0 ? <p className="px-1 py-2 text-xs text-muted-foreground">Empty</p> : null}
              </div>
            </section>
          );
        })}
      </div>
      <VendorSheet vendorId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
