import assert from "node:assert/strict";
import { test } from "node:test";

import { findSnippet, groundClaims, normalizeForMatch, type PageIndex } from "@/lib/adapters/webSearchLlm";
import type { FetchedPage } from "@/lib/llm/fetchPage";
import { NormalizeOutput, type RawRecord } from "@/lib/pipeline/types";
import { loadRuleset } from "@/lib/rulesets/loader";

const page = (url: string, text: string, title = "Acme"): FetchedPage => ({ url, final_url: url, status: 200, title, text, links: [], fetched_at: "2026-09-07T00:00:00.000Z" });
const HOME = page("https://acme.example/", "Acme builds STEREO camera glasses for egocentric data capture.\n\nWe are registered in Berlin, Germany.");
const ABOUT = page("https://acme.example/about", "Founded in 2019, Acme collects footage across Germany, France and Spain.");
const index: PageIndex[] = [HOME, ABOUT].map((p) => ({ page: p, key: p.final_url, norm: normalizeForMatch(p.text) }));
const raw: RawRecord = { source: "web_search", url: "https://acme.example/", domain: "acme.example", title: "Acme", snippet: null, query: "stereo egocentric", discovered_at: "2026-09-07T00:00:00.000Z", hop: 1, extra: {} };
const ruleset = loadRuleset("ego_data_supplier@v1");
const now = "2026-09-07T00:00:00.000Z";

const parsed = (fields: Record<string, unknown>[], tags: Record<string, unknown>[] = []) =>
  NormalizeOutput.parse({
    page_type: "vendor_site",
    name: "Acme",
    primary_domain: "acme.example",
    registration_country: "DE",
    ownership_country: null,
    parent_entity: null,
    collection_countries: ["DE", "FR", "ES"],
    fields,
    tags,
    mentioned_vendors: [],
    notes: null,
  });

test("findSnippet: verbatim match survives case and whitespace, prefers the claimed page, rejects short snippets", () => {
  const hit = findSnippet("stereo   CAMERA glasses for egocentric data capture", "https://acme.example/", index);
  assert.deepEqual(hit, { found: true, source_url: "https://acme.example/" });
  const elsewhere = findSnippet("collects footage across Germany, France and Spain", "https://acme.example/", index);
  assert.equal(elsewhere.found, true);
  assert.equal(elsewhere.source_url, "https://acme.example/about");
  assert.equal(findSnippet("stereo", "https://acme.example/", index).found, false);
  assert.equal(findSnippet("we ship lidar rigs to the moon every week", "https://acme.example/", index).found, false);
});

test("groundClaims: grounded values are verified with the page they came from; invented ones stay unverified", () => {
  const g = groundClaims(
    parsed([
      { field_path: "sensor_rig", value: "stereo", source_url: "https://acme.example/", snippet: "STEREO camera glasses for egocentric data capture", confidence: 0.9, proxy: false },
      { field_path: "registration_country", value: "de", source_url: "https://acme.example/", snippet: "registered in Berlin, Germany", confidence: 0.8, proxy: false },
      { field_path: "ownership_country", value: "DE", source_url: "https://acme.example/", snippet: "owned by Acme Holdings in Munich", confidence: 0.7, proxy: false },
    ]),
    [HOME, ABOUT],
    raw,
    "acme.example",
    ruleset,
    "ego_data",
    now,
  );
  const by = (fp: string) => g.evidence.filter((e) => e.field_path === fp);
  assert.deepEqual(by("sensor_rig").map((e) => [e.value, e.verified, e.source_url]), [["stereo", true, "https://acme.example/"]]);
  assert.deepEqual(by("registration_country").map((e) => [e.value, e.verified]), [["DE", true]]);
  assert.deepEqual(by("ownership_country").map((e) => [e.value, e.verified]), [["DE", false]]);
  assert.ok(g.notes.some((n) => n.startsWith("ownership_country:")));
  assert.deepEqual(g.tags.find((t) => t.dimension === "sensor_rig")?.source_badge, "verified");
  assert.equal(g.vendor.registration_country, "DE");
  assert.equal(g.vendor.ownership_country, null);
  assert.equal(g.vendor.vendor_id, "acme.example");
  // provenance row and tag for a fresh discovery
  assert.equal(by("source_channel")[0]?.verified, true);
  assert.ok(g.tags.some((t) => t.dimension === "source_channel" && t.value === "web_search"));
});

test("groundClaims: bad codes are dropped with a note, every must-field gets a row, top-level claims become unverified evidence", () => {
  const g = groundClaims(
    parsed([{ field_path: "registration_country", value: "Germany", source_url: "https://acme.example/", snippet: "registered in Berlin, Germany", confidence: 0.8, proxy: false }]),
    [HOME, ABOUT],
    raw,
    "acme.example",
    ruleset,
    "ego_data",
    now,
  );
  assert.ok(g.notes.some((n) => /invalid_country_code/.test(n)));
  for (const must of ruleset.must) assert.ok(g.evidence.some((e) => e.field_path === must.field_path), must.field_path);
  const collection = g.evidence.filter((e) => e.field_path === "collection_countries");
  assert.deepEqual(collection.map((e) => [e.value, e.verified]), [["DE", false], ["FR", false], ["ES", false]]);
  assert.deepEqual(g.vendor.collection_countries, []); // unverified never reaches the vendor
});

test("groundClaims: directly proposed tags need a grounded snippet for a verified badge; refresh adds no provenance", () => {
  const g = groundClaims(
    parsed([], [
      { dimension: "scene_class", value: "urban", source_url: "https://acme.example/about", snippet: "collects footage across Germany, France and Spain", confidence: 0.8 },
      { dimension: "annotation", value: "segmentation", source_url: null, snippet: null, confidence: 0.5 },
    ]),
    [HOME, ABOUT],
    { ...raw, extra: { refresh: true } },
    "acme.example",
    ruleset,
    "ego_data",
    now,
  );
  assert.equal(g.tags.find((t) => t.dimension === "scene_class")?.source_badge, "verified");
  assert.equal(g.tags.find((t) => t.dimension === "annotation")?.source_badge, "unknown");
  assert.equal(g.evidence.some((e) => e.field_path === "source_channel"), false);
});
