"use client";

import type { ReactNode } from "react";
import { Info } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A label that explains itself on hover or focus. Explanations belong here
 * rather than in a grey paragraph under the title: the page shows the work,
 * the tooltip answers "what is this and why does it matter".
 */
export function HelpLabel({
  children,
  help,
  label,
  className,
  side = "bottom",
}: {
  children: ReactNode;
  help: ReactNode;
  /** Screen-reader name; defaults to the visible text when that is a plain string. */
  label?: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  const name = label ?? (typeof children === "string" ? children : undefined);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn("inline-flex cursor-help items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
          aria-label={name ? `${name}: what this is` : undefined}
        >
          {children}
          <Info aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} align="start" sideOffset={6} className="max-w-80 flex-col items-start gap-1.5 py-2 text-left leading-snug">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}
