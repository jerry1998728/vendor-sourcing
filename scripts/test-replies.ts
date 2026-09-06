/**
 * Reply test set (PRD §8): 10 inbound emails with the expected next state.
 *   npm run test:replies
 * Runs real inference (sonnet) and reports accuracy plus which cases would
 * go to Proposals instead of auto-applying. Exit 1 below 8/10.
 */
import fs from "node:fs";
import path from "node:path";

import type { DiligenceStage, VendorStatus } from "@/lib/db/enums";
import { inferStatus } from "@/lib/track/infer";

type Case = {
  name: string;
  vendor: { name: string; vendor_type: string; status: VendorStatus; stage: DiligenceStage | null };
  message: { from: string; subject: string; body: string; date: string };
  unknown_must_fields: string[];
  expected: { to_status: VendorStatus; to_stage: DiligenceStage | null };
  expect_proposal: boolean;
};

async function main() {
  const dir = path.resolve(process.cwd(), "tests", "replies");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  let correct = 0;
  const toProposals: string[] = [];
  const rows: string[] = [];
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Case;
    const inf = await inferStatus({ vendor: c.vendor, message: c.message, unknownMustFields: c.unknown_must_fields });
    const ok = inf.to_status === c.expected.to_status && (inf.to_stage ?? null) === (c.expected.to_stage ?? null);
    if (ok) correct += 1;
    const routed = inf.action === "propose" ? "proposals" : inf.action === "apply" ? "auto-applied" : inf.action;
    if (inf.action === "propose") toProposals.push(c.name);
    const proposalOk = c.expect_proposal ? inf.action === "propose" : inf.action !== "propose" || !ok;
    rows.push(
      `${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(20)} got ${inf.to_status}${inf.to_stage ? "/" + inf.to_stage : ""} (conf ${inf.confidence.toFixed(2)}, ${routed})${ok ? "" : `  expected ${c.expected.to_status}${c.expected.to_stage ? "/" + c.expected.to_stage : ""}`}${c.expect_proposal && !proposalOk ? "  [expected a proposal]" : ""}`,
    );
    rows.push(`      ${inf.summary}`);
  }
  console.log(rows.join("\n"));
  console.log(`\naccuracy ${correct}/${files.length}`);
  console.log(`went to proposals: ${toProposals.join(", ") || "none"}`);
  process.exit(correct >= 8 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
