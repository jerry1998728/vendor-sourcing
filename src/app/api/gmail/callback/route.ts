import { NextResponse } from "next/server";

import { exchangeCode } from "@/lib/outreach/gmail";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  const back = new URL("/outreach", url.origin);
  back.searchParams.set("tab", "draft");
  if (denied || !code) {
    back.searchParams.set("gmail_error", denied ?? "no authorization code returned");
    return NextResponse.redirect(back);
  }
  try {
    await exchangeCode(url.origin, code);
    back.searchParams.set("gmail", "connected");
  } catch (err) {
    back.searchParams.set("gmail_error", err instanceof Error ? err.message : String(err));
  }
  return NextResponse.redirect(back);
}
