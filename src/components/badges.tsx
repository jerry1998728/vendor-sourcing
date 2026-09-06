import { Badge } from "@/components/ui/badge";
import type { ScreenResult, SourceBadge, VendorStatus } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

/* Status colors live only on badges (docs/THEME.md). */
/** Tinted outline badges; every coloured status chip in the app derives from these four. */
export const TONE_CLASS = {
  success: "border-success/40 bg-success/15 text-success",
  warning: "border-warning/40 bg-warning/15 text-warning",
  destructive: "border-destructive/40 bg-destructive/15 text-destructive",
  muted: "border-border text-muted-foreground",
} as const;

export const SCREEN_CLASS: Record<ScreenResult, string> = {
  pass: TONE_CLASS.success,
  unknown: TONE_CLASS.warning,
  fail: TONE_CLASS.destructive,
};

export function ScreenResultBadge({
  result,
  className,
}: {
  result: ScreenResult | null | undefined;
  className?: string;
}) {
  if (!result) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={cn("capitalize", SCREEN_CLASS[result], className)}>
      {result}
    </Badge>
  );
}

export function StatusBadge({ status, className }: { status: VendorStatus; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("whitespace-nowrap", className)}>
      {status}
    </Badge>
  );
}

const SOURCE_CLASS: Record<SourceBadge, string> = {
  verified: "border-success/40 bg-success/15 text-success",
  proxy: "border-border bg-muted text-foreground",
  manual: "border-border text-muted-foreground",
  unknown: "border-warning/40 bg-warning/15 text-warning",
};

export function SourceBadgeChip({ badge, className }: { badge: SourceBadge; className?: string }) {
  return (
    <Badge variant="outline" className={cn(SOURCE_CLASS[badge], className)}>
      {badge}
    </Badge>
  );
}

export function badgeForEvidence(e: {
  verified: boolean;
  proxy: boolean;
  extraction_method: string;
}): SourceBadge {
  if (!e.verified) return "unknown";
  if (e.extraction_method === "manual") return "manual";
  return e.proxy ? "proxy" : "verified";
}
