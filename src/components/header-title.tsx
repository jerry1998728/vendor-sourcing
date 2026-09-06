"use client";

import { usePathname } from "next/navigation";

import { navTrail } from "@/components/nav-items";

export function HeaderTitle() {
  const pathname = usePathname();
  const { section, child } = navTrail(pathname);
  const title = section?.title ?? (pathname.startsWith("/vendors/") ? "Vendor" : "Vendor Sourcing");
  return (
    <span className="flex items-center gap-1.5 text-sm font-medium">
      <span>{title}</span>
      {child ? (
        <>
          <span className="text-muted-foreground">/</span>
          <span>{child.title}</span>
        </>
      ) : null}
    </span>
  );
}
