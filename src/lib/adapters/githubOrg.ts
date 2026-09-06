/**
 * SourceAdapter "github_org" (octokit): one VendorCandidate per GitHub
 * organisation. discover() searches repositories per language, ranks the
 * owning organisations by the ruleset's should-score and collects the
 * evidence signals up front; normalize() is a pure mapping of that payload.
 * Every value is an API fact with a GitHub URL as source. No screening here.
 */
import type { Octokit } from "octokit";

import type { EvidenceRow, Vendor } from "@/lib/db/schema";
import { mapWithConcurrency } from "@/lib/pipeline/concurrency";
import { canonicalDomain, isNonVendorHost, vendorIdFor } from "@/lib/pipeline/ids";
import { scoreShould } from "@/lib/pipeline/screen";
import type {
  AdapterContext,
  DiscoveryQuery,
  Evidence,
  NormalizeResult,
  RawRecord,
  SourceAdapter,
  Tag,
  VendorCandidate,
} from "@/lib/pipeline/types";

type RepoLite = {
  name: string;
  full_name: string;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  license: string | null;
  fork: boolean;
  archived: boolean;
  pushed_at: string | null;
  description: string | null;
};

export type OrgSignals = {
  login: string;
  name: string;
  description: string | null;
  html_url: string;
  website: string | null;
  location: string | null;
  email: string | null;
  public_repos: number;
  repos_sampled: number;
  top_repo: RepoLite | null;
  merged_prs_public: number | null;
  merged_prs_url: string;
  root_entries: string[];
  ci_config: boolean;
  ci_detail: string;
  release_tags: boolean;
  release_detail: string;
  test_directory: boolean;
  license: boolean;
  license_spdx: string | null;
  lockfile: boolean;
  lockfile_name: string | null;
  last_commit_days: number | null;
  last_commit_repo: string | null;
  last_commit_at: string | null;
  is_fork_or_tutorial: boolean;
  fork_or_tutorial_reason: string | null;
  languages: string[];
  code_license: "permissive" | "copyleft" | "proprietary" | "unknown";
  org_type: "company" | "foundation";
  stars_total: number;
  errors: string[];
};

const LOCKFILES = [
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "poetry.lock", "pipfile.lock", "uv.lock", "pdm.lock", "requirements.lock",
  "cargo.lock", "go.sum", "gemfile.lock", "composer.lock", "packages.lock.json",
  "mix.lock", "pubspec.lock", "gradle.lockfile", "flake.lock",
];
const CI_FILES = [".gitlab-ci.yml", ".travis.yml", "jenkinsfile", "azure-pipelines.yml", ".circleci", ".buildkite", "bitbucket-pipelines.yml", ".drone.yml"];
const TEST_DIRS = /^(tests?|spec|specs|__tests__|test_suite|testing)$/i;
const FOUNDATION = /\b(foundation|apache|eclipse|linux foundation|cncf|openjs|numfocus|non-?profit|charity|consortium)\b/i;

/** Word-boundary match of any keyword; used on names only (descriptions produce false positives). */
export function keywordMatcher(keywords: string[]): (s: string | null | undefined) => boolean {
  const res = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean).map((k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i"));
  return (s) => !!s && res.some((re) => re.test(s));
}

let client: Octokit | undefined;
/** octokit is ESM-only; load it lazily so CommonJS scripts (tsx) can import this module. */
async function getOctokit(log: (m: string) => void): Promise<Octokit> {
  if (client) return client;
  const auth = process.env.GITHUB_TOKEN;
  if (!auth) throw new Error("GITHUB_TOKEN is not set (put it in .env.local)");
  const { Octokit: OctokitCtor } = await import("octokit");
  client = new OctokitCtor({
    auth,
    userAgent: "vendor-sourcing/0.1",
    throttle: {
      onRateLimit: (retryAfter: number, options: { method: string; url: string }, _o: unknown, retryCount: number) => {
        log(`rate limit on ${options.method} ${options.url}; retry ${retryCount + 1} in ${retryAfter}s`);
        return retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }, _o: unknown, retryCount: number) => {
        log(`secondary rate limit on ${options.method} ${options.url}; retry ${retryCount + 1} in ${retryAfter}s`);
        return retryCount < 3;
      },
    },
  });
  return client;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function licenseFamily(spdx: string | null | undefined): OrgSignals["code_license"] {
  if (!spdx || spdx === "NOASSERTION") return "unknown";
  const s = spdx.toUpperCase();
  if (/^(BUSL|SSPL|ELASTIC|POLYFORM|COMMONS-CLAUSE|CONFLUENT|RSAL|FSL)/.test(s)) return "proprietary";
  if (/^(MIT|APACHE|BSD|ISC|UNLICENSE|0BSD|CC0|ZLIB|WTFPL|PSF|BSL-1\.0|PYTHON|BLUEOAK|MIT-0|NCSA|UPL)/.test(s)) return "permissive";
  if (/^(GPL|AGPL|LGPL|MPL|EPL|EUPL|OSL|CC-BY-SA|CDDL|CECILL)/.test(s)) return "copyleft";
  return "unknown";
}

const COUNTRY_HINTS: [RegExp, string][] = [
  [/\b(usa|u\.s\.a\.|united states|america)\b|\b(ca|ny|wa|tx|ma|il|co|ga|fl|pa|nc|va|or|az|ut|mn|mi|oh|nj|md|dc)\b$|\b(san francisco|new york|nyc|seattle|austin|boston|los angeles|chicago|denver|palo alto|mountain view|sunnyvale|redmond|menlo park|cupertino|san jose|oakland|portland|atlanta|miami|dallas|houston|philadelphia|washington|bay area|silicon valley|brooklyn|san diego|salt lake|raleigh|pittsburgh|minneapolis|phoenix|nashville|cambridge, ma)\b/i, "US"],
  [/\b(uk|u\.k\.|united kingdom|england|scotland|wales|london|manchester|cambridge, uk|edinburgh|bristol|oxford)\b/i, "GB"],
  [/\b(germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|karlsruhe)\b/i, "DE"],
  [/\b(france|paris|lyon|toulouse|grenoble|nantes)\b/i, "FR"],
  [/\b(canada|toronto|vancouver|montreal|montréal|ottawa|waterloo|calgary)\b/i, "CA"],
  [/\b(netherlands|the netherlands|amsterdam|rotterdam|utrecht|eindhoven)\b/i, "NL"],
  [/\b(sweden|stockholm|gothenburg|göteborg|malmö)\b/i, "SE"],
  [/\b(switzerland|zurich|zürich|geneva|lausanne|bern|basel)\b/i, "CH"],
  [/\b(spain|madrid|barcelona|valencia)\b/i, "ES"],
  [/\b(italy|italia|milan|milano|rome|roma|turin|torino)\b/i, "IT"],
  [/\b(japan|tokyo|osaka|kyoto)\b/i, "JP"],
  [/\b(china|beijing|shanghai|shenzhen|hangzhou|guangzhou|chengdu|nanjing|wuhan|hong kong)\b/i, "CN"],
  [/\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai|gurgaon|noida)\b/i, "IN"],
  [/\b(australia|sydney|melbourne|brisbane|perth)\b/i, "AU"],
  [/\b(israel|tel aviv|jerusalem|haifa)\b/i, "IL"],
  [/\bsingapore\b/i, "SG"],
  [/\b(korea|seoul|busan)\b/i, "KR"],
  [/\b(brazil|brasil|são paulo|sao paulo|rio de janeiro|florianópolis)\b/i, "BR"],
  [/\b(poland|polska|warsaw|warszawa|kraków|krakow|wrocław|gdańsk)\b/i, "PL"],
  [/\b(finland|helsinki|espoo|oulu)\b/i, "FI"],
  [/\b(norway|oslo)\b/i, "NO"],
  [/\b(denmark|copenhagen|københavn|aarhus)\b/i, "DK"],
  [/\b(ireland|dublin|cork)\b/i, "IE"],
  [/\b(belgium|brussels|bruxelles|ghent|antwerp|leuven)\b/i, "BE"],
  [/\b(austria|vienna|wien|graz|linz)\b/i, "AT"],
  [/\b(portugal|lisbon|lisboa|porto)\b/i, "PT"],
  [/\b(czech|czechia|prague|praha|brno)\b/i, "CZ"],
  [/\b(estonia|tallinn|tartu)\b/i, "EE"],
  [/\b(taiwan|taipei|hsinchu)\b/i, "TW"],
  [/\b(new zealand|auckland|wellington)\b/i, "NZ"],
  [/\b(argentina|buenos aires)\b/i, "AR"],
  [/\b(mexico|méxico|ciudad de méxico|guadalajara|monterrey)\b/i, "MX"],
  [/\b(russia|moscow|saint petersburg|st\. petersburg)\b/i, "RU"],
  [/\b(ukraine|kyiv|kiev|lviv|kharkiv)\b/i, "UA"],
  [/\b(turkey|türkiye|istanbul|ankara)\b/i, "TR"],
  [/\b(nigeria|lagos|abuja)\b/i, "NG"],
  [/\b(south africa|cape town|johannesburg)\b/i, "ZA"],
  [/\b(vietnam|hanoi|ho chi minh|saigon)\b/i, "VN"],
  [/\b(indonesia|jakarta|bandung)\b/i, "ID"],
  [/\b(philippines|manila)\b/i, "PH"],
  [/\b(thailand|bangkok)\b/i, "TH"],
  [/\b(malaysia|kuala lumpur)\b/i, "MY"],
  [/\b(pakistan|karachi|lahore|islamabad)\b/i, "PK"],
  [/\b(egypt|cairo)\b/i, "EG"],
  [/\b(uae|united arab emirates|dubai|abu dhabi)\b/i, "AE"],
  [/\b(saudi arabia|riyadh)\b/i, "SA"],
  [/\b(hungary|budapest)\b/i, "HU"],
  [/\b(romania|bucharest|cluj)\b/i, "RO"],
  [/\b(greece|athens)\b/i, "GR"],
  [/\b(lithuania|vilnius)\b/i, "LT"],
  [/\b(latvia|riga)\b/i, "LV"],
  [/\b(serbia|belgrade)\b/i, "RS"],
  [/\b(croatia|zagreb)\b/i, "HR"],
  [/\b(chile|santiago)\b/i, "CL"],
  [/\b(colombia|bogotá|bogota|medellín|medellin)\b/i, "CO"],
  [/\b(kenya|nairobi)\b/i, "KE"],
];

export function guessCountry(location: string | null | undefined): string | null {
  if (!location) return null;
  const s = location.trim();
  if (!s) return null;
  for (const [re, code] of COUNTRY_HINTS) if (re.test(s)) return code;
  return null;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

function normalizeWebsite(blog: string | null | undefined): string | null {
  if (!blog) return null;
  let s = blog.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    const domain = canonicalDomain(u.href);
    if (!domain || isNonVendorHost(domain)) return null;
    return u.href;
  } catch {
    return null;
  }
}

function lite(r: {
  name: string;
  full_name: string;
  html_url: string;
  stargazers_count?: number;
  language?: string | null;
  license?: { spdx_id?: string | null } | null;
  fork: boolean;
  archived?: boolean;
  pushed_at?: string | null;
  description?: string | null;
}): RepoLite {
  return {
    name: r.name,
    full_name: r.full_name,
    html_url: r.html_url,
    stargazers_count: r.stargazers_count ?? 0,
    language: r.language ?? null,
    license: r.license?.spdx_id ?? null,
    fork: r.fork,
    archived: r.archived ?? false,
    pushed_at: r.pushed_at ?? null,
    description: r.description ?? null,
  };
}

// ---------------------------------------------------------------------------
// signal collection
// ---------------------------------------------------------------------------

async function collectSignals(
  octokit: Octokit,
  login: string,
  exclude: string[],
  hits: RepoLite[],
  log: (m: string) => void,
): Promise<OrgSignals | null> {
  const errors: string[] = [];
  const matches = keywordMatcher(exclude);

  let org;
  try {
    org = (await octokit.rest.orgs.get({ org: login })).data;
  } catch (err) {
    log(`${login}: org profile failed (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }

  let repos: RepoLite[] = hits;
  try {
    const res = await octokit.rest.repos.listForOrg({ org: login, type: "public", sort: "pushed", direction: "desc", per_page: 30 });
    repos = res.data.map(lite);
  } catch (err) {
    errors.push(`listForOrg: ${err instanceof Error ? err.message : String(err)}`);
  }
  const active = repos.filter((r) => !r.fork && !r.archived);
  const topRepos = [...active].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 5);
  const top = topRepos[0] ?? null;

  let merged: number | null = null;
  const mergedQuery = `org:${login} is:pr is:merged`;
  try {
    const res = await octokit.request("GET /search/issues", { q: mergedQuery, per_page: 1, advanced_search: "true" });
    merged = res.data.total_count;
  } catch (err) {
    errors.push(`merged PR search: ${err instanceof Error ? err.message : String(err)}`);
  }

  let rootEntries: string[] = [];
  let workflowCount: number | null = null;
  if (top) {
    try {
      const res = await octokit.rest.repos.getContent({ owner: login, repo: top.name, path: "" });
      if (Array.isArray(res.data)) rootEntries = res.data.map((e) => e.name);
    } catch (err) {
      errors.push(`root listing ${top.full_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (rootEntries.includes(".github")) {
      try {
        const res = await octokit.rest.repos.getContent({ owner: login, repo: top.name, path: ".github/workflows" });
        workflowCount = Array.isArray(res.data) ? res.data.length : 0;
      } catch {
        workflowCount = 0;
      }
    }
  }
  const lower = rootEntries.map((e) => e.toLowerCase());
  const ciFile = CI_FILES.find((f) => lower.includes(f)) ?? null;
  const ci_config = (workflowCount ?? 0) > 0 || ciFile !== null;
  const ci_detail = (workflowCount ?? 0) > 0 ? `.github/workflows with ${workflowCount} file(s)` : ciFile ? `${ciFile} in the repository root` : "no CI configuration in the repository root";
  const test_directory = rootEntries.some((e) => TEST_DIRS.test(e));
  const lockfile_name = LOCKFILES.find((f) => lower.includes(f)) ?? null;
  const license_spdx = top?.license ?? null;
  const license = (license_spdx !== null && license_spdx !== "NOASSERTION") || lower.some((e) => /^(license|copying|licence)/.test(e));

  let release_tags = false;
  let release_detail = "no releases or tags";
  if (top) {
    try {
      const rel = await octokit.rest.repos.listReleases({ owner: login, repo: top.name, per_page: 1 });
      if (rel.data.length > 0) {
        release_tags = true;
        release_detail = `latest release ${rel.data[0].tag_name ?? rel.data[0].name ?? ""}`.trim();
      } else {
        const tags = await octokit.rest.repos.listTags({ owner: login, repo: top.name, per_page: 1 });
        if (tags.data.length > 0) {
          release_tags = true;
          release_detail = `latest tag ${tags.data[0].name}`;
        }
      }
    } catch (err) {
      errors.push(`releases ${top.full_name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const newest = [...active].sort((a, b) => Date.parse(b.pushed_at ?? "0") - Date.parse(a.pushed_at ?? "0"))[0] ?? null;
  const last_commit_days = daysSince(newest?.pushed_at);

  let fork_or_tutorial_reason: string | null = null;
  if (active.length === 0) fork_or_tutorial_reason = "every sampled repository is a fork or archived";
  else if (matches(org.login) || matches(org.name)) fork_or_tutorial_reason = "organisation name matches an excluded keyword";
  else if (topRepos.length > 0 && topRepos.every((r) => matches(r.name))) fork_or_tutorial_reason = `top repositories (${topRepos.map((r) => r.name).join(", ")}) match excluded keywords`;

  const languages = [...new Set(topRepos.map((r) => r.language?.toLowerCase()).filter((l): l is string => !!l))];
  const org_type: OrgSignals["org_type"] = FOUNDATION.test(`${org.login} ${org.name ?? ""} ${org.description ?? ""}`) ? "foundation" : "company";
  const signals = [ci_config, release_tags, test_directory, license, lockfile_name !== null].filter(Boolean).length;
  void signals;

  return {
    login: org.login,
    name: org.name ?? org.login,
    description: org.description ?? null,
    html_url: org.html_url,
    website: normalizeWebsite(org.blog),
    location: org.location ?? null,
    email: org.email ?? null,
    public_repos: org.public_repos,
    repos_sampled: repos.length,
    top_repo: top,
    merged_prs_public: merged,
    merged_prs_url: `https://github.com/search?q=${encodeURIComponent(mergedQuery)}&type=pullrequests`,
    root_entries: rootEntries,
    ci_config,
    ci_detail,
    release_tags,
    release_detail,
    test_directory,
    license,
    license_spdx,
    lockfile: lockfile_name !== null,
    lockfile_name,
    last_commit_days,
    last_commit_repo: newest?.full_name ?? null,
    last_commit_at: newest?.pushed_at ?? null,
    is_fork_or_tutorial: fork_or_tutorial_reason !== null,
    fork_or_tutorial_reason,
    languages,
    code_license: licenseFamily(license_spdx),
    org_type,
    stars_total: active.reduce((n, r) => n + r.stargazers_count, 0),
    errors,
  };
}

// ---------------------------------------------------------------------------
// evidence mapping
// ---------------------------------------------------------------------------

export function signalsToEvidence(s: OrgSignals, now: string): { evidence: Evidence[]; tags: Tag[] } {
  const evidence: Evidence[] = [];
  const tags: Tag[] = [];
  const top = s.top_repo;
  const add = (
    field_path: string,
    value: string | null,
    source_url: string | null,
    snippet: string | null,
    o: { confidence?: number; proxy?: boolean } = {},
  ) => {
    const verified = value !== null && source_url !== null;
    evidence.push({
      field_path,
      value,
      source_url,
      snippet,
      extraction_method: "api",
      confidence: value === null ? 0 : (o.confidence ?? 1),
      proxy: Boolean(o.proxy),
      verified,
      attested_by: null,
      observed_at: now,
    });
    return evidence.length - 1;
  };
  const tag = (dimension: Tag["dimension"], value: string, index: number, proxy = false) => {
    tags.push({ dimension, value, source_badge: proxy ? "proxy" : "verified", evidence_index: index });
  };

  add(
    "merged_prs_public",
    s.merged_prs_public === null ? null : String(s.merged_prs_public),
    s.merged_prs_public === null ? null : s.merged_prs_url,
    s.merged_prs_public === null ? null : `GitHub search: ${s.merged_prs_public} merged pull requests across public repositories of ${s.login}`,
    { proxy: true, confidence: 0.9 },
  );
  const signalList = [
    ["ci_config", s.ci_config, s.ci_detail],
    ["release_tags", s.release_tags, s.release_detail],
    ["test_directory", s.test_directory, s.test_directory ? `a tests directory exists in the root of ${top?.full_name ?? "the top repository"}` : `no tests directory in the root of ${top?.full_name ?? "the top repository"}`],
    ["license", s.license, s.license ? `license ${s.license_spdx ?? "file"} on ${top?.full_name ?? "the top repository"}` : `no license declared on ${top?.full_name ?? "the top repository"}`],
    ["lockfile", s.lockfile, s.lockfile ? `${s.lockfile_name} in the root of ${top?.full_name ?? "the top repository"}` : `no dependency lockfile in the root of ${top?.full_name ?? "the top repository"}`],
  ] as const;
  const count = signalList.filter(([, v]) => v).length;
  add("production_signals", top ? String(count) : null, top?.html_url ?? null, top ? `${count} of 5 production signals on ${top.full_name}: ${signalList.filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}` : null, { proxy: true, confidence: 0.9 });
  for (const [field, value, detail] of signalList) {
    add(field, top ? String(value) : null, top?.html_url ?? null, top ? `${top.full_name}: ${detail}` : null);
  }
  add(
    "last_commit_days",
    s.last_commit_days === null ? null : String(s.last_commit_days),
    s.last_commit_repo ? `https://github.com/${s.last_commit_repo}` : null,
    s.last_commit_at ? `Most recent push ${s.last_commit_at} to ${s.last_commit_repo}` : null,
  );
  add("is_fork_or_tutorial", String(s.is_fork_or_tutorial), s.html_url, s.fork_or_tutorial_reason ?? `Organisation ${s.login} owns ${s.repos_sampled} sampled repositories, top ${top?.full_name ?? "-"} is not a fork`);
  add("public_repos", String(s.public_repos), s.html_url, `Organisation profile lists ${s.public_repos} public repositories`);
  add("stars_total", String(s.stars_total), s.html_url, `${s.stars_total} stars across ${s.repos_sampled} sampled repositories`);
  const orgIdx = add("org_type", s.org_type, s.html_url, `Organisation profile: ${s.name}${s.description ? ` — ${s.description}` : ""}`, { confidence: 0.8 });
  tag("org_type", s.org_type, orgIdx);
  for (const lang of s.languages) {
    const repo = [s.top_repo].find((r) => r?.language?.toLowerCase() === lang) ?? s.top_repo;
    const idx = add("code_language", lang, repo?.html_url ?? s.html_url, `${repo?.full_name ?? s.login}: primary language ${lang}`);
    tag("code_language", lang, idx);
  }
  const licIdx = add("code_license", s.code_license, top?.html_url ?? s.html_url, `${top?.full_name ?? s.login} license: ${s.license_spdx ?? "none declared"}`, { confidence: s.license_spdx ? 1 : 0.6 });
  tag("code_license", s.code_license, licIdx);
  const modIdx = add("modality", "code", s.html_url, `Source code repositories owned by ${s.login}`);
  tag("modality", "code", modIdx);
  const colIdx = add("collection_type", "licensed_existing", s.html_url, `Existing codebase owned by ${s.login}; licensing would cover existing repositories`, { proxy: true, confidence: 0.6 });
  tag("collection_type", "licensed_existing", colIdx, true);
  if (s.website) add("website", s.website, s.html_url, `Profile website: ${s.website}`);
  if (s.location) {
    add("headquarters", s.location, s.html_url, `Profile location: ${s.location}`);
    const country = guessCountry(s.location);
    if (country) add("registration_country", country, s.html_url, `Profile location "${s.location}" is in ${country}`, { proxy: true, confidence: 0.6 });
  }
  if (s.email) add("contact_email", s.email, s.html_url, `Profile email: ${s.email}`);
  add("github_org", s.login, s.html_url, `GitHub organisation ${s.login}`);
  const srcIdx = add("source_channel", "github", s.html_url, `Discovered through the GitHub API (${s.login})`);
  tag("source_channel", "github", srcIdx);
  return { evidence, tags };
}

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

async function discover(q: DiscoveryQuery, ctx: AdapterContext): Promise<RawRecord[]> {
  if (q.kind !== "github") throw new Error(`github_org cannot run a "${q.kind}" query`);
  const octokit = await getOctokit(ctx.log);
  const exclude = q.exclude_keywords.map((k) => k.toLowerCase());
  const matches = keywordMatcher(exclude);
  const since = new Date(Date.now() - q.activity_window_days * 86_400_000).toISOString().slice(0, 10);

  type Cand = { login: string; hits: RepoLite[]; stars: number; languages: Set<string> };
  const cands = new Map<string, Cand>();
  let searched = 0;
  for (const lang of q.languages) {
    for (const page of [1, 2]) {
      const query = `language:"${lang}" stars:>=${q.min_stars} pushed:>=${since} fork:false archived:false`;
      let items;
      try {
        const res = await octokit.rest.search.repos({ q: query, sort: "stars", order: "desc", per_page: 100, page });
        items = res.data.items;
        searched += items.length;
        await ctx.persist(`search_${lang.toLowerCase()}_${page}.json`, { query, total_count: res.data.total_count, items: items.map((i) => ({ ...lite(i), owner: i.owner?.login, owner_type: i.owner?.type })) });
      } catch (err) {
        ctx.log(`search ${lang} page ${page} failed: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      for (const item of items) {
        if (item.owner?.type !== "Organization") continue;
        const login = item.owner.login;
        if (matches(login) || matches(item.name)) continue;
        const c = cands.get(login) ?? { login, hits: [], stars: 0, languages: new Set<string>() };
        c.hits.push(lite(item));
        c.stars += item.stargazers_count ?? 0;
        c.languages.add(lang);
        cands.set(login, c);
      }
      if (items.length < 100) break;
    }
  }
  ctx.log(`${searched} repositories -> ${cands.size} organisations`);

  const shortlist = [...cands.values()]
    .sort((a, b) => b.languages.size - a.languages.size || b.hits.length - a.hits.length || b.stars - a.stars)
    .slice(0, Math.min(80, Math.max(q.limit, Math.ceil(q.limit * 1.6))));
  ctx.log(`collecting signals for ${shortlist.length} organisations`);

  const now = new Date().toISOString();
  let done = 0;
  const records = await mapWithConcurrency(shortlist, 2, async (c): Promise<RawRecord | null> => {
    const s = await collectSignals(octokit, c.login, exclude, c.hits, ctx.log);
    done += 1;
    if (!s) return null;
    const { evidence, tags } = signalsToEvidence(s, now);
    const should = scoreShould(evidence, ctx.ruleset);
    await ctx.persist(`org_${c.login}.json`, { signals: s, should_score: should });
    if (done % 10 === 0) ctx.log(`signals ${done}/${shortlist.length}`);
    return {
      source: "github",
      url: s.website ?? s.html_url,
      domain: canonicalDomain(s.website),
      title: s.name,
      snippet: s.description,
      query: `language:${[...c.languages].join("|")}`,
      discovered_at: now,
      hop: 1,
      extra: { login: s.login, should_score: should, merged_prs_public: s.merged_prs_public, signals: s, evidence, tags },
    };
  });

  const ranked = records
    .filter((r): r is RawRecord => r !== null)
    .sort((a, b) => Number(b.extra?.should_score ?? 0) - Number(a.extra?.should_score ?? 0) || Number(b.extra?.merged_prs_public ?? 0) - Number(a.extra?.merged_prs_public ?? 0));
  ctx.log(`ranked ${ranked.length} organisations by should-score; keeping ${Math.min(q.limit, ranked.length)}`);
  return ranked.slice(0, q.limit);
}

async function normalize(raw: RawRecord, ctx: AdapterContext): Promise<NormalizeResult> {
  const extra = raw.extra as { login?: string; signals?: OrgSignals; evidence?: Evidence[]; tags?: Tag[] } | undefined;
  const s = extra?.signals;
  if (!s || !extra?.evidence || !extra?.tags) {
    return { page_type: "other", vendor: null, evidence: [], tags: [], mentioned_vendors: [], raw: { record: raw, error: "missing signals" } };
  }
  const now = new Date().toISOString();
  const evidence = extra.evidence.map((e) => ({ ...e, observed_at: now }));
  const tags = [...extra.tags];
  for (const must of ctx.ruleset.must) {
    if (!evidence.some((e) => e.field_path === must.field_path)) {
      evidence.push({ field_path: must.field_path, value: null, source_url: null, snippet: null, extraction_method: "api", confidence: 0, proxy: false, verified: false, attested_by: null, observed_at: now, note: "not_found" });
    }
  }
  const first = (fp: string) => evidence.find((e) => e.field_path === fp && e.verified && e.value)?.value ?? null;
  const vendor: VendorCandidate = {
    vendor_id: vendorIdFor(raw.domain, s.name, ctx.config.vendor_type),
    name: s.name,
    vendor_type: ctx.config.vendor_type,
    primary_domain: raw.domain,
    contact_email: first("contact_email"),
    registration_country: first("registration_country"),
    ownership_country: null,
    parent_entity: null,
    collection_countries: [],
    discovered_via: githubOrgAdapter.name,
  };
  return { page_type: "vendor_site", vendor, evidence, tags, mentioned_vendors: [], raw: { record: raw, signals: s } };
}

/** P1 refresh: recollect the organisation's signals (GitHub API only, no LLM). */
async function refresh(vendor: Vendor, evidence: EvidenceRow[], ctx: AdapterContext): Promise<NormalizeResult> {
  const login = evidence.find((e) => e.field_path === "github_org" && e.value)?.value;
  if (!login) {
    return { page_type: "other", vendor: null, evidence: [], tags: [], mentioned_vendors: [], raw: { error: "vendor has no github_org evidence" } };
  }
  const octokit = await getOctokit(ctx.log);
  const exclude = (ctx.config.github?.exclude_keywords ?? []).map((k) => k.toLowerCase());
  const s = await collectSignals(octokit, login, exclude, [], ctx.log);
  if (!s) {
    return { page_type: "unreachable", vendor: null, evidence: [], tags: [], mentioned_vendors: [], raw: { error: `organisation ${login} not reachable` } };
  }
  const now = new Date().toISOString();
  const { evidence: rows, tags } = signalsToEvidence(s, now);
  const raw: RawRecord = {
    source: "github",
    url: s.website ?? s.html_url,
    domain: canonicalDomain(s.website),
    title: s.name,
    snippet: s.description,
    query: null,
    discovered_at: now,
    hop: 1,
    extra: { login: s.login, refresh: true, signals: s, evidence: rows, tags },
  };
  const result = await normalize(raw, ctx);
  if (result.vendor) {
    result.vendor = { ...result.vendor, vendor_id: vendor.vendor_id, primary_domain: vendor.primary_domain ?? result.vendor.primary_domain };
  }
  return result;
}

export const githubOrgAdapter: SourceAdapter = {
  name: "github_org",
  vendorTypes: ["code_data"],
  discover,
  normalize,
  refresh,
};
