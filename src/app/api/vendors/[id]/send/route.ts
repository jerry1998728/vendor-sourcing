import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, interactions, nowIso, vendors } from "@/lib/db";
import { getVendorDetail, insertInteraction } from "@/lib/db/queries";
import { TransitionError, transition } from "@/lib/db/state";
import { isAllowedRecipient, normalizeEmail, parseAllowlist } from "@/lib/outreach/allowlist";
import { GmailNotConfiguredError, GmailNotConnectedError, profile, sendMessage } from "@/lib/outreach/gmail";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  to: z.string().trim().min(3).max(320),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20_000),
  draft_interaction_id: z.number().int().positive().optional(),
});

const FOLLOW_UP_DAYS = 7;

/**
 * The human send gate (PRD §6 Qualified -> Contacted). The recipient allowlist
 * is enforced here regardless of what the client showed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const vendorId = decodeURIComponent(id);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  }
  const input = parsed.data;
  const to = normalizeEmail(input.to);

  const allowlist = parseAllowlist();
  if (!isAllowedRecipient(to, allowlist)) {
    return NextResponse.json(
      {
        error: allowlist.length
          ? `${to} is not in DEMO_ALLOWED_RECIPIENTS`
          : "DEMO_ALLOWED_RECIPIENTS is empty; add allowed addresses to .env.local before sending",
        allowed_recipients: allowlist,
      },
      { status: 403 },
    );
  }

  const db = getDb();
  const detail = getVendorDetail(vendorId, db);
  if (!detail) return NextResponse.json({ error: `vendor ${vendorId} not found` }, { status: 404 });
  const followUp = detail.vendor.status === "Contacted" || detail.vendor.status === "Dormant";
  if (detail.vendor.status !== "Qualified" && !followUp) {
    return NextResponse.json({ error: `vendor is ${detail.vendor.status}; only Qualified vendors can be contacted (Contacted/Dormant get in-thread follow-ups)` }, { status: 409 });
  }
  const priorThread = followUp
    ? db.select().from(interactions).where(and(eq(interactions.vendor_id, vendorId), eq(interactions.direction, "outbound"))).orderBy(desc(interactions.interaction_id)).get()
    : undefined;
  if (followUp && !priorThread?.gmail_thread_id) {
    return NextResponse.json({ error: "no earlier outbound thread to follow up on" }, { status: 409 });
  }

  let sender: string;
  let sent: { threadId: string; messageId: string };
  try {
    sender = (await profile()).email;
    sent = await sendMessage(to, input.subject, input.body, followUp ? { threadId: priorThread?.gmail_thread_id ?? undefined } : {});
  } catch (err) {
    if (err instanceof GmailNotConnectedError || err instanceof GmailNotConfiguredError) {
      return NextResponse.json({ error: err.message, auth_url: "/api/gmail/auth" }, { status: 409 });
    }
    return NextResponse.json({ error: `Gmail send failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }

  try {
    const now = nowIso();
    const result = db.transaction((tx) => {
      const interaction = insertInteraction(
        {
          vendor_id: vendorId,
          direction: "outbound",
          gmail_thread_id: sent.threadId,
          sent_at: now,
          subject: input.subject,
          body_text: input.body,
          llm_summary: `${followUp ? "follow-up" : "first contact"}${input.draft_interaction_id ? ` from draft #${input.draft_interaction_id}` : ""}`,
        },
        tx,
      );
      const t = followUp
        ? null
        : transition(
            {
              vendorId,
              toStatus: "Contacted",
              actor: "human",
              reason: "sent outreach email",
              evidenceRef: `interaction:${interaction.interaction_id}`,
              payload: { gmail_thread_id: sent.threadId, gmail_message_id: sent.messageId, to, subject: input.subject },
            },
            tx,
          );
      tx.update(vendors)
        .set({
          owner: sender || detail.vendor.owner,
          contact_email: detail.vendor.contact_email ?? to,
          next_action: "await_reply",
          due_at: new Date(Date.now() + FOLLOW_UP_DAYS * 86_400_000).toISOString(),
          updated_at: now,
        })
        .where(eq(vendors.vendor_id, vendorId))
        .run();
      return { interaction, transition: t };
    });
    return NextResponse.json({ ok: true, thread_id: sent.threadId, message_id: sent.messageId, sender, ...result });
  } catch (err) {
    // The email is out; make the inconsistency loud rather than silent.
    console.error(`[send ${vendorId}] email sent (thread ${sent.threadId}) but recording failed`, err);
    if (err instanceof TransitionError) {
      return NextResponse.json({ error: `email sent (thread ${sent.threadId}) but status change failed: ${err.message}`, thread_id: sent.threadId }, { status: 409 });
    }
    return NextResponse.json({ error: `email sent (thread ${sent.threadId}) but recording failed: ${err instanceof Error ? err.message : String(err)}`, thread_id: sent.threadId }, { status: 500 });
  }
}
