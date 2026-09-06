/**
 * Eight tables exactly as PRD §5. Column names are the PRD field names and
 * the TypeScript property names match them, so rows round-trip through the
 * API and UI without renaming.
 *
 * Postgres-portable types only: text, integer (boolean mode), real, and text
 * columns holding JSON. Timestamps are ISO-8601 strings.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export * from "./enums";
import type {
  Actor,
  DiligenceStage,
  ExtractionMethod,
  InputType,
  InteractionDirection,
  ScreenResult,
  SourceBadge,
  VendorStatus,
} from "./enums";

/** Verified values only. Multi-valued field paths hold arrays. */
export type VendorAttributes = Record<string, string | string[]>;

export type ScreenReason = {
  rule_id: string;
  kind: "must" | "should";
  field_path: string;
  outcome: ScreenResult;
  detail: string;
  observed: string[];
  evidence_ids: number[];
};

export type RunPhase =
  | "queued"
  | "discovering"
  | "refreshing"
  | "normalizing"
  | "screening"
  | "done"
  | "failed"
  | "cancelled";

export type RunCounts = {
  raw_records?: number;
  discovered?: number;
  normalized?: number;
  vendor_sites?: number;
  unreachable?: number;
  new_vendors?: number;
  existing_vendors?: number;
  pass?: number;
  fail?: number;
  unknown?: number;
  must_field_coverage?: number;
  unknown_rate?: number;
  refreshed?: number;
  changed?: number;
  screen_changed?: number;
  skipped?: number;
  errors?: number;
  llm_usage?: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    web_searches: number;
  };
  progress?: {
    phase: RunPhase;
    /** set by POST /api/runs/[id]/cancel; executors stop between vendors */
    cancel_requested?: boolean;
    step?: number;
    total?: number;
    message?: string;
    error?: string;
  };
};

export const runs = sqliteTable("runs", {
  run_id: text("run_id").primaryKey(),
  input_type: text("input_type").$type<InputType>().notNull(),
  adapter: text("adapter").notNull(),
  vendor_type: text("vendor_type").notNull(),
  query: text("query", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  ruleset_version: text("ruleset_version").notNull(),
  started_at: text("started_at").notNull(),
  finished_at: text("finished_at"),
  counts: text("counts", { mode: "json" })
    .$type<RunCounts>()
    .notNull()
    .default(sql`'{}'`),
  raw_payload_path: text("raw_payload_path"),
});

export const vendors = sqliteTable(
  "vendors",
  {
    /** normalized domain, or slug(name)+vendor_type when there is no domain */
    vendor_id: text("vendor_id").primaryKey(),
    name: text("name").notNull(),
    vendor_type: text("vendor_type").notNull(),
    primary_domain: text("primary_domain"),
    contact_email: text("contact_email"),
    registration_country: text("registration_country"),
    ownership_country: text("ownership_country"),
    parent_entity: text("parent_entity"),
    collection_countries: text("collection_countries", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    attributes: text("attributes", { mode: "json" })
      .$type<VendorAttributes>()
      .notNull()
      .default(sql`'{}'`),
    screen_result: text("screen_result").$type<ScreenResult>(),
    screen_reasons: text("screen_reasons", { mode: "json" })
      .$type<ScreenReason[]>()
      .notNull()
      .default(sql`'[]'`),
    status: text("status").$type<VendorStatus>().notNull().default("Identified"),
    diligence_stage: text("diligence_stage").$type<DiligenceStage>(),
    status_confidence: real("status_confidence"),
    coverage_confidence: real("coverage_confidence"),
    next_action: text("next_action"),
    owner: text("owner"),
    due_at: text("due_at"),
    first_seen_run_id: text("first_seen_run_id").references(() => runs.run_id),
    discovered_via: text("discovered_via"),
    last_verified_at: text("last_verified_at"),
    discovered_at: text("discovered_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    index("vendors_status_idx").on(t.status),
    index("vendors_type_idx").on(t.vendor_type),
    index("vendors_domain_idx").on(t.primary_domain),
    index("vendors_screen_idx").on(t.screen_result),
    index("vendors_next_action_idx").on(t.next_action),
    index("vendors_owner_idx").on(t.owner),
    index("vendors_last_verified_idx").on(t.last_verified_at),
    index("vendors_discovered_via_idx").on(t.discovered_via),
    index("vendors_first_run_idx").on(t.first_seen_run_id),
  ],
);

export const evidence = sqliteTable(
  "evidence",
  {
    evidence_id: integer("evidence_id").primaryKey({ autoIncrement: true }),
    vendor_id: text("vendor_id")
      .notNull()
      .references(() => vendors.vendor_id),
    field_path: text("field_path").notNull(),
    /** null = looked for it and did not find it (explicit unknown) */
    value: text("value"),
    source_url: text("source_url"),
    snippet: text("snippet"),
    extraction_method: text("extraction_method")
      .$type<ExtractionMethod>()
      .notNull(),
    confidence: real("confidence").notNull().default(0),
    proxy: integer("proxy", { mode: "boolean" }).notNull().default(false),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    attested_by: text("attested_by"),
    observed_at: text("observed_at").notNull(),
  },
  (t) => [
    index("evidence_vendor_field_idx").on(t.vendor_id, t.field_path),
    index("evidence_verified_idx").on(t.verified),
    index("evidence_source_idx").on(t.vendor_id, t.field_path, t.value, t.source_url),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    tag_id: integer("tag_id").primaryKey({ autoIncrement: true }),
    vendor_id: text("vendor_id")
      .notNull()
      .references(() => vendors.vendor_id),
    dimension: text("dimension").notNull(),
    value: text("value").notNull(),
    source_badge: text("source_badge").$type<SourceBadge>().notNull(),
    evidence_id: integer("evidence_id").references(() => evidence.evidence_id),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("tags_vendor_dimension_value_uq").on(
      t.vendor_id,
      t.dimension,
      t.value,
    ),
    index("tags_dimension_value_idx").on(t.dimension, t.value),
  ],
);

export const interactions = sqliteTable(
  "interactions",
  {
    interaction_id: integer("interaction_id").primaryKey({ autoIncrement: true }),
    vendor_id: text("vendor_id")
      .notNull()
      .references(() => vendors.vendor_id),
    gmail_thread_id: text("gmail_thread_id"),
    direction: text("direction").$type<InteractionDirection>().notNull(),
    sent_at: text("sent_at"),
    subject: text("subject"),
    body_text: text("body_text"),
    llm_summary: text("llm_summary"),
  },
  (t) => [
    index("interactions_vendor_idx").on(t.vendor_id, t.direction),
    index("interactions_thread_idx").on(t.gmail_thread_id),
  ],
);

/** Append-only. vendors.status and diligence_stage replay from this table. */
export const events = sqliteTable(
  "events",
  {
    event_id: integer("event_id").primaryKey({ autoIncrement: true }),
    vendor_id: text("vendor_id")
      .notNull()
      .references(() => vendors.vendor_id),
    from_status: text("from_status").$type<VendorStatus>(),
    to_status: text("to_status").$type<VendorStatus>().notNull(),
    from_stage: text("from_stage").$type<DiligenceStage>(),
    to_stage: text("to_stage").$type<DiligenceStage>(),
    actor: text("actor").$type<Actor>().notNull(),
    reason: text("reason"),
    confidence: real("confidence"),
    evidence_ref: text("evidence_ref"),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    created_at: text("created_at").notNull(),
  },
  (t) => [index("events_vendor_idx").on(t.vendor_id, t.event_id)],
);

export const proposals = sqliteTable(
  "proposals",
  {
    proposal_id: integer("proposal_id").primaryKey({ autoIncrement: true }),
    vendor_id: text("vendor_id")
      .notNull()
      .references(() => vendors.vendor_id),
    interaction_id: integer("interaction_id").references(
      () => interactions.interaction_id,
    ),
    to_status: text("to_status").$type<VendorStatus>(),
    to_stage: text("to_stage").$type<DiligenceStage>(),
    confidence: real("confidence"),
    evidence_snippet: text("evidence_snippet"),
    decided_by: text("decided_by"),
    decided_at: text("decided_at"),
  },
  (t) => [index("proposals_vendor_idx").on(t.vendor_id), index("proposals_pending_idx").on(t.decided_at)],
);

/** P1 */
export const schedules = sqliteTable(
  "schedules",
  {
    schedule_id: integer("schedule_id").primaryKey({ autoIncrement: true }),
    config: text("config").notNull(),
    cron: text("cron").notNull(),
    last_run_id: text("last_run_id").references(() => runs.run_id),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("schedules_config_uq").on(t.config)],
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Vendor = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;
export type EvidenceRow = typeof evidence.$inferSelect;
export type NewEvidenceRow = typeof evidence.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;
export type Interaction = typeof interactions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
export type InteractionRow = typeof interactions.$inferSelect;
export type NewInteraction = typeof interactions.$inferInsert;
export type Proposal = typeof proposals.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
