import type { ReactNode } from "react";

import { HelpLabel } from "@/components/help-label";

/**
 * Page title, its explanation on hover, and the page's tools on the right.
 * `description` is for data about the thing on screen (a vendor's type and
 * id); anything that explains the page belongs in `help`.
 */
export function PageHeader({
  title,
  description,
  help,
  actions,
}: {
  title: string;
  description?: string;
  help?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {help ? <HelpLabel help={help}>{title}</HelpLabel> : title}
        </h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
