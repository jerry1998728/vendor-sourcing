import assert from "node:assert/strict";
import { test } from "node:test";

import { canonicalDomain, normalizeDomain, registrableDomain, vendorIdFor } from "@/lib/pipeline/ids";

test("domains normalise to the registrable domain, hosting subdomains survive", () => {
  assert.equal(normalizeDomain("https://www.Example.com/about?x=1"), "example.com");
  assert.equal(canonicalDomain("https://data.eu.example.co.uk/"), "example.co.uk");
  assert.equal(canonicalDomain("https://netflix.github.io/"), "netflix.github.io");
  assert.equal(canonicalDomain("https://argoproj.github.io/"), "argoproj.github.io");
  assert.equal(registrableDomain("docs.vercel.app"), "docs.vercel.app");
  assert.equal(canonicalDomain("not a url"), null);
  assert.equal(vendorIdFor(null, "Acme Data Labs", "ego_data"), "acme-data-labs+ego_data");
});
