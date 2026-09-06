/**
 * The human send gate (PRD §6 Qualified -> Contacted), as a domain operation:
 * allowlist, status rules, thread reuse for follow-ups, the Gmail call, then
 * the interaction row, the transition and the vendor's next action. The route
 * only validates input and maps SendError codes to HTTP statuses.
 */
import { and, desc, eq } from "drizzle-orm";

import { getDb, interactions, nowIso, vendors, type Db } from "@/lib/db";
import { getVendorDetail, insertInteraction } from "@/lib/db/queries";
import type { InteractionRow } from "@/lib/db/schema";
import { TransitionError, transition, type TransitionResult } from "@/lib/db/state";

import { isAllowedRecipient, normalizeEmail, parseAllowlist } from "./allowlist";
import { GmailNotConfiguredError, GmailNotConnectedError, profile, sendMessage } from "./gmail";

/** A follow-up is expected within a week; the Board shows the date and flags it when overdue. */
export const FOLLOW_UP_DAYS = 7;

export type SendInput = { to: string; subject: string; body: string; draft_interaction_id?: number };

export type SendErrorCode =
  | "recipient_not_allowed"
  | "vendor_not_found"
  | "wrong_status"
  | "no_thread"
  | "gmail_not_connected"
  | "gmail_failed"
  | "recording_failed";

export class SendError extends Error {
  constructor(
    public readonly code: SendErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function sendErrorStatus(code: SendErrorCode): number {
  switch (code) {
    case "recipient_not_allowed":
      return 403;
    case "vendor_not_found":
      return 404;
    case "gmail_failed":
      return 502;
    case "recording_failed":
      return 500;
    default:
      return 409;
  }
}

/** Seam for tests and for a different mail provider later. */
export type Mailer = {
  profile: () => Promise<{ email: string }>;
  sendMessage: (to: string, subject: string, body: string, opts?: { threadId?: string }) => Promise<{ threadId: string; messageId: string }>;
};

const gmailMailer: Mailer = { profile, sendMessage };

export type SendResult = {
  thread_id: string;
  message_id: string;
  sender: string;
  follow_up: boolean;
  interaction: InteractionRow;
  transition: TransitionResult | null;
};

export async function sendOutreach(
  vendorId: string,
  input: SendInput,
  deps: { db?: Db; mailer?: Mailer; allowlist?: string[] } = {},
): Promise<SendResult> {
  const db = deps.db ?? getDb();
  const mailer = deps.mailer ?? gmailMailer;
  const allowlist = deps.allowlist ?? parseAllowlist();
  const to = normalizeEmail(input.to);

  if (!isAllowedRecipient(to, allowlist)) {
    throw new SendError(
      "recipient_not_allowed",
      allowlist.length ? `${to} is not in DEMO_ALLOWED_RECIPIENTS` : "DEMO_ALLOWED_RECIPIENTS is empty; add allowed addresses to .env.local before sending",
      { allowed_recipients: allowlist },
    );
  }
  const detail = getVendorDetail(vendorId, db);
  if (!detail) throw new SendError("vendor_not_found", `vendor ${vendorId} not found`);

  // First contact leaves Qualified; a Contacted or Dormant vendor gets an in-thread follow-up with no status change.
  const followUp = detail.vendor.status === "Contacted" || detail.vendor.status === "Dormant";
  if (detail.vendor.status !== "Qualified" && !followUp) {
    throw new SendError("wrong_status", `vendor is ${detail.vendor.status}; only Qualified vendors can be contacted (Contacted/Dormant get in-thread follow-ups)`);
  }
  const priorThread = followUp
    ? db.select().from(interactions).where(and(eq(interactions.vendor_id, vendorId), eq(interactions.direction, "outbound"))).orderBy(desc(interactions.interaction_id)).get()
    : undefined;
  if (followUp && !priorThread?.gmail_thread_id) throw new SendError("no_thread", "no earlier outbound thread to follow up on");

  let sender: string;
  let sent: { threadId: string; messageId: string };
  try {
    sender = (await mailer.profile()).email;
    sent = await mailer.sendMessage(to, input.subject, input.body, followUp ? { threadId: priorThread?.gmail_thread_id ?? undefined } : {});
  } catch (err) {
    if (err instanceof GmailNotConnectedError || err instanceof GmailNotConfiguredError) {
      throw new SendError("gmail_not_connected", err.message, { auth_url: "/api/gmail/auth" });
    }
    throw new SendError("gmail_failed", `Gmail send failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const now = nowIso();
    return db.transaction((tx) => {
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
      return { thread_id: sent.threadId, message_id: sent.messageId, sender, follow_up: followUp, interaction, transition: t };
    });
  } catch (err) {
    // The email is out; make the inconsistency loud rather than silent.
    console.error(`[send ${vendorId}] email sent (thread ${sent.threadId}) but recording failed`, err);
    throw new SendError(
      "recording_failed",
      `email sent (thread ${sent.threadId}) but ${err instanceof TransitionError ? "the status change" : "recording"} failed: ${err instanceof Error ? err.message : String(err)}`,
      { thread_id: sent.threadId },
    );
  }
}
