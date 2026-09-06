import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { HeaderTitle } from "@/components/header-title";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getDb } from "@/lib/db";
import { sidebarCounts } from "@/lib/db/queries";

export default function AppLayout({ children }: { children: ReactNode }) {
  // Sub-page badges (review queue, sendable drafts, pending proposals). Every
  // page is dynamic and every action calls router.refresh(), so these stay
  // current except across a pure client-side link click.
  const counts = sidebarCounts(getDb());
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar counts={counts} />
        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-[orientation=vertical]:h-4"
            />
            <HeaderTitle />
          </header>
          <div className="flex flex-1 flex-col gap-6 p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
