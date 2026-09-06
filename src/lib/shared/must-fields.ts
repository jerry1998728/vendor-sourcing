import type { Vendor } from "@/lib/db/schema";

/**
 * The one definition of "unknown must-field": must rules whose last screening
 * outcome was unknown. Every write re-screens, so screen_reasons is current.
 * Client-safe (types only) so the sheet, the draft and inference agree.
 */
export function unknownMustFields(vendor: Pick<Vendor, "screen_reasons">): string[] {
  return vendor.screen_reasons.filter((r) => r.kind === "must" && r.outcome === "unknown").map((r) => r.field_path);
}
