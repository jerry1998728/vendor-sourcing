/**
 * Plain HTTP fetch of a vendor page, reduced to readable text plus its
 * same-site links. No headless browser: marketing sites are mostly static.
 */
import { normalizeDomain, registrableDomain } from "@/lib/pipeline/ids";

export type FetchedPage = {
  url: string;
  final_url: string;
  status: number;
  title: string | null;
  text: string;
  links: string[];
  fetched_at: string;
};

export type FetchFailure = { url: string; error: string; status?: number };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 VendorSourcing/0.1";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : null;
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|dd|dt|pre|table|ul|ol|nav|aside|main|figure|figcaption|address)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: s };
}

function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const baseDomain = registrableDomain(normalizeDomain(base));
  const re = /href\s*=\s*["']([^"'#\s]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.size < 300) {
    const href = m[1];
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (registrableDomain(normalizeDomain(u.href)) !== baseDomain) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mov|css|js|xml|ico)$/i.test(u.pathname)) continue;
    u.hash = "";
    out.add(u.href);
  }
  return [...out];
}

export async function fetchPage(
  url: string,
  opts: { timeoutMs?: number; maxChars?: number; signal?: AbortSignal } = {},
): Promise<FetchedPage | FetchFailure> {
  const { timeoutMs = 15_000, maxChars = 12_000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  const onOuterAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.8",
      },
    });
    const ctype = res.headers.get("content-type") ?? "";
    if (!res.ok) return { url, error: `http_${res.status}`, status: res.status };
    if (ctype && !/text\/html|application\/xhtml|text\/plain/i.test(ctype)) {
      return { url, error: `non_html:${ctype.split(";")[0]}`, status: res.status };
    }
    const html = (await res.text()).slice(0, 2_000_000);
    const { title, text } = htmlToText(html);
    if (text.length < 80) return { url, error: "empty_page", status: res.status };
    return {
      url,
      final_url: res.url || url,
      status: res.status,
      title,
      text: text.slice(0, maxChars),
      links: extractLinks(html, res.url || url),
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, error: msg.includes("timeout") ? "timeout" : `fetch_failed:${msg.slice(0, 80)}` };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export function isFetched(p: FetchedPage | FetchFailure): p is FetchedPage {
  return "text" in p;
}

const SUBPAGE_KEYWORDS: [RegExp, number][] = [
  [/\b(about|company|who-we-are|our-story|story|mission)\b/i, 5],
  [/\b(imprint|impressum|legal|legal-notice|mentions-legales)\b/i, 5],
  [/\b(contact|contact-us|get-in-touch)\b/i, 4],
  [/\b(team|leadership|people)\b/i, 3],
  [/\b(privacy|terms)\b/i, 2],
  [/\b(data|datasets?|egocentric|first-person|capture|collection|solutions?|services?|products?|platform|technology|offering)\b/i, 3],
];

/** Same-site pages most likely to state location, ownership and offering. */
export function pickSubpages(page: FetchedPage, max = 3): string[] {
  const homeUrl = new URL(page.final_url);
  const scored: { url: string; score: number; len: number }[] = [];
  for (const link of page.links) {
    const u = new URL(link);
    if (u.pathname === "/" || u.pathname === homeUrl.pathname) continue;
    if (/\/(blog|news|press|careers|jobs|login|signup|cart|search|tag|category|wp-)/i.test(u.pathname)) continue;
    if (u.pathname.split("/").filter(Boolean).length > 3) continue;
    let score = 0;
    for (const [re, w] of SUBPAGE_KEYWORDS) if (re.test(u.pathname)) score += w;
    if (score === 0) continue;
    scored.push({ url: u.href, score, len: u.pathname.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  const out: string[] = [];
  const seenPaths = new Set<string>();
  for (const s of scored) {
    const p = new URL(s.url).pathname.replace(/\/$/, "").toLowerCase();
    if (seenPaths.has(p)) continue;
    seenPaths.add(p);
    out.push(s.url);
    if (out.length >= max) break;
  }
  return out;
}
