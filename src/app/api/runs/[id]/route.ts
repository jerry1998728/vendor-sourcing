import { NextResponse } from "next/server";

import { getRun, runStatus } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

/** Progress for one run: counts, phase, step/total, finished_at. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: `run ${id} not found` }, { status: 404 });
  return NextResponse.json({ run, status: runStatus(run) });
}
