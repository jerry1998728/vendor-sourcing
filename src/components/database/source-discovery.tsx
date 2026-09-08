"use client";

/**
 * One section for every way vendors enter the database. The channel picks the
 * form; the form shows only what you decide (requirement, queries, languages,
 * the file) and folds its settings into one row that summarises them. Runs and
 * schedules live in the page header, not here.
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, FileCode2, LoaderCircle, Play, Sparkles, Upload } from "lucide-react";

import { SCREEN_CLASS, ScreenResultBadge } from "@/components/badges";
import { DetailsToggle } from "@/components/details-toggle";
import { HelpLabel } from "@/components/help-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { RunCounts, ScreenResult } from "@/lib/db/schema";
import { VENDOR_TYPES, type VendorType } from "@/lib/pipeline/types";
import type { RulesetSummary } from "@/lib/rulesets/loader";
import { formatPct, shortRunId } from "@/lib/format";
import { postJson } from "@/lib/shared/http";
import { REQUIREMENT_MIN_CHARS } from "@/lib/shared/inputs";
import { DEFAULT_RULESETS as DEFAULT_RULESET } from "@/lib/shared/rulesets";

import { LanguageSelect } from "./language-select";
import { NewRulesetDialog } from "./new-ruleset-dialog";
import { RunProgress } from "./run-progress";
import { useRun } from "./use-run";

const CHANNEL_HELP = {
  web: "Seed queries are the web searches a run executes: each one goes to Claude's web search tool and every result domain becomes a candidate vendor, so varied queries find more vendors. Describe the requirement, let Generate propose eight, then edit or add your own. Saving writes configs/<name>.yaml so the search is repeatable.",
  github:
    "Repository search per language, then per-organisation signals (merged PRs, CI, releases, tests, license, lockfile, activity). Ranked by should-score and capped at the limit. Saving writes configs/<name>.yaml so the search is repeatable.",
  manual:
    "Download the CSV template (field paths, tag dimensions, source_url, attestation), fill it, upload. Values are verified only with a source URL or your attestation; everything else stays unknown. Rows land in the Review Queue.",
} as const;

/** Why a button is disabled, next to it, so an inactive control never reads as broken. */
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

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
    <div className="flex items-center gap-1.5">
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
      <NewRulesetDialog cloneFrom={value} onCreated={onChange} />
    </div>
  );
}

function Field({ id, label, children }: { id?: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom web search
// ---------------------------------------------------------------------------

function CustomSearchPanel({ rulesets }: { rulesets: RulesetSummary[] }) {
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
  const requirementOk = requirement.trim().length >= REQUIREMENT_MIN_CHARS;
  const generateHint = requirementOk ? null : `Describe the requirement first (${REQUIREMENT_MIN_CHARS}+ characters)`;
  const saveHint = !requirementOk ? `Requirement needs ${REQUIREMENT_MIN_CHARS}+ characters` : queryCount === 0 ? "Add at least one seed query" : null;

  return (
    <div className="flex flex-col gap-3">
      <DetailsToggle label="Options" summary={`${vendorType} · ${ruleset} · limit ${limit}`}>
        <div className="flex flex-wrap items-end gap-3">
          <Field id="ws-type" label="Vendor type">
            <VendorTypeSelect id="ws-type" value={vendorType} onChange={changeType} />
          </Field>
          <Field id="ws-ruleset" label="Ruleset">
            <RulesetSelect id="ws-ruleset" rulesets={rulesets} vendorType={vendorType} value={ruleset} onChange={setRuleset} />
          </Field>
          <Field id="ws-limit" label="Limit">
            <Input id="ws-limit" type="number" min={1} max={200} className="w-24" value={limit} onChange={(e) => setLimit(Number(e.target.value) || 30)} />
          </Field>
        </div>
      </DetailsToggle>

      <Field id="ws-requirement" label="Requirement">
        <Textarea id="ws-requirement" rows={3} value={requirement} onChange={(e) => setRequirement(e.target.value)} placeholder="e.g. Companies collecting first-person video with stereo rigs for robotics training, outside China." />
      </Field>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor="ws-queries">Seed queries (one per line, {queryCount})</Label>
          <span className="flex items-center gap-2">
            {!generating && generateHint ? <Hint>{generateHint}</Hint> : null}
            <Button type="button" variant="outline" size="sm" onClick={() => void generate()} disabled={generating || !requirementOk} title={generateHint ?? "Ask Claude for eight seed queries"}>
              {generating ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              Generate seed queries
            </Button>
          </span>
        </div>
        <Textarea id="ws-queries" rows={6} value={queries} onChange={(e) => setQueries(e.target.value)} placeholder="Generate or type queries, one per line" className="font-mono text-xs" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => void saveAndRun()} disabled={saving || run.busy || !!saveHint} title={saveHint ?? "Write the config and start a run"}>
          {saving || run.busy ? <LoaderCircle className="animate-spin" /> : <Play />}
          Save config &amp; run
        </Button>
        {!saving && !run.busy && saveHint ? <Hint>{saveHint}</Hint> : null}
        {configName ? <span className="text-xs text-muted-foreground">saved as configs/{configName}.yaml</span> : null}
      </div>
      {run.view ? <RunProgress view={run.view} align="start" onCancel={() => void run.cancel()} /> : null}
      {error || run.error ? <p className="text-sm text-destructive">{error ?? run.error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub organisations
// ---------------------------------------------------------------------------

function GithubSearchPanel({ rulesets }: { rulesets: RulesetSummary[] }) {
  const [ruleset, setRuleset] = React.useState(DEFAULT_RULESET.code_data);
  const [languages, setLanguages] = React.useState<string[]>(["Python", "TypeScript", "Go"]);
  const [minPrs, setMinPrs] = React.useState(200);
  const [windowDays, setWindowDays] = React.useState(90);
  const [minStars, setMinStars] = React.useState(300);
  const [exclude, setExclude] = React.useState("awesome, tutorial, course, example, sample, learn, book");
  const [limit, setLimit] = React.useState(50);
  const [saving, setSaving] = React.useState(false);
  const [configName, setConfigName] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const run = useRun();

  const excluded = exclude.split(",").map((k) => k.trim()).filter(Boolean);

  const saveAndRun = async () => {
    setError(null);
    setSaving(true);
    try {
      const data = await postJson<{ name: string }>("/api/configs", {
        kind: "github",
        vendor_type: "code_data",
        ruleset,
        languages,
        min_merged_prs: minPrs,
        activity_window_days: windowDays,
        min_stars: minStars,
        exclude_keywords: excluded,
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
    <div className="flex flex-col gap-3">
      <Field id="gh-languages" label="Languages">
        <LanguageSelect id="gh-languages" value={languages} onChange={setLanguages} />
      </Field>

      <DetailsToggle label="Filters" summary={`${minPrs} PRs · ${windowDays} d · ${minStars} stars · ${excluded.length} excluded · limit ${limit} · ${ruleset}`}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field id="gh-ruleset" label="Ruleset">
              <RulesetSelect id="gh-ruleset" rulesets={rulesets} vendorType="code_data" value={ruleset} onChange={setRuleset} />
            </Field>
            <Field id="gh-prs" label="Min merged PRs">
              <Input id="gh-prs" type="number" min={0} className="w-28" value={minPrs} onChange={(e) => setMinPrs(Number(e.target.value) || 0)} />
            </Field>
            <Field id="gh-window" label="Activity window (days)">
              <Input id="gh-window" type="number" min={1} className="w-28" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 90)} />
            </Field>
            <Field id="gh-stars" label="Min stars">
              <Input id="gh-stars" type="number" min={0} className="w-28" value={minStars} onChange={(e) => setMinStars(Number(e.target.value) || 0)} />
            </Field>
            <Field id="gh-limit" label="Limit">
              <Input id="gh-limit" type="number" min={1} max={200} className="w-24" value={limit} onChange={(e) => setLimit(Number(e.target.value) || 50)} />
            </Field>
          </div>
          <Field id="gh-exclude" label="Exclude keywords (organisation / repository names)">
            <Input id="gh-exclude" value={exclude} onChange={(e) => setExclude(e.target.value)} />
          </Field>
        </div>
      </DetailsToggle>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => void saveAndRun()} disabled={saving || run.busy || languages.length === 0} title={languages.length === 0 ? "Pick at least one language" : "Write the config and start a run"}>
          {saving || run.busy ? <LoaderCircle className="animate-spin" /> : <Play />}
          Save config &amp; run
        </Button>
        {!saving && !run.busy && languages.length === 0 ? <Hint>Pick at least one language</Hint> : null}
        {configName ? <span className="text-xs text-muted-foreground">saved as configs/{configName}.yaml</span> : null}
      </div>
      {run.view ? <RunProgress view={run.view} align="start" onCancel={() => void run.cancel()} /> : null}
      {error || run.error ? <p className="text-sm text-destructive">{error ?? run.error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual upload
// ---------------------------------------------------------------------------

type UploadRow = { row: number; name: string; vendor_id?: string; result?: ScreenResult; verified_values?: number; notes?: string[]; error?: string };
type UploadResult = { run_id: string; counts: RunCounts; rows: UploadRow[] };

function ManualUploadPanel({ rulesets }: { rulesets: RulesetSummary[] }) {
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
    <div className="flex flex-col gap-3">
      <DetailsToggle label="Template" summary={`${vendorType} · ${ruleset}`}>
        <div className="flex flex-wrap items-end gap-3">
          <Field id="mu-type" label="Vendor type">
            <VendorTypeSelect id="mu-type" value={vendorType} onChange={changeType} />
          </Field>
          <Field id="mu-ruleset" label="Ruleset">
            <RulesetSelect id="mu-ruleset" rulesets={rulesets} vendorType={vendorType} value={ruleset} onChange={setRuleset} />
          </Field>
          <Button asChild variant="outline">
            <a href={templateHref} download>
              <Download /> Download template
            </a>
          </Button>
        </div>
      </DetailsToggle>

      <div className="flex flex-wrap items-end gap-3">
        <Field id="mu-uploader" label="Uploader (recorded as attested_by)">
          <Input id="mu-uploader" className="w-64" value={uploader} onChange={(e) => setUploader(e.target.value)} placeholder="you@company.com" />
        </Field>
        <Field id="mu-file" label="CSV file">
          <Input id="mu-file" type="file" accept=".csv,text/csv" className="w-72" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
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
        {!busy && !file ? <Hint>Choose a filled CSV file</Hint> : null}
        {!busy && file && uploader.trim().length === 0 ? <Hint>Your address is recorded as the attester</Hint> : null}
        {result ? (
          <Button asChild variant="link" size="sm">
            <Link href="/database/review">Open Review Queue</Link>
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
    </div>
  );
}

// ---------------------------------------------------------------------------

export function SourceDiscovery({ rulesets }: { rulesets: RulesetSummary[] }) {
  const [channel, setChannel] = React.useState("web");
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6">
        <Tabs value={channel} onValueChange={setChannel} className="gap-4">
          <TabsList>
            <TabsTrigger value="web" title={CHANNEL_HELP.web}>
              <Sparkles /> Custom web search
            </TabsTrigger>
            <TabsTrigger value="github" title={CHANNEL_HELP.github}>
              <FileCode2 /> GitHub organisations
            </TabsTrigger>
            <TabsTrigger value="manual" title={CHANNEL_HELP.manual}>
              <Upload /> Manual upload
            </TabsTrigger>
          </TabsList>
          <div className="text-xs">
            <HelpLabel help={CHANNEL_HELP[channel as keyof typeof CHANNEL_HELP]} className="text-muted-foreground">
              How this channel works
            </HelpLabel>
          </div>
          <TabsContent value="web">
            <CustomSearchPanel rulesets={rulesets} />
          </TabsContent>
          <TabsContent value="github">
            <GithubSearchPanel rulesets={rulesets} />
          </TabsContent>
          <TabsContent value="manual">
            <ManualUploadPanel rulesets={rulesets} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
