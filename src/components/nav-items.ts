import { Database, LayoutDashboard, Send, type LucideIcon } from "lucide-react";

export type NavItem = {
  title: string;
  href: "/dashboard" | "/database" | "/outreach";
  description: string;
  icon: LucideIcon;
};

export const NAV_ITEMS: readonly NavItem[] = [
  {
    title: "Dashboard",
    href: "/dashboard",
    description: "Funnel, coverage, unknown rate, active pipeline and backlog.",
    icon: LayoutDashboard,
  },
  {
    title: "Database",
    href: "/database",
    description: "Vendors, review queue and inputs.",
    icon: Database,
  },
  {
    title: "Outreach",
    href: "/outreach",
    description: "Board, draft & send, proposals.",
    icon: Send,
  },
];

export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
