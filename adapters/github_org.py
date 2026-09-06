"""`github_org` adapter (H1a, D1 PM): organizations whose public GitHub activity signals a large,
production-grade codebase.  Structured source -> evidence rows with extraction_method='api'
whose source_url is always the repo or org URL.

discover()  : GitHub repository search per seed query -> one RawRecord per owning organization (cap 50 orgs)
normalize() : one VendorCandidate per org with evidence rows
              merged_prs_public (proxy=true), ci_config, release_tags, test_directory, license, lockfile,
              last_commit_days, is_fork_or_tutorial, attributable_public_entity (+ org.public_repos,
              entity.location, entity.website, contact.email)
All judgment lives in rulesets/repo_owner.v1.yaml; this adapter only measures.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from core.models import DiscoveryQuery, Evidence, FieldSpec, RawRecord, VendorCandidate, normalize_domain, slugify, utcnow

TOY_RE = re.compile(r"\b(awesome|tutorial|example|examples|demo|demos|starter|boilerplate|course|homework|playground|sample|"
                    r"samples|template|templates|hello[- ]world|dotfiles|blog|workshop|exercise|exercises|kata|learning|"
                    r"cheatsheet|interview|leetcode)\b", re.I)
LOCKFILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "pipfile.lock", "cargo.lock", "go.sum",
             "gemfile.lock", "composer.lock", "uv.lock", "packages.lock.json", "mix.lock", "pubspec.lock", "bun.lockb", "bun.lock"}
TEST_DIRS = {"test", "tests", "spec", "specs", "__tests__", "testing", "e2e", "integration_tests", "unittests"}
CI_FILES = {".travis.yml", ".gitlab-ci.yml", "jenkinsfile", "azure-pipelines.yml", ".circleci", "bitbucket-pipelines.yml",
            ".drone.yml", "cloudbuild.yaml", ".buildkite", "appveyor.yml"}
SIGNALS = ("ci_config", "release_tags", "test_directory", "license", "lockfile")
# hosts that many orgs share: never a vendor's own primary domain (PK falls back to slug(name)+type)
SHARED_HOSTS = {"github.com", "github.io", "sites.google.com", "linktr.ee", "notion.site", "medium.com", "twitter.com", "x.com",
                "linkedin.com", "youtube.com", "gitlab.com", "bitbucket.org", "huggingface.co", "readthedocs.io", "substack.com"}


@dataclass
class RepoInfo:
    full_name: str
    html_url: str
    owner_login: str
    owner_type: str
    default_branch: str = "main"
    fork: bool = False
    archived: bool = False
    description: str = ""
    stars: int = 0
    pushed_at: str | None = None            # ISO
    license: str | None = None
    topics: list[str] = field(default_factory=list)


@dataclass
class OrgInfo:
    login: str
    html_url: str
    name: str | None = None
    blog: str | None = None
    location: str | None = None
    email: str | None = None
    description: str | None = None
    public_repos: int = 0
    api_url: str = ""


def _with_backoff(fn: Callable[[], Any], what: str, attempts: int = 3) -> Any:
    """Retry PyGithub calls on primary/secondary rate limits."""
    from github import GithubException, RateLimitExceededException
    for i in range(attempts):
        try:
            return fn()
        except RateLimitExceededException as exc:
            reset = getattr(getattr(exc, "headers", None), "get", lambda *_: None)("x-ratelimit-reset")
            wait = 60.0
            try:
                if reset:
                    wait = max(5.0, float(reset) - time.time() + 2)
            except ValueError:
                pass
            time.sleep(min(wait, 120.0))
        except GithubException as exc:
            if exc.status in (403, 429) and "rate" in str(exc).lower() and i < attempts - 1:
                time.sleep(30 * (i + 1))
                continue
            raise
    return fn()


class GitHubGateway:
    """All PyGithub calls in one place so the adapter is testable with a fake."""

    def __init__(self, token: str | None = None) -> None:
        from github import Auth, Github
        tok = token or os.environ.get("GITHUB_TOKEN")
        self.gh = Github(auth=Auth.Token(tok), per_page=50) if tok else Github(per_page=50)

    @staticmethod
    def _repo(r: Any) -> RepoInfo:
        lic = None
        try:
            lic = r.license.spdx_id if r.license else None
        except Exception:
            lic = None
        return RepoInfo(full_name=r.full_name, html_url=r.html_url, owner_login=r.owner.login, owner_type=r.owner.type,
                        default_branch=r.default_branch or "main", fork=bool(r.fork), archived=bool(r.archived),
                        description=r.description or "", stars=int(r.stargazers_count or 0),
                        pushed_at=r.pushed_at.replace(tzinfo=timezone.utc).isoformat() if r.pushed_at else None, license=lic)

    def search_repos(self, query: str, limit: int) -> list[RepoInfo]:
        def go() -> list[RepoInfo]:
            out = []
            for r in self.gh.search_repositories(query=query, sort="stars", order="desc"):
                out.append(self._repo(r))
                if len(out) >= limit:
                    break
            return out
        return _with_backoff(go, "search")

    def get_org(self, login: str) -> OrgInfo:
        o = _with_backoff(lambda: self.gh.get_organization(login), "org")
        return OrgInfo(login=o.login, html_url=o.html_url, name=o.name, blog=o.blog, location=o.location, email=o.email,
                       description=o.description, public_repos=int(o.public_repos or 0), api_url=o.url)

    def org_repos(self, login: str, limit: int) -> list[RepoInfo]:
        def go() -> list[RepoInfo]:
            out = []
            for r in self.gh.get_organization(login).get_repos(type="public", sort="pushed", direction="desc"):
                out.append(self._repo(r))
                if len(out) >= limit:
                    break
            return out
        return _with_backoff(go, "repos")

    def root_paths(self, repo: RepoInfo) -> list[str]:
        try:
            r = _with_backoff(lambda: self.gh.get_repo(repo.full_name), "repo")
            return [e.path for e in _with_backoff(lambda: r.get_git_tree(repo.default_branch), "tree").tree]
        except Exception:
            return []

    def has_workflows(self, repo: RepoInfo) -> bool:
        try:
            return bool(_with_backoff(lambda: self.gh.get_repo(repo.full_name).get_contents(".github/workflows"), "workflows"))
        except Exception:
            return False

    def has_releases(self, repo: RepoInfo) -> bool:
        try:
            r = _with_backoff(lambda: self.gh.get_repo(repo.full_name), "repo")
            if _with_backoff(lambda: r.get_releases().totalCount, "releases") > 0:
                return True
            return _with_backoff(lambda: r.get_tags().totalCount, "tags") > 0
        except Exception:
            return False

    def merged_pr_count(self, login: str) -> int:
        """Exact total_count from the search API (PaginatedList.totalCount is capped at the 1000-result window)."""
        q = f"org:{login} is:pr is:merged"
        try:
            requester = getattr(self.gh, "requester", None) or getattr(self.gh, "_Github__requester")
            _, data = _with_backoff(lambda: requester.requestJsonAndCheck("GET", "/search/issues", parameters={"q": q, "per_page": 1}), "pr-search")
            return int(data.get("total_count", -1))
        except Exception:
            try:
                return int(_with_backoff(lambda: self.gh.search_issues(query=q).totalCount, "pr-search"))
            except Exception:
                return -1


def proxy_hits(paths: list[str], repo: RepoInfo, has_workflows: bool, has_releases: bool) -> dict[str, bool]:
    lower = {p.lower() for p in paths}
    return {
        "ci_config": has_workflows or bool(lower & CI_FILES),
        "release_tags": has_releases,
        "test_directory": bool(lower & TEST_DIRS),
        "license": bool(repo.license) or any(p.startswith("license") or p.startswith("copying") for p in lower),
        "lockfile": bool(lower & LOCKFILES),
    }


def looks_toy(repo: RepoInfo) -> bool:
    return bool(TOY_RE.search(repo.full_name.split("/")[-1])) or bool(TOY_RE.search(repo.description or ""))


def days_since(iso: str | None, now: datetime) -> int | None:
    if not iso:
        return None
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return max(0, (now - dt).days)


class GitHubOrgAdapter:
    name = "github_org"

    def __init__(self, vendor_type: str = "repo_owner", field_catalog: Iterable[FieldSpec] = (), vendor_description: str = "",
                 *, gateway: GitHubGateway | None = None, run_dir: str | os.PathLike | None = None,
                 repos_per_query: int = 40, repos_per_org: int = 8, min_stars: int = 100, max_orgs: int = 50,
                 model: str | None = None, **_: Any) -> None:
        self.vendor_type = vendor_type
        self.field_catalog = tuple(field_catalog)
        self.vendor_description = vendor_description
        self.gateway = gateway or GitHubGateway()
        self.run_dir = Path(run_dir) if run_dir else None
        self.repos_per_query, self.repos_per_org, self.min_stars, self.max_orgs = repos_per_query, repos_per_org, min_stars, max_orgs
        self.model = "github-api"
        self.usage: dict[str, int] = {"api_calls": 0, "search_calls": 0}

    def _persist(self, name: str, obj: dict[str, Any]) -> None:
        if self.run_dir is None:
            return
        self.run_dir.mkdir(parents=True, exist_ok=True)
        (self.run_dir / f"{name}.json").write_text(json.dumps(obj, indent=1, default=str), encoding="utf-8")

    # --- contract ---------------------------------------------------------------

    def discover(self, q: DiscoveryQuery) -> Iterable[RawRecord]:
        """Search public repos; yield one RawRecord per owning Organization (users skipped), cap max_orgs."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d")
        seen: set[str] = set()
        for i, kw in enumerate(q.keywords):
            if len(seen) >= self.max_orgs:
                break
            query = kw if re.search(r"\b(topic|language|stars|pushed|org|user):", kw) else f"{kw} in:name,description,topics"
            query += f" stars:>={self.min_stars} pushed:>={cutoff} fork:false archived:false"
            repos = self.gateway.search_repos(query, self.repos_per_query)
            self.usage["search_calls"] += 1
            self._persist(f"search_{i:02d}", {"seed_query": kw, "search_query": query, "repos": [r.__dict__ for r in repos]})
            n = 0
            for r in repos:
                if r.owner_type != "Organization" or r.owner_login.lower() in seen:
                    continue
                if len(seen) >= self.max_orgs:
                    break
                seen.add(r.owner_login.lower())
                yield RawRecord(payload={"org_login": r.owner_login, "org_url": f"https://github.com/{r.owner_login}",
                                         "dedup_key": f"github:{r.owner_login.lower()}",
                                         "seed_query": kw, "search_query": query, "sample_repo": r.__dict__},
                                source_url=f"https://github.com/{r.owner_login}", fetched_at=utcnow())
                n += 1
                if q.limit and n >= q.limit:
                    break

    def normalize(self, raw: RawRecord) -> tuple[VendorCandidate, list[Evidence]]:
        login = raw.payload["org_login"]
        now = datetime.now(timezone.utc)
        org = self.gateway.get_org(login)
        repos = [r for r in self.gateway.org_repos(login, self.repos_per_org) if not r.archived]
        self.usage["api_calls"] += 2
        measured: list[dict[str, Any]] = []
        for r in repos:
            paths = self.gateway.root_paths(r)
            hits = proxy_hits(paths, r, self.gateway.has_workflows(r), self.gateway.has_releases(r))
            self.usage["api_calls"] += 3
            measured.append({"repo": r.full_name, "html_url": r.html_url, "hits": hits, "hit_count": sum(hits.values()),
                             "fork": r.fork, "toy": looks_toy(r), "days_since_push": days_since(r.pushed_at, now), "stars": r.stars})
        merged = self.gateway.merged_pr_count(login)
        self.usage["search_calls"] += 1
        self._persist(f"normalize_{slugify(login)}", {"raw": raw.to_json(), "org": org.__dict__, "repos": measured, "merged_prs": merged})

        website = normalize_domain(org.blog) if org.blog else None
        shared_host = website is None or any(website == h or website.endswith("." + h) for h in SHARED_HOSTS)
        domain = None if shared_host else website
        cand = VendorCandidate(name=org.name or org.login, vendor_type=self.vendor_type, primary_domain=domain,
                               source_url=org.html_url if domain else None, page_type="vendor_site", discovered_via=self.name,
                               extras={"github_login": org.login, "github_url": org.html_url, "repos_measured": len(measured),
                                       "dedup_key": f"github:{org.login.lower()}"})
        if not domain:  # PK falls back to slug(name)+type when the org has no website
            cand.extras["fallback_id"] = f"{slugify(org.login)}+{self.vendor_type}"
        observed_at = utcnow()
        ev: list[Evidence] = []

        def api(fp: str, value: Any, url: str, snippet: str, conf: float = 0.9, proxy: bool = False) -> None:
            ev.append(Evidence(fp, str(value).lower() if isinstance(value, bool) else str(value), url, "api", snippet, conf,
                               proxy=proxy, verified=True, observed_at=observed_at))

        real = [m for m in measured if not m["toy"] and not m["fork"]]
        best = max(real, key=lambda m: (m["hit_count"], m["stars"]), default=None) or (measured[0] if measured else None)
        if best:
            found = ", ".join(k for k, v in best["hits"].items() if v) or "none"
            for sig in SIGNALS:
                api(sig, best["hits"][sig], best["html_url"], f"{best['repo']}: {sig} = {best['hits'][sig]} (signals present: {found})", 0.9, proxy=True)
            api("is_fork_or_tutorial", not real, best["html_url"],
                (f"{best['repo']}: not a fork and no tutorial/demo/awesome markers" if real
                 else f"every measured public repo is a fork or looks like a tutorial/demo/awesome-list (e.g. {best['repo']})"), 0.75, proxy=True)
        recent = min((m for m in measured if m["days_since_push"] is not None), key=lambda m: m["days_since_push"], default=None)
        if recent:
            api("last_commit_days", recent["days_since_push"], recent["html_url"], f"{recent['repo']}: last push {recent['days_since_push']} days ago", 0.95)
        if merged >= 0:
            api("merged_prs_public", merged, org.html_url, f"GitHub search org:{login} is:pr is:merged -> {merged} merged pull requests across public repos", 0.9, proxy=True)
        # attributable = we can name who we would contract with: a website / email / location, or a named org with a description
        attributable = bool(org.blog or org.email or org.location) or (bool(org.name) and bool(org.description))
        api("attributable_public_entity", attributable, org.html_url,
            f"GitHub organization {login}: name={org.name or '-'}, website={org.blog or '-'}, location={org.location or '-'}, email={org.email or '-'}", 0.85, proxy=True)
        api("org.public_repos", org.public_repos, org.html_url, f"{login}: public_repos = {org.public_repos}", 0.95)
        if org.location:
            api("entity.location", org.location, org.html_url, f"profile location: {org.location}", 0.8, proxy=True)
        if org.email:
            api("contact.email", org.email, org.html_url, f"profile email: {org.email}", 0.9)
            cand.contact_email = org.email
        if org.blog:
            api("entity.website", org.blog, org.html_url, f"profile website: {org.blog}", 0.9)
        allowed = {f.path for f in self.field_catalog}
        if allowed:
            ev = [e for e in ev if e.field_path in allowed]
        return cand, ev
