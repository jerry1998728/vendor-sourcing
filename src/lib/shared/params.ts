/** Next.js search params can repeat; every page reads the first value. */
export function singleParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
