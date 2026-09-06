/**
 * Loads configs/*.yaml and rulesets/*.yaml. A new vendor category is one
 * config + one ruleset; nothing here is category-specific.
 */
import fs from "node:fs";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { z } from "zod";

import { RULE_OPS, type FieldRule, type Ruleset } from "@/lib/pipeline/screen";
import { VENDOR_TYPES, type DiscoveryQuery } from "@/lib/pipeline/types";

export const CONFIG_DIR = path.resolve(process.cwd(), "configs");
export const RULESET_DIR = path.resolve(process.cwd(), "rulesets");

const SAFE_NAME = /^[a-z0-9_]+$/;
const RULESET_REF = /^([a-z0-9_]+)@(v\d+)$/;

// ---------------------------------------------------------------------------
// Rulesets
// ---------------------------------------------------------------------------

const FieldRuleSchema = z.object({
  field_path: z.string().min(1),
  op: z.enum(RULE_OPS),
  value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  description: z.string().optional(),
});

const MustSchema = FieldRuleSchema.extend({ id: z.string().optional() });

const ShouldSchema = z
  .object({
    id: z.string().min(1),
    weight: z.number().positive().default(1),
    description: z.string().optional(),
    any_of: z.array(FieldRuleSchema).min(1).optional(),
    field_path: z.string().optional(),
    op: z.enum(RULE_OPS).optional(),
    value: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
  })
  .refine((s) => s.any_of || (s.field_path && s.op), {
    message: "should rule needs any_of[] or field_path+op",
  });

const ExtractFieldSchema = z.object({
  path: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(["string", "country", "list", "enum", "number", "boolean"]).default("string"),
  values: z.array(z.string()).optional(),
});

const RulesetFileSchema = z.object({
  name: z.string().regex(SAFE_NAME),
  version: z.string().regex(/^v\d+$/),
  vendor_type: z.enum(VENDOR_TYPES),
  description: z.string().default(""),
  must: z.array(MustSchema).min(1),
  should: z.array(ShouldSchema).default([]),
  fields: z.array(ExtractFieldSchema).default([]),
});

export function parseRulesetRef(ref: string): { name: string; version: string } {
  const m = RULESET_REF.exec(ref);
  if (!m) throw new Error(`invalid ruleset reference "${ref}" (expected name@vN)`);
  return { name: m[1], version: m[2] };
}

export function rulesetPath(ref: string): string {
  const { name, version } = parseRulesetRef(ref);
  return path.join(RULESET_DIR, `${name}.${version}.yaml`);
}

export function loadRuleset(ref: string): Ruleset {
  const file = rulesetPath(ref);
  if (!fs.existsSync(file)) throw new Error(`ruleset file not found: ${file}`);
  const parsed = RulesetFileSchema.safeParse(loadYaml(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`invalid ruleset ${file}: ${parsed.error.message}`);
  }
  const r = parsed.data;
  const { name, version } = parseRulesetRef(ref);
  if (r.name !== name || r.version !== version) {
    throw new Error(`ruleset ${file} declares ${r.name}@${r.version}, expected ${ref}`);
  }
  return {
    name: r.name,
    version: r.version,
    ruleset_version: `${r.name}@${r.version}`,
    vendor_type: r.vendor_type,
    description: r.description,
    must: r.must.map((m) => ({ ...m, id: m.id ?? `${m.field_path}_${m.op}` })),
    should: r.should.map((s) => {
      const any_of: FieldRule[] = s.any_of ?? [
        { field_path: s.field_path as string, op: s.op as FieldRule["op"], value: s.value },
      ];
      return { id: s.id, weight: s.weight, description: s.description, any_of };
    }),
    fields: r.fields,
  };
}

export type RulesetSummary = {
  ref: string;
  name: string;
  version: string;
  vendor_type?: string;
  description?: string;
  valid: boolean;
  error?: string;
};

/** Every rulesets/<name>.<version>.yaml; invalid files are listed with their error. */
export function listRulesets(): RulesetSummary[] {
  if (!fs.existsSync(RULESET_DIR)) return [];
  return fs
    .readdirSync(RULESET_DIR)
    .filter((f) => /\.v\d+\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const m = /^([a-z0-9_]+)\.(v\d+)\.ya?ml$/.exec(f);
      const ref = m ? `${m[1]}@${m[2]}` : f;
      try {
        const r = loadRuleset(ref);
        return { ref, name: r.name, version: r.version, vendor_type: r.vendor_type, description: r.description, valid: true };
      } catch (err) {
        return { ref, name: m?.[1] ?? f, version: m?.[2] ?? "", valid: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

const GithubBlockSchema = z.object({
  languages: z.array(z.string()).default([]),
  min_merged_prs: z.number().int().nonnegative().default(200),
  activity_window_days: z.number().int().positive().default(90),
  min_stars: z.number().int().nonnegative().default(300),
  exclude_keywords: z.array(z.string()).default([]),
});

const ConfigFileSchema = z.object({
  name: z.string().regex(SAFE_NAME).optional(),
  vendor_type: z.enum(VENDOR_TYPES),
  adapter: z.string().regex(SAFE_NAME),
  ruleset: z.string().regex(RULESET_REF),
  description: z.string().default(""),
  /** plain-language statement of what a good vendor looks like; used in prompts */
  requirement: z.string().default(""),
  /** max vendor candidates to normalize per run */
  limit: z.number().int().positive().max(200).default(30),
  seed_queries: z.array(z.string().min(3)).optional(),
  max_results_per_query: z.number().int().positive().max(20).default(10),
  exclude_domains: z.array(z.string()).default([]),
  github: GithubBlockSchema.optional(),
});

export type AppConfig = z.infer<typeof ConfigFileSchema> & {
  name: string;
  path: string;
};

export function configPath(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid config name "${name}"`);
  return path.join(CONFIG_DIR, `${name}.yaml`);
}

export function loadConfig(name: string): AppConfig {
  const file = configPath(name);
  if (!fs.existsSync(file)) throw new Error(`config not found: ${file}`);
  const parsed = ConfigFileSchema.safeParse(loadYaml(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`invalid config ${file}: ${parsed.error.message}`);
  }
  return { ...parsed.data, name: parsed.data.name ?? name, path: file };
}

export type ConfigSummary = {
  name: string;
  vendor_type?: string;
  adapter?: string;
  ruleset?: string;
  description?: string;
  valid: boolean;
  error?: string;
};

/** Every configs/*.yaml; invalid files are listed with their error instead of thrown. */
export function listConfigs(): ConfigSummary[] {
  if (!fs.existsSync(CONFIG_DIR)) return [];
  return fs
    .readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()
    .map((f) => {
      const name = f.replace(/\.ya?ml$/, "");
      try {
        const c = loadConfig(name);
        return {
          name: c.name,
          vendor_type: c.vendor_type,
          adapter: c.adapter,
          ruleset: c.ruleset,
          description: c.description,
          valid: true,
        };
      } catch (err) {
        return { name, valid: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
}

export function buildDiscoveryQuery(config: AppConfig): DiscoveryQuery {
  switch (config.adapter) {
    case "web_search_llm": {
      if (!config.seed_queries || config.seed_queries.length === 0) {
        throw new Error(`config ${config.name}: web_search_llm needs seed_queries`);
      }
      return {
        kind: "web_search",
        vendor_type: config.vendor_type,
        requirement: config.requirement,
        seed_queries: config.seed_queries,
        limit: config.limit,
        max_results_per_query: config.max_results_per_query,
        exclude_domains: config.exclude_domains,
      };
    }
    case "github_org": {
      const g = config.github ?? GithubBlockSchema.parse({});
      return {
        kind: "github",
        vendor_type: config.vendor_type,
        languages: g.languages,
        min_merged_prs: g.min_merged_prs,
        activity_window_days: g.activity_window_days,
        min_stars: g.min_stars,
        exclude_keywords: g.exclude_keywords,
        limit: config.limit,
      };
    }
    default:
      throw new Error(`config ${config.name}: unknown adapter "${config.adapter}"`);
  }
}

// ---------------------------------------------------------------------------
// Writing configs (custom searches from the Inputs tab)
// ---------------------------------------------------------------------------


export type NewConfigInput =
  | {
      kind: "web_search";
      name?: string;
      vendor_type: (typeof VENDOR_TYPES)[number];
      ruleset: string;
      description?: string;
      requirement: string;
      seed_queries: string[];
      limit?: number;
      exclude_domains?: string[];
    }
  | {
      kind: "github";
      name?: string;
      vendor_type: (typeof VENDOR_TYPES)[number];
      ruleset: string;
      description?: string;
      requirement?: string;
      languages: string[];
      min_merged_prs?: number;
      activity_window_days?: number;
      min_stars?: number;
      exclude_keywords?: string[];
      limit?: number;
    };

function stampName(prefix: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Validate, write configs/<name>.yaml and return the loaded config. Never overwrites. */
export function writeConfig(input: NewConfigInput): AppConfig {
  const name = (input.name?.trim() || stampName(`custom_${input.kind}_${input.vendor_type}`)).toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (!SAFE_NAME.test(name)) throw new Error(`invalid config name "${name}"`);
  const file = configPath(name);
  if (fs.existsSync(file)) throw new Error(`config ${name} already exists`);
  parseRulesetRef(input.ruleset);
  const ruleset = loadRuleset(input.ruleset);
  if (ruleset.vendor_type !== input.vendor_type) {
    throw new Error(`ruleset ${input.ruleset} is for ${ruleset.vendor_type}, config is ${input.vendor_type}`);
  }
  const body: Record<string, unknown> =
    input.kind === "web_search"
      ? {
          name,
          vendor_type: input.vendor_type,
          adapter: "web_search_llm",
          ruleset: input.ruleset,
          description: input.description ?? `Custom web search created from the Inputs tab`,
          requirement: input.requirement,
          limit: input.limit ?? 30,
          max_results_per_query: 10,
          seed_queries: input.seed_queries,
          exclude_domains: input.exclude_domains ?? [],
        }
      : {
          name,
          vendor_type: input.vendor_type,
          adapter: "github_org",
          ruleset: input.ruleset,
          description: input.description ?? `Custom GitHub search created from the Inputs tab`,
          requirement: input.requirement ?? "",
          limit: input.limit ?? 50,
          github: {
            languages: input.languages,
            min_merged_prs: input.min_merged_prs ?? 200,
            activity_window_days: input.activity_window_days ?? 90,
            min_stars: input.min_stars ?? 300,
            exclude_keywords: input.exclude_keywords ?? [],
          },
        };
  const validated = ConfigFileSchema.safeParse(body);
  if (!validated.success) throw new Error(`invalid config: ${validated.error.message}`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, `# generated from the Inputs tab on ${new Date().toISOString()}\n${dumpYaml(body, { lineWidth: 100 })}`, "utf8");
  return loadConfig(name);
}
