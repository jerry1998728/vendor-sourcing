import { NextResponse } from "next/server";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { REQUIREMENT_MAX_CHARS, REQUIREMENT_MIN_CHARS } from "@/lib/shared/inputs";

import { getAnthropic, modelFor, supportsEffort } from "@/lib/llm/client";
import { SeedQueriesOutput, VENDOR_TYPES } from "@/lib/pipeline/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  vendor_type: z.enum(VENDOR_TYPES),
  requirement: z.string().trim().min(REQUIREMENT_MIN_CHARS).max(REQUIREMENT_MAX_CHARS),
  count: z.number().int().min(3).max(12).default(8),
});

const SYSTEM = `You write web search queries for a vendor-sourcing analyst.
Given a vendor category and a plain-language requirement, produce distinct search queries (5-12 words each) that surface the websites of companies offering that product or service.
Vary the vocabulary: industry terms, product names, capture methods, use cases, buyer language. Avoid phrasing that finds news, list articles ("top 10"), directories or academic papers. Do not include quotes or search operators.`;

/** LLM-generated, editable seed queries for a custom web search. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const { vendor_type, requirement, count } = parsed.data;
  try {
    const model = modelFor("seed_queries");
    const res = await getAnthropic().messages.parse({
      model,
      max_tokens: 2000,
      output_config: {
        ...(supportsEffort(model) ? { effort: "low" as const } : {}),
        format: zodOutputFormat(SeedQueriesOutput),
      },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Vendor category: ${vendor_type}\nRequirement: ${requirement}\n\nReturn exactly ${count} queries.`,
        },
      ],
    });
    const out = res.parsed_output ? SeedQueriesOutput.parse(res.parsed_output) : null;
    if (!out) return NextResponse.json({ error: `model returned no parseable output (${res.stop_reason})` }, { status: 502 });
    const queries = [...new Set(out.queries.map((q) => q.trim()).filter((q) => q.length >= 3))].slice(0, count);
    return NextResponse.json({ queries, usage: res.usage });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
