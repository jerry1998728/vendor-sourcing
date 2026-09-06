/**
 * Manual CSV input. Rows go through the same normalize -> evidence -> screen
 * path as adapters: extraction_method=manual, verified only with a source_url
 * or an attestation (PRD §4.2), then writeNormalizedVendor() -> Review Queue.
 */
import { eq } from "drizzle-orm";

import { getDb, nowIso, runs, type Db, type Run, type RunCounts, type ScreenResult } from "@/lib/db";
import { loadRuleset } from "@/lib/rulesets/loader";

import { canonicalDomain, vendorIdFor } from "./ids";
import { writeNormalizedVendor } from "./run";
import type { Ruleset } from "./screen";
import { newRunId, persistJson, relativeRunDir } from "./storage";
import {
  TAG_DIMENSIONS_BY_TYPE,
  isTagDimension,
  normalizeTagValue,
  type Evidence,
  type NormalizeResult,
  type Tag,
  type VendorCandidate,
  type VendorType,
} from "./types";

export const FIXED_COLUMNS = ["name", "primary_domain", "contact_email"] as const;
export const TRAILING_COLUMNS = ["source_url", "attestation", "notes"] as const;
const COUNTRY_FIELDS = new Set(["registration_country", "ownership_country", "collection_countries"]);
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "attested"]);

/** Columns = fixed identity columns + every ruleset field / tag dimension + provenance columns. */
export function manualTemplateColumns(ruleset: Ruleset, vendorType: VendorType): string[] {
  const must = ruleset.must.map((m) => m.field_path);
  const fields = ruleset.fields.map((f) => f.path);
  const dims = TAG_DIMENSIONS_BY_TYPE[vendorType].filter((d) => d !== "source_channel");
  const skip = new Set<string>([...FIXED_COLUMNS, ...TRAILING_COLUMNS]);
  const middle = [...new Set([...must, ...fields, ...dims])].filter((c) => !skip.has(c));
  return [...FIXED_COLUMNS, ...middle, ...TRAILING_COLUMNS];
}

function exampleValue(ruleset: Ruleset, column: string): string {
  const f = ruleset.fields.find((x) => x.path === column);
  if (COUNTRY_FIELDS.has(column)) return column === "collection_countries" ? "DE|FR" : "DE";
  if (f?.type === "boolean") return "true";
  if (f?.type === "number") return "250";
  if (f?.values?.length) return f.values[0];
  if (isTagDimension(column)) {
    const allowed = TAG_DIMENSIONS_BY_TYPE.ego_data.includes(column) || TAG_DIMENSIONS_BY_TYPE.code_data.includes(column);
    if (allowed) {
      const v = normalizeTagValue(column, "video") ?? normalizeTagValue(column, "code") ?? "";
      if (v) return v;
    }
  }
  if (f?.type === "list") return "value1|value2";
  return "";
}

export function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function manualTemplateCsv(ruleset: Ruleset, vendorType: VendorType): string {
  const columns = manualTemplateColumns(ruleset, vendorType);
  const example: Record<string, string> = {
    name: "Example Vendor (delete this row)",
    primary_domain: "example-vendor.example",
    contact_email: "sales@example-vendor.example",
    source_url: "https://example-vendor.example/about",
    attestation: "false",
    notes: "Multi-valued cells use | between values. attestation=true makes values without a source_url verified.",
  };
  const row = columns.map((c) => csvEscape(example[c] ?? exampleValue(ruleset, c)));
  return `${columns.join(",")}\n${row.join(",")}\n`;
}

/** RFC 4180 CSV parser: quotes, escaped quotes, newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type ManualRowResult = {
  row: number;
  name: string;
  vendor_id?: string;
  result?: ScreenResult;
  verified_values?: number;
  notes?: string[];
  error?: string;
};

export type ManualImportOptions = {
  vendorType: VendorType;
  rulesetRef: string;
  uploader: string;
  /** treat every value as attested even without an attestation column */
  attestAll: boolean;
  configName?: string;
};

export function rowToNormalized(
  header: string[],
  cells: string[],
  ruleset: Ruleset,
  opts: ManualImportOptions,
): { result: NormalizeResult & { vendor: VendorCandidate }; notes: string[] } | { error: string } {
  const get = (col: string) => {
    const i = header.indexOf(col);
    return i >= 0 ? (cells[i] ?? "").trim() : "";
  };
  const name = get("name");
  if (!name) return { error: "name is required" };
  const domain = canonicalDomain(get("primary_domain") || null);
  const sourceUrl = get("source_url");
  const attested = opts.attestAll || TRUE_WORDS.has(get("attestation").toLowerCase());
  const verifiedByRow = Boolean(sourceUrl) || attested;
  const now = nowIso();
  const notes: string[] = [];
  const evidence: Evidence[] = [];
  const tags: Tag[] = [];

  const push = (field_path: string, value: string | null) => {
    const verified = value !== null && verifiedByRow;
    evidence.push({
      field_path,
      value,
      source_url: sourceUrl || null,
      snippet: value === null ? null : sourceUrl ? `Manual upload by ${opts.uploader}: ${field_path} = ${value}` : attested ? `Attested by ${opts.uploader}` : null,
      extraction_method: "manual",
      confidence: value === null ? 0 : verified ? 0.9 : 0.5,
      proxy: false,
      verified,
      attested_by: verified && !sourceUrl ? opts.uploader : null,
      observed_at: now,
    });
    if (value !== null && isTagDimension(field_path)) {
      tags.push({ dimension: field_path, value, source_badge: verified ? "manual" : "unknown", evidence_index: evidence.length - 1 });
    }
  };

  const skip = new Set<string>(["name", "primary_domain", "source_url", "attestation", "notes"]);
  for (const column of header) {
    if (skip.has(column) || !column) continue;
    const raw = get(column);
    if (!raw) continue;
    const values = raw.split(/[|;]/).map((v) => v.trim()).filter(Boolean);
    for (let value of values) {
      if (COUNTRY_FIELDS.has(column)) {
        const c = value.toUpperCase();
        if (!/^[A-Z]{2}$/.test(c)) {
          notes.push(`${column}: "${value}" is not an ISO alpha-2 code, skipped`);
          continue;
        }
        value = c;
      } else if (isTagDimension(column)) {
        const v = normalizeTagValue(column, value);
        if (!v) {
          notes.push(`${column}: "${value}" is not in the vocabulary, skipped`);
          continue;
        }
        value = v;
      } else if (column === "contact_email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        notes.push(`contact_email: "${value}" is not an email, skipped`);
        continue;
      }
      push(column, value);
    }
  }
  for (const must of ruleset.must) {
    if (!evidence.some((e) => e.field_path === must.field_path)) push(must.field_path, null);
  }
  evidence.push({
    field_path: "source_channel", value: "manual", source_url: null, snippet: `Manual CSV upload by ${opts.uploader}`,
    extraction_method: "manual", confidence: 1, proxy: false, verified: true, attested_by: opts.uploader, observed_at: now,
  });
  tags.push({ dimension: "source_channel", value: "manual", source_badge: "manual", evidence_index: evidence.length - 1 });

  const first = (fp: string) => evidence.find((e) => e.field_path === fp && e.verified && e.value)?.value ?? null;
  const vendor: VendorCandidate = {
    vendor_id: vendorIdFor(domain, name, opts.vendorType),
    name,
    vendor_type: opts.vendorType,
    primary_domain: domain,
    contact_email: first("contact_email"),
    registration_country: first("registration_country"),
    ownership_country: first("ownership_country"),
    parent_entity: first("parent_entity"),
    collection_countries: evidence.filter((e) => e.field_path === "collection_countries" && e.verified && e.value).map((e) => e.value as string),
    discovered_via: "manual",
  };
  return { result: { page_type: "vendor_site", vendor, evidence, tags, mentioned_vendors: [], raw: { row: cells, notes } }, notes };
}

export function importManualCsv(
  text: string,
  opts: ManualImportOptions,
  db: Db = getDb(),
): { run: Run; rows: ManualRowResult[]; counts: RunCounts } {
  const ruleset = loadRuleset(opts.rulesetRef);
  if (ruleset.vendor_type !== opts.vendorType) {
    throw new Error(`ruleset ${opts.rulesetRef} is for ${ruleset.vendor_type}, upload is ${opts.vendorType}`);
  }
  const parsed = parseCsv(text);
  if (parsed.length < 2) throw new Error("CSV needs a header row and at least one data row");
  const header = parsed[0].map((h) => h.trim().toLowerCase());
  if (!header.includes("name")) throw new Error('CSV header must include a "name" column');

  const run_id = newRunId();
  const startedAt = nowIso();
  const run = db
    .insert(runs)
    .values({
      run_id,
      input_type: "manual",
      adapter: "manual",
      vendor_type: opts.vendorType,
      query: { config: opts.configName ?? "manual_upload", ruleset: opts.rulesetRef, uploader: opts.uploader, attest_all: opts.attestAll, rows: parsed.length - 1 },
      ruleset_version: ruleset.ruleset_version,
      started_at: startedAt,
      counts: { progress: { phase: "normalizing", step: 0, total: parsed.length - 1 } },
      raw_payload_path: relativeRunDir(run_id),
    })
    .returning()
    .get();
  void persistJson(run_id, "upload.csv.json", { header, rows: parsed.slice(1), options: { ...opts } });

  const rows: ManualRowResult[] = [];
  const outcomes: { result: ScreenResult; coverage: number }[] = [];
  parsed.slice(1).forEach((cells, i) => {
    const rowNo = i + 2;
    const conv = rowToNormalized(header, cells, ruleset, opts);
    if ("error" in conv) {
      rows.push({ row: rowNo, name: cells[header.indexOf("name")] ?? "", error: conv.error });
      return;
    }
    try {
      const out = writeNormalizedVendor(db, run, ruleset, conv.result);
      outcomes.push({ result: out.result, coverage: out.must_field_coverage });
      rows.push({
        row: rowNo,
        name: conv.result.vendor.name,
        vendor_id: out.vendor_id,
        result: out.result,
        verified_values: conv.result.evidence.filter((e) => e.verified && e.field_path !== "source_channel").length,
        notes: conv.notes.length ? conv.notes : undefined,
      });
    } catch (err) {
      rows.push({ row: rowNo, name: conv.result.vendor.name, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const count = (r: ScreenResult) => outcomes.filter((o) => o.result === r).length;
  const counts: RunCounts = {
    raw_records: parsed.length - 1,
    discovered: parsed.length - 1,
    normalized: outcomes.length,
    vendor_sites: outcomes.length,
    new_vendors: outcomes.length,
    pass: count("pass"),
    fail: count("fail"),
    unknown: count("unknown"),
    must_field_coverage: outcomes.length ? Math.round((outcomes.reduce((a, b) => a + b.coverage, 0) / outcomes.length) * 1000) / 1000 : 0,
    unknown_rate: outcomes.length ? Math.round((count("unknown") / outcomes.length) * 1000) / 1000 : 0,
    progress: { phase: "done", step: parsed.length - 1, total: parsed.length - 1 },
  };
  const finished = db.update(runs).set({ counts, finished_at: nowIso() }).where(eq(runs.run_id, run_id)).returning().get();
  void persistJson(run_id, "summary.json", { counts, rows });
  return { run: finished ?? run, rows, counts };
}

