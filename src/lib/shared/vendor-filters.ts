/**
 * Vendor filters: URL search params <-> typed filters. Client-safe (no DB
 * imports); the SQL side lives in src/lib/db/filters.ts. The URL is the source
 * of truth so the Dashboard can deep-link into any filtered view.
 *
 *   ?q=text&vendor_type=ego_data&screen_result=pass,unknown&status=Screened
 *   &owner=a@x.com,none&country=DE,FR&country_mode=not_in
 *   &coverage_min=50&coverage_max=100&source_channel=web_search&stale=1
 *   &tag.sensor_rig=stereo,imu&tag.scene_class=urban
 */
import { TAG_DIMENSION_NAMES, isTagDimension, type TagDimension } from "@/lib/pipeline/types";
import { singleParam as single } from "./params";

export { SCREEN_RESULTS, VENDOR_STATUSES, type ScreenResult, type VendorStatus } from "@/lib/db/enums";
import { SCREEN_RESULTS, VENDOR_STATUSES, type ScreenResult, type VendorStatus } from "@/lib/db/enums";

export const STALE_DAYS = 30;
/** owner filter value meaning "no owner assigned" */
export const OWNER_UNASSIGNED = "none";

export type CountryMode = "in" | "not_in";

export type VendorFilters = {
  q?: string;
  vendor_type?: string[];
  screen_result?: ScreenResult[];
  status?: VendorStatus[];
  owner?: string[];
  /** applies to registration_country */
  country?: string[];
  country_mode?: CountryMode;
  /** percent, 0..100 */
  coverage_min?: number;
  coverage_max?: number;
  /** vendors.discovered_via */
  source_channel?: string[];
  /** last_verified_at older than STALE_DAYS or missing */
  stale?: boolean;
  /** any of the values per dimension; dimensions combine with AND */
  tags?: Partial<Record<TagDimension, string[]>>;
};

export type SearchParams = Record<string, string | string[] | undefined>;


function list(v: string | string[] | undefined): string[] | undefined {
  const raw = Array.isArray(v) ? v.join(",") : v;
  if (!raw) return undefined;
  const out = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  return out.length ? out : undefined;
}

function percent(v: string | string[] | undefined): number | undefined {
  const s = single(v);
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function parseVendorFilters(sp: SearchParams): VendorFilters {
  const f: VendorFilters = {};
  const q = single(sp.q)?.trim();
  if (q) f.q = q.slice(0, 100);
  const vt = list(sp.vendor_type);
  if (vt) f.vendor_type = vt;
  const sr = list(sp.screen_result)?.filter((s): s is ScreenResult => (SCREEN_RESULTS as readonly string[]).includes(s));
  if (sr?.length) f.screen_result = sr;
  const st = list(sp.status)?.filter((s): s is VendorStatus => (VENDOR_STATUSES as readonly string[]).includes(s));
  if (st?.length) f.status = st;
  const owner = list(sp.owner);
  if (owner) f.owner = owner;
  const country = list(sp.country)?.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  if (country?.length) {
    f.country = country;
    f.country_mode = single(sp.country_mode) === "not_in" ? "not_in" : "in";
  }
  const min = percent(sp.coverage_min);
  if (min !== undefined && min > 0) f.coverage_min = min;
  const max = percent(sp.coverage_max);
  if (max !== undefined && max < 100) f.coverage_max = max;
  const sc = list(sp.source_channel);
  if (sc) f.source_channel = sc;
  const stale = single(sp.stale);
  if (stale === "1" || stale === "true") f.stale = true;
  for (const [key, value] of Object.entries(sp)) {
    if (!key.startsWith("tag.")) continue;
    const dimension = key.slice(4);
    if (!isTagDimension(dimension)) continue;
    const values = list(value);
    if (!values) continue;
    f.tags = { ...(f.tags ?? {}), [dimension]: values };
  }
  return f;
}

/** Write filters into an existing URLSearchParams (other keys such as tab are kept). */
export function applyFiltersToParams(f: VendorFilters, params: URLSearchParams): URLSearchParams {
  const setList = (key: string, values: string[] | undefined) => {
    if (values && values.length) params.set(key, values.join(","));
    else params.delete(key);
  };
  if (f.q) params.set("q", f.q);
  else params.delete("q");
  setList("vendor_type", f.vendor_type);
  setList("screen_result", f.screen_result);
  setList("status", f.status);
  setList("owner", f.owner);
  setList("country", f.country);
  if (f.country?.length && f.country_mode === "not_in") params.set("country_mode", "not_in");
  else params.delete("country_mode");
  if (f.coverage_min !== undefined) params.set("coverage_min", String(f.coverage_min));
  else params.delete("coverage_min");
  if (f.coverage_max !== undefined) params.set("coverage_max", String(f.coverage_max));
  else params.delete("coverage_max");
  setList("source_channel", f.source_channel);
  if (f.stale) params.set("stale", "1");
  else params.delete("stale");
  for (const d of TAG_DIMENSION_NAMES) setList(`tag.${d}`, f.tags?.[d]);
  return params;
}

export function countActiveFilters(f: VendorFilters): number {
  let n = 0;
  if (f.q) n += 1;
  for (const key of ["vendor_type", "screen_result", "status", "owner", "country", "source_channel"] as const) {
    if (f[key]?.length) n += 1;
  }
  if (f.coverage_min !== undefined || f.coverage_max !== undefined) n += 1;
  if (f.stale) n += 1;
  n += Object.values(f.tags ?? {}).filter((v) => v && v.length).length;
  return n;
}

