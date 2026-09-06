/**
 * Pipeline contracts (PRD §7) and the zod schemas for every LLM output.
 */
import { z } from "zod";

import {
  DILIGENCE_STAGES,
  VENDOR_STATUSES,
  type ExtractionMethod,
  type SourceBadge,
} from "@/lib/db/enums";
import type { EvidenceRow, Vendor } from "@/lib/db/schema";
import type { LlmUsage } from "@/lib/llm/client";
import type { AppConfig } from "@/lib/rulesets/loader";
import type { Ruleset } from "./screen";

export const VENDOR_TYPES = ["ego_data", "code_data"] as const;
export type VendorType = (typeof VENDOR_TYPES)[number];

/** PRD §5 tag dimensions. `null` means free text. */
export const TAG_DIMENSIONS = {
  modality: ["video", "image", "lidar", "audio", "text", "code", "multimodal"],
  collection_type: [
    "egocentric",
    "exocentric",
    "simulation",
    "synthetic",
    "scraped",
    "licensed_existing",
  ],
  sensor_rig: ["stereo", "mono", "depth", "lidar", "imu", "gps", "eye_tracking"],
  scene_class: ["urban", "suburban", "highway", "indoor", "night", "adverse_weather"],
  scale: null,
  licensing_model: [
    "exclusive",
    "non_exclusive",
    "per_hour",
    "per_dataset",
    "subscription",
  ],
  compliance: ["consent_documented", "pii_handling", "gdpr", "release_forms"],
  annotation: ["none", "box_2d", "box_3d", "segmentation", "temporal"],
  code_language: null,
  code_license: ["permissive", "copyleft", "proprietary", "unknown"],
  org_type: ["company", "foundation", "individual", "broker"],
  delivery: ["api", "bulk", "on_prem"],
  source_channel: ["web_search", "github", "manual", "directory", "referral"],
} as const satisfies Record<string, readonly string[] | null>;

export type TagDimension = keyof typeof TAG_DIMENSIONS;
export const TAG_DIMENSION_NAMES = Object.keys(TAG_DIMENSIONS) as TagDimension[];

export const TAG_DIMENSIONS_BY_TYPE: Record<VendorType, readonly TagDimension[]> = {
  ego_data: [
    "modality",
    "collection_type",
    "sensor_rig",
    "scene_class",
    "scale",
    "licensing_model",
    "compliance",
    "annotation",
    "org_type",
    "delivery",
    "source_channel",
  ],
  code_data: [
    "modality",
    "collection_type",
    "scale",
    "licensing_model",
    "code_language",
    "code_license",
    "org_type",
    "delivery",
    "source_channel",
  ],
};

export function isTagDimension(s: string): s is TagDimension {
  return Object.prototype.hasOwnProperty.call(TAG_DIMENSIONS, s);
}

/** Lower-cases, snake_cases and checks the value against the dimension's vocabulary. */
export function normalizeTagValue(
  dimension: TagDimension,
  raw: string,
): string | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_.+]/g, "");
  if (!v) return null;
  const allowed = TAG_DIMENSIONS[dimension];
  if (allowed === null) return v.slice(0, 64);
  return (allowed as readonly string[]).includes(v) ? v : null;
}

/** Field paths whose verified values are stored as arrays in vendors.attributes. */
export const MULTI_VALUE_FIELDS: ReadonlySet<string> = new Set([
  ...TAG_DIMENSION_NAMES,
  "collection_countries",
]);

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export type WebSearchQuery = {
  kind: "web_search";
  vendor_type: VendorType;
  requirement: string;
  seed_queries: string[];
  limit: number;
  max_results_per_query: number;
  exclude_domains: string[];
};

export type GithubQuery = {
  kind: "github";
  vendor_type: VendorType;
  languages: string[];
  min_merged_prs: number;
  activity_window_days: number;
  min_stars: number;
  exclude_keywords: string[];
  limit: number;
};

export type DiscoveryQuery = WebSearchQuery | GithubQuery;

export type RawRecord = {
  source: "web_search" | "github" | "manual";
  url: string;
  domain: string | null;
  title: string | null;
  snippet: string | null;
  /** seed query (or API query) that surfaced the record */
  query: string | null;
  discovered_at: string;
  /** 1 = direct search result, 2 = harvested from an aggregator/directory page */
  hop: number;
  extra?: Record<string, unknown>;
};

export type VendorCandidate = {
  vendor_id: string;
  name: string;
  vendor_type: VendorType;
  primary_domain: string | null;
  contact_email: string | null;
  registration_country: string | null;
  ownership_country: string | null;
  parent_entity: string | null;
  collection_countries: string[];
  discovered_via: string;
};

export type Evidence = {
  field_path: string;
  /** null = looked and did not find (explicit unknown) */
  value: string | null;
  source_url: string | null;
  snippet: string | null;
  extraction_method: ExtractionMethod;
  confidence: number;
  proxy: boolean;
  verified: boolean;
  attested_by: string | null;
  observed_at: string;
  /** why verified is false; kept in the raw payload */
  note?: string;
};

export type Tag = {
  dimension: TagDimension;
  value: string;
  source_badge: SourceBadge;
  /** index into the sibling evidence array; resolved to evidence_id on write */
  evidence_index: number | null;
};

export type PageType =
  | "vendor_site"
  | "aggregator"
  | "directory"
  | "news"
  | "marketplace"
  | "other"
  | "unreachable";

export type NormalizeResult = {
  page_type: PageType;
  /** null unless page_type is vendor_site */
  vendor: VendorCandidate | null;
  evidence: Evidence[];
  tags: Tag[];
  /** vendors named on aggregator / directory pages; fed back as hop-2 candidates */
  mentioned_vendors: { name: string; url: string }[];
  /** raw LLM output, fetched pages, verification notes (persisted per run) */
  raw: Record<string, unknown>;
};

export type AdapterContext = {
  run_id: string;
  config: AppConfig;
  ruleset: Ruleset;
  /** persist a raw payload under data/runs/<run_id>/<name> */
  persist: (name: string, payload: unknown) => Promise<void>;
  log: (message: string) => void;
  /** running token / search totals for the run */
  usage: LlmUsage;
  signal?: AbortSignal;
};

export interface SourceAdapter {
  readonly name: string;
  readonly vendorTypes: readonly VendorType[];
  discover(q: DiscoveryQuery, ctx: AdapterContext): Promise<RawRecord[]>;
  normalize(raw: RawRecord, ctx: AdapterContext): Promise<NormalizeResult>;
  /** P1 refresh: re-fetch a known vendor's sources and re-extract; optional per adapter. */
  refresh?(vendor: Vendor, evidence: EvidenceRow[], ctx: AdapterContext): Promise<NormalizeResult>;
}

// ---------------------------------------------------------------------------
// LLM outputs (all parsed with zod; nothing else is trusted)
// ---------------------------------------------------------------------------

export const LlmFieldClaim = z.object({
  field_path: z.string(),
  value: z.string().nullable(),
  source_url: z.string().nullable(),
  snippet: z.string().nullable(),
  confidence: z.number(),
  proxy: z.boolean(),
});
export type LlmFieldClaim = z.infer<typeof LlmFieldClaim>;

export const LlmTagClaim = z.object({
  dimension: z.string(),
  value: z.string(),
  source_url: z.string().nullable(),
  snippet: z.string().nullable(),
});
export type LlmTagClaim = z.infer<typeof LlmTagClaim>;

export const LLM_PAGE_TYPES = [
  "vendor_site",
  "aggregator",
  "directory",
  "news",
  "marketplace",
  "other",
] as const;

/** normalize(): strict JSON extracted from a fetched vendor page set. */
export const NormalizeOutput = z.object({
  page_type: z.enum(LLM_PAGE_TYPES),
  name: z.string(),
  primary_domain: z.string().nullable(),
  registration_country: z.string().nullable(),
  ownership_country: z.string().nullable(),
  parent_entity: z.string().nullable(),
  collection_countries: z.array(z.string()),
  fields: z.array(LlmFieldClaim),
  tags: z.array(LlmTagClaim),
  mentioned_vendors: z.array(z.object({ name: z.string(), url: z.string() })),
  notes: z.string().nullable(),
});
export type NormalizeOutput = z.infer<typeof NormalizeOutput>;

/** POST /api/seed-queries (D1 PM). */
export const SeedQueriesOutput = z.object({
  queries: z.array(z.string()),
});
export type SeedQueriesOutput = z.infer<typeof SeedQueriesOutput>;

/** track/infer (D2 PM). */
export const StatusInferenceOutput = z.object({
  to_status: z.enum(VENDOR_STATUSES),
  to_stage: z.enum(DILIGENCE_STAGES).nullable(),
  confidence: z.number(),
  evidence_snippet: z.string(),
  summary: z.string(),
});
export type StatusInferenceOutput = z.infer<typeof StatusInferenceOutput>;

/** outreach/draft (D2 AM). */
export const DraftEmailOutput = z.object({
  subject: z.string(),
  body: z.string(),
  cited_evidence_ids: z.array(z.number()),
  asked_field_paths: z.array(z.string()),
});
export type DraftEmailOutput = z.infer<typeof DraftEmailOutput>;
