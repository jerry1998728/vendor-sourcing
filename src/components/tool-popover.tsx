"use client";

import * as React from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A small tool (filters, a run form) behind a button whose label carries its
 * current state, so the page stays short without hiding what is set.
 */
export function ToolPopover({
  label,
  summary,
  icon: Icon,
  align = "end",
  className,
  contentClassName,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  summary?: string;
  icon?: LucideIcon;
  align?: "start" | "center" | "end";
  className?: string;
  contentClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={cn("gap-1.5 font-normal", className)}>
          {Icon ? <Icon /> : null}
          <span className="font-medium">{label}</span>
          {summary ? <span className="text-muted-foreground">· {summary}</span> : null}
          <ChevronDown aria-hidden className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className={cn("w-80", contentClassName)}>
        {children}
      </PopoverContent>
    </Popover>
  );
}
