"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Browser back when this tab has somewhere to go back to; otherwise the fallback page (a pasted link, a fresh tab). */
export function BackButton({ fallback = "/database/vendors", label = "Back" }: { fallback?: string; label?: string }) {
  const router = useRouter();
  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push(fallback);
  };
  return (
    <Button type="button" variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground hover:text-foreground" onClick={goBack}>
      <ArrowLeft />
      {label}
    </Button>
  );
}
