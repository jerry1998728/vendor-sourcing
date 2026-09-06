import { NextResponse } from "next/server";
import { z } from "zod";

import { listSchedules, upsertSchedule } from "@/lib/db/queries";
import { SCHEDULE_PRESETS, parseCron } from "@/lib/pipeline/cron";
import { loadConfig } from "@/lib/rulesets/loader";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ config: z.string().regex(/^[a-z0-9_]+$/), cron: z.string().trim().min(9).max(60), enabled: z.boolean() });

export async function GET() {
  return NextResponse.json({ schedules: listSchedules(), presets: SCHEDULE_PRESETS });
}

/** Upsert one schedule per config. Cron is 5-field, UTC. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "body must be { config, cron, enabled }" }, { status: 400 });
  if (!parseCron(parsed.data.cron)) return NextResponse.json({ error: `invalid cron "${parsed.data.cron}"` }, { status: 400 });
  try {
    loadConfig(parsed.data.config);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
  return NextResponse.json({ schedule: upsertSchedule(parsed.data) });
}
