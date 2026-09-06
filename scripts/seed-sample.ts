/**
 * Sample data for testing the UI without API calls: fictional vendors (all on
 * reserved .example domains) pushed through the real write path, so evidence,
 * tags, screening, attributes and events look exactly like a real run's.
 *   npm run seed:sample
 * Idempotent: existing vendors are re-written, statuses are only set on first insert.
 */
import { eq } from "drizzle-orm";

import { getDb, nowIso, runs, vendors, type Run } from "@/lib/db";
import { transition } from "@/lib/db/state";
import { writeNormalizedVendor } from "@/lib/pipeline/run";
import { isTagDimension, type Evidence, type NormalizeResult, type Tag, type VendorCandidate, type VendorType } from "@/lib/pipeline/types";
import { loadRuleset } from "@/lib/rulesets/loader";

type EvSpec = [field: string, value: string | null, opts?: { verified?: boolean; proxy?: boolean; confidence?: number; snippet?: string; page?: string }];
type Status = "Qualified" | "Contacted" | "Rejected" | "In Discussion";
type Fixture = {
  domain: string;
  name: string;
  type: VendorType;
  ruleset: "ego_data_supplier@v1" | "repo_owner@v1" | "code_data_broker@v1";
  evidence: EvSpec[];
  /** tags without evidence (unknown badge) */
  tags?: [dimension: string, value: string][];
  status?: Status;
  reason?: string;
  owner?: string;
  due_at?: string;
  stale_days?: number;
};

const OWNER_A = "sourcer@example.com";
const OWNER_B = "sourcer2@example.com";
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

const EGO: Fixture[] = [
  {
    domain: "northlight-ego.example", name: "Northlight Ego Labs", type: "ego_data", ruleset: "ego_data_supplier@v1",
    status: "Qualified", reason: "review: strong fit, stereo rig and EU entity evidenced", owner: OWNER_A, due_at: daysAhead(3),
    evidence: [
      ["sensor_rig", "stereo", { confidence: 0.95, snippet: "Our head-mounted rig records synchronized stereo video from two global-shutter cameras at 30 fps." }],
      ["sensor_rig", "imu", { snippet: "Every session ships with 200 Hz IMU traces aligned to the video." }],
      ["registration_country", "DE", { snippet: "Northlight Ego Labs GmbH, Torstraße 12, 10119 Berlin, Germany", page: "imprint" }],
      ["ownership_country", "DE", { proxy: true, confidence: 0.7, snippet: "We are an independent, founder-owned company based in Berlin.", page: "about" }],
      ["collection_countries", "DE"], ["collection_countries", "FR"], ["collection_countries", "ES"],
      ["scene_class", "urban"], ["scene_class", "indoor"], ["scene_class", "night"],
      ["scale", "1,200 hours", { snippet: "Over 1,200 hours of egocentric footage collected to date." }],
      ["modality", "video"], ["collection_type", "egocentric"], ["licensing_model", "non_exclusive"],
      ["compliance", "gdpr"], ["compliance", "consent_documented"], ["annotation", "segmentation"], ["annotation", "temporal"],
      ["delivery", "bulk"], ["delivery", "api"], ["org_type", "company"],
      ["contact_email", "sales@northlight-ego.example"],
    ],
  },
  {
    domain: "wearcapture.example", name: "WearCapture", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Participants wear our stereo camera glasses during everyday tasks." }],
      ["registration_country", "US", { proxy: true, confidence: 0.7, snippet: "WearCapture is headquartered in Austin, Texas." }],
      ["ownership_country", null],
      ["collection_countries", "US"], ["scene_class", "urban"], ["scene_class", "suburban"],
      ["scale", "400 participants", { verified: false, confidence: 0.4 }],
      ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"],
    ],
    tags: [["licensing_model", "per_hour"]],
  },
  {
    domain: "kinesa.example", name: "Kinesa Vision", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Kinesa rigs pair a stereo camera with an active depth sensor." }],
      ["sensor_rig", "depth"],
      ["registration_country", "JP", { snippet: "Kinesa Vision K.K., Minato-ku, Tokyo 105-0001, Japan", page: "company" }],
      ["ownership_country", "JP", { proxy: true, confidence: 0.6, snippet: "A privately held Tokyo company founded in 2019." }],
      ["collection_countries", "JP"], ["collection_countries", "KR"], ["scene_class", "indoor"],
      ["scale", "6,000 clips"], ["annotation", "box_2d"], ["modality", "video"], ["collection_type", "egocentric"],
      ["delivery", "bulk"], ["org_type", "company"], ["contact_email", "hello@kinesa.example"],
    ],
  },
  {
    domain: "fieldframe.example", name: "Fieldframe Data", type: "ego_data", ruleset: "ego_data_supplier@v1",
    status: "Contacted", owner: OWNER_A, due_at: daysAhead(7),
    evidence: [
      ["sensor_rig", "stereo", { snippet: "All Fieldframe captures use a calibrated stereo pair for metric depth." }],
      ["registration_country", "GB", { snippet: "Fieldframe Data Ltd is registered in England and Wales, company no. 12345678.", page: "legal" }],
      ["ownership_country", "GB", { proxy: true, confidence: 0.65, snippet: "Fieldframe is independently owned by its founders." }],
      ["collection_countries", "GB"], ["collection_countries", "DE"], ["collection_countries", "IN"],
      ["scene_class", "urban"], ["scene_class", "highway"], ["scene_class", "adverse_weather"],
      ["scale", "900 hours"], ["licensing_model", "per_dataset"], ["compliance", "release_forms"],
      ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"], ["contact_email", "partners@fieldframe.example"],
    ],
  },
  {
    domain: "streetsense.example", name: "Streetsense Collect", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "mono", { snippet: "Our lightweight monocular chest camera keeps the setup unobtrusive." }],
      ["registration_country", "FR", { snippet: "Streetsense Collect SAS, 75011 Paris, France", page: "mentions-legales" }],
      ["ownership_country", "FR", { proxy: true, confidence: 0.6, snippet: "Streetsense is an independent French company." }],
      ["collection_countries", "FR"], ["scene_class", "urban"], ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"],
    ],
  },
  {
    domain: "aperturehuman.example", name: "Aperture Human Data", type: "ego_data", ruleset: "ego_data_supplier@v1",
    status: "Rejected", reason: "duplicate: same supplier as an existing partner", owner: OWNER_B,
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Head-mounted stereo cameras capture both views at 1080p." }],
      ["registration_country", "CA", { snippet: "Aperture Human Data Inc., Toronto, ON, Canada", page: "contact" }],
      ["ownership_country", "CA", { proxy: true, confidence: 0.6, snippet: "We are a privately held Canadian company." }],
      ["collection_countries", "CA"], ["collection_countries", "US"], ["collection_countries", "MX"],
      ["scene_class", "urban"], ["scene_class", "suburban"], ["scene_class", "indoor"], ["scale", "800 hours"],
      ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"],
    ],
  },
  {
    domain: "lumen-ego.example", name: "Lumen Ego Studio", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", null],
      ["registration_country", "ES", { proxy: true, confidence: 0.6, snippet: "Based in Valencia, Spain, Lumen Ego Studio produces first-person video." }],
      ["ownership_country", null],
      ["collection_countries", "ES"], ["modality", "video"], ["collection_type", "egocentric"],
    ],
    tags: [["scene_class", "indoor"]],
  },
  {
    domain: "handsight.example", name: "Handsight", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Handsight glasses combine stereo RGB cameras with eye tracking." }],
      ["sensor_rig", "eye_tracking"],
      ["registration_country", "KR", { snippet: "Handsight Co., Ltd., Gangnam-gu, Seoul, Republic of Korea", page: "company" }],
      ["ownership_country", "KR", { proxy: true, confidence: 0.6, snippet: "Handsight is a privately owned Korean startup." }],
      ["collection_countries", "KR"], ["scene_class", "indoor"], ["scale", "350 hours"], ["annotation", "temporal"],
      ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"], ["contact_email", "contact@handsight.example"],
    ],
  },
  {
    domain: "orbita.example", name: "Orbita Capture", type: "ego_data", ruleset: "ego_data_supplier@v1",
    stale_days: 45,
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Riders wear a helmet-mounted stereo camera with GPS logging." }],
      ["sensor_rig", "gps"],
      ["registration_country", "BR", { snippet: "Orbita Capture Ltda., São Paulo, SP, Brasil", page: "contato" }],
      ["ownership_country", "BR", { proxy: true, confidence: 0.6, snippet: "Uma empresa brasileira independente." }],
      ["collection_countries", "BR"], ["collection_countries", "AR"], ["collection_countries", "CL"],
      ["scene_class", "urban"], ["scene_class", "highway"], ["scene_class", "night"], ["scale", "2,100 hours"],
      ["modality", "video"], ["collection_type", "egocentric"], ["licensing_model", "non_exclusive"], ["org_type", "company"],
    ],
  },
  {
    domain: "veritypov.example", name: "Verity POV", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Verity POV kits record stereo video with synchronized audio." }],
      ["registration_country", "US", { snippet: "Verity POV LLC, 500 Market St, San Francisco, CA 94105", page: "legal" }],
      ["ownership_country", "SG", { snippet: "Verity POV is a wholly owned subsidiary of Verity Holdings Pte. Ltd., Singapore.", page: "about" }],
      ["parent_entity", "Verity Holdings Pte. Ltd.", { snippet: "Verity POV is a wholly owned subsidiary of Verity Holdings Pte. Ltd., Singapore.", page: "about" }],
      ["collection_countries", "US"], ["scene_class", "urban"], ["scale", "500 hours"], ["modality", "video"], ["modality", "audio"],
      ["collection_type", "egocentric"], ["org_type", "company"],
    ],
  },
  {
    domain: "nomadsensors.example", name: "Nomad Sensors", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "depth", { snippet: "The Nomad pack carries a depth camera and a solid-state lidar." }],
      ["sensor_rig", "lidar"], ["sensor_rig", "mono"],
      ["registration_country", "AU", { snippet: "Nomad Sensors Pty Ltd, ABN 12 345 678 901, Melbourne VIC", page: "terms" }],
      ["ownership_country", "AU", { proxy: true, confidence: 0.6, snippet: "An Australian-owned company." }],
      ["collection_countries", "AU"], ["scene_class", "suburban"], ["modality", "lidar"], ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"],
    ],
  },
  {
    domain: "gazecollective.example", name: "Gaze Collective", type: "ego_data", ruleset: "ego_data_supplier@v1",
    status: "In Discussion", owner: OWNER_B, due_at: daysAgo(2),
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Our binocular glasses capture a true stereo pair for every gaze sample." }],
      ["sensor_rig", "eye_tracking"],
      ["registration_country", "NL", { snippet: "Gaze Collective B.V., KvK 12345678, Amsterdam", page: "imprint" }],
      ["ownership_country", "NL", { proxy: true, confidence: 0.6, snippet: "Gaze Collective is independent and employee-owned." }],
      ["collection_countries", "NL"], ["collection_countries", "BE"], ["collection_countries", "DE"],
      ["scene_class", "indoor"], ["scene_class", "urban"], ["scale", "2,500 sessions"], ["compliance", "gdpr"], ["compliance", "consent_documented"],
      ["modality", "video"], ["collection_type", "egocentric"], ["licensing_model", "subscription"], ["delivery", "api"], ["org_type", "company"],
      ["contact_email", "team@gazecollective.example"],
    ],
  },
  {
    domain: "shenzhen-vision.example", name: "Shenzhen Vision Data", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Dual-camera stereo modules capture first-person video for training." }],
      ["registration_country", "CN", { confidence: 0.95, snippet: "Shenzhen Vision Data Co., Ltd., Nanshan District, Shenzhen, China", page: "about" }],
      ["ownership_country", "CN", { proxy: true, confidence: 0.7, snippet: "A privately held company registered in Shenzhen." }],
      ["collection_countries", "CN"], ["scene_class", "urban"], ["scene_class", "indoor"], ["scale", "5,000 hours"],
      ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"],
    ],
  },
  {
    domain: "huaxia-wear.example", name: "Huaxia Wearables Europe", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Stereo wearable capture for robotics customers across Europe." }],
      ["registration_country", "DE", { snippet: "Huaxia Wearables Europe GmbH, Frankfurt am Main", page: "impressum" }],
      ["ownership_country", "CN", { snippet: "Huaxia Wearables Europe GmbH is a subsidiary of Huaxia Group Co., Ltd., Shenzhen.", page: "impressum" }],
      ["parent_entity", "Huaxia Group Co., Ltd.", { snippet: "Huaxia Wearables Europe GmbH is a subsidiary of Huaxia Group Co., Ltd., Shenzhen.", page: "impressum" }],
      ["collection_countries", "DE"], ["collection_countries", "PL"], ["scene_class", "urban"], ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"],
    ],
  },
  {
    domain: "polarego.example", name: "Polar Ego Data", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Arctic-rated stereo rigs with heated lenses." }],
      ["sensor_rig", "imu"],
      ["registration_country", "FI", { snippet: "Polar Ego Data Oy, Business ID 1234567-8, Oulu", page: "legal" }],
      ["ownership_country", null],
      ["collection_countries", "FI"], ["collection_countries", "SE"], ["collection_countries", "NO"],
      ["scene_class", "adverse_weather"], ["scene_class", "night"], ["scene_class", "urban"], ["scale", "1,800 hours"],
      ["modality", "video"], ["collection_type", "egocentric"], ["licensing_model", "non_exclusive"], ["org_type", "company"],
    ],
  },
  {
    domain: "terrafp.example", name: "Terra Firstperson", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Terra rigs record stereo footage from a chest mount." }],
      ["registration_country", "IN", { snippet: "Terra Firstperson Pvt. Ltd., CIN U12345KA2020PTC000000, Bengaluru", page: "legal" }],
      ["ownership_country", "IN", { proxy: true, confidence: 0.6, snippet: "An independent Indian company." }],
      ["collection_countries", "IN"], ["scene_class", "urban"], ["scene_class", "suburban"], ["scale", "300 hours"],
      ["modality", "video"], ["collection_type", "egocentric"], ["delivery", "bulk"], ["org_type", "company"], ["contact_email", "sales@terrafp.example"],
    ],
  },
  {
    domain: "metisdata.example", name: "Metis Robotics Data", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { snippet: "Teleoperators wear stereo headsets so every demonstration is captured in stereo." }],
      ["registration_country", "IL", { snippet: "Metis Robotics Data Ltd., Tel Aviv, Israel", page: "about" }],
      ["ownership_country", "IL", { proxy: true, confidence: 0.6, snippet: "Metis is an independent company backed by Israeli investors." }],
      ["collection_countries", "IL"], ["scene_class", "indoor"], ["annotation", "box_3d"], ["scale", "12,000 demonstrations"],
      ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"],
    ],
  },
  {
    domain: "cobaltego.example", name: "Cobalt Egocentric", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "mono", { snippet: "A single wide-angle camera keeps the Cobalt cap under 60 grams." }],
      ["registration_country", "US", { snippet: "Cobalt Egocentric, Inc., Delaware", page: "terms" }],
      ["ownership_country", "US", { proxy: true, confidence: 0.6, snippet: "Cobalt is an independent Delaware corporation." }],
      ["collection_countries", "US"], ["scene_class", "indoor"], ["modality", "video"], ["collection_type", "egocentric"], ["org_type", "company"],
    ],
  },
  {
    domain: "pixelpath.example", name: "PixelPath Collect", type: "ego_data", ruleset: "ego_data_supplier@v1",
    evidence: [
      ["sensor_rig", "stereo", { verified: false, confidence: 0.4 }],
      ["registration_country", "PT", { proxy: true, confidence: 0.6, snippet: "PixelPath Collect is based in Lisbon, Portugal." }],
      ["ownership_country", null],
      ["collection_countries", "PT"], ["modality", "video"], ["collection_type", "egocentric"],
    ],
  },
];

const CODE: Fixture[] = [
  {
    domain: "atlassystems.example", name: "Atlas Systems", type: "code_data", ruleset: "repo_owner@v1",
    status: "Qualified", reason: "review: high PR volume, mature repos", owner: OWNER_A, due_at: daysAhead(5),
    evidence: [
      ["merged_prs_public", "1450", { proxy: true, snippet: "GitHub search: 1,450 merged pull requests across public repositories of atlas-systems." }],
      ["production_signals", "5", { proxy: true }], ["ci_config", "true"], ["release_tags", "true"], ["test_directory", "true"], ["license", "true"], ["lockfile", "true"],
      ["last_commit_days", "3"], ["is_fork_or_tutorial", "false"], ["public_repos", "42"], ["stars_total", "18,300"],
      ["org_type", "company"], ["code_language", "typescript"], ["code_language", "go"], ["code_license", "permissive"],
      ["website", "https://atlassystems.example"], ["headquarters", "Stockholm, Sweden"], ["registration_country", "SE", { proxy: true, confidence: 0.6 }],
      ["modality", "code"], ["collection_type", "licensed_existing"],
    ],
  },
  {
    domain: "helix.example", name: "Helix Compute", type: "code_data", ruleset: "repo_owner@v1",
    evidence: [
      ["merged_prs_public", "310", { proxy: true }], ["production_signals", "3", { proxy: true }], ["ci_config", "true"], ["release_tags", "false"], ["test_directory", "true"], ["license", "true"], ["lockfile", "false"],
      ["last_commit_days", "20"], ["is_fork_or_tutorial", "false"], ["public_repos", "9"], ["stars_total", "1,100"],
      ["org_type", "company"], ["code_language", "python"], ["code_license", "permissive"], ["website", "https://helix.example"], ["headquarters", "Denver, CO"], ["registration_country", "US", { proxy: true, confidence: 0.6 }],
      ["modality", "code"], ["collection_type", "licensed_existing"],
    ],
  },
  {
    domain: "quill.example", name: "Quill Foundation", type: "code_data", ruleset: "repo_owner@v1",
    evidence: [
      ["merged_prs_public", "5200", { proxy: true }], ["production_signals", "4", { proxy: true }], ["ci_config", "true"], ["release_tags", "true"], ["test_directory", "true"], ["license", "true"], ["lockfile", "false"],
      ["last_commit_days", "1"], ["is_fork_or_tutorial", "false"], ["public_repos", "120"], ["stars_total", "64,000"],
      ["org_type", "foundation"], ["code_language", "rust"], ["code_language", "python"], ["code_license", "permissive"], ["website", "https://quill.example"],
      ["modality", "code"], ["collection_type", "licensed_existing"],
    ],
  },
  {
    domain: "bramble.example", name: "Bramble Labs", type: "code_data", ruleset: "repo_owner@v1",
    evidence: [
      ["merged_prs_public", "90", { proxy: true }], ["production_signals", "2", { proxy: true }], ["ci_config", "true"], ["release_tags", "false"], ["test_directory", "true"], ["license", "false"], ["lockfile", "false"],
      ["last_commit_days", "12"], ["is_fork_or_tutorial", "false"], ["public_repos", "6"], ["stars_total", "400"],
      ["org_type", "company"], ["code_language", "java"], ["code_license", "unknown"], ["modality", "code"], ["collection_type", "licensed_existing"],
    ],
  },
  {
    domain: "sunder.example", name: "Sunder Tools", type: "code_data", ruleset: "repo_owner@v1",
    evidence: [
      ["merged_prs_public", null], ["production_signals", "4", { proxy: true }], ["ci_config", "true"], ["release_tags", "true"], ["test_directory", "true"], ["license", "true"], ["lockfile", "false"],
      ["last_commit_days", "8"], ["is_fork_or_tutorial", "false"], ["public_repos", "15"], ["stars_total", "2,900"],
      ["org_type", "company"], ["code_language", "go"], ["code_license", "copyleft"], ["website", "https://sunder.example"], ["modality", "code"], ["collection_type", "licensed_existing"],
    ],
  },
  {
    domain: "kestrel.example", name: "Kestrel AI", type: "code_data", ruleset: "repo_owner@v1",
    evidence: [
      ["merged_prs_public", "760", { proxy: true }], ["production_signals", "4", { proxy: true }], ["ci_config", "true"], ["release_tags", "true"], ["test_directory", "true"], ["license", "true"], ["lockfile", "false"],
      ["last_commit_days", "140"], ["is_fork_or_tutorial", "false"], ["public_repos", "11"], ["stars_total", "3,400"],
      ["org_type", "company"], ["code_language", "python"], ["code_license", "permissive"], ["modality", "code"], ["collection_type", "licensed_existing"],
    ],
  },
  {
    domain: "repohaus.example", name: "Repohaus", type: "code_data", ruleset: "code_data_broker@v1",
    evidence: [
      ["offers_code_data", "true", { snippet: "Repohaus licenses curated source-code datasets for AI model training." }],
      ["inventory_private_repos", "true", { snippet: "Our inventory comes from private repositories licensed directly from their owners." }],
      ["license_provenance", "true", { snippet: "Every repository carries a signed license agreement and a provenance record." }],
      ["inventory_pr_history", "true", { snippet: "Datasets include full pull-request and code-review history." }],
      ["inventory_scale", "40,000 repositories"], ["registration_country", "DE", { snippet: "Repohaus GmbH, Hamburg", page: "impressum" }],
      ["licensing_model", "per_dataset"], ["delivery", "bulk"], ["code_language", "python"], ["code_language", "typescript"], ["code_license", "proprietary"],
      ["org_type", "broker"], ["contact_email", "licensing@repohaus.example"], ["modality", "code"], ["collection_type", "licensed_existing"],
    ],
  },
  {
    domain: "forgeline.example", name: "Forgeline Licensing", type: "code_data", ruleset: "code_data_broker@v1",
    evidence: [
      ["offers_code_data", "true", { snippet: "Forgeline supplies code datasets to model developers." }],
      ["inventory_private_repos", null], ["license_provenance", null],
      ["registration_country", "US", { proxy: true, confidence: 0.6, snippet: "Forgeline is headquartered in Seattle." }],
      ["org_type", "broker"], ["modality", "code"], ["collection_type", "licensed_existing"],
    ],
  },
];

function toResult(f: Fixture): NormalizeResult & { vendor: VendorCandidate } {
  const now = nowIso();
  const evidence: Evidence[] = f.evidence.map(([field_path, value, o = {}]) => {
    const verified = value !== null && o.verified !== false;
    const page = o.page ?? "about";
    return {
      field_path,
      value,
      source_url: verified ? `https://${f.domain}/${page}` : null,
      snippet: verified ? (o.snippet ?? `${f.name}: ${field_path.replace(/_/g, " ")} ${value}`) : null,
      extraction_method: "manual",
      confidence: o.confidence ?? (value === null ? 0 : verified ? 0.85 : 0.4),
      proxy: Boolean(o.proxy),
      verified,
      attested_by: verified ? "seed-sample" : null,
      observed_at: now,
    };
  });
  const tags: Tag[] = [];
  evidence.forEach((e, i) => {
    if (e.value !== null && isTagDimension(e.field_path)) {
      tags.push({ dimension: e.field_path, value: e.value, source_badge: e.verified ? "manual" : "unknown", evidence_index: i });
    }
  });
  for (const [dimension, value] of f.tags ?? []) {
    if (isTagDimension(dimension)) tags.push({ dimension, value, source_badge: "unknown", evidence_index: null });
  }
  evidence.push({
    field_path: "source_channel", value: "manual", source_url: null, snippet: "Sample fixture (npm run seed:sample)",
    extraction_method: "manual", confidence: 1, proxy: false, verified: true, attested_by: "seed-sample", observed_at: now,
  });
  tags.push({ dimension: "source_channel", value: "manual", source_badge: "manual", evidence_index: evidence.length - 1 });
  const first = (fp: string) => evidence.find((e) => e.field_path === fp && e.verified && e.value)?.value ?? null;
  return {
    page_type: "vendor_site",
    vendor: {
      vendor_id: f.domain, name: f.name, vendor_type: f.type, primary_domain: f.domain,
      contact_email: first("contact_email"), registration_country: first("registration_country"), ownership_country: first("ownership_country"),
      parent_entity: first("parent_entity"),
      collection_countries: evidence.filter((e) => e.field_path === "collection_countries" && e.verified && e.value).map((e) => e.value as string),
      discovered_via: "manual",
    },
    evidence, tags, mentioned_vendors: [], raw: { sample: true },
  };
}

function ensureRun(db: ReturnType<typeof getDb>, run_id: string, config: string, vendor_type: VendorType, ruleset_version: string): Run {
  const existing = db.select().from(runs).where(eq(runs.run_id, run_id)).get();
  if (existing) return existing;
  const now = nowIso();
  return db.insert(runs).values({
    run_id, input_type: "manual", adapter: "sample_fixture", vendor_type, query: { config, sample: true },
    ruleset_version, started_at: now, finished_at: now, counts: { progress: { phase: "done" } }, raw_payload_path: null,
  }).returning().get();
}

function applyStatus(db: ReturnType<typeof getDb>, f: Fixture) {
  const v = f.domain;
  const human = (toStatus: "Qualified" | "Contacted" | "Rejected", reason: string) => transition({ vendorId: v, toStatus, actor: "human", reason }, db);
  switch (f.status) {
    case "Qualified":
      human("Qualified", f.reason ?? "review: qualified");
      break;
    case "Contacted":
      human("Qualified", "review: qualified");
      human("Contacted", "sent intro email");
      break;
    case "Rejected":
      human("Rejected", f.reason ?? "review: rejected");
      break;
    case "In Discussion":
      human("Qualified", "review: qualified");
      human("Contacted", "sent intro email");
      transition({ vendorId: v, toStatus: "Replied", actor: "system", reason: "first inbound reply" }, db);
      transition({ vendorId: v, toStatus: "In Discussion", actor: "llm_inference", reason: "positive reply, asked for sample specs", confidence: 0.91 }, db);
      transition({ vendorId: v, toStatus: "In Discussion", toStage: "technical_review", actor: "llm_inference", reason: "sent technical questionnaire", confidence: 0.88 }, db);
      break;
  }
}

function main() {
  const db = getDb();
  const groups: { run_id: string; config: string; vendor_type: VendorType; fixtures: Fixture[] }[] = [
    { run_id: "run_20260901_090000_5a3e01", config: "ego_data_stereo", vendor_type: "ego_data", fixtures: EGO },
    { run_id: "run_20260901_091500_5a3e02", config: "code_data_github_orgs", vendor_type: "code_data", fixtures: CODE.filter((f) => f.ruleset === "repo_owner@v1") },
    { run_id: "run_20260901_093000_5a3e03", config: "code_data_brokers", vendor_type: "code_data", fixtures: CODE.filter((f) => f.ruleset === "code_data_broker@v1") },
  ];
  let inserted = 0;
  let updated = 0;
  for (const g of groups) {
    const rulesetRef = g.fixtures[0].ruleset;
    const run = ensureRun(db, g.run_id, g.config, g.vendor_type, rulesetRef);
    const results: { result: string; coverage: number }[] = [];
    for (const f of g.fixtures) {
      const ruleset = loadRuleset(f.ruleset);
      const out = writeNormalizedVendor(db, run, ruleset, toResult(f));
      results.push({ result: out.result, coverage: out.must_field_coverage });
      const patch: Partial<typeof vendors.$inferInsert> = {};
      if (out.is_new) {
        inserted += 1;
        applyStatus(db, f);
        if (f.owner) patch.owner = f.owner;
        if (f.due_at) patch.due_at = f.due_at;
      } else updated += 1;
      // re-applied on every seed so the stale sample survives re-writes (which refresh last_verified_at)
      if (f.stale_days) patch.last_verified_at = daysAgo(f.stale_days);
      if (Object.keys(patch).length) db.update(vendors).set(patch).where(eq(vendors.vendor_id, f.domain)).run();
    }
    const count = (r: string) => results.filter((x) => x.result === r).length;
    db.update(runs).set({
      counts: {
        discovered: g.fixtures.length, normalized: g.fixtures.length, vendor_sites: g.fixtures.length,
        new_vendors: g.fixtures.length, pass: count("pass"), fail: count("fail"), unknown: count("unknown"),
        must_field_coverage: Math.round((results.reduce((a, b) => a + b.coverage, 0) / results.length) * 1000) / 1000,
        unknown_rate: Math.round((count("unknown") / results.length) * 1000) / 1000,
        progress: { phase: "done" },
      },
    }).where(eq(runs.run_id, g.run_id)).run();
    console.log(`${g.config}: ${g.fixtures.length} vendors -> pass ${count("pass")}, unknown ${count("unknown")}, fail ${count("fail")}`);
  }
  console.log(`inserted ${inserted}, re-written ${updated}`);
}

main();
