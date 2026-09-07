"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS, isNavActive, navHref } from "@/components/nav-items";
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
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const active = isNavActive(pathname, item.href);
                return (
                  <SidebarMenuItem key={item.href}>
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
                      </Link>
                    </SidebarMenuButton>
                    {item.children ? (
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
