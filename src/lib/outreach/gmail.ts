/**
 * Gmail via googleapis. OAuth desktop flow: GET /api/gmail/auth redirects to
 * Google, GET /api/gmail/callback exchanges the code and persists token.json
 * (repo root, gitignored). Everything here is server-only.
 */
import fs from "node:fs";
import path from "node:path";
import { google, type gmail_v1 } from "googleapis";

import { htmlToText } from "@/lib/llm/fetchPage";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type Credentials = Parameters<OAuth2Client["setCredentials"]>[0];

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const CREDENTIALS_PATH = path.resolve(process.cwd(), process.env.GMAIL_CREDENTIALS_PATH ?? "credentials.json");
const TOKEN_PATH = path.resolve(process.cwd(), "token.json");

export class GmailNotConfiguredError extends Error {}
export class GmailNotConnectedError extends Error {}

type ClientCredentials = { client_id: string; client_secret: string };

function loadClientCredentials(): ClientCredentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new GmailNotConfiguredError(`Gmail credentials not found at ${CREDENTIALS_PATH} (GMAIL_CREDENTIALS_PATH)`);
  }
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8")) as { installed?: ClientCredentials; web?: ClientCredentials };
  const c = raw.installed ?? raw.web;
  if (!c?.client_id || !c?.client_secret) {
    throw new GmailNotConfiguredError("credentials.json has no installed/web client_id and client_secret");
  }
  return c;
}

export function isConfigured(): boolean {
  return fs.existsSync(CREDENTIALS_PATH);
}

export function isConnected(): boolean {
  return fs.existsSync(TOKEN_PATH);
}

function loadToken(): Credentials | null {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")) as Credentials;
}

function saveToken(tokens: Credentials): void {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function disconnect(): void {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
}

export function callbackUrl(origin: string): string {
  return `${origin}/api/gmail/callback`;
}

function oauthClient(origin?: string): OAuth2Client {
  const c = loadClientCredentials();
  return new google.auth.OAuth2(c.client_id, c.client_secret, origin ? callbackUrl(origin) : undefined);
}

/** Desktop clients accept any http://localhost:<port>/<path> redirect, so the callback route works as-is. */
export function authUrl(origin: string): string {
  return oauthClient(origin).generateAuthUrl({ access_type: "offline", prompt: "consent", scope: GMAIL_SCOPES });
}

export async function exchangeCode(origin: string, code: string): Promise<void> {
  const { tokens } = await oauthClient(origin).getToken(code);
  if (!tokens.refresh_token) {
    const existing = loadToken();
    if (existing?.refresh_token) tokens.refresh_token = existing.refresh_token;
  }
  saveToken(tokens);
}

function authorizedClient(): OAuth2Client {
  const token = loadToken();
  if (!token) throw new GmailNotConnectedError("Gmail is not connected; open /api/gmail/auth first");
  const client = oauthClient();
  client.setCredentials(token);
  client.on("tokens", (fresh) => saveToken({ ...(loadToken() ?? {}), ...fresh }));
  return client;
}

export function gmailClient(): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: authorizedClient() });
}

export async function profile(): Promise<{ email: string; messages_total: number | null }> {
  const res = await gmailClient().users.getProfile({ userId: "me" });
  return { email: res.data.emailAddress ?? "", messages_total: res.data.messagesTotal ?? null };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** RFC 2047 encoded-word for non-ASCII header values. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

export type OutgoingMessage = { to: string; subject: string; body: string; from?: string; inReplyTo?: string; references?: string };

/** RFC 2822 text/plain message, base64url encoded for users.messages.send. */
export function buildRawMessage(m: OutgoingMessage): string {
  const lines = [
    ...(m.from ? [`From: ${encodeHeader(m.from)}`] : []),
    `To: ${m.to.replace(/[\r\n]+/g, " ").trim()}`,
    `Subject: ${encodeHeader(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.body, "utf8").toString("base64"),
  ];
  return base64url(lines.join("\r\n"));
}

export async function sendMessage(to: string, subject: string, body: string, opts: { threadId?: string; inReplyTo?: string } = {}): Promise<{ threadId: string; messageId: string }> {
  const raw = buildRawMessage({ to, subject, body, inReplyTo: opts.inReplyTo, references: opts.inReplyTo });
  const res = await gmailClient().users.messages.send({ userId: "me", requestBody: { raw, threadId: opts.threadId } });
  const threadId = res.data.threadId;
  const messageId = res.data.id;
  if (!threadId || !messageId) throw new Error("Gmail send returned no thread id");
  return { threadId, messageId };
}

export type ThreadMessage = {
  id: string;
  thread_id: string;
  message_id_header: string | null;
  from: string;
  to: string;
  subject: string;
  date: string;
  internal_date: string;
  snippet: string;
  body_text: string;
  label_ids: string[];
  is_sent: boolean;
};

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Prefer text/plain; fall back to text/html reduced to text. */
export function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  let plain = "";
  let html = "";
  const walk = (part: gmail_v1.Schema$MessagePart) => {
    const data = part.body?.data;
    if (data && part.mimeType === "text/plain" && !plain) plain = decodeBase64url(data);
    else if (data && part.mimeType === "text/html" && !html) html = decodeBase64url(data);
    for (const p of part.parts ?? []) walk(p);
  };
  walk(payload);
  if (plain) return plain.trim();
  if (html) return htmlToText(html).text;
  return "";
}

export function toThreadMessage(m: gmail_v1.Schema$Message): ThreadMessage {
  const headers = m.payload?.headers;
  const internal = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "";
  return {
    id: m.id ?? "",
    thread_id: m.threadId ?? "",
    message_id_header: header(headers, "Message-ID") || null,
    from: header(headers, "From"),
    to: header(headers, "To"),
    subject: header(headers, "Subject"),
    date: header(headers, "Date"),
    internal_date: internal,
    snippet: m.snippet ?? "",
    body_text: extractPlainText(m.payload),
    label_ids: m.labelIds ?? [],
    is_sent: (m.labelIds ?? []).includes("SENT"),
  };
}

export async function listThreadMessages(threadId: string): Promise<ThreadMessage[]> {
  const res = await gmailClient().users.threads.get({ userId: "me", id: threadId, format: "full" });
  return (res.data.messages ?? []).map(toThreadMessage);
}
