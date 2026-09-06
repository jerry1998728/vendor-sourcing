import type { VendorType } from "./types";

/** "https://www.Example.com/about?x" -> "example.com"; bare domains accepted. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return null;
  return host;
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unnamed";
}

/** PRD §5: vendor_id = normalized domain | slug(name)+type */
export function vendorIdFor(
  domain: string | null,
  name: string,
  vendorType: VendorType,
): string {
  return domain ?? `${slugify(name)}+${vendorType}`;
}

export function rootUrl(domain: string): string {
  return `https://${domain}/`;
}

/** Matches "example.com" and any subdomain against a block list. */
export function domainMatches(domain: string, list: readonly string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "or.kr", "com.br", "com.cn", "com.tw", "com.sg", "com.hk",
  "co.in", "co.nz", "co.za", "com.mx", "com.ar", "co.il", "com.tr", "com.ua",
  "co.id", "com.my", "com.ph", "co.th", "com.vn", "com.pl", "com.ru",
]);

/**
 * Shared hosting domains where the subdomain is the organisation. Treated as
 * suffixes so "netflix.github.io" and "argoproj.github.io" stay distinct.
 */
const HOSTING_SUFFIXES = new Set([
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "readthedocs.io",
  "herokuapp.com", "web.app", "firebaseapp.com", "notion.site", "webflow.io", "wixsite.com",
  "squarespace.com", "myshopify.com", "substack.com", "wordpress.com", "blogspot.com",
  "carrd.co", "framer.website", "super.site", "bitbucket.io", "surge.sh", "fly.dev",
  "onrender.com", "railway.app", "hf.space", "streamlit.app", "azurewebsites.net",
]);

/** "data.eu.example.co.uk" -> "example.co.uk"; the dedup key for vendors. */
export function registrableDomain(domain: string | null): string | null {
  if (!domain) return null;
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join(".");
  if ((TWO_PART_SUFFIXES.has(lastTwo) || HOSTING_SUFFIXES.has(lastTwo)) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/** Hosts that are never a vendor's own domain (code hosts, app stores, social). */
const NON_VENDOR_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "sourceforge.net", "npmjs.com", "pypi.org", "crates.io", "linkedin.com", "twitter.com", "x.com", "facebook.com", "youtube.com"]);

export function isNonVendorHost(domain: string | null): boolean {
  return domain !== null && NON_VENDOR_HOSTS.has(domain);
}

export function canonicalDomain(urlOrDomain: string | null | undefined): string | null {
  return registrableDomain(normalizeDomain(urlOrDomain));
}
