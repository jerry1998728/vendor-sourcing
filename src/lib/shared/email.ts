/** "Name <a@b.c>" or "a@b.c" -> "a@b.c", lower-cased. Pure, used by the allowlist and the draft sheet. */
export function normalizeEmail(email: string): string {
  const m = /<([^>]+)>/.exec(email);
  return (m ? m[1] : email).trim().toLowerCase();
}
