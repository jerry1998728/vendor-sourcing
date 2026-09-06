import assert from "node:assert/strict";
import { test } from "node:test";

import { NAV_ITEMS, isNavActive, navHref, navTrail } from "@/components/nav-items";
import { sectionTarget } from "@/lib/shared/params";

const LEGACY = { inputs: "/database/sources", vendors: "/database/vendors", review: "/database/review" };

test("section root: default sub-page, legacy ?tab= mapping, other params carried over", () => {
  assert.equal(sectionTarget({}, LEGACY, "/database/sources"), "/database/sources");
  assert.equal(sectionTarget({ tab: "review", vendor: "acme.example" }, LEGACY, "/database/sources"), "/database/review?vendor=acme.example");
  assert.equal(sectionTarget({ tab: "nonsense", config: "ego_data_stereo" }, LEGACY, "/database/sources"), "/database/sources?config=ego_data_stereo");
  assert.equal(sectionTarget({ tab: ["vendors", "review"], status: ["Qualified", "Contacted"] }, LEGACY, "/database/sources"), "/database/vendors?status=Qualified&status=Contacted");
});

test("nav items: sections open their first sub-page and the trail names section and sub-page", () => {
  const database = NAV_ITEMS.find((i) => i.title === "Database")!;
  assert.equal(navHref(database), "/database/sources");
  assert.deepEqual(database.children?.map((c) => c.title), ["Vendor Source", "Vendor Data", "Review Queue"]);
  const outreach = NAV_ITEMS.find((i) => i.title === "Outreach")!;
  assert.deepEqual(outreach.children?.map((c) => c.title), ["Board", "Draft & Send", "Proposals"]);

  assert.equal(isNavActive("/database/review", "/database"), true);
  assert.equal(isNavActive("/databases", "/database"), false);
  const trail = navTrail("/outreach/proposals");
  assert.equal(trail.section?.title, "Outreach");
  assert.equal(trail.child?.title, "Proposals");
  assert.equal(navTrail("/vendors/acme.example").section, undefined);
});
