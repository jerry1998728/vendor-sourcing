"use client";

/**
 * The two things a Vendor Source page needs occasionally, not while working:
 * the refresh schedules and the run history. Each is an icon in the page
 * header carrying its own summary, opening a panel.
 */
import * as React from "react";
import { CalendarClock, History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ScheduleWithRun } from "@/lib/db/queries";
import { runStatus } from "@/lib/shared/run-status";
import type { Run } from "@/lib/db/schema";
import type { ConfigSummary } from "@/lib/rulesets/loader";
import { cn } from "@/lib/utils";

import { RunsList } from "./runs-list";
import { ScheduleCard } from "./schedule-card";

function ToolButton({
  label,
  summary,
  icon: Icon,
  dot,
  onClick,
}: {
  label: string;
  summary: string;
  icon: typeof History;
  dot?: "active" | "on";
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="relative gap-1.5 font-normal" onClick={onClick} aria-label={`${label}: ${summary}`}>
          <Icon />
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground">· {summary}</span>
          {dot ? (
            <span
              aria-hidden
              className={cn("absolute -right-1 -top-1 size-2 rounded-full", dot === "active" ? "animate-pulse bg-primary" : "bg-success")}
            />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        Open {label.toLowerCase()}
      </TooltipContent>
    </Tooltip>
  );
}

export function SourceTools({ configs, runs, schedules }: { configs: ConfigSummary[]; runs: Run[]; schedules: ScheduleWithRun[] }) {
  const [open, setOpen] = React.useState<"schedules" | "runs" | null>(null);
  const running = runs.filter((r) => runStatus(r) === "running").length;
  const enabled = schedules.filter((s) => s.enabled).length;
  const validConfigs = configs.filter((c) => c.valid);

  return (
    <>
      <ToolButton
        label="Schedules"
        summary={enabled ? `${enabled} enabled` : "none enabled"}
        icon={CalendarClock}
        dot={enabled ? "on" : undefined}
        onClick={() => setOpen("schedules")}
      />
      <ToolButton
        label="Runs"
        summary={running ? `${running} running` : `${runs.length} recorded`}
        icon={History}
        dot={running ? "active" : undefined}
        onClick={() => setOpen("runs")}
      />

      <Sheet open={open === "schedules"} onOpenChange={(o) => setOpen(o ? "schedules" : null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
          <SheetHeader className="border-b">
            <SheetTitle>Scheduled refresh</SheetTitle>
          </SheetHeader>
          <div className="p-4">
            <ScheduleCard configs={configs} schedules={schedules} flush />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={open === "runs"} onOpenChange={(o) => setOpen(o ? "runs" : null)}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-4xl">
          <SheetHeader className="border-b">
            <SheetTitle>Runs</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-xs text-muted-foreground">
              {validConfigs.length} configs on disk: {validConfigs.map((c) => c.name).join(", ")}
            </p>
            <RunsList runs={runs} flush />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
