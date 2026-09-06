/** Enumerations shared by the schema, the pipeline and client components (no drizzle import). */
export const VENDOR_STATUSES = [
  "Identified",
  "Screened",
  "Qualified",
  "Contacted",
  "Replied",
  "In Discussion",
  "Approved",
  "Rejected",
  "Dormant",
] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const DILIGENCE_STAGES = ["responded", "technical_review", "quote_received", "sampling"] as const;
export type DiligenceStage = (typeof DILIGENCE_STAGES)[number];

export const ACTORS = ["system", "adapter", "llm_inference", "human"] as const;
export type Actor = (typeof ACTORS)[number];

export const SCREEN_RESULTS = ["pass", "fail", "unknown"] as const;
export type ScreenResult = (typeof SCREEN_RESULTS)[number];

export const EXTRACTION_METHODS = ["api", "llm", "manual"] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export const SOURCE_BADGES = ["verified", "proxy", "manual", "unknown"] as const;
export type SourceBadge = (typeof SOURCE_BADGES)[number];

export const INTERACTION_DIRECTIONS = ["draft", "outbound", "inbound"] as const;
export type InteractionDirection = (typeof INTERACTION_DIRECTIONS)[number];

export const INPUT_TYPES = ["web_search", "github", "manual", "refresh"] as const;
export type InputType = (typeof INPUT_TYPES)[number];
