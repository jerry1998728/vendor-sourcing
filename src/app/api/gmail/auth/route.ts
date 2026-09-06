import { NextResponse } from "next/server";

import { GmailNotConfiguredError, authUrl } from "@/lib/outreach/gmail";

export const dynamic = "force-dynamic";

/** Redirects to Google's consent screen; the callback persists token.json. */
export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  try {
    return NextResponse.redirect(authUrl(origin));
  } catch (err) {
    const status = err instanceof GmailNotConfiguredError ? 503 : 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
