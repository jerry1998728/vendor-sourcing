import { NextResponse, after } from "next/server";
import { z } from "zod";

import { findActiveRun, runStatus } from "@/lib/db/queries";
import { createRefresh, executeRefresh } from "@/lib/pipeline/refresh";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  config: z.string().regex(/^[a-z0-9_]+$/),
  vendor_ids: z.array(z.string().min(1)).max(500).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

/** P1: refresh a config's vendors (re-fetch, re-extract, diff). 202 with a runs row to poll. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON: { config, vendor_ids?, limit? }" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "body must be { config, vendor_ids?, limit? }" }, { status: 400 });
  const active = findActiveRun(parsed.data.config);
  if (active) return NextResponse.json({ error: `run ${active.run_id} for ${parsed.data.config} is still in progress`, run_id: active.run_id }, { status: 409 });
  let run;
  try {
    run = createRefresh(parsed.data.config, { vendorIds: parsed.data.vendor_ids, limit: parsed.data.limit });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  const runId = run.run_id;
  after(async () => {
    try {
      await executeRefresh(runId);
    } catch (err) {
      console.error(`[refresh ${runId}] crashed`, err);
    }
  });
  return NextResponse.json({ run_id: runId, run, status: runStatus(run), vendors: run.query.vendor_ids }, { status: 202 });
}
