import assert from "node:assert/strict";
import { test } from "node:test";

import { NAV_ITEMS, isNavActive, isSectionActive, navHref, navTrail } from "@/components/nav-items";
import { sectionTarget } from "@/lib/shared/params";

const LEGACY = { inputs: "/database/sources", vendors: "/database/vendors", review: "/database/review" };

test("section root: default sub-page, legacy ?tab= mapping, other params carried over", () => {
  assert.equal(sectionTarget({}, LEGACY, "/database/sources"), "/database/sources");
  assert.equal(sectionTarget({ tab: "review", vendor: "acme.example" }, LEGACY, "/database/sources"), "/database/review?vendor=acme.example");
  assert.equal(sectionTarget({ tab: "nonsense", config: "ego_data_stereo" }, LEGACY, "/database/sources"), "/database/sources?config=ego_data_stereo");
  assert.equal(sectionTarget({ tab: ["vendors", "review"], status: ["Qualified", "Contacted"] }, LEGACY, "/database/sources"), "/database/vendors?status=Qualified&status=Contacted");
});

test("navigation follows the lifecycle: discover, select, evaluate, manage, then the planned stages", () => {
  assert.deepEqual(NAV_ITEMS.map((i) => i.title), ["Dashboard", "Discover", "Select", "Evaluate", "Manage", "Contract & Onboard", "Renew or Exit"]);
  const planned = NAV_ITEMS.filter((i) => i.planned);
  assert.deepEqual(planned.map((i) => i.title), ["Contract & Onboard", "Renew or Exit"]);
  assert.ok(planned.every((i) => i.note));

  const discover = NAV_ITEMS.find((i) => i.title === "Discover")!;
  assert.deepEqual(discover.children?.map((c) => c.title), ["Vendor Source", "Vendor Data"]);
  assert.equal(navHref(discover), "/database/sources");
  assert.equal(navHref(NAV_ITEMS.find((i) => i.title === "Manage")!), "/outreach/board");
});

test("a section is active only for its own pages, and planned stages never are", () => {
  const discover = NAV_ITEMS.find((i) => i.title === "Discover")!;
  const select = NAV_ITEMS.find((i) => i.title === "Select")!;
  const evaluate = NAV_ITEMS.find((i) => i.title === "Evaluate")!;
  const manage = NAV_ITEMS.find((i) => i.title === "Manage")!;

  // Review Queue sits under /database but belongs to Select, not Discover.
  assert.equal(isSectionActive("/database/review", select), true);
  assert.equal(isSectionActive("/database/review", discover), false);
  assert.equal(isSectionActive("/database/vendors", discover), true);
  // Board and the Evaluate pages share the /outreach prefix.
  assert.equal(isSectionActive("/outreach/board", manage), true);
  assert.equal(isSectionActive("/outreach/board", evaluate), false);
  assert.equal(isSectionActive("/outreach/proposals", evaluate), true);
  assert.equal(isSectionActive("/dashboard", NAV_ITEMS.find((i) => i.planned)!), false);

  assert.equal(isNavActive("/database/review", "/database"), true);
  assert.equal(isNavActive("/databases", "/database"), false);
});

test("the header trail names the stage and the page", () => {
  const trail = navTrail("/outreach/proposals");
  assert.equal(trail.section?.title, "Evaluate");
  assert.equal(trail.child?.title, "Proposals");
  assert.equal(navTrail("/database/review").section?.title, "Select");
  assert.equal(navTrail("/vendors/acme.example").section, undefined);
});
