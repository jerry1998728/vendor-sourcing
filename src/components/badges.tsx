import { Badge } from "@/components/ui/badge";
import type { ScreenResult, SourceBadge, VendorStatus } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

/* Status colors live only on badges (docs/THEME.md). */
const SCREEN_CLASS: Record<ScreenResult, string> = {
  pass: "border-success/40 bg-success/15 text-success",
  unknown: "border-warning/40 bg-warning/15 text-warning",
  fail: "border-destructive/40 bg-destructive/15 text-destructive",
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
