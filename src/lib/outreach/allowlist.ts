/** DEMO_ALLOWED_RECIPIENTS (CLAUDE.md): outreach may only go to these addresses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseAllowlist(raw: string | undefined = process.env.DEMO_ALLOWED_RECIPIENTS): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[,\s;]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL_RE.test(s)))];
}

export { normalizeEmail } from "@/lib/shared/email";
import { normalizeEmail } from "@/lib/shared/email";

/** Exact, case-insensitive match; an empty allowlist allows nobody. */
export function isAllowedRecipient(email: string, allowlist: string[] = parseAllowlist()): boolean {
  const e = normalizeEmail(email);
  return EMAIL_RE.test(e) && allowlist.includes(e);
}
