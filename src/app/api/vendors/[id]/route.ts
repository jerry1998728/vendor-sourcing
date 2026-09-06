import { NextResponse } from "next/server";

import { getVendorDetail } from "@/lib/db/queries";

export const dynamic = "force-dynamic";

/** Vendor row plus its evidence, tags and event log. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = getVendorDetail(decodeURIComponent(id));
  if (!detail) return NextResponse.json({ error: `vendor ${id} not found` }, { status: 404 });
  return NextResponse.json(detail);
}
