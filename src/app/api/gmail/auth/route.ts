import { NextResponse } from "next/server";

import { GmailNotConfiguredError, authUrl } from "@/lib/outreach/gmail";

export const dynamic = "force-dynamic";

export const STATE_COOKIE = "gmail_oauth_state";

/** Redirects to Google's consent screen; the callback checks the state cookie, then persists token.json. */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  try {
    const state = crypto.randomUUID();
    const res = NextResponse.redirect(authUrl(origin, state));
    res.cookies.set(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https"), path: "/api/gmail", maxAge: 600 });
    return res;
  } catch (err) {
    const status = err instanceof GmailNotConfiguredError ? 503 : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
