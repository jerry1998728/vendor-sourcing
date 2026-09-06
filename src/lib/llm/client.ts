/**
 * Single Anthropic client. Web search goes through the Messages API
 * server tool only (CLAUDE.md); no third-party search APIs.
 */
import Anthropic from "@anthropic-ai/sdk";

const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-5";

/**
 * CLAUDE.md model routing: haiku for extraction and classification; sonnet
 * for seed-query generation, email drafting and status inference.
 * "discovery" (shortlisting web_search results) is a classification-shaped
 * task, so it routes to haiku alongside extraction.
 */
export type LlmTask = "extraction" | "discovery" | "seed_queries" | "drafting" | "status_inference";

const MODEL_BY_TASK: Record<LlmTask, string> = {
  extraction: HAIKU,
  discovery: HAIKU,
  seed_queries: SONNET,
  drafting: SONNET,
  status_inference: SONNET,
};

/** Global override for local testing; the per-task routing table is the default. */
export function modelFor(task: LlmTask): string {
  return process.env.ANTHROPIC_MODEL ?? MODEL_BY_TASK[task];
}

/** claude-haiku-4-5 rejects output_config.effort with a 400; opus/sonnet accept it. */
export function supportsEffort(model: string): boolean {
  return !model.includes("haiku");
}

export type Effort = NonNullable<Anthropic.Messages.OutputConfig["effort"]>;
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
function effortFromEnv(name: string, fallback: Effort): Effort {
  const v = process.env[name];
  return v && (EFFORTS as readonly string[]).includes(v) ? (v as Effort) : fallback;
}
/** Search-and-list is routine work. */
export const DISCOVER_EFFORT = effortFromEnv("LLM_DISCOVER_EFFORT", "low");
/** Grounded extraction needs some care. */
export const EXTRACT_EFFORT = effortFromEnv("LLM_EXTRACT_EFFORT", "medium");

export type WebSearchToolType = "web_search_20250305" | "web_search_20260209";
/** CLAUDE.md pins the basic variant; the env var allows the newer one. */
export const WEB_SEARCH_TOOL_TYPE: WebSearchToolType =
  process.env.ANTHROPIC_WEB_SEARCH_TOOL === "web_search_20260209"
    ? "web_search_20260209"
    : "web_search_20250305";

export function webSearchTool(maxUses: number): Anthropic.Messages.ToolUnion {
  if (WEB_SEARCH_TOOL_TYPE === "web_search_20260209") {
    return { type: "web_search_20260209", name: "web_search", max_uses: maxUses };
  }
  return { type: "web_search_20250305", name: "web_search", max_uses: maxUses };
}

let client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set (put it in .env.local)");
    }
    client = new Anthropic({ maxRetries: 3, timeout: 240_000 });
  }
  return client;
}

export type LlmUsage = {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  web_searches: number;
};

export function emptyUsage(): LlmUsage {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, web_searches: 0 };
}

export function addUsage(total: LlmUsage, u: Anthropic.Messages.Usage | undefined): LlmUsage {
  if (!u) return total;
  total.calls += 1;
  total.input_tokens += u.input_tokens ?? 0;
  total.output_tokens += u.output_tokens ?? 0;
  total.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  total.web_searches += u.server_tool_use?.web_search_requests ?? 0;
  return total;
}
