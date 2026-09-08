"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Secondary detail folded behind one row that summarises it. The summary is
 * the point: it must say what is inside (the current values, a count), so a
 * closed section still answers the question a glance would have asked.
 */
export function DetailsToggle({
  label,
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  label: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("rounded-lg border bg-card/40", className)}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="font-medium">{label}</span>
        {summary ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-data-[state=open]:hidden">{summary}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}
