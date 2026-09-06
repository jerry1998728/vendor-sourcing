"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { VendorFilterOptions } from "@/lib/db/filters";
import {
  OWNER_UNASSIGNED,
  SCREEN_RESULTS,
  STALE_DAYS,
  VENDOR_STATUSES,
  applyFiltersToParams,
  countActiveFilters,
  type ScreenResult,
  type VendorFilters as Filters,
  type VendorStatus,
} from "@/lib/shared/vendor-filters";

import type { TagDimension } from "@/lib/pipeline/types";

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  render,
}: {
  label: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  render?: (value: string) => React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          {label}
          {selected.length ? <Badge variant="secondary" className="px-1.5">{selected.length}</Badge> : null}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {options.length === 0 ? <DropdownMenuItem disabled>No values yet</DropdownMenuItem> : null}
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o}
            checked={selected.includes(o)}
            onCheckedChange={(c) => onChange(c ? [...selected, o] : selected.filter((x) => x !== o))}
            onSelect={(e) => e.preventDefault()}
          >
            {render ? render(o) : o}
          </DropdownMenuCheckboxItem>
        ))}
        {selected.length ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange([])}>Clear</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function VendorFilters({
  filters,
  options,
}: {
  filters: Filters;
  options: VendorFilterOptions;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [q, setQ] = React.useState(filters.q ?? "");
  const [countryText, setCountryText] = React.useState(filters.country?.join(",") ?? "");

  const push = React.useCallback(
    (next: Filters) => {
      const params = applyFiltersToParams(next, new URLSearchParams(searchParams.toString()));
      params.set("tab", "vendors");
      params.delete("vendor");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );
  const update = (patch: Partial<Filters>) => push({ ...filters, ...patch });

  // debounce free-text fields
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const trimmed = q.trim();
      if ((filters.q ?? "") !== trimmed) push({ ...filters, q: trimmed || undefined });
    }, 350);
    return () => window.clearTimeout(t);
  }, [q, filters, push]);
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const codes = [...new Set(countryText.split(",").map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
      const current = filters.country ?? [];
      if (codes.join(",") !== current.join(",")) {
        push({ ...filters, country: codes.length ? codes : undefined, country_mode: codes.length ? (filters.country_mode ?? "in") : undefined });
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [countryText, filters, push]);

  const active = countActiveFilters(filters);
  const tagDimensions = Object.keys(options.tags) as TagDimension[];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or domain"
          className="h-8 w-52"
          aria-label="Search"
        />
        <MultiSelect label="Type" options={options.vendor_types} selected={filters.vendor_type ?? []} onChange={(v) => update({ vendor_type: v.length ? v : undefined })} />
        <MultiSelect label="Screen" options={SCREEN_RESULTS} selected={filters.screen_result ?? []} onChange={(v) => update({ screen_result: v.length ? (v as ScreenResult[]) : undefined })} />
        <MultiSelect label="Status" options={VENDOR_STATUSES} selected={filters.status ?? []} onChange={(v) => update({ status: v.length ? (v as VendorStatus[]) : undefined })} />
        <MultiSelect
          label="Owner"
          options={[OWNER_UNASSIGNED, ...options.owners]}
          selected={filters.owner ?? []}
          onChange={(v) => update({ owner: v.length ? v : undefined })}
          render={(o) => (o === OWNER_UNASSIGNED ? <span className="text-muted-foreground">unassigned</span> : o)}
        />
        <MultiSelect label="Source" options={options.source_channels} selected={filters.source_channel ?? []} onChange={(v) => update({ source_channel: v.length ? v : undefined })} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              Tags
              {Object.values(filters.tags ?? {}).filter((v) => v?.length).length ? (
                <Badge variant="secondary" className="px-1.5">
                  {Object.values(filters.tags ?? {}).reduce((n, v) => n + (v?.length ?? 0), 0)}
                </Badge>
              ) : null}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Tag dimensions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {tagDimensions.length === 0 ? <DropdownMenuItem disabled>No tags yet</DropdownMenuItem> : null}
            {tagDimensions.map((d) => {
              const selected = filters.tags?.[d] ?? [];
              return (
                <DropdownMenuSub key={d}>
                  <DropdownMenuSubTrigger>
                    <span className="font-mono text-xs">{d}</span>
                    {selected.length ? <Badge variant="secondary" className="ml-2 px-1.5">{selected.length}</Badge> : null}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                    {options.tags[d].map((v) => (
                      <DropdownMenuCheckboxItem
                        key={v}
                        checked={selected.includes(v)}
                        onCheckedChange={(c) => {
                          const next = c ? [...selected, v] : selected.filter((x) => x !== v);
                          update({ tags: { ...(filters.tags ?? {}), [d]: next.length ? next : undefined } });
                        }}
                        onSelect={(e) => e.preventDefault()}
                      >
                        {v}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        {active > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => { setQ(""); setCountryText(""); push({}); }}>
            <X /> Clear {active}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="country" className="text-xs text-muted-foreground">Country</Label>
          <Select
            value={filters.country_mode ?? "in"}
            onValueChange={(v) => update({ country_mode: v === "not_in" ? "not_in" : "in" })}
          >
            <SelectTrigger className="h-8 w-24" aria-label="Country mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="in">in</SelectItem>
              <SelectItem value="not_in">not in</SelectItem>
            </SelectContent>
          </Select>
          <Input
            id="country"
            value={countryText}
            onChange={(e) => setCountryText(e.target.value)}
            placeholder="DE, FR"
            className="h-8 w-28 font-mono text-xs uppercase"
            list="country-options"
          />
          <datalist id="country-options">
            {options.countries.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-xs text-muted-foreground">Coverage %</Label>
          <Input
            type="number" min={0} max={100} className="h-8 w-16" placeholder="0" aria-label="Coverage min"
            value={filters.coverage_min ?? ""}
            onChange={(e) => update({ coverage_min: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
          <span className="text-muted-foreground">–</span>
          <Input
            type="number" min={0} max={100} className="h-8 w-16" placeholder="100" aria-label="Coverage max"
            value={filters.coverage_max ?? ""}
            onChange={(e) => update({ coverage_max: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Checkbox id="stale" checked={Boolean(filters.stale)} onCheckedChange={(c) => update({ stale: c === true ? true : undefined })} />
          <Label htmlFor="stale" className="text-xs text-muted-foreground">Stale (&gt; {STALE_DAYS}d or never verified)</Label>
        </div>
      </div>
    </div>
  );
}
