"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, LoaderCircle, Play, Sparkles, Upload } from "lucide-react";

import { SCREEN_CLASS, ScreenResultBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Run, RunCounts, ScreenResult } from "@/lib/db/schema";
import { VENDOR_TYPES, type VendorType } from "@/lib/pipeline/types";
import type { ScheduleWithRun } from "@/lib/db/queries";
import type { ConfigSummary, RulesetSummary } from "@/lib/rulesets/loader";
import { formatPct, shortRunId } from "@/lib/format";

import { RunProgress } from "./run-progress";
import { DEFAULT_RULESETS as DEFAULT_RULESET } from "@/lib/shared/rulesets";
import { postJson } from "@/lib/shared/http";

import { RunsList } from "./runs-list";
import { ScheduleCard } from "./schedule-card";
import { useRun } from "./use-run";


function VendorTypeSelect({ value, onChange, id }: { value: VendorType; onChange: (v: VendorType) => void; id: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as VendorType)}>
      <SelectTrigger id={id} className="w-40" aria-label="Vendor type">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {VENDOR_TYPES.map((t) => (
          <SelectItem key={t} value={t}>{t}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RulesetSelect({ rulesets, vendorType, value, onChange, id }: { rulesets: RulesetSummary[]; vendorType: VendorType; value: string; onChange: (v: string) => void; id: string }) {
  const options = rulesets.filter((r) => r.valid && r.vendor_type === vendorType);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-56" aria-label="Ruleset">
        <SelectValue placeholder="Ruleset" />
      </SelectTrigger>
      <SelectContent>
        {options.map((r) => (
          <SelectItem key={r.ref} value={r.ref}>{r.ref}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Custom web search
// ---------------------------------------------------------------------------

function CustomSearchCard({ rulesets }: { rulesets: RulesetSummary[] }) {
  const [vendorType, setVendorType] = React.useState<VendorType>("ego_data");
  const [ruleset, setRuleset] = React.useState(DEFAULT_RULESET.ego_data);
  const [requirement, setRequirement] = React.useState("");
  const [limit, setLimit] = React.useState(30);
  const [queries, setQueries] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [configName, setConfigName] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const run = useRun();

  const changeType = (t: VendorType) => {
    setVendorType(t);
    setRuleset(t === "ego_data" ? DEFAULT_RULESET.ego_data : "code_data_broker@v1");
  };

  const generate = async () => {
    setError(null);
    setGenerating(true);
    try {
      const data = await postJson<{ queries: string[] }>("/api/seed-queries", { vendor_type: vendorType, requirement, count: 8 });
      setQueries(data.queries.join("\n"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const saveAndRun = async () => {
    setError(null);
    setSaving(true);
    try {
      const seed = queries.split("\n").map((q) => q.trim()).filter(Boolean);
      const data = await postJson<{ name: string }>("/api/configs", {
        kind: "web_search",
        vendor_type: vendorType,
        ruleset,
        requirement,
        seed_queries: seed,
        limit,
      });
      setConfigName(data.name);
      await run.start(data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const queryCount = queries.split("\n").filter((q) => q.trim()).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Custom web search</CardTitle>
        <CardDescription>
          Describe the vendors you want; Claude proposes seed queries you can edit. Running saves a new config under configs/, so the search is repeatable.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-type">Vendor type</Label>
            <VendorTypeSelect id="ws-type" value={vendorType} onChange={changeType} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-ruleset">Ruleset</Label>
            <RulesetSelect id="ws-ruleset" rulesets={rulesets} vendorType={vendorType} value={ruleset} onChange={setRuleset} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-limit">Limit</Label>
            <Input id="ws-limit" type="number" min={1} max={200} className="w-24" value={limit} onChange={(e) => setLimit(Number(e.target.value) || 30)} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ws-requirement">Requirement</Label>
          <Textarea id="ws-requirement" rows={3} value={requirement} onChange={(e) => setRequirement(e.target.value)} placeholder="e.g. Companies collecting first-person video with stereo rigs for robotics training, outside China." />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="ws-queries">Seed queries (one per line, {queryCount})</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => void generate()} disabled={generating || requirement.trim().length < 10}>
              {generating ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              Generate seed queries
            </Button>
          </div>
          <Textarea id="ws-queries" rows={6} value={queries} onChange={(e) => setQueries(e.target.value)} placeholder="Generate or type queries, one per line" className="font-mono text-xs" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void saveAndRun()} disabled={saving || run.busy || queryCount === 0 || requirement.trim().length < 10}>
            {saving || run.busy ? <LoaderCircle className="animate-spin" /> : <Play />}
            Save config &amp; run
          </Button>
          {configName ? <span className="text-xs text-muted-foreground">saved as configs/{configName}.yaml</span> : null}
        </div>
        {run.view ? <RunProgress view={run.view} align="start" onCancel={() => void run.cancel()} /> : null}
        {error || run.error ? <p className="text-sm text-destructive">{error ?? run.error}</p> : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// GitHub organisations
// ---------------------------------------------------------------------------

function GithubSearchCard({ rulesets }: { rulesets: RulesetSummary[] }) {
  const [ruleset, setRuleset] = React.useState(DEFAULT_RULESET.code_data);
  const [languages, setLanguages] = React.useState("Python, TypeScript, Go");
  const [minPrs, setMinPrs] = React.useState(200);
  const [windowDays, setWindowDays] = React.useState(90);
  const [minStars, setMinStars] = React.useState(300);
  const [exclude, setExclude] = React.useState("awesome, tutorial, course, example, sample, learn, book");
  const [limit, setLimit] = React.useState(50);
  const [saving, setSaving] = React.useState(false);
  const [configName, setConfigName] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const run = useRun();

  const saveAndRun = async () => {
    setError(null);
    setSaving(true);
    try {
      const data = await postJson<{ name: string }>("/api/configs", {
        kind: "github",
        vendor_type: "code_data",
        ruleset,
        languages: languages.split(",").map((l) => l.trim()).filter(Boolean),
        min_merged_prs: minPrs,
        activity_window_days: windowDays,
        min_stars: minStars,
        exclude_keywords: exclude.split(",").map((k) => k.trim()).filter(Boolean),
        limit,
      });
      setConfigName(data.name);
      await run.start(data.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub organisations</CardTitle>
        <CardDescription>
          Repository search per language, then per-organisation signals (merged PRs, CI, releases, tests, license, lockfile, activity). Ranked by should-score, capped at the limit.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-64 flex-1 flex-col gap-1.5">
            <Label htmlFor="gh-languages">Languages (comma separated)</Label>
            <Input id="gh-languages" value={languages} onChange={(e) => setLanguages(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-ruleset">Ruleset</Label>
            <RulesetSelect id="gh-ruleset" rulesets={rulesets} vendorType="code_data" value={ruleset} onChange={setRuleset} />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-prs">Min merged PRs</Label>
            <Input id="gh-prs" type="number" min={0} className="w-28" value={minPrs} onChange={(e) => setMinPrs(Number(e.target.value) || 0)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-window">Activity window (days)</Label>
            <Input id="gh-window" type="number" min={1} className="w-28" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 90)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-stars">Min stars</Label>
            <Input id="gh-stars" type="number" min={0} className="w-28" value={minStars} onChange={(e) => setMinStars(Number(e.target.value) || 0)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gh-limit">Limit</Label>
            <Input id="gh-limit" type="number" min={1} max={200} className="w-24" value={limit} onChange={(e) => setLimit(Number(e.target.value) || 50)} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gh-exclude">Exclude keywords (organisation / repository names)</Label>
          <Input id="gh-exclude" value={exclude} onChange={(e) => setExclude(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void saveAndRun()} disabled={saving || run.busy || !languages.trim()}>
            {saving || run.busy ? <LoaderCircle className="animate-spin" /> : <Play />}
            Save config &amp; run
          </Button>
          {configName ? <span className="text-xs text-muted-foreground">saved as configs/{configName}.yaml</span> : null}
        </div>
        {run.view ? <RunProgress view={run.view} align="start" onCancel={() => void run.cancel()} /> : null}
        {error || run.error ? <p className="text-sm text-destructive">{error ?? run.error}</p> : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Manual upload
// ---------------------------------------------------------------------------

type UploadRow = { row: number; name: string; vendor_id?: string; result?: ScreenResult; verified_values?: number; notes?: string[]; error?: string };
type UploadResult = { run_id: string; counts: RunCounts; rows: UploadRow[] };

function ManualUploadCard({ rulesets }: { rulesets: RulesetSummary[] }) {
  const router = useRouter();
  const [vendorType, setVendorType] = React.useState<VendorType>("ego_data");
  const [ruleset, setRuleset] = React.useState(DEFAULT_RULESET.ego_data);
  const [uploader, setUploader] = React.useState("");
  const [attest, setAttest] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<UploadResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const changeType = (t: VendorType) => {
    setVendorType(t);
    setRuleset(DEFAULT_RULESET[t]);
  };
  const templateHref = `/api/inputs/manual/template?vendor_type=${vendorType}&ruleset=${encodeURIComponent(ruleset)}`;

  const upload = async () => {
    if (!file) return;
    setError(null);
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("vendor_type", vendorType);
      form.set("ruleset", ruleset);
      form.set("uploader", uploader.trim());
      form.set("attest_all", attest ? "true" : "false");
      const res = await fetch("/api/inputs/manual", { method: "POST", body: form });
      const data = (await res.json()) as UploadResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `upload failed (${res.status})`);
      setResult(data);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual upload</CardTitle>
        <CardDescription>
          Download the CSV template (field paths, tag dimensions, source_url, attestation), fill it, upload. Values are verified only with a source URL or your attestation; everything else stays unknown. Rows land in the Review Queue.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mu-type">Vendor type</Label>
            <VendorTypeSelect id="mu-type" value={vendorType} onChange={changeType} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mu-ruleset">Ruleset</Label>
            <RulesetSelect id="mu-ruleset" rulesets={rulesets} vendorType={vendorType} value={ruleset} onChange={setRuleset} />
          </div>
          <Button asChild variant="outline">
            <a href={templateHref} download>
              <Download /> Download template
            </a>
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mu-uploader">Uploader (recorded as attested_by)</Label>
            <Input id="mu-uploader" className="w-64" value={uploader} onChange={(e) => setUploader(e.target.value)} placeholder="you@company.com" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mu-file">CSV file</Label>
            <Input id="mu-file" type="file" accept=".csv,text/csv" className="w-72" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="mu-attest" checked={attest} onCheckedChange={(c) => setAttest(c === true)} />
          <Label htmlFor="mu-attest">I attest that values without a source URL in this file are accurate</Label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void upload()} disabled={busy || !file || uploader.trim().length === 0}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Upload />}
            Upload
          </Button>
          {result ? (
            <Button asChild variant="link" size="sm">
              <Link href="/database?tab=review">Open Review Queue</Link>
            </Button>
          ) : null}
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {result ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="font-mono text-xs text-muted-foreground">{shortRunId(result.run_id)}</span>
              <Badge variant="secondary">{result.counts.normalized ?? 0} vendors</Badge>
              <Badge variant="outline" className={SCREEN_CLASS.pass}>{result.counts.pass ?? 0} pass</Badge>
              <Badge variant="outline" className={SCREEN_CLASS.unknown}>{result.counts.unknown ?? 0} unknown</Badge>
              <Badge variant="outline" className={SCREEN_CLASS.fail}>{result.counts.fail ?? 0} fail</Badge>
              <Badge variant="outline">coverage {formatPct(result.counts.must_field_coverage)}</Badge>
            </div>
            <ul className="divide-y rounded-lg border text-sm">
              {result.rows.map((r) => (
                <li key={r.row} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                  <span className="w-12 font-mono text-xs text-muted-foreground">row {r.row}</span>
                  <span className="font-medium">{r.name || "(no name)"}</span>
                  {r.result ? <ScreenResultBadge result={r.result} /> : null}
                  {r.verified_values !== undefined ? <span className="text-xs text-muted-foreground">{r.verified_values} verified values</span> : null}
                  {r.error ? <span className="text-xs text-destructive">{r.error}</span> : null}
                  {r.notes?.length ? <span className="text-xs text-warning">{r.notes.join("; ")}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function InputsTab({ configs, rulesets, runs, schedules }: { configs: ConfigSummary[]; rulesets: RulesetSummary[]; runs: Run[]; schedules: ScheduleWithRun[] }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {configs.filter((c) => c.valid).length} configs on disk: {configs.filter((c) => c.valid).map((c) => c.name).join(", ")}
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        <CustomSearchCard rulesets={rulesets} />
        <GithubSearchCard rulesets={rulesets} />
      </div>
      <ManualUploadCard rulesets={rulesets} />
      <ScheduleCard configs={configs} schedules={schedules} />
      <RunsList runs={runs} />
    </div>
  );
}
