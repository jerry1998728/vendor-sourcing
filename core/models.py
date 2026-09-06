"""Shared dataclasses and the SourceAdapter contract (PRD Section 8).

Discovery = SourceAdapter(discover, normalize) + pure screen(vendor, evidence, ruleset).
Everything the stages exchange goes through SQLite; these types are the in-memory
shapes used inside one stage.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Literal, Protocol, runtime_checkable
from urllib.parse import urlparse

VENDOR_TYPES: tuple[str, ...] = ("repo_owner", "ego_data_supplier")
ScreenResult = Literal["pass", "fail", "unknown"]
Reason = dict[str, Any]  # JSON-serializable, reproducible
ExtractionMethod = Literal["api", "llm", "manual"]


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def normalize_domain(url_or_domain: str | None) -> str | None:
    """'https://www.Example.com/x' -> 'example.com'; None when unparseable."""
    if not url_or_domain:
        return None
    s = str(url_or_domain).strip().lower()
    if not s:
        return None
    if "://" not in s:
        s = "http://" + s
    host = (urlparse(s).hostname or "").strip(".")
    if host.startswith("www."):
        host = host[4:]
    return host or None


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-") or "unnamed"


# --- adapter I/O ---------------------------------------------------------------

@dataclass(frozen=True)
class DiscoveryQuery:
    keywords: tuple[str, ...]
    filters: dict[str, Any] = field(default_factory=dict)
    limit: int = 20  # max raw records yielded per keyword


@dataclass
class RawRecord:
    """One raw hit from a source, persisted per run so a run is replayable."""
    payload: dict[str, Any]
    source_url: str | None
    fetched_at: str = field(default_factory=utcnow)

    def to_json(self) -> dict[str, Any]:
        return {"payload": self.payload, "source_url": self.source_url, "fetched_at": self.fetched_at}


@dataclass
class Evidence:
    """Field-level provenance.  Mirrors the `evidence` table.

    Hard rule: no source_url -> verified is forced to False.  For LLM extraction a
    missing snippet also forces verified=False.  Unverified rows are never
    promoted to vendors.attributes.
    """
    field_path: str
    value: str
    source_url: str | None
    extraction_method: ExtractionMethod = "llm"
    snippet: str | None = None
    confidence: float | None = None
    proxy: bool = False
    verified: bool = False
    observed_at: str = field(default_factory=utcnow)
    evidence_id: int | None = None   # assigned once persisted
    vendor_id: str | None = None

    def __post_init__(self) -> None:
        self.value = str(self.value).strip()
        self.source_url = (self.source_url or "").strip() or None
        self.snippet = (self.snippet or "").strip() or None
        if self.source_url is None:
            self.verified = False
        if self.extraction_method == "llm" and self.snippet is None:
            self.verified = False
        self.proxy = bool(self.proxy)
        self.verified = bool(self.verified)


@dataclass
class VendorCandidate:
    name: str
    vendor_type: str
    primary_domain: str | None = None
    country: str | None = None          # hint only; vendors.country is set from verified evidence
    contact_email: str | None = None
    page_type: str = "vendor_site"
    source_url: str | None = None
    discovered_via: str = ""
    extras: dict[str, Any] = field(default_factory=dict)

    @property
    def vendor_id(self) -> str:
        """PK rule: normalized domain, fallback slug(name)+type."""
        dom = normalize_domain(self.primary_domain) or normalize_domain(self.source_url)
        return dom if dom else f"{slugify(self.name)}+{self.vendor_type}"


# --- rulesets ------------------------------------------------------------------

RULE_OPS: tuple[str, ...] = (
    "exists", "is_true", "is_false", "eq", "in", "not_in", "none_in", "any_in", "count_gte", "gte", "lte",
)


@dataclass(frozen=True)
class Rule:
    field: str                      # evidence.field_path this rule reads
    op: str                         # one of RULE_OPS
    value: Any = None               # eq
    values: tuple[str, ...] = ()    # in / not_in / none_in / any_in
    min: float | None = None        # count_gte / gte
    max: float | None = None        # lte


@dataclass(frozen=True)
class Criterion:
    key: str
    kind: Literal["must", "should"]
    rules: tuple[Rule, ...]
    combine: Literal["all", "any", "min_pass"] = "all"
    description: str = ""
    min_pass: int | None = None     # combine == min_pass: how many rules must pass


@dataclass(frozen=True)
class FieldSpec:
    """What an adapter is asked to extract; every value still needs source_url + snippet."""
    path: str
    type: str = "string"            # boolean | string | number | country | list[country] | list[enum] | list[string]
    description: str = ""
    enum: tuple[str, ...] = ()

    @property
    def is_list(self) -> bool:
        return self.type.startswith("list")


@dataclass(frozen=True)
class Ruleset:
    name: str
    version: str
    must: tuple[Criterion, ...]
    should: tuple[Criterion, ...]
    fields: tuple[FieldSpec, ...] = ()
    description: str = ""
    path: str | None = None

    @property
    def version_string(self) -> str:
        return f"{self.name}@{self.version}"

    @property
    def must_fields(self) -> tuple[str, ...]:
        seen: list[str] = []
        for c in self.must:
            for r in c.rules:
                if r.field not in seen:
                    seen.append(r.field)
        return tuple(seen)


# --- adapter contract ----------------------------------------------------------

@runtime_checkable
class SourceAdapter(Protocol):
    name: str
    vendor_type: str

    def discover(self, q: DiscoveryQuery) -> Iterable[RawRecord]: ...

    def normalize(self, raw: RawRecord) -> tuple[VendorCandidate, list[Evidence]]: ...
