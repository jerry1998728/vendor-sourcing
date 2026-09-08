/**
 * The sidebar follows the vendor management lifecycle: find them, decide who
 * is worth pursuing, evaluate the ones you contacted, then manage the
 * relationship. The later stages of the lifecycle are listed as placeholders
 * so the gap is visible rather than implied.
 */
import { ClipboardCheck, FileSignature, LayoutDashboard, RefreshCcw, Search, Send, Users, type LucideIcon } from "lucide-react";

export type NavChild = { title: string; href: string };

export type NavItem = {
  title: string;
  /** Section root. A section with children opens its first child; a planned stage has none. */
  href?: string;
  icon: LucideIcon;
  children?: readonly NavChild[];
  /** A lifecycle stage the MVP does not cover yet: shown, not clickable. */
  planned?: boolean;
  /** One line explaining a planned stage. */
  note?: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    title: "Discover",
    href: "/database",
    icon: Search,
    children: [
      { title: "Vendor Source", href: "/database/sources" },
      { title: "Vendor Data", href: "/database/vendors" },
    ],
  },
  {
    title: "Select",
    href: "/database/review",
    icon: ClipboardCheck,
    children: [{ title: "Review Queue", href: "/database/review" }],
  },
  {
    title: "Evaluate",
    href: "/outreach",
    icon: Send,
    children: [
      { title: "Draft & Send", href: "/outreach/draft" },
      { title: "Proposals", href: "/outreach/proposals" },
    ],
  },
  {
    title: "Manage",
    href: "/outreach/board",
    icon: Users,
    children: [{ title: "Board", href: "/outreach/board" }],
  },
  {
    title: "Contract & Onboard",
    icon: FileSignature,
    planned: true,
    note: "Contract terms, service levels and onboarding tasks. Not in the MVP: Approved is where the pipeline ends today.",
  },
  {
    title: "Renew or Exit",
    icon: RefreshCcw,
    planned: true,
    note: "Performance against the contract, renewal dates and offboarding. Not in the MVP.",
  },
];

/** A section is active when the page belongs to it: exact match, a sub-page, or a nested route. */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isSectionActive(pathname: string, item: NavItem): boolean {
  if (item.planned || !item.href) return false;
  if (item.children?.length) return item.children.some((c) => isNavActive(pathname, c.href));
  return isNavActive(pathname, item.href);
}

/** The link a section opens: its first sub-page when it has any. Planned stages have no page. */
export function navHref(item: NavItem): string {
  return item.children?.[0]?.href ?? item.href ?? "#";
}

/** Section and sub-page for a pathname, for the header breadcrumb. */
export function navTrail(pathname: string): { section?: NavItem; child?: NavChild } {
  const section = NAV_ITEMS.find((item) => isSectionActive(pathname, item));
  const child = section?.children?.find((c) => isNavActive(pathname, c.href));
  return { section, child };
}
