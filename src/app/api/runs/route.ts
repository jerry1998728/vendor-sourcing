import { NextResponse, after } from "next/server";
import { z } from "zod";

import { findActiveRun, listRuns, runStatus } from "@/lib/db/queries";
import { createRun, executeRun, findReplaySource } from "@/lib/pipeline/run";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  config: z.string().regex(/^[a-z0-9_]+$/),
  /** CLAUDE.md cost control: re-extract the latest finished run's persisted candidates, skip search. */
  replay: z.boolean().optional(),
  /** explicit candidate cap; overrides the development default (5) */
  limit: z.number().int().positive().max(200).optional(),
});

/** Start a run for a config. Returns 202 with the run_id; poll GET /api/runs/[id]. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON: { config }" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "body must be { config: <configs/*.yaml name>, replay?: boolean, limit?: number }" },
      { status: 400 },
    );
  }
  const { config, replay, limit } = parsed.data;

  const active = findActiveRun(config);
  if (active) {
    return NextResponse.json(
      { error: `run ${active.run_id} for ${config} is still in progress`, run_id: active.run_id },
      { status: 409 },
    );
  }

  let replayOf: string | undefined;
  if (replay) {
    const source = findReplaySource(config);
    if (!source) {
      return NextResponse.json({ error: `no finished previous run of ${config} to replay` }, { status: 400 });
    }
    replayOf = source.run_id;
  }

  let run;
  try {
    run = createRun(config, { replayOf, limit });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  const runId = run.run_id;
  after(async () => {
    try {
      await executeRun(runId);
    } catch (err) {
      console.error(`[run ${runId}] crashed`, err);
    }
  });

  return NextResponse.json({ run_id: runId, run, status: runStatus(run) }, { status: 202 });
}

export async function GET() {
  const rows = listRuns();
  return NextResponse.json({ runs: rows.map((run) => ({ ...run, status: runStatus(run) })) });
}
