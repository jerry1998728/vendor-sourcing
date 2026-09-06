import { NextResponse } from "next/server";

import { getRun, requestCancel, runStatus } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

/** Ask a running run (discovery or refresh) to stop after the vendor it is on. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: `run ${id} not found` }, { status: 404 });
  if (run.finished_at) return NextResponse.json({ error: `run ${id} already finished (${runStatus(run)})` }, { status: 409 });
  const updated = requestCancel(id);
  return NextResponse.json({ ok: true, run: updated, status: updated ? runStatus(updated) : "running" }, { status: 202 });
}
