import { NextResponse, type NextRequest } from "next/server";

import { exchangeCode } from "@/lib/outreach/gmail";

import { STATE_COOKIE } from "../auth/route";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  const expected = req.cookies.get(STATE_COOKIE)?.value;
  const back = new URL("/outreach/draft", url.origin);
  const redirect = () => {
    const res = NextResponse.redirect(back);
    res.cookies.delete({ name: STATE_COOKIE, path: "/api/gmail" });
    return res;
  };
  if (denied || !code) {
    back.searchParams.set("gmail_error", denied ?? "no authorization code returned");
    return redirect();
  }
  // CSRF guard: the code must come back with the state we issued.
  if (!state || !expected || state !== expected) {
    back.searchParams.set("gmail_error", "authorization state mismatch; start again from Connect Gmail");
    return redirect();
  }
  try {
    await exchangeCode(url.origin, code);
    back.searchParams.set("gmail", "connected");
  } catch (err) {
    back.searchParams.set("gmail_error", err instanceof Error ? err.message : String(err));
  }
  return redirect();
}
