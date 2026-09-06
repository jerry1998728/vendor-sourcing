"""Thin Claude wrapper used by the outreach (drafting) and track (status inference) stages.

Structured JSON via output_config.format; any API failure surfaces as LLMUnavailable so
callers can degrade safely (template draft, proposal routed to the human queue).
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable

DEFAULT_MODEL = "claude-opus-5"


class LLMUnavailable(RuntimeError):
    pass


class LLM:
    def __init__(self, client: Any = None, model: str | None = None) -> None:
        self._client = client
        self.model = model or os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODEL)

    @property
    def client(self) -> Any:
        if self._client is None:
            import anthropic
            if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
                raise LLMUnavailable("ANTHROPIC_API_KEY is not set (.env)")
            self._client = anthropic.Anthropic()
        return self._client

    def json(self, prompt: str, schema: dict[str, Any], *, system: str | None = None,
             effort: str = "medium", max_tokens: int = 4000) -> dict[str, Any]:
        import anthropic
        kwargs: dict[str, Any] = dict(
            model=self.model, max_tokens=max_tokens, messages=[{"role": "user", "content": prompt}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        )
        if system:
            kwargs["system"] = system
        try:
            resp = self.client.messages.create(**kwargs)
        except anthropic.APIError as exc:
            raise LLMUnavailable(str(exc)) from exc
        if resp.stop_reason == "refusal":
            raise LLMUnavailable(f"refused: {getattr(resp, 'stop_details', None)}")
        text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
        try:
            data = json.loads(text)
        except ValueError as exc:
            raise LLMUnavailable(f"non-JSON response: {text[:200]}") from exc
        if not isinstance(data, dict):
            raise LLMUnavailable("JSON response is not an object")
        return data


class FakeLLM:
    """Deterministic stand-in for tests and offline demos."""

    def __init__(self, handler: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
                 responses: list[dict[str, Any]] | None = None, fail: bool = False) -> None:
        self.handler = handler
        self.responses = list(responses or [])
        self.fail = fail
        self.calls: list[str] = []
        self.model = "fake"

    def json(self, prompt: str, schema: dict[str, Any], **_: Any) -> dict[str, Any]:
        self.calls.append(prompt)
        if self.fail:
            raise LLMUnavailable("fake failure")
        if self.handler:
            return self.handler(prompt, schema)
        if not self.responses:
            raise LLMUnavailable("no canned response")
        return self.responses.pop(0)
