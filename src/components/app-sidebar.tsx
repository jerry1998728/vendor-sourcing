"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS, isNavActive, isSectionActive, navHref, type NavItem } from "@/components/nav-items";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";

/** Badge counts keyed by sub-page href (see sidebarCounts in src/lib/db/queries.ts). */
export type SidebarCounts = Partial<Record<string, number>>;

const ACTIVE_CLASS = "data-active:text-primary data-active:hover:text-primary";

/** A section with one sub-page shows that page's count on the section itself. */
function sectionCount(item: NavItem, counts: SidebarCounts): number {
  const children = item.children ?? [];
  if (children.length !== 1) return 0;
  return counts[children[0].href] ?? 0;
}

export function AppSidebar({ counts = {} }: { counts?: SidebarCounts }) {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-2">
          <span
            aria-hidden
            className="size-3 shrink-0 rounded-full bg-primary"
          />
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
            Vendor Sourcing
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Vendor lifecycle</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const active = isSectionActive(pathname, item);
                if (item.planned) {
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        tooltip={item.note ?? "Not in the MVP yet"}
                        aria-disabled
                        className="cursor-default text-muted-foreground/60 hover:bg-transparent hover:text-muted-foreground/60"
                      >
                        <item.icon />
                        <span>{item.title}</span>
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground/60 group-data-[collapsible=icon]:hidden">soon</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                }
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.title}
                      className={ACTIVE_CLASS}
                    >
                      <Link
                        href={navHref(item)}
                        aria-current={active && !item.children ? "page" : undefined}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                        {sectionCount(item, counts) ? (
                          <span className="ml-auto rounded-md bg-sidebar-accent px-1.5 text-[11px] tabular-nums text-sidebar-foreground group-data-[collapsible=icon]:hidden">
                            {sectionCount(item, counts)}
                          </span>
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                    {item.children && item.children.length > 1 ? (
                      <SidebarMenuSub>
                        {item.children.map((child) => {
                          const childActive = isNavActive(pathname, child.href);
                          const n = counts[child.href] ?? 0;
                          return (
                            <SidebarMenuSubItem key={child.href}>
                              <SidebarMenuSubButton asChild isActive={childActive} className={ACTIVE_CLASS}>
                                <Link href={child.href} aria-current={childActive ? "page" : undefined}>
                                  <span className="truncate">{child.title}</span>
                                  {n > 0 ? (
                                    <span className="ml-auto rounded-md bg-sidebar-accent px-1.5 text-[11px] tabular-nums text-sidebar-foreground">
                                      {n}
                                    </span>
                                  ) : null}
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          );
                        })}
                      </SidebarMenuSub>
                    ) : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
