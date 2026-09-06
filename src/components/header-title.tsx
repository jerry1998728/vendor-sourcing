"use client";

import { usePathname } from "next/navigation";

import { NAV_ITEMS, isNavActive } from "@/components/nav-items";

export function HeaderTitle() {
  const pathname = usePathname();
  const current = NAV_ITEMS.find((item) => isNavActive(pathname, item.href));
  return (
    <span className="text-sm font-medium">
      {current?.title ?? "Vendor Sourcing"}
    </span>
  );
}
