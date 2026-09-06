/** Next.js search params can repeat; every page reads the first value. */
export function singleParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Where a section root (/database, /outreach) sends a request: the sub-page a
 * legacy ?tab= value named, else the default sub-page. Every other search
 * param is carried over so deep links (?config=, ?vendor=, filters) survive.
 */
export function sectionTarget(sp: RawSearchParams, legacyTabs: Record<string, string>, fallback: string): string {
  const tab = singleParam(sp.tab);
  const target = (tab && legacyTabs[tab]) || fallback;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (key === "tab" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  const qs = params.toString();
  return qs ? `${target}?${qs}` : target;
}
