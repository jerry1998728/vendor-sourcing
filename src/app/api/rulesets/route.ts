import { NextResponse } from "next/server";
import { z } from "zod";

import { RulesetExistsError, listRulesets, readRulesetYaml, writeRuleset } from "@/lib/rulesets/loader";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]{3,60}$/, "lowercase letters, digits and underscores (3-60 characters)"),
  version: z.string().trim().regex(/^v\d{1,3}$/, "v1, v2, ..."),
  yaml: z.string().min(10).max(50_000),
});

/** GET lists every ruleset; GET ?ref=name@vN returns that file's YAML for the clone-and-edit dialog. */
export async function GET(req: Request) {
  const ref = new URL(req.url).searchParams.get("ref");
  if (!ref) return NextResponse.json({ rulesets: listRulesets() });
  try {
    return NextResponse.json({ ref, yaml: readRulesetYaml(ref) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 });
  }
}

/** Write a new rulesets/<name>.<version>.yaml (a new category is one config + one ruleset, no code). */
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
    const summary = writeRuleset(parsed.data);
    return NextResponse.json(summary, { status: 201 });
  } catch (err) {
    const status = err instanceof RulesetExistsError ? 409 : 400;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
