import type { SourceAdapter } from "@/lib/pipeline/types";
import { githubOrgAdapter } from "./githubOrg";
import { webSearchLlmAdapter } from "./webSearchLlm";

const ADAPTERS: Record<string, SourceAdapter> = {
  [webSearchLlmAdapter.name]: webSearchLlmAdapter,
  [githubOrgAdapter.name]: githubOrgAdapter,
};

export function getAdapter(name: string): SourceAdapter {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown adapter "${name}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
  return a;
}

export function listAdapters(): string[] {
  return Object.keys(ADAPTERS);
}
