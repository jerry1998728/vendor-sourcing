import { NextResponse } from "next/server";
import { z } from "zod";

import { REQUIREMENT_MAX_CHARS, REQUIREMENT_MIN_CHARS } from "@/lib/shared/inputs";

import { VENDOR_TYPES } from "@/lib/pipeline/types";
import { listConfigs, writeConfig } from "@/lib/rulesets/loader";

export const dynamic = "force-dynamic";

const name = z.string().trim().regex(/^[a-z0-9_]{3,60}$/).optional();
const rulesetRef = z.string().regex(/^[a-z0-9_]+@v\d+$/);

const BodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("web_search"),
    name,
    vendor_type: z.enum(VENDOR_TYPES),
    ruleset: rulesetRef,
    description: z.string().trim().max(500).optional(),
    requirement: z.string().trim().min(REQUIREMENT_MIN_CHARS).max(REQUIREMENT_MAX_CHARS),
    seed_queries: z.array(z.string().trim().min(3).max(200)).min(1).max(20),
    limit: z.number().int().min(1).max(200).optional(),
    exclude_domains: z.array(z.string().trim().min(3)).max(50).optional(),
  }),
  z.object({
    kind: z.literal("github"),
    name,
    vendor_type: z.enum(VENDOR_TYPES),
    ruleset: rulesetRef,
    description: z.string().trim().max(500).optional(),
    requirement: z.string().trim().max(REQUIREMENT_MAX_CHARS).optional(),
    languages: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
    min_merged_prs: z.number().int().min(0).optional(),
    activity_window_days: z.number().int().min(1).max(3650).optional(),
    min_stars: z.number().int().min(0).optional(),
    exclude_keywords: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
]);

export async function GET() {
  return NextResponse.json({ configs: listConfigs() });
}

/** Write a new configs/<name>.yaml (a new category is one config + one ruleset, no code). */
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
  try {
    const config = writeConfig(parsed.data);
    return NextResponse.json({ name: config.name, path: config.path, config }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
