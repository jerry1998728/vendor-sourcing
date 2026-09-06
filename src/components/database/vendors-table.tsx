"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";

import { SCREEN_CLASS, StatusBadge } from "@/components/badges";
import { ColumnVisibilityMenu, DataTable, SortableHeader } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import type { Vendor } from "@/lib/db/schema";
import { formatDate, formatPct, shortRunId } from "@/lib/format";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Must-field chips: the "why" behind pass / unknown / fail, one chip per rule
// ---------------------------------------------------------------------------

const MUST_LABEL: Record<string, string> = {
  sensor_rig: "rig",
  registration_country: "reg",
  ownership_country: "owner",
  merged_prs_public: "PRs",
  production_signals: "prod",
  last_commit_days: "commit",
  is_fork_or_tutorial: "fork",
  offers_code_data: "code data",
  inventory_private_repos: "private",
  license_provenance: "provenance",
};


const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

function formatObserved(field: string, observed: string[] | undefined): string {
  const v = observed?.[0];
  if (v === undefined) return "?";
  if (/_country$/.test(field)) return v.toUpperCase();
  if (field === "is_fork_or_tutorial") return v === "true" ? "yes" : "no";
  if (field === "last_commit_days") return `${v}d`;
  if (/^\d+(\.\d+)?$/.test(v)) return compact.format(Number(v));
  return v;
}

function MustChips({ vendor }: { vendor: Vendor }) {
  const musts = vendor.screen_reasons.filter((r) => r.kind === "must");
  if (musts.length === 0) return <span className="text-xs text-muted-foreground">not screened</span>;
  return (
    <div className="flex min-w-60 flex-wrap gap-1">
      {musts.map((r) => (
        <span
          key={r.field_path}
          title={r.detail}
          className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 font-mono text-[10px] leading-4", SCREEN_CLASS[r.outcome])}
        >
          <span className="opacity-70">{MUST_LABEL[r.field_path] ?? r.field_path.replace(/_/g, " ")}</span>
          <span className="font-medium">{r.outcome === "unknown" ? "?" : formatObserved(r.field_path, r.observed)}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Type-aware columns, read from verified attributes only
// ---------------------------------------------------------------------------

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);

function Chips({ values, max = 3 }: { values: string[]; max?: number }) {
  if (values.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {values.slice(0, max).map((v) => (
        <Badge key={v} variant="secondary" className="px-1.5 py-0 text-[10px]">
          {v}
        </Badge>
      ))}
      {values.length > max ? <span className="text-[10px] text-muted-foreground">+{values.length - max}</span> : null}
    </div>
  );
}

const EGO_COLUMNS: ColumnDef<Vendor>[] = [
  { id: "sensor_rig", meta: { label: "Rig" }, header: "Rig", cell: ({ row }) => <Chips values={list(row.original.attributes.sensor_rig)} /> },
  { id: "scene_class", meta: { label: "Scenes" }, header: "Scenes", cell: ({ row }) => <Chips values={list(row.original.attributes.scene_class)} max={4} /> },
  { id: "collection_countries", meta: { label: "Collected in" }, header: "Collected in", cell: ({ row }) => <Chips values={row.original.collection_countries} max={5} /> },
];

const CODE_COLUMNS: ColumnDef<Vendor>[] = [
  { id: "code_language", meta: { label: "Languages" }, header: "Languages", cell: ({ row }) => <Chips values={list(row.original.attributes.code_language)} /> },
  {
    id: "merged_prs_public",
    meta: { label: "Merged PRs" },
    header: ({ column }) => <SortableHeader column={column}>Merged PRs</SortableHeader>,
    accessorFn: (v) => Math.max(0, ...list(v.attributes.merged_prs_public).map(Number).filter(Number.isFinite)),
    cell: ({ getValue }) => {
      const n = getValue<number>();
      return <span className="text-xs tabular-nums">{n ? compact.format(n) : "—"}</span>;
    },
  },
  { id: "code_license", meta: { label: "License" }, header: "License", cell: ({ row }) => <Chips values={list(row.original.attributes.code_license)} /> },
];

const TYPE_COLUMNS: Record<string, ColumnDef<Vendor>[]> = { ego_data: EGO_COLUMNS, code_data: CODE_COLUMNS };

// ---------------------------------------------------------------------------
// Base columns
// ---------------------------------------------------------------------------

const BASE_COLUMNS: ColumnDef<Vendor>[] = [
  {
    accessorKey: "name",
    enableHiding: false,
    meta: { label: "Name" },
    header: ({ column }) => <SortableHeader column={column}>Name</SortableHeader>,
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium">{row.original.name}</span>
        <span className="text-xs text-muted-foreground">{row.original.primary_domain ?? row.original.vendor_id}</span>
      </div>
    ),
  },
  {
    accessorKey: "vendor_type",
    meta: { label: "Type" },
    header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
    cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span>,
  },
  {
    accessorKey: "screen_result",
    meta: { label: "Screening" },
    header: ({ column }) => <SortableHeader column={column}>Screening</SortableHeader>,
    cell: ({ row }) => <MustChips vendor={row.original} />,
  },
  {
    accessorKey: "status",
    meta: { label: "Status" },
    header: ({ column }) => <SortableHeader column={column}>Status</SortableHeader>,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "coverage_confidence",
    meta: { label: "Coverage" },
    header: ({ column }) => <SortableHeader column={column}>Coverage</SortableHeader>,
    cell: ({ getValue }) => <span className="tabular-nums">{formatPct(getValue<number | null>())}</span>,
    sortUndefined: "last",
  },
  {
    accessorKey: "registration_country",
    meta: { label: "Country" },
    header: ({ column }) => <SortableHeader column={column}>Country</SortableHeader>,
    cell: ({ row }) => (
      <span className="font-mono text-xs">
        {row.original.registration_country ?? "?"}
        {row.original.ownership_country && row.original.ownership_country !== row.original.registration_country
          ? ` (owner ${row.original.ownership_country})`
          : ""}
      </span>
    ),
  },
  {
    accessorKey: "owner",
    meta: { label: "Owner" },
    header: ({ column }) => <SortableHeader column={column}>Owner</SortableHeader>,
    cell: ({ getValue }) => <span className="text-xs">{getValue<string | null>() ?? "—"}</span>,
  },
  {
    accessorKey: "next_action",
    meta: { label: "Next action" },
    header: ({ column }) => <SortableHeader column={column}>Next action</SortableHeader>,
    cell: ({ getValue }) => <span className="text-xs">{getValue<string | null>() ?? "—"}</span>,
  },
  {
    accessorKey: "last_verified_at",
    meta: { label: "Last verified" },
    header: ({ column }) => <SortableHeader column={column}>Last verified</SortableHeader>,
    cell: ({ getValue }) => <span className="font-mono text-xs">{formatDate(getValue<string | null>())}</span>,
  },
  {
    accessorKey: "first_seen_run_id",
    meta: { label: "Run" },
    header: ({ column }) => <SortableHeader column={column}>Run</SortableHeader>,
    cell: ({ getValue }) => <span className="font-mono text-xs">{shortRunId(getValue<string | null>())}</span>,
  },
];

/** Type-specific columns slot in after Coverage when the table is filtered to one vendor type. */
function columnsFor(vendorType: string | undefined): ColumnDef<Vendor>[] {
  const extra = vendorType ? (TYPE_COLUMNS[vendorType] ?? []) : [];
  if (extra.length === 0) return BASE_COLUMNS;
  const at = BASE_COLUMNS.findIndex((c) => "accessorKey" in c && c.accessorKey === "coverage_confidence") + 1;
  return [...BASE_COLUMNS.slice(0, at), ...extra, ...BASE_COLUMNS.slice(at)];
}

export function VendorsTable({
  vendors,
  vendorType,
  onSelect,
}: {
  vendors: Vendor[];
  /** set when the type filter selects exactly one type */
  vendorType?: string;
  onSelect: (vendorId: string) => void;
}) {
  const columns = React.useMemo(() => columnsFor(vendorType), [vendorType]);
  return (
    <DataTable
      columns={columns}
      data={vendors}
      rowKey={(v) => v.vendor_id}
      onRowClick={(v) => onSelect(v.vendor_id)}
      initialSorting={[{ id: "coverage_confidence", desc: true }]}
      emptyMessage="No vendors match. Adjust the filters or run a config."
      toolbar={(table) => <ColumnVisibilityMenu table={table} />}
    />
  );
}
