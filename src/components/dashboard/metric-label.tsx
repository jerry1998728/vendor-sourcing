"use client";

import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import type { MetricHelp } from "./metric-help";

/** A metric name that explains itself on hover or focus: what it is, then why it matters. */
export function MetricLabel({ label, help }: { label: string; help: MetricHelp }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex cursor-help items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${label}: definition and business impact`}>
          {label}
          <Info aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={6} className="max-w-80 flex-col items-start gap-1.5 py-2 text-left leading-snug">
        <p>
          <span className="font-semibold">What it is.</span> {help.what}
        </p>
        <p>
          <span className="font-semibold">Why it matters.</span> {help.why}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
