import { Database, LayoutDashboard, Send, type LucideIcon } from "lucide-react";

export type NavChild = { title: string; href: string };

export type NavItem = {
  title: string;
  /** Section root. A section with children redirects to its first child. */
  href: string;
  icon: LucideIcon;
  children?: readonly NavChild[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    title: "Database",
    href: "/database",
    icon: Database,
    children: [
      { title: "Vendor Source", href: "/database/sources" },
      { title: "Vendor Data", href: "/database/vendors" },
      { title: "Review Queue", href: "/database/review" },
    ],
  },
  {
    title: "Outreach",
    href: "/outreach",
    icon: Send,
    children: [
      { title: "Board", href: "/outreach/board" },
      { title: "Draft & Send", href: "/outreach/draft" },
      { title: "Proposals", href: "/outreach/proposals" },
    ],
  },
];

export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The link a section opens: its first sub-page when it has any. */
export function navHref(item: NavItem): string {
  return item.children?.[0]?.href ?? item.href;
}

/** Section and sub-page for a pathname, for the header breadcrumb. */
export function navTrail(pathname: string): { section?: NavItem; child?: NavChild } {
  const section = NAV_ITEMS.find((item) => isNavActive(pathname, item.href));
  const child = section?.children?.find((c) => isNavActive(pathname, c.href));
  return { section, child };
}
