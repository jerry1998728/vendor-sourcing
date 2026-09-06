import { ExternalLink } from "lucide-react";

import { SourceBadgeChip, badgeForEvidence } from "@/components/badges";
import type { EvidenceRow } from "@/lib/db/schema";
import { formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One evidence row per line: field, value, badge, method and confidence, source link, verbatim snippet. */
export function EvidenceList({ evidence, showIds = false, bordered = true, className }: { evidence: EvidenceRow[]; showIds?: boolean; bordered?: boolean; className?: string }) {
  if (evidence.length === 0) return <p className="p-3 text-sm text-muted-foreground">No evidence rows.</p>;
  return (
    <ul className={cn("flex flex-col divide-y", bordered && "rounded-lg border bg-card", className)}>
      {evidence.map((e) => (
        <li key={e.evidence_id} className="flex flex-col gap-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {showIds ? `#${e.evidence_id} ` : ""}
              {e.field_path}
            </span>
            <span className="font-medium">{e.value ?? <span className="text-muted-foreground">not found</span>}</span>
            <SourceBadgeChip badge={badgeForEvidence(e)} />
            <span className="text-xs text-muted-foreground">
              {e.extraction_method} · {formatPct(e.confidence)}
              {e.attested_by ? ` · attested by ${e.attested_by}` : ""}
            </span>
            {e.source_url ? (
              <a href={e.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                source <ExternalLink className="size-3" />
              </a>
            ) : null}
          </div>
          {e.snippet ? <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground">“{e.snippet}”</blockquote> : null}
        </li>
      ))}
    </ul>
  );
}
