import { NextResponse, type NextRequest } from "next/server";

/**
 * Request gate. When APP_PASSWORD is set, every page and API route requires
 * HTTP Basic auth (any username); browsers prompt once, cron callers pass
 * `curl -u :password`. Unset, local development is unchanged.
 */
export function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const [scheme, encoded] = (req.headers.get("authorization") ?? "").split(" ");
  if (scheme === "Basic" && encoded && constantTimeEqual(decodePassword(encoded), password)) {
    return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="vendor-sourcing", charset="UTF-8"' },
  });
}

function decodePassword(encoded: string): string {
  try {
    const decoded = atob(encoded);
    return decoded.slice(decoded.indexOf(":") + 1);
  } catch {
    return "";
  }
}

/** Compare without leaking the position of the first mismatch. */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!_next/|icon\\.svg|favicon\\.ico).*)"],
};
