"""`web_search_llm` adapter: Anthropic built-in web search + LLM JSON extraction with snippets.

discover(q)   : one Messages API call per seed query using the built-in
                `web_search_20250305` tool; every search hit becomes a RawRecord.
normalize(raw): one Messages API call that fetches the page with the built-in
                `web_fetch_20250910` tool and returns strict JSON
                {page_type, name, primary_domain, country, fields:[...]}.
                Only page_type == "vendor_site" produces evidence.  A value is
                verified only when it has a source_url we actually fetched AND a
                snippet that appears verbatim in the fetched page text.

No screening logic lives here: the adapter only extracts what the ruleset's
field catalog asks for; verdicts come from core.screen.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Iterable

import anthropic

from core.models import (
    DiscoveryQuery, Evidence, FieldSpec, RawRecord, VendorCandidate, normalize_domain, slugify, utcnow,
)

log = logging.getLogger("adapters.web_search_llm")


class AdapterFatalError(RuntimeError):
    """Auth / billing failure: retrying other records cannot succeed, abort the run."""


def is_fatal(exc: BaseException) -> bool:
    if isinstance(exc, AdapterFatalError):
        return True
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return True
    return isinstance(exc, anthropic.BadRequestError) and "credit balance" in str(exc).lower()

WEB_SEARCH_TOOL = "web_search_20250305"   # pinned by CLAUDE.md
WEB_FETCH_TOOL = "web_fetch_20250910"     # basic variant that pairs with it
DEFAULT_MODEL = "claude-opus-5"

PAGE_TYPES: tuple[str, ...] = ("vendor_site", "aggregator", "article", "marketplace", "research", "other")
PLACEHOLDERS = frozenset({"", "unknown", "n/a", "na", "none", "null", "not stated", "not specified", "unspecified", "-"})

# Hosts that are never a vendor's own site; skipped before any fetch to save calls.
SKIP_DOMAINS = frozenset({
    "arxiv.org", "huggingface.co", "github.com", "gitlab.com", "wikipedia.org", "youtube.com", "youtu.be",
    "linkedin.com", "reddit.com", "medium.com", "x.com", "twitter.com", "facebook.com", "instagram.com",
    "scholar.google.com", "google.com", "bing.com", "semanticscholar.org", "researchgate.net",
    "openreview.net", "paperswithcode.com", "kaggle.com", "amazon.com", "quora.com", "substack.com",
    "crunchbase.com", "g2.com", "capterra.com", "glassdoor.com", "indeed.com", "pypi.org", "stackoverflow.com",
})

DISCOVER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "name": {"type": "string"},
                    "likely_vendor_site": {"type": "boolean"},
                    "note": {"type": "string"},
                },
                "required": ["url", "name", "likely_vendor_site", "note"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["candidates"],
    "additionalProperties": False,
}

NORMALIZE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "page_type": {"type": "string", "enum": list(PAGE_TYPES)},
        "name": {"type": ["string", "null"]},
        "primary_domain": {"type": ["string", "null"]},
        "country": {"type": ["string", "null"]},
        "fields": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "field_path": {"type": "string"},
                    "value": {"type": "string"},
                    "source_url": {"type": ["string", "null"]},
                    "snippet": {"type": ["string", "null"]},
                    "confidence": {"type": "number"},
                    "proxy": {"type": "boolean"},
                },
                "required": ["field_path", "value", "source_url", "snippet", "confidence", "proxy"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["page_type", "name", "primary_domain", "country", "fields"],
    "additionalProperties": False,
}

DISCOVER_PROMPT = """You are a sourcing analyst building a longlist of vendors. Recall matters: we want as many DIFFERENT companies as possible.
Target vendors: {vendor_description}
Seed query: "{query}"
{already_found}
Use the web_search tool up to {n} times. Each search MUST use a materially different phrasing so it surfaces different
companies — never repeat a phrasing:
  1. the seed query as given
  2. a synonym variant (e.g. "first-person" / "POV" / "head-mounted" / "smart glasses" / "AR glasses" / "wearable camera",
     "data collection" / "data acquisition" / "dataset provider" / "AI training data services")
  3. a niche or regional variant (e.g. add "robotics", "embodied AI", "VR", or a region such as Europe, USA, India, Japan, Korea)
Prefer company product/service pages over news, papers, listicles or marketplaces, but do not discard listicles: they
name vendors we can look up.

After searching, return JSON with one entry per result URL you saw:
  url                : the result URL exactly as returned by the search (never invent or edit URLs)
  name               : the company or site name
  likely_vendor_site : true only if the URL belongs to a company that itself offers the target product/service
  note               : one short phrase on why
"""

NORMALIZE_PROMPT = """You are extracting evidence about a potential vendor.
Target vendors: {vendor_description}

Primary URL: {url}
Other URLs seen on this domain: {other_urls}

Steps:
1. Fetch the primary URL with web_fetch. If it is a company website and the key facts below are not on that page,
   you may fetch up to {extra} more pages on the SAME domain (e.g. /about, /contact, or one of the other URLs listed).
2. Classify page_type:
   vendor_site  = the company's own website AND that company itself offers products/services matching the target
   aggregator   = directory, listicle, comparison or "top N vendors" page
   article      = news or blog post by a third party
   marketplace  = multi-vendor marketplace or dataset hub
   research     = paper, benchmark or academic dataset page
   other        = anything else, or the page could not be fetched
3. ONLY if page_type == vendor_site, extract the fields in the catalog below. For EVERY field value you MUST give:
   source_url = the exact URL you fetched where the fact appears (one of the pages you fetched, nothing else)
   snippet    = a VERBATIM quote of 8-60 words copied exactly from that fetched page that contains the fact
   If you cannot quote the fact from a fetched page, OMIT the field entirely. Never output placeholder values
   such as "unknown", "n/a" or "not stated". Do not infer facts that the page does not support.

Field catalog (field_path — type — meaning):
{catalog}

Value formats: booleans as "true"/"false"; countries as ISO 3166-1 alpha-2 codes ("US", "DE", "CN"); list fields as
ONE entry per item (repeat the field_path); enums must use the listed values; numbers/strings as stated on the page.
proxy = true when the value is inferred from an indirect signal (e.g. an office address used for HQ country, a named
camera model used for stereo capture) rather than stated directly. confidence is your 0-1 belief in the value.
name = the company's name; primary_domain = the company's main website domain (e.g. "example.com");
country = HQ country code if a fetched page states it, else null.

Return only the JSON object.
"""


def _norm_url(u: str | None) -> str:
    return (u or "").strip().rstrip("/").lower()


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().casefold()


def snippet_in_text(snippet: str | None, text: str | None) -> bool:
    """True when the snippet is a verbatim quote of the page (whitespace/case-insensitive).
    Tolerates trimmed edges: any 6-word window of the snippet appearing in the page counts."""
    if not snippet or not text:
        return False
    s, t = _squash(snippet), _squash(text)
    if s in t:
        return True
    words = s.split()
    if len(words) < 6:
        return False
    for i in range(0, len(words) - 5):
        if " ".join(words[i:i + 6]) in t:
            return True
    return False


class WebSearchLLMAdapter:
    name = "web_search_llm"

    def __init__(self, vendor_type: str, field_catalog: Iterable[FieldSpec] = (), vendor_description: str = "",
                 *, client: anthropic.Anthropic | None = None, model: str | None = None,
                 run_dir: str | os.PathLike | None = None, max_searches_per_query: int = 3,
                 max_fetches_per_page: int = 3, effort_discover: str = "low", effort_normalize: str = "medium") -> None:
        self.vendor_type = vendor_type
        self.field_catalog = tuple(field_catalog)
        self.vendor_description = vendor_description or vendor_type
        self.client = client or anthropic.Anthropic()
        self.model = model or os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODEL)
        self.run_dir = Path(run_dir) if run_dir else None
        self.max_searches = max(1, int(max_searches_per_query))
        self.max_fetches = max(1, int(max_fetches_per_page))
        self.effort_discover = effort_discover
        self.effort_normalize = effort_normalize
        self.usage: dict[str, int] = {
            "api_calls": 0, "input_tokens": 0, "output_tokens": 0, "web_search_requests": 0, "web_fetch_requests": 0,
        }
        self._lock = threading.Lock()

    # --- plumbing ---------------------------------------------------------------

    def _record_usage(self, resp: anthropic.types.Message) -> None:
        u = resp.usage
        stu = getattr(u, "server_tool_use", None)
        with self._lock:
            self.usage["api_calls"] += 1
            self.usage["input_tokens"] += int(u.input_tokens or 0)
            self.usage["output_tokens"] += int(u.output_tokens or 0)
            if stu is not None:
                self.usage["web_search_requests"] += int(getattr(stu, "web_search_requests", 0) or 0)
                self.usage["web_fetch_requests"] += int(getattr(stu, "web_fetch_requests", 0) or 0)

    def _persist(self, name: str, obj: dict[str, Any]) -> None:
        if self.run_dir is None:
            return
        self.run_dir.mkdir(parents=True, exist_ok=True)
        with open(self.run_dir / f"{name}.json", "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False, indent=1, default=str)

    def _call(self, *, prompt: str, tools: list[dict[str, Any]], effort: str, schema: dict[str, Any],
              max_tokens: int = 8000) -> tuple[anthropic.types.Message, list[Any]]:
        """One Messages API call with a server tool + strict JSON output.
        Resumes `pause_turn` transparently; returns the final message and ALL content blocks seen."""
        messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
        blocks: list[Any] = []
        resp = None
        for _ in range(4):
            resp = self.client.messages.create(
                model=self.model, max_tokens=max_tokens, messages=messages, tools=tools,
                output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            )
            self._record_usage(resp)
            blocks.extend(resp.content)
            if resp.stop_reason == "pause_turn":
                messages = messages + [{"role": "assistant", "content": resp.content}]
                continue
            break
        assert resp is not None
        return resp, blocks

    @staticmethod
    def _final_json(blocks: list[Any]) -> dict[str, Any] | None:
        texts = [b.text for b in blocks if getattr(b, "type", None) == "text" and b.text and b.text.strip()]
        for candidate in ([texts[-1]] if texts else []) + ["".join(texts)]:
            try:
                data = json.loads(candidate)
                if isinstance(data, dict):
                    return data
            except (ValueError, TypeError):
                continue
        return None

    @staticmethod
    def _dump(resp: anthropic.types.Message) -> dict[str, Any]:
        return resp.model_dump(mode="json")

    # --- contract ---------------------------------------------------------------

    def discover(self, q: DiscoveryQuery) -> Iterable[RawRecord]:
        tools = [{"type": WEB_SEARCH_TOOL, "name": "web_search", "max_uses": self.max_searches}]
        seen_urls: set[str] = set()
        seen_domains: list[str] = []  # steer later queries towards companies not found yet
        for i, keyword in enumerate(q.keywords):
            already = ("Companies already found by earlier queries (find OTHER ones): " + ", ".join(seen_domains[-60:])
                       if seen_domains else "")
            prompt = DISCOVER_PROMPT.format(vendor_description=self.vendor_description, query=keyword,
                                            n=self.max_searches, already_found=already)
            try:
                resp, blocks = self._call(prompt=prompt, tools=tools, effort=self.effort_discover, schema=DISCOVER_SCHEMA)
            except anthropic.APIError as exc:
                log.error("discover[%d] %r failed: %s", i, keyword, exc)
                self._persist(f"search_{i:02d}", {"seed_query": keyword, "error": str(exc)})
                if is_fatal(exc):
                    raise AdapterFatalError(str(exc)) from exc
                continue
            self._persist(f"search_{i:02d}", {"seed_query": keyword, "response": self._dump(resp)})
            if resp.stop_reason == "refusal":
                log.warning("discover[%d] refused: %s", i, getattr(resp, "stop_details", None))
                continue
            fetched_at = utcnow()
            results: list[dict[str, Any]] = []
            search_query = keyword
            for b in blocks:
                if b.type == "server_tool_use":
                    search_query = (b.input or {}).get("query", search_query)
                elif b.type == "web_search_tool_result":
                    content = b.content
                    if not isinstance(content, list):
                        log.warning("discover[%d] search error: %s", i, content)
                        continue
                    for r in content:
                        if getattr(r, "type", None) != "web_search_result" or not getattr(r, "url", None):
                            continue
                        results.append({"url": r.url, "title": getattr(r, "title", None),
                                        "page_age": getattr(r, "page_age", None), "search_query": search_query})
            data = self._final_json(blocks) or {}
            judgments = {_norm_url(c.get("url")): c for c in data.get("candidates", []) if isinstance(c, dict)}
            # any URL the model listed but that did not appear in a result block is still a hit it saw
            for key, c in judgments.items():
                if key and key not in {_norm_url(r["url"]) for r in results}:
                    results.append({"url": c["url"], "title": c.get("name"), "page_age": None,
                                    "search_query": search_query, "from_llm_list": True})
            n = 0
            for r in results:
                key = _norm_url(r["url"])
                if not key or key in seen_urls:
                    continue
                seen_urls.add(key)
                dom = normalize_domain(r["url"])
                if dom and dom not in seen_domains and dom not in SKIP_DOMAINS:
                    seen_domains.append(dom)
                payload = {**r, "seed_query": keyword, "seed_index": i, "llm_prefilter": judgments.get(key)}
                yield RawRecord(payload=payload, source_url=r["url"], fetched_at=fetched_at)
                n += 1
                if q.limit and n >= q.limit:
                    break

    def normalize(self, raw: RawRecord) -> tuple[VendorCandidate, list[Evidence]]:
        url = raw.source_url or ""
        host = normalize_domain(url) or ""
        title = raw.payload.get("title") or (raw.payload.get("llm_prefilter") or {}).get("name") or host
        base = dict(vendor_type=self.vendor_type, primary_domain=host or None, source_url=url or None,
                    discovered_via=self.name)
        if not host or host in SKIP_DOMAINS or any(host.endswith("." + d) for d in SKIP_DOMAINS):
            return VendorCandidate(name=title, page_type="other", extras={"skipped": "domain_skiplist"}, **base), []

        other_urls = [u for u in raw.payload.get("other_urls", []) if _norm_url(u) != _norm_url(url)][:5]
        catalog = "\n".join(
            f"- {f.path} — {f.type}{(' ' + json.dumps(list(f.enum))) if f.enum else ''} — {f.description}"
            for f in self.field_catalog) or "- (none)"
        prompt = NORMALIZE_PROMPT.format(vendor_description=self.vendor_description, url=url,
                                         other_urls=", ".join(other_urls) or "(none)",
                                         extra=self.max_fetches - 1, catalog=catalog)
        tools = [{"type": WEB_FETCH_TOOL, "name": "web_fetch", "max_uses": self.max_fetches}]
        resp, blocks = self._call(prompt=prompt, tools=tools, effort=self.effort_normalize, schema=NORMALIZE_SCHEMA)
        self._persist(f"normalize_{slugify(host)}", {"raw": raw.to_json(), "response": self._dump(resp)})
        if resp.stop_reason == "refusal":
            return VendorCandidate(name=title, page_type="other", extras={"error": "refusal"}, **base), []

        # pages actually fetched -> their plain text (for verbatim-snippet verification)
        fetched: dict[str, str | None] = {}
        for b in blocks:
            if b.type != "web_fetch_tool_result":
                continue
            c = b.content
            if getattr(c, "type", None) != "web_fetch_result":
                continue
            text = None
            doc = getattr(c, "content", None)
            src = getattr(doc, "source", None)
            if src is not None and getattr(src, "type", None) == "text":
                text = getattr(src, "data", None)
            fetched[_norm_url(getattr(c, "url", None))] = text
        if not fetched:
            return VendorCandidate(name=title, page_type="other", extras={"error": "fetch_failed"}, **base), []

        data = self._final_json(blocks)
        if not data:
            return VendorCandidate(name=title, page_type="other", extras={"error": "no_json"}, **base), []

        page_type = data.get("page_type") if data.get("page_type") in PAGE_TYPES else "other"
        name = (data.get("name") or "").strip() or title
        primary_domain = normalize_domain(data.get("primary_domain")) or host
        candidate = VendorCandidate(
            name=name, vendor_type=self.vendor_type, primary_domain=primary_domain,
            country=(data.get("country") or None), page_type=page_type, source_url=url or None,
            discovered_via=self.name,
            extras={"fetched_urls": sorted(k for k in fetched), "seed_query": raw.payload.get("seed_query"),
                    "title": title, "llm_prefilter": raw.payload.get("llm_prefilter")},
        )
        if page_type != "vendor_site":
            return candidate, []

        allowed = {f.path for f in self.field_catalog}
        observed_at = utcnow()
        evidence: list[Evidence] = []
        dropped: list[dict[str, Any]] = []
        for f in data.get("fields", []):
            if not isinstance(f, dict):
                continue
            fp = str(f.get("field_path") or "")
            value = str(f.get("value") or "").strip()
            if fp not in allowed or value.casefold() in PLACEHOLDERS:
                dropped.append(f)
                continue
            src = (f.get("source_url") or "").strip() or None
            snippet = (f.get("snippet") or "").strip() or None
            page_text = fetched.get(_norm_url(src)) if src else None
            src_fetched = bool(src) and _norm_url(src) in fetched
            # verified only when we fetched that URL and the snippet is a verbatim quote of it
            # (when the page came back as a non-text document we cannot check the quote and trust the URL + snippet)
            quote_ok = snippet_in_text(snippet, page_text) if page_text else bool(snippet)
            verified = bool(src) and bool(snippet) and src_fetched and quote_ok
            try:
                conf = float(f.get("confidence")) if f.get("confidence") is not None else None
            except (TypeError, ValueError):
                conf = None
            evidence.append(Evidence(
                field_path=fp, value=value, source_url=src, extraction_method="llm", snippet=snippet,
                confidence=conf, proxy=bool(f.get("proxy")), verified=verified, observed_at=observed_at,
            ))
        candidate.extras["dropped_fields"] = dropped
        for e in evidence:
            if e.field_path == "contact.email" and e.verified and not candidate.contact_email:
                candidate.contact_email = e.value
        return candidate, evidence
