/** Raw payloads for every run live under data/runs/<run_id>/ (gitignored). */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** data/runs by default; RUNS_DIR overrides it (tests point it at a temp directory). */
export function runsDir(): string {
  return path.resolve(process.cwd(), process.env.RUNS_DIR ?? path.join("data", "runs"));
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `run_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
}

const RUN_ID_RE = /^run_[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/;

export function runDir(runId: string): string {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`invalid run id "${runId}"`);
  }
  const dir = path.join(runsDir(), runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolves a run's directory without creating it (for reading a replay source). */
function runDirReadOnly(runId: string): string {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`invalid run id "${runId}"`);
  }
  return path.join(runsDir(), runId);
}

export function relativeRunDir(runId: string): string {
  return path.relative(process.cwd(), runDir(runId));
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export async function persistJson(runId: string, name: string, payload: unknown): Promise<void> {
  const file = path.join(runDir(runId), safeName(name));
  await fs.promises.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
}

export async function appendJsonl(runId: string, name: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const file = path.join(runDir(runId), safeName(name));
  await fs.promises.appendFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/**
 * Cost control (CLAUDE.md): a replay reads a prior run's persisted candidate
 * list instead of calling discover() again, so re-extraction never re-runs
 * the (billed, rate-limited) search step.
 */
export async function readRawRecords(runId: string): Promise<unknown[]> {
  const file = path.join(runDirReadOnly(runId), "raw_records.jsonl");
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`run ${runId} has no raw_records.jsonl to replay`);
    }
    throw err;
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
