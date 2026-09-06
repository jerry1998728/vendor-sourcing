"""Adapter registry: config `adapter:` name -> SourceAdapter implementation."""
from __future__ import annotations

from typing import Any


def build_adapter(name: str, **kwargs: Any):
    if name == "web_search_llm":
        from adapters.web_search_llm import WebSearchLLMAdapter
        return WebSearchLLMAdapter(**kwargs)
    if name == "github_org":
        from adapters.github_org import GitHubOrgAdapter
        return GitHubOrgAdapter(**kwargs)
    raise KeyError(f"unknown adapter {name!r}")
