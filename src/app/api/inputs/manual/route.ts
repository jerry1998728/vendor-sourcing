import { NextResponse } from "next/server";
import { z } from "zod";

import { importManualCsv } from "@/lib/pipeline/manual";
import { VENDOR_TYPES } from "@/lib/pipeline/types";

export const dynamic = "force-dynamic";

const FieldsSchema = z.object({
  vendor_type: z.enum(VENDOR_TYPES),
  ruleset: z.string().regex(/^[a-z0-9_]+@v\d+$/),
  uploader: z.string().trim().min(1).max(200),
  attest_all: z.boolean(),
});

/** multipart/form-data: file (CSV), vendor_type, ruleset, uploader, attest_all */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (file.size > 2_000_000) return NextResponse.json({ error: "CSV larger than 2 MB" }, { status: 400 });
  const fields = FieldsSchema.safeParse({
    vendor_type: form.get("vendor_type"),
    ruleset: form.get("ruleset"),
    uploader: form.get("uploader"),
    attest_all: form.get("attest_all") === "true",
  });
  if (!fields.success) {
    return NextResponse.json({ error: fields.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  try {
    const text = await file.text();
    const out = importManualCsv(text, {
      vendorType: fields.data.vendor_type,
      rulesetRef: fields.data.ruleset,
      uploader: fields.data.uploader,
      attestAll: fields.data.attest_all,
      configName: `manual_upload:${file.name}`,
    });
    return NextResponse.json({ run_id: out.run.run_id, counts: out.counts, rows: out.rows });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
