"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Mail } from "lucide-react";

import { ScreenResultBadge, StatusBadge } from "@/components/badges";
import { DataTable, SortableHeader } from "@/components/data-table";
import { ToolPopover } from "@/components/tool-popover";
import { Badge } from "@/components/ui/badge";
import { isFollowUpDraft } from "@/lib/shared/drafts";
import { Button } from "@/components/ui/button";
import type { InteractionRow, Vendor } from "@/lib/db/schema";
import { formatDate, formatPct } from "@/lib/format";

import { unknownMustFields } from "@/lib/shared/must-fields";

import { DraftSheet, type GmailState } from "./draft-sheet";

type Row = Vendor & { draft?: InteractionRow };

const columns: ColumnDef<Row>[] = [
  {
    accessorKey: "name",
    enableHiding: false,
    meta: { label: "Name" },
    header: ({ column }) => <SortableHeader column={column}>Vendor</SortableHeader>,
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium">{row.original.name}</span>
        <span className="text-xs text-muted-foreground">{row.original.primary_domain ?? row.original.vendor_id}</span>
      </div>
    ),
  },
  {
    accessorKey: "status",
    meta: { label: "Status" },
    header: ({ column }) => <SortableHeader column={column}>Status</SortableHeader>,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "vendor_type",
    meta: { label: "Type" },
    header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
    cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span>,
  },
  {
    accessorKey: "screen_result",
    meta: { label: "Screen" },
    header: ({ column }) => <SortableHeader column={column}>Screen</SortableHeader>,
    cell: ({ row }) => <ScreenResultBadge result={row.original.screen_result} />,
  },
  {
    accessorKey: "coverage_confidence",
    meta: { label: "Coverage" },
    header: ({ column }) => <SortableHeader column={column}>Coverage</SortableHeader>,
    cell: ({ getValue }) => <span className="tabular-nums">{formatPct(getValue<number | null>())}</span>,
    sortUndefined: "last",
  },
  {
    id: "unknown",
    meta: { label: "Still unknown" },
    header: "Still unknown",
    cell: ({ row }) => {
      const u = unknownMustFields(row.original);
      return u.length ? (
        <div className="flex flex-wrap gap-1">
          {u.map((f) => (
            <Badge key={f} variant="outline" className="border-warning/40 bg-warning/15 font-mono text-[10px] text-warning">{f}</Badge>
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">none</span>
      );
    },
  },
  {
    accessorKey: "contact_email",
    meta: { label: "Contact" },
    header: "Contact",
    cell: ({ getValue }) => <span className="text-xs">{getValue<string | null>() ?? <span className="text-muted-foreground">unknown</span>}</span>,
  },
  {
    id: "draft",
    meta: { label: "Draft" },
    header: "Draft",
    cell: ({ row }) =>
      row.original.draft ? (
        <Badge variant="secondary">{isFollowUpDraft(row.original.draft) ? "follow-up" : "draft"} #{row.original.draft.interaction_id}</Badge>
      ) : (
        <span className="text-xs text-muted-foreground">none</span>
      ),
  },
  {
    accessorKey: "next_action",
    meta: { label: "Next action" },
    header: ({ column }) => <SortableHeader column={column}>Next action</SortableHeader>,
    cell: ({ getValue }) => <span className="text-xs">{getValue<string | null>() ?? "—"}</span>,
  },
  {
    accessorKey: "updated_at",
    meta: { label: "Updated" },
    header: ({ column }) => <SortableHeader column={column}>Updated</SortableHeader>,
    cell: ({ getValue }) => <span className="font-mono text-xs">{formatDate(getValue<string>())}</span>,
  },
];

export function DraftSendTab({
  vendors,
  drafts,
  gmail,
  allowlist,
  notice,
}: {
  vendors: Vendor[];
  drafts: Record<string, InteractionRow>;
  gmail: GmailState;
  allowlist: string[];
  notice: string | null;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const rows: Row[] = vendors.map((v) => ({ ...v, draft: drafts[v.vendor_id] }));
  const selected = rows.find((r) => r.vendor_id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm">
          <span className="font-medium">{vendors.length}</span>{" "}
          <span className="text-muted-foreground">ready for outreach · click a row to draft and send</span>
        </p>
        <ToolPopover
          label="Sending"
          summary={`${gmail.connected ? "Gmail connected" : gmail.configured ? "not connected" : "no credentials"} · ${allowlist.length} allowed`}
          icon={Mail}
        >
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-col gap-1">
              <span className="font-medium">Gmail</span>
              {gmail.connected ? (
                <span className="text-muted-foreground">Connected. Sends go out from the connected account and land in its Sent folder.</span>
              ) : gmail.configured ? (
                <>
                  <span className="text-muted-foreground">Not connected yet.</span>
                  <Button asChild size="sm" variant="outline" className="self-start">
                    <a href="/api/gmail/auth">Connect Gmail</a>
                  </Button>
                </>
              ) : (
                <span className="text-destructive">credentials.json is missing; see the README setup section.</span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-medium">Allowed recipients</span>
              {allowlist.length ? (
                <ul className="flex flex-col gap-0.5 font-mono text-xs text-muted-foreground">
                  {allowlist.map((a) => <li key={a}>{a}</li>)}
                </ul>
              ) : (
                <span className="text-warning">DEMO_ALLOWED_RECIPIENTS is empty, so every send is rejected server-side. Add your test inbox to .env.local and restart.</span>
              )}
            </div>
          </div>
        </ToolPopover>
      </div>
      {notice ? <p className="rounded-lg border bg-card px-3 py-2 text-sm">{notice}</p> : null}
      <DataTable
        columns={columns}
        data={rows}
        rowKey={(r) => r.vendor_id}
        onRowClick={(r) => setSelectedId(r.vendor_id)}
        initialSorting={[{ id: "coverage_confidence", desc: true }]}
        emptyMessage="No Qualified vendors. Qualify vendors in the Database Review Queue first."
      />
      <DraftSheet vendor={selected} draft={selected?.draft} gmail={gmail} allowlist={allowlist} onClose={() => setSelectedId(null)} />
    </div>
  );
}
