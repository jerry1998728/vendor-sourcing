import { NextResponse } from "next/server";

import { parseAllowlist } from "@/lib/outreach/allowlist";
import { isConfigured, isConnected, profile } from "@/lib/outreach/gmail";

export const dynamic = "force-dynamic";

/** Connection state for the Draft & Send UI; the profile call also validates the stored token. */
export async function GET() {
  const configured = isConfigured();
  const connected = configured && isConnected();
  let email: string | null = null;
  let error: string | null = null;
  if (connected) {
    try {
      email = (await profile()).email;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return NextResponse.json({
    configured,
    connected: connected && !error,
    email,
    error,
    allowed_recipients: parseAllowlist(),
    auth_url: "/api/gmail/auth",
  });
}
