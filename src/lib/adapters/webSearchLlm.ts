/**
 * SourceAdapter "web_search_llm":
 *   discover()  – runs the config's seed queries through the Anthropic
 *                 web_search server tool and returns one RawRecord per
 *                 candidate domain.
 *   normalize() – fetches the candidate's pages, asks Claude for strict JSON
 *                 (zod-validated), and keeps a value only when its snippet is
 *                 found verbatim on a fetched page. Only vendor_site pages
 *                 yield a vendor; list pages yield hop-2 candidates instead.
 * No screening happens here.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  fetchPage,
  isFetched,
  pickSubpages,
  type FetchFailure,
  type FetchedPage,
} from "@/lib/llm/fetchPage";
import {
  DISCOVER_EFFORT,
  EXTRACT_EFFORT,
  addUsage,
  emptyUsage,
  getAnthropic,
  modelFor,
  supportsEffort,
  webSearchTool,
} from "@/lib/llm/client";
import { mapWithConcurrency } from "@/lib/pipeline/concurrency";
import {
  canonicalDomain,
  domainMatches,
  normalizeDomain,
  rootUrl,
  vendorIdFor,
} from "@/lib/pipeline/ids";
import type { EvidenceRow, Vendor } from "@/lib/db/schema";
import type { Ruleset } from "@/lib/pipeline/screen";
import {
  NormalizeOutput,
  TAG_DIMENSIONS,
  TAG_DIMENSIONS_BY_TYPE,
  isTagDimension,
  normalizeTagValue,
  type AdapterContext,
  type DiscoveryQuery,
  type Evidence,
  type NormalizeResult,
  type RawRecord,
  type VendorCandidate,
  type SourceAdapter,
  type Tag,
  type VendorType,
} from "@/lib/pipeline/types";

/** Sites that are never vendors: social, aggregators, news, academic, code hosts. */
export const DEFAULT_EXCLUDED_DOMAINS = [
  "linkedin.com", "crunchbase.com", "wikipedia.org", "github.com", "gitlab.com",
  "medium.com", "reddit.com", "youtube.com", "twitter.com", "x.com", "facebook.com",
  "instagram.com", "tiktok.com", "g2.com", "capterra.com", "gartner.com", "forbes.com",
  "techcrunch.com", "arxiv.org", "huggingface.co", "kaggle.com", "quora.com",
  "glassdoor.com", "indeed.com", "pitchbook.com", "zoominfo.com", "bloomberg.com",
  "reuters.com", "businesswire.com", "prnewswire.com", "globenewswire.com", "clutch.co",
  "goodfirms.co", "sourceforge.net", "producthunt.com", "ycombinator.com", "substack.com",
  "springer.com", "ieee.org", "nature.com", "sciencedirect.com", "researchgate.net",
  "semanticscholar.org", "openreview.net", "paperswithcode.com", "amazon.com", "aws.amazon.com",
  "cloud.google.com", "azure.microsoft.com", "wired.com", "theverge.com", "venturebeat.com",
  "zdnet.com", "cnet.com", "datasetlist.com", "ai-data.org", "trustradius.com",
  "softwareadvice.com", "designrules.com", "f6s.com", "tracxn.com", "cbinsights.com",
  "owler.com", "apollo.io", "rocketreach.co", "dnb.com", "opencorporates.com",
  "yelp.com", "trustpilot.com", "slideshare.net", "scribd.com", "docs.google.com",
  "notion.site", "notion.so", "eventbrite.com", "meetup.com", "discord.com", "slack.com",
];

const DISCOVERY_SYSTEM = `You are a sourcing analyst finding vendor companies for a procurement pipeline.
Use the web_search tool for the query you are given; you may refine it once if the first results are poor.
Then reply with a Markdown bullet list of the search results that are most likely to be the websites of actual vendors / companies matching the requirement, one per line as "- Name — https://url".
Skip news articles, list/comparison articles, directories, marketplaces, social profiles, academic papers and code repositories.
Only list URLs that appeared in the search results; never invent URLs.`;

const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;

function padIndex(i: number): string {
  return String(i).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

async function discover(q: DiscoveryQuery, ctx: AdapterContext): Promise<RawRecord[]> {
  if (q.kind !== "web_search") {
    throw new Error(`web_search_llm cannot run a "${q.kind}" query`);
  }
  const excluded = [...DEFAULT_EXCLUDED_DOMAINS, ...q.exclude_domains];
  const client = getAnthropic();
  const usage = emptyUsage();

  type Hit = { url: string; title: string | null; page_age: string | null; query: string; pick: boolean };
  const perQuery = await mapWithConcurrency(q.seed_queries, 3, async (seed, i): Promise<Hit[]> => {
    ctx.log(`search ${i + 1}/${q.seed_queries.length}: ${seed}`);
    const discoveryModel = modelFor("discovery");
    const res = await client.messages.create(
      {
        model: discoveryModel,
        max_tokens: 4000,
        ...(supportsEffort(discoveryModel) ? { output_config: { effort: DISCOVER_EFFORT } } : {}),
        tools: [webSearchTool(2)],
        system: DISCOVERY_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Requirement: ${q.requirement || "(see query)"}\n\nSearch query: ${seed}`,
          },
        ],
      },
      { signal: ctx.signal },
    );
    addUsage(usage, res.usage);
    addUsage(ctx.usage, res.usage);
    await ctx.persist(`search_${padIndex(i)}.json`, { seed_query: seed, response: res });

    const picks = new Set<string>();
    const hits: Hit[] = [];
    for (const block of res.content) {
      if (block.type === "text") {
        for (const m of block.text.match(URL_RE) ?? []) {
          const d = canonicalDomain(m);
          if (d) picks.add(d);
        }
      } else if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) {
          for (const r of block.content) {
            if (r.type === "web_search_result") {
              hits.push({ url: r.url, title: r.title, page_age: r.page_age, query: seed, pick: false });
            }
          }
        } else {
          ctx.log(`web_search error for "${seed}": ${block.content.error_code}`);
        }
      }
    }
    for (const h of hits) {
      const d = canonicalDomain(h.url);
      if (d && picks.has(d)) h.pick = true;
    }
    return hits.slice(0, q.max_results_per_query * 2);
  });

  await ctx.persist("discover_usage.json", usage);

  // One candidate per registrable domain, ranked: model picks first, then how
  // many queries surfaced it, then shortest URL path (homepage-like).
  type Cand = { domain: string; hits: Hit[]; queries: Set<string>; pick: boolean };
  const byDomain = new Map<string, Cand>();
  let rawCount = 0;
  for (const hits of perQuery) {
    for (const h of hits) {
      rawCount += 1;
      const domain = canonicalDomain(h.url);
      if (!domain || domainMatches(domain, excluded)) continue;
      const c = byDomain.get(domain) ?? { domain, hits: [], queries: new Set(), pick: false };
      c.hits.push(h);
      c.queries.add(h.query);
      c.pick = c.pick || h.pick;
      byDomain.set(domain, c);
    }
  }
  ctx.log(`${rawCount} search results -> ${byDomain.size} candidate domains`);

  const ranked = [...byDomain.values()].sort(
    (a, b) => Number(b.pick) - Number(a.pick) || b.queries.size - a.queries.size || a.domain.localeCompare(b.domain),
  );

  const now = new Date().toISOString();
  return ranked.slice(0, q.limit).map((c) => {
    const best = [...c.hits].sort((x, y) => new URL(x.url).pathname.length - new URL(y.url).pathname.length)[0];
    return {
      source: "web_search",
      url: best.url,
      domain: c.domain,
      title: best.title,
      snippet: null,
      query: best.query,
      discovered_at: now,
      hop: 1,
      extra: {
        model_pick: c.pick,
        query_count: c.queries.size,
        all_urls: c.hits.map((h) => h.url),
        page_age: best.page_age,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

const COUNTRY_FIELDS = new Set(["registration_country", "ownership_country", "collection_countries"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildExtractionSystemPrompt(ruleset: Ruleset, vendorType: VendorType, requirement: string): string {
  const mustPaths = [...new Set(ruleset.must.map((m) => m.field_path))];
  const catalog = ruleset.fields
    .map((f) => {
      const values = f.values?.length ? ` [allowed values: ${f.values.join(", ")}]` : "";
      const kind = f.type === "country" ? " (ISO 3166-1 alpha-2)" : f.type === "list" ? " (one entry per value)" : "";
      return `- ${f.path}${kind}${values}: ${f.description.replace(/\s+/g, " ").trim()}`;
    })
    .join("\n");
  const tagVocab = TAG_DIMENSIONS_BY_TYPE[vendorType]
    .filter((d) => d !== "source_channel")
    .map((d) => {
      const allowed = TAG_DIMENSIONS[d];
      return `- ${d}: ${allowed ? allowed.join(", ") : "free text (short, lower_snake_case)"}`;
    })
    .join("\n");

  return `You extract structured, evidence-backed facts about one organisation from the text of its web pages, for a vendor-sourcing pipeline.

Vendor category: ${vendorType}
Requirement: ${requirement || "(none given)"}

TASK
1. Classify the page set.
   - "vendor_site": these pages belong to an organisation that itself sells or provides the kind of data / service described in the requirement (or is clearly a data-collection / annotation company that could).
   - "aggregator": list or comparison article ("top 10 vendors...", "best companies for...").
   - "directory": company directory, review site or listing of many organisations.
   - "news": news, blog or press site whose pages are about other organisations.
   - "marketplace": a data marketplace hosting third-party datasets.
   - "other": anything else (unrelated business, personal page, academic paper, social profile, software product without data services).
2. If page_type is NOT "vendor_site": fill name and primary_domain for the site itself, leave fields and tags empty, and list in mentioned_vendors up to 15 organisations named on the pages that could be vendors in this category (name plus the URL of their own website when it is printed on the page, otherwise their most likely homepage URL).
3. If page_type is "vendor_site": extract the fields and tags below.

EVIDENCE RULES (strict)
- Every field value and every tag must cite source_url = exactly one of the PAGE URLs you were given, and snippet = a verbatim quote (max 300 characters) copied character-for-character from that page's text that supports the value. Never paraphrase a snippet.
- If no sentence on these pages supports a value, return the field entry with value null, source_url null and snippet null. Never guess.
- Only state what the pages say. A country needs a stated location, address, registration or ownership on the page; an address or "based in X" implies the registration country (proxy = true, confidence <= 0.7); an imprint / legal notice / "GmbH, Berlin" style statement is direct (proxy = false).
- ownership_country: only when the pages state ownership ("a subsidiary of X", "part of the Y group", "independent", "privately held", "founder-owned"). If the pages state the company is independent or privately held, use the registration country and quote that statement (proxy = true).
- Country codes: ISO 3166-1 alpha-2 in upper case (DE, US, GB, JP...).
- confidence: 0.0-1.0 for how directly the snippet supports the value (1.0 explicit statement, 0.5 strong implication).
- proxy: true when the value is an indirect signal rather than the fact itself.
- One entry per value for multi-valued fields (e.g. each sensor type, each collection country, each scene class).
- Always include one entry for each of these must-fields, with value null when not found: ${mustPaths.join(", ")}.
- Use only the field paths listed below (plus contact_email, parent_entity, founded_year, headquarters if stated).

FIELDS
${catalog}

TAGS (put one tag per value; only these dimensions and, where listed, only these values)
${tagVocab}

The top-level registration_country, ownership_country, parent_entity and collection_countries must agree with the corresponding field entries; the evidence lives in fields.
Answer only with the JSON object required by the schema.`;
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type PageIndex = { page: FetchedPage; key: string; norm: string };

export function findSnippet(
  snippet: string | null,
  claimedUrl: string | null,
  pages: PageIndex[],
): { found: boolean; source_url: string | null; note?: string } {
  if (!snippet || normalizeForMatch(snippet).length < 15) {
    return { found: false, source_url: null, note: "snippet_missing" };
  }
  const norm = normalizeForMatch(snippet);
  const head = norm.split(" ").slice(0, 12).join(" ");
  const claimedKey = canonicalDomain(claimedUrl);
  const ordered = [
    ...pages.filter((p) => claimedUrl && (p.page.final_url === claimedUrl || p.page.url === claimedUrl)),
    ...pages.filter((p) => !(claimedUrl && (p.page.final_url === claimedUrl || p.page.url === claimedUrl))),
  ];
  for (const p of ordered) {
    if (p.norm.includes(norm) || (head.length >= 30 && p.norm.includes(head))) {
      return { found: true, source_url: p.page.final_url };
    }
  }
  return {
    found: false,
    source_url: claimedKey ? claimedUrl : null,
    note: "snippet_not_found_on_fetched_pages",
  };
}

function cleanCountry(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

function cleanFieldPath(p: string): string {
  return p.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_.]/g, "").slice(0, 64);
}

type FetchedSet = { pages: FetchedPage[]; failures: FetchFailure[] };

/** I/O: the homepage, the discovered URL, a few "about"-style pages, and on refresh the pages behind existing evidence. */
async function fetchVendorPages(raw: RawRecord, domain: string, ctx: AdapterContext): Promise<FetchedSet> {
  const failures: FetchFailure[] = [];
  const pages: FetchedPage[] = [];
  const seen = new Set<string>();
  const take = async (url: string, maxChars: number) => {
    if (seen.has(url)) return;
    seen.add(url);
    const r = await fetchPage(url, { maxChars, signal: ctx.signal });
    if (isFetched(r)) {
      if (!pages.some((p) => p.final_url === r.final_url)) pages.push(r);
    } else failures.push(r);
  };
  await take(rootUrl(domain), 12_000);
  if (normalizeDomain(raw.url) !== domain || new URL(raw.url).pathname !== "/") {
    await take(raw.url, 8_000);
  }
  if (pages.length > 0) {
    const subs = pickSubpages(pages[0], 3);
    await mapWithConcurrency(subs, 3, (u) => take(u, 6_000));
  }
  // Refresh: re-fetch the pages that produced the vendor's existing evidence.
  const refetch = Array.isArray(raw.extra?.refetch_urls)
    ? (raw.extra.refetch_urls as unknown[]).filter((u): u is string => typeof u === "string" && canonicalDomain(u) === domain).slice(0, 4)
    : [];
  await mapWithConcurrency(refetch, 3, (u) => take(u, 6_000));
  return { pages, failures };
}

type Extraction = { parsed: NormalizeOutput | null; usage: Anthropic.Messages.Usage; model: string; stop_reason: string | null };

/** I/O: one model call for strict JSON over the fetched pages. */
async function extractClaims(pages: FetchedPage[], ctx: AdapterContext): Promise<Extraction> {
  const client = getAnthropic();
  const system = buildExtractionSystemPrompt(ctx.ruleset, ctx.config.vendor_type, ctx.config.requirement);
  const userText =
    pages
      .map((p, i) => `=== PAGE ${i + 1}: ${p.final_url}\nTITLE: ${p.title ?? ""}\n\n${p.text}`)
      .join("\n\n") + "\n\nExtract the JSON now.";
  const extractionModel = modelFor("extraction");
  const res = await client.messages.parse(
    {
      model: extractionModel,
      max_tokens: 8000,
      output_config: {
        ...(supportsEffort(extractionModel) ? { effort: EXTRACT_EFFORT } : {}),
        format: zodOutputFormat(NormalizeOutput),
      },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
    },
    { signal: ctx.signal },
  );
  addUsage(ctx.usage, res.usage);
  // zod is the contract even when the SDK already parsed the output
  return { parsed: res.parsed_output ? NormalizeOutput.parse(res.parsed_output) : null, usage: res.usage, model: res.model, stop_reason: res.stop_reason };
}

export type Grounded = { evidence: Evidence[]; tags: Tag[]; notes: string[]; vendor: VendorCandidate };

/**
 * Pure: every claim must be found verbatim on a fetched page or it stays
 * unverified; tags follow their evidence; every must-field gets a row.
 */
export function groundClaims(parsed: NormalizeOutput, pages: FetchedPage[], raw: RawRecord, domain: string, ruleset: Ruleset, vendorType: VendorType, now: string): Grounded {
  const notes: string[] = [];
  // 3. Ground every claim: the snippet must appear on a fetched page.
  const index: PageIndex[] = pages.map((p) => ({ page: p, key: p.final_url, norm: normalizeForMatch(p.text) }));
  const evidence: Evidence[] = [];
  const tags: Tag[] = [];
  const tagKey = (d: string, v: string) => `${d}:${v}`;
  const tagByKey = new Map<string, number>();

  const pushTag = (dimension: string, value: string, badge: Tag["source_badge"], evidence_index: number | null) => {
    if (!isTagDimension(dimension)) return;
    const norm = normalizeTagValue(dimension, value);
    if (!norm) {
      notes.push(`tag ${dimension}=${value} not in vocabulary`);
      return;
    }
    const key = tagKey(dimension, norm);
    const rank = { verified: 3, proxy: 2, manual: 1, unknown: 0 } as const;
    const existing = tagByKey.get(key);
    if (existing !== undefined) {
      if (rank[badge] > rank[tags[existing].source_badge]) {
        tags[existing] = { dimension, value: norm, source_badge: badge, evidence_index };
      }
      return;
    }
    tagByKey.set(key, tags.length);
    tags.push({ dimension, value: norm, source_badge: badge, evidence_index });
  };

  const seenFieldPaths = new Set<string>();
  for (const claim of parsed.fields) {
    const field_path = cleanFieldPath(claim.field_path);
    if (!field_path) continue;
    seenFieldPaths.add(field_path);
    let value: string | null = claim.value?.trim() || null;
    let note: string | undefined;
    if (value !== null && COUNTRY_FIELDS.has(field_path)) {
      const c = cleanCountry(value);
      if (!c) note = `invalid_country_code:${value}`;
      value = c;
    }
    if (value !== null && isTagDimension(field_path)) {
      const v = normalizeTagValue(field_path, value);
      if (!v) note = `not_in_vocabulary:${value}`;
      value = v;
    }
    if (value !== null && field_path === "contact_email" && !EMAIL_RE.test(value)) {
      note = `invalid_email:${value}`;
      value = null;
    }
    const confidence = Math.max(0, Math.min(1, Number.isFinite(claim.confidence) ? claim.confidence : 0));
    const match = value === null ? { found: false, source_url: null as string | null, note: "value_null" } : findSnippet(claim.snippet, claim.source_url, index);
    const verified = value !== null && match.found;
    if (!verified && match.note && !note) note = match.note;
    if (note) notes.push(`${field_path}: ${note}`);
    evidence.push({
      field_path,
      value,
      source_url: match.source_url,
      snippet: claim.snippet?.trim().slice(0, 300) || null,
      extraction_method: "llm",
      confidence,
      proxy: Boolean(claim.proxy),
      verified,
      attested_by: null,
      observed_at: now,
      note,
    });
    if (value !== null && isTagDimension(field_path)) {
      pushTag(field_path, value, verified ? (claim.proxy ? "proxy" : "verified") : "unknown", evidence.length - 1);
    }
  }

  // Top-level claims without a field entry become unverified evidence (value without source).
  const topLevel: [string, string | null][] = [
    ["registration_country", cleanCountry(parsed.registration_country)],
    ["ownership_country", cleanCountry(parsed.ownership_country)],
    ["parent_entity", parsed.parent_entity?.trim() || null],
    ...parsed.collection_countries.map((c): [string, string | null] => ["collection_countries", cleanCountry(c)]),
  ];
  for (const [field_path, value] of topLevel) {
    if (value === null) continue;
    const present = evidence.some((e) => e.field_path === field_path && e.value === value);
    if (present) continue;
    if (seenFieldPaths.has(field_path) && evidence.some((e) => e.field_path === field_path && e.value !== null)) continue;
    evidence.push({
      field_path,
      value,
      source_url: null,
      snippet: null,
      extraction_method: "llm",
      confidence: 0.3,
      proxy: false,
      verified: false,
      attested_by: null,
      observed_at: now,
      note: "top_level_claim_without_snippet",
    });
  }

  // Tags proposed directly.
  for (const t of parsed.tags) {
    const dimension = cleanFieldPath(t.dimension);
    if (!isTagDimension(dimension)) {
      notes.push(`tag dimension ${t.dimension} unknown`);
      continue;
    }
    const value = normalizeTagValue(dimension, t.value);
    if (!value) {
      notes.push(`tag ${dimension}=${t.value} not in vocabulary`);
      continue;
    }
    const match = findSnippet(t.snippet, t.source_url, index);
    if (match.found) {
      evidence.push({
        field_path: dimension,
        value,
        source_url: match.source_url,
        snippet: t.snippet?.trim().slice(0, 300) ?? null,
        extraction_method: "llm",
        confidence: 0.8,
        proxy: false,
        verified: true,
        attested_by: null,
        observed_at: now,
      });
      pushTag(dimension, value, "verified", evidence.length - 1);
    } else {
      pushTag(dimension, value, "unknown", null);
    }
  }

  // Every must-field gets a row, even when nothing was found.
  for (const must of ruleset.must) {
    if (!evidence.some((e) => e.field_path === must.field_path)) {
      evidence.push({
        field_path: must.field_path,
        value: null,
        source_url: null,
        snippet: null,
        extraction_method: "llm",
        confidence: 0,
        proxy: false,
        verified: false,
        attested_by: null,
        observed_at: now,
        note: "not_found",
      });
    }
  }

  // Provenance: how this vendor entered the pipeline (not repeated on refresh).
  if (raw.extra?.refresh !== true) evidence.push({
    field_path: "source_channel",
    value: "web_search",
    source_url: raw.url,
    snippet: raw.title ? `Search result: ${raw.title}` : `Search result for "${raw.query ?? ""}"`,
    extraction_method: "api",
    confidence: 1,
    proxy: false,
    verified: true,
    attested_by: null,
    observed_at: now,
  });
  if (raw.extra?.refresh !== true) pushTag("source_channel", "web_search", "verified", evidence.length - 1);

  const firstVerified = (fp: string) => evidence.find((e) => e.field_path === fp && e.verified && e.value)?.value ?? null;
  const allVerified = (fp: string) => [...new Set(evidence.filter((e) => e.field_path === fp && e.verified && e.value).map((e) => e.value as string))];

  const name = parsed.name.trim() || pages[0].title || domain;
  const vendor = {
    vendor_id: vendorIdFor(domain, name, vendorType),
    name,
    vendor_type: vendorType,
    primary_domain: domain,
    contact_email: firstVerified("contact_email"),
    registration_country: firstVerified("registration_country"),
    ownership_country: firstVerified("ownership_country"),
    parent_entity: firstVerified("parent_entity"),
    collection_countries: allVerified("collection_countries"),
    discovered_via: webSearchLlmAdapter.name,
  };

  return { evidence, tags, notes, vendor };
}

async function normalize(raw: RawRecord, ctx: AdapterContext): Promise<NormalizeResult> {
  const domain = raw.domain ?? canonicalDomain(raw.url);
  const empty = (page_type: NormalizeResult["page_type"], rawExtra: Record<string, unknown>): NormalizeResult => ({
    page_type,
    vendor: null,
    evidence: [],
    tags: [],
    mentioned_vendors: [],
    raw: { record: raw, ...rawExtra },
  });
  if (!domain) return empty("other", { reason: "no_domain" });

  const { pages, failures } = await fetchVendorPages(raw, domain, ctx);
  if (pages.length === 0) {
    ctx.log(`unreachable: ${domain} (${failures.map((f) => f.error).join(", ")})`);
    return empty("unreachable", { failures });
  }
  const pageMeta = pages.map((p) => ({ url: p.url, final_url: p.final_url, status: p.status, title: p.title, chars: p.text.length }));

  const { parsed, usage, model, stop_reason } = await extractClaims(pages, ctx);
  if (!parsed) {
    ctx.log(`normalize: unparseable output for ${domain} (stop_reason=${stop_reason})`);
    return empty("other", { pages: pageMeta, failures, stop_reason, usage, error: "unparseable_llm_output" });
  }

  if (parsed.page_type !== "vendor_site") {
    const mentioned = parsed.mentioned_vendors
      .map((m) => ({ name: m.name.trim(), url: m.url.trim() }))
      .filter((m) => m.name && canonicalDomain(m.url) && canonicalDomain(m.url) !== domain)
      .slice(0, 15);
    ctx.log(`${domain}: ${parsed.page_type}, ${mentioned.length} vendors mentioned`);
    return { page_type: parsed.page_type, vendor: null, evidence: [], tags: [], mentioned_vendors: mentioned, raw: { record: raw, pages: pageMeta, failures, llm_output: parsed, usage, model } };
  }

  const { evidence, tags, notes, vendor } = groundClaims(parsed, pages, raw, domain, ctx.ruleset, ctx.config.vendor_type, new Date().toISOString());
  ctx.log(`${domain}: vendor_site "${vendor.name}", ${evidence.filter((e) => e.verified).length}/${evidence.length} evidence verified, ${tags.length} tags`);
  return {
    page_type: "vendor_site",
    vendor,
    evidence,
    tags,
    mentioned_vendors: [],
    raw: { record: raw, pages: pageMeta, failures, llm_output: parsed, usage, model, notes, llm_primary_domain: parsed.primary_domain },
  };
}

/** P1 refresh: root page, the pages behind the vendor's evidence, then the usual extraction. */
async function refresh(vendor: Vendor, evidence: EvidenceRow[], ctx: AdapterContext): Promise<NormalizeResult> {
  const domain = vendor.primary_domain ?? canonicalDomain(vendor.vendor_id);
  if (!domain) {
    return { page_type: "other", vendor: null, evidence: [], tags: [], mentioned_vendors: [], raw: { error: "vendor has no domain to refresh" } };
  }
  const refetch_urls = [...new Set(evidence.map((e) => e.source_url).filter((u): u is string => !!u && canonicalDomain(u) === domain))];
  const raw: RawRecord = {
    source: "web_search",
    url: rootUrl(domain),
    domain,
    title: vendor.name,
    snippet: null,
    query: null,
    discovered_at: new Date().toISOString(),
    hop: 1,
    extra: { refresh: true, refetch_urls },
  };
  const result = await normalize(raw, ctx);
  if (result.vendor) {
    result.vendor = { ...result.vendor, vendor_id: vendor.vendor_id, primary_domain: vendor.primary_domain ?? result.vendor.primary_domain };
  }
  return result;
}

export const webSearchLlmAdapter: SourceAdapter = {
  name: "web_search_llm",
  vendorTypes: ["ego_data", "code_data"],
  discover,
  normalize,
  refresh,
};
