/** Minimal 5-field cron (minute hour day-of-month month day-of-week), evaluated in UTC. */
export type CronSpec = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number> };

export const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at 03:00 UTC", cron: "0 3 * * *" },
  { label: "Weekdays at 07:00 UTC", cron: "0 7 * * 1-5" },
  { label: "Weekly, Monday 03:00 UTC", cron: "0 3 * * 1" },
];

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v === 7 && max === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dom = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dow = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  return (
    spec.minute.has(date.getUTCMinutes()) &&
    spec.hour.has(date.getUTCHours()) &&
    spec.dom.has(date.getUTCDate()) &&
    spec.month.has(date.getUTCMonth() + 1) &&
    spec.dow.has(date.getUTCDay())
  );
}

/** First fire time strictly after `from`, or null within the search window. */
export function nextFireAfter(spec: CronSpec, from: Date, windowMinutes = 60 * 24 * 8): Date | null {
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 1; i <= windowMinutes; i++) {
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    if (cronMatches(spec, t)) return new Date(t.getTime());
  }
  return null;
}

/** Due when a fire time exists after the last run (or the last 24h for a never-run schedule) and not after now. */
export function isDue(cron: string, lastRunAt: string | null, now: Date = new Date()): boolean {
  const spec = parseCron(cron);
  if (!spec) return false;
  const floor = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const from = lastRunAt && Date.parse(lastRunAt) > floor.getTime() ? new Date(lastRunAt) : floor;
  const next = nextFireAfter(spec, from);
  return next !== null && next.getTime() <= now.getTime();
}
