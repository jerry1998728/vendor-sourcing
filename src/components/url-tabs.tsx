"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type UrlTabItem = { value: string; label: ReactNode; content: ReactNode };

/** Tabs whose active value lives in a search param, so every tab is deep-linkable. */
export function UrlTabs({ value, items, param = "tab" }: { value: string; items: UrlTabItem[]; param?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onChange = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(param, next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  return (
    <Tabs value={value} onValueChange={onChange} className="gap-4">
      <TabsList>
        {items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {items.map((item) => (
        <TabsContent key={item.value} value={item.value}>
          {item.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
