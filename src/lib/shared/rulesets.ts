/** Ruleset a vendor type is judged by when a vendor carries no run of its own. Client-safe. */
export const DEFAULT_RULESETS: Record<string, string> = { ego_data: "ego_data_supplier@v1", code_data: "repo_owner@v1" };

export function defaultRulesetFor(vendorType: string): string | undefined {
  return DEFAULT_RULESETS[vendorType];
}
