import { SourceBadgeChip } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import type { TagRow } from "@/lib/db/schema";

/** Tags grouped by dimension, each value with its source badge. */
export function TagList({ tags }: { tags: TagRow[] }) {
  if (tags.length === 0) return <p className="text-sm text-muted-foreground">No tags.</p>;
  const byDimension = new Map<string, TagRow[]>();
  for (const t of tags) (byDimension.get(t.dimension) ?? byDimension.set(t.dimension, []).get(t.dimension)!).push(t);
  return (
    <div className="flex flex-col gap-1.5">
      {[...byDimension.entries()].map(([dimension, list]) => (
        <div key={dimension} className="flex flex-wrap items-center gap-1.5">
          <span className="w-36 shrink-0 font-mono text-xs text-muted-foreground">{dimension}</span>
          {list.map((t) => (
            <span key={t.tag_id} className="inline-flex items-center gap-1">
              <Badge variant="secondary">{t.value}</Badge>
              <SourceBadgeChip badge={t.source_badge} className="px-1.5 py-0 text-[10px]" />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
