/**
 * mail-message -- opens one email, marks it read or unread, and hands out a
 * 60-second link to one of its attachments.
 *
 *   POST { action: "open", message_id, peek? }
 *   POST { action: "mark", message_id, seen }
 *   POST { action: "attachment", message_id, idx }
 *
 * ONE DOOR: the signed-in office. verify_jwt is off in config.toml because
 * the browser's CORS preflight carries no token; mailCaller() is the bouncer
 * (getUser on the bearer, then can_use_company_mail() asked with the
 * caller's own token, which must answer exactly true). The message is then
 * read through the CALLER's client, so RLS -- own company AND the mail gate
 * -- decides whether it exists for them at all, and its mailbox is read the
 * same way (loadAccountAsCaller) before the service role goes near the
 * mailbox's password. Every service-role write filters company_id itself.
 *
 * WHAT "open" ANSWERS. Always 200 with a `state` unless the request itself
 * failed (then the usual {error_code, message} from errors.ts):
 *
 *   ok           { html, text, truncated, attachments[], inline_images,
 *                  is_seen, server_gone, mark_error? }
 *   too_large    { size }  -- over OPEN_MESSAGE_MAX_BYTES; never downloaded.
 *                The office says to open it in the mailbox itself.
 *   gone         deleted or moved in the mailbox, and FenceFlow has no copy.
 *   changed      the mailbox renumbered its messages (UIDVALIDITY), or the
 *                message at that number is not this one any more. The next
 *                sync puts it right; open it again after that.
 *   unavailable  { reason: "disconnected" | "no_copy" } -- the mailbox was
 *                disconnected before this message was ever opened, or
 *                there is nowhere to fetch it from.
 *
 * `html` is the message's own HTML, capped but NOT sanitized: the office
 * sanitizes it (DOMPurify) and shows it only inside a sandboxed srcdoc
 * frame with no allow-scripts and its own CSP. `inline_images` maps each
 * Content-ID the HTML shows through cid: to a data: URL (PNG, JPEG, GIF or
 * WebP only, INLINE_IMAGE_MAX_BYTES each, INLINE_IMAGES_TOTAL_MAX_BYTES in
 * all), because that frame's CSP allows data: images and nothing else.
 * `attachments[]` never carries a storage path; `attachment` mints the link.
 * A part is reported "inline" only when its picture is in the inline_images
 * of the same answer; any other part (not stored yet, over the caps) says
 * "attachment", so the office shows a chip for every attachment and no part
 * is ever neither shown nor downloadable.
 * `mark_error` is set when the message should have been marked read in the
 * mailbox and could not be: the body still comes back, and FenceFlow's own
 * copy is NOT marked read, because the next sync would copy the mailbox's
 * "unread" back over it anyway.
 *
 * OPENING AN IMAP MESSAGE the first time (nothing is cached): the stored
 * host is checked again (a preset must still be its provider's own server;
 * a custom name is re-validated and re-resolved, so one re-pointed at a
 * private address since it was connected never gets a socket), the password
 * is read from Vault, and one session runs EXAMINE, the size, then
 * BODY.PEEK[] -- nothing over OPEN_MESSAGE_MAX_BYTES is downloaded. The
 * message's Message-ID must match the one sync recorded, or it is not the
 * same message and nothing is stored. Only then, unless `peek`, is \Seen set
 * (SELECT + UID STORE). The body is parsed by the vendored postal-mime
 * (message-meta.bodyFields), capped, and cached on the row; every part up to
 * ATTACHMENT_MAX_BYTES is stored in the private mail-files bucket under
 * <company>/<account>/<message>/<idx>-<name>, typed by storageContentType()
 * so HTML, SVG and anything unrecognised is application/octet-stream.
 * Later opens are served from the row with no mailbox session, except to set
 * \Seen on a message that is still unread.
 *
 * NOTHING HERE CAN DELETE OR MOVE MAIL. The only change FenceFlow makes to a
 * mailbox is \Seen on or off, and imap-client.ts has no command for anything
 * else (uidStore refuses \Deleted; there is no EXPUNGE, MOVE or COPY).
 *
 * THE PASSWORD is read from Vault (mail_secret_get, service role only) after
 * the gate, handed to the IMAP login and to redact(), and to nothing else.
 * It is never logged, stored, returned or put into an error. A refused
 * sign-in marks the mailbox auth_failed (only if nobody changed the row in
 * the meantime), and an auth_failed mailbox is never signed in to from here
 * at all -- opening five unread messages must not present a wrong password
 * five times, which is how Zoho and Google lock a mailbox. The owner enters
 * a new app password through mail-connect.
 *
 * RATE. Every mailbox sign-in and every call to Resend's receiving API is
 * spent from the mail_events ledger first (kind message_session, per
 * company): MESSAGE_SESSIONS_PER_MINUTE, and MESSAGE_SESSIONS_PER_HOUR. It is
 * spent before the password is read or any socket opens, and refused
 * attempts count, so a loop of marks or opens keeps itself refused instead of
 * becoming the stream of sign-ins that gets a mailbox locked (and a lock
 * reads as a refused password, which takes the mailbox down until the owner
 * types a new one). A message FenceFlow already holds still opens when the
 * budget is spent; only the read mark in the mailbox and the fetching of
 * pending attachments wait.
 *
 * FENCEFLOW MAIL (Resend). A reply received through resend-inbound arrives
 * with its text cached and its attachments `pending`; "open" (and
 * "attachment") lists them again through Resend's receiving API and stores
 * them. The download links Resend hands out are fetched only if they are
 * https on resend.com or a subdomain of it, without our API key, without
 * following redirects, and capped in size -- a link anywhere else is never
 * requested. If the text was never cached, it is fetched again the same way.
 *
 * WHAT A mail_messages.attachments ENTRY LOOKS LIKE, for every writer
 * (mail-message, mail-send, resend-inbound):
 *   { idx: integer >= 0, unique in the message,
 *     filename, content_type, size, content_id|null,
 *     disposition: "inline" | "attachment",
 *     storage_path: "<company>/..." | null,
 *     state: "stored" | "pending" | "too_large",
 *     provider_id?: Resend's attachment id (resend_inbound only) }
 * An entry without an integer idx is ignored. "stored" without a storage
 * path, or any unknown state, is treated as pending. A path that does not
 * start with the caller's own company id is never signed.
 */

import type { Email } from "../_shared/vendor/postal-mime/postal-mime.d.ts";
import { corsHeaders, errorResponse, isUuid, json, loadAccountAsCaller, mailCaller, readJsonBody } from "../_shared/mail/caller.ts";
import type { MailCaller } from "../_shared/mail/caller.ts";
import { accountStatusFor, classifyNetworkError, forCustomHost, MailError, MESSAGES, redact } from "../_shared/mail/errors.ts";
import type { MailErrorCode } from "../_shared/mail/errors.ts";
import { denoResolver, resolveAndCheck, resolvePreset, validateCustomHost, ZOHO_REGIONS } from "../_shared/mail/hosts.ts";
import type { Resolver } from "../_shared/mail/hosts.ts";
import { fetchMessage, ImapClient, openSession, setFlag } from "../_shared/mail/imap-client.ts";
import {
  ATTACHMENT_MAX_BYTES,
  IMAP_PORT,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGES_TOTAL_MAX_BYTES,
  MESSAGE_SESSIONS_PER_HOUR,
  MESSAGE_SESSIONS_PER_MINUTE,
  OP_TIMEOUT_MS,
  OPEN_MESSAGE_MAX_BYTES,
  SESSION_BYTE_CAP,
  SIGNED_URL_SECONDS,
} from "../_shared/mail/limits.ts";
import {
  bodyFields,
  flagsToColumns,
  inlineImages,
  MESSAGE_PARTS_MAX,
  parseMail,
  storageContentType,
  storageObjectName,
} from "../_shared/mail/message-meta.ts";
import type { AttachmentMeta, MessagePart } from "../_shared/mail/message-meta.ts";
import { cleanFilename, cleanMessageId } from "../_shared/mail/mime-build.ts";
import { connectTls } from "../_shared/mail/tls-transport.ts";
import type { ConnectOptions, MailTransport } from "../_shared/mail/tls-transport.ts";

// ---------------------------------------------------------------------------
// Numbers that belong to this function alone. Everything shared is in
// limits.ts.
// ---------------------------------------------------------------------------

/** One "open" session, connect to logout. Under the shared 120 s ceiling so
 *  the uploads to storage that follow still finish inside the gateway's
 *  150 s. A 10 MB message needs a small fraction of this. */
export const OPEN_SESSION_MS = 90_000;
/** A read/unread mark: sign in, SELECT, STORE, LOGOUT. */
export const MARK_SESSION_MS = 30_000;
export const BUCKET = "mail-files";
/** Parts uploaded to storage at once. */
const UPLOAD_CONCURRENCY = 4;
const RESEND_API = "https://api.resend.com";
/** A received email from Resend's API: capped text and HTML are all that is
 *  kept, but its HTML may carry inline pictures as data: URIs. */
const RESEND_JSON_MAX_BYTES = 12 * 1024 * 1024;
/** Attachment bytes downloaded from Resend in one call; the rest wait. */
const RESEND_DOWNLOAD_TOTAL_MAX_BYTES = SESSION_BYTE_CAP;
const RESEND_LIST_MAX_PAGES = 3;
/** Resend ids are UUIDs; anything that is not plainly an id never reaches a
 *  URL path. */
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
/** Highest attachment idx accepted from a row or a request. */
const MAX_PART_IDX = 999;
/** The only picture types ever sent back as data: URLs (inlineImages()
 *  checks again). No SVG: it is a document that can carry script. */
const INLINE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NEEDS_PASSWORD = "The owner needs to enter a new app password in Settings, Company email.";

// ---------------------------------------------------------------------------
// What the function needs from the outside world, so the Node tests can give
// it a fake mailbox, a fake Resend and a fake clock and call the real
// handler exactly as the gateway does.
// ---------------------------------------------------------------------------

export interface MessageDeps {
  connect: (opts: ConnectOptions) => Promise<MailTransport>;
  resolver: Resolver | null;
  /** Resend's receiving API and its download links. Nothing else. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  env: (name: string) => string | undefined;
}

// deno-lint-ignore no-explicit-any
const denoGlobal = (): any => (globalThis as any).Deno;

export function productionDeps(): MessageDeps {
  return {
    connect: connectTls,
    resolver: denoResolver(),
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    env: (name) => denoGlobal()?.env?.get(name) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A UID or UIDVALIDITY read back from the database, or null. */
function uidOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 4294967295 ? n : null;
}

function countOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A folder path fit to hand to SELECT (the tables refuse control
 *  characters and anything over 300 characters too). */
function usablePath(v: unknown): string | null {
  const s = typeof v === "string" ? v : "";
  // deno-lint-ignore no-control-regex
  return s && s.length <= 300 && !/[\x00-\x1f\x7f]/.test(s) ? s : null;
}

function asMailError(e: unknown): MailError {
  // Socket and TLS errors arrive as Deno errors; our own code throws
  // MailError. Anything else is a bug here and says nothing to the office.
  if (e instanceof MailError) return e;
  const name = String((e as { name?: unknown })?.name ?? "");
  if (/TimedOut|TimeoutError|AbortError|ConnectionRefused|ConnectionReset|ConnectionAborted|NotConnected|BrokenPipe|InvalidData|UnexpectedEof|Interrupted/.test(name)) {
    return classifyNetworkError(e);
  }
  return new MailError("server_error");
}

const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

function cleanType(raw: unknown): string {
  const t = String(raw ?? "").trim().toLowerCase();
  return TYPE_RE.test(t) ? t : "application/octet-stream";
}

/** Runs `work` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(items: ReadonlyArray<T>, limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

// ---------------------------------------------------------------------------
// Stored parts: the mail_messages.attachments entries.
// ---------------------------------------------------------------------------

export interface StoredPart extends AttachmentMeta {
  storage_path: string | null;
  state: "stored" | "pending" | "too_large";
  provider_id?: string;
}

/** The provider's id for an entry, under any of the names a writer might
 *  have used. Only something shaped like an id counts. */
function providerIdOf(e: Record<string, unknown>): string | null {
  for (const k of ["provider_id", "provider_attachment_id", "attachment_id", "resend_id"]) {
    const v = e[k];
    if (typeof v === "string" && PROVIDER_ID_RE.test(v)) return v;
  }
  return null;
}

/**
 * mail_messages.attachments as this function trusts it. The row is written
 * only by the service role, but it is still read defensively: junk entries
 * go, every displayed string is cleaned again, a duplicated idx keeps its
 * first entry, and "stored" without a path is not stored.
 */
export function storedParts(raw: unknown): StoredPart[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredPart[] = [];
  const seen = new Set<number>();
  for (const item of raw.slice(0, 200)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    const idx = typeof e.idx === "number" ? e.idx : NaN;
    if (!Number.isInteger(idx) || idx < 0 || idx > MAX_PART_IDX || seen.has(idx)) continue;
    seen.add(idx);
    const storagePath = typeof e.storage_path === "string" && e.storage_path ? e.storage_path : null;
    const state = e.state === "too_large" ? "too_large" : e.state === "stored" && storagePath ? "stored" : "pending";
    const providerId = providerIdOf(e);
    out.push({
      idx,
      filename: cleanFilename(e.filename),
      content_type: cleanType(e.content_type),
      size: countOf(e.size) ?? 0,
      content_id: e.content_id ? cleanMessageId(e.content_id) : null,
      disposition: e.disposition === "inline" ? "inline" : "attachment",
      storage_path: storagePath,
      state,
      ...(providerId ? { provider_id: providerId } : {}),
    });
    if (out.length >= MESSAGE_PARTS_MAX) break;
  }
  return out.sort((a, b) => a.idx - b.idx);
}

/** What the office is told about each part. No storage path: the link comes
 *  from {action:'attachment'}, signed and short-lived. "inline" only for a
 *  part whose picture is in `images` (the inline_images of the same answer);
 *  a picture that did not make it -- not stored yet, over the caps, written
 *  by another function with looser rules -- is listed as an attachment. */
export function officeParts(parts: ReadonlyArray<StoredPart>, images: Readonly<Record<string, string>>) {
  return parts.map((p) => ({
    idx: p.idx,
    filename: p.filename,
    content_type: p.content_type,
    size: p.size,
    disposition: p.disposition === "inline" && p.content_id !== null && Object.hasOwn(images, p.content_id) ? "inline" : "attachment",
    content_id: p.content_id,
    state: p.state,
  }));
}

/**
 * A storage key this company may be handed a link to: under its own
 * company folder, with no empty, "." or ".." segment, no backslash and no
 * control character. The rows are written only by the service role; this
 * is the check that a corrupted or mistaken row still cannot mint a link
 * into another company's files.
 */
export function safeStoragePath(path: unknown, companyId: string): path is string {
  if (typeof path !== "string" || !companyId || path.length > 1024) return false;
  if (!path.startsWith(`${companyId}/`)) return false;
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function partPath(row: MessageRow, meta: Pick<AttachmentMeta, "idx" | "filename">): string {
  return `${row.company_id}/${row.account_id}/${row.id}/${storageObjectName(meta)}`;
}

// ---------------------------------------------------------------------------
// The message row, read as the caller.
// ---------------------------------------------------------------------------

export interface MessageRow {
  id: string;
  company_id: string;
  account_id: string;
  folder_role: "inbox" | "sent";
  source: string;
  uidvalidity: unknown;
  uid: unknown;
  provider_message_id: string | null;
  message_id_header: string | null;
  size_bytes: unknown;
  body_state: string;
  body_text: string | null;
  body_html: string | null;
  body_truncated: boolean | null;
  attachments: unknown;
  is_seen: boolean | null;
  server_gone_at: string | null;
}

export const MESSAGE_COLUMNS =
  "id, company_id, account_id, folder_role, source, uidvalidity, uid, provider_message_id, message_id_header, " +
  "size_bytes, body_state, body_text, body_html, body_truncated, attachments, is_seen, server_gone_at";

/** Through the caller's own client: RLS (own company AND the mail gate)
 *  decides whether this message exists for them. */
async function loadMessage(caller: MailCaller, id: unknown): Promise<MessageRow> {
  if (!isUuid(id)) throw new MailError("bad_request", "Invalid message id.");
  const { data, error } = await caller.userClient
    .from("mail_messages")
    .select(MESSAGE_COLUMNS)
    .eq("id", id)
    .eq("company_id", caller.companyId)
    .maybeSingle();
  if (error) throw new MailError("server_error");
  if (!data) throw new MailError("not_found");
  return data as MessageRow;
}

/** Writes to the row with the service role, scoped to the caller's company.
 *  Answers whether exactly that row changed. The table's triggers cap every
 *  column again and recompute the thread's unread count and snippet. */
async function saveMessage(caller: MailCaller, row: MessageRow, patch: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await caller.admin
    .from("mail_messages")
    .update(patch)
    .eq("id", row.id)
    .eq("company_id", caller.companyId)
    .select("id");
  return !error && Array.isArray(data) && data.length === 1;
}

// ---------------------------------------------------------------------------
// Which mailbox and folder a message can be fetched from.
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: string;
  company_id: string;
  kind: string;
  provider: string;
  email_address: string;
  username: string | null;
  imap_host: string | null;
  imap_port: number | null;
  sent_folder: string | null;
  status: string;
  updated_at: string;
}

/**
 * The IMAP host to connect to for this row, re-checked now -- the same rule
 * mail-sync applies. A preset row must name exactly the host hosts.ts would
 * pick for its address today (in any offered Zoho region); a custom row
 * goes through validateCustomHost and resolveAndCheck again, so a name that
 * now points somewhere private is refused before any socket opens.
 */
export async function imapHostFor(row: AccountRow, resolver: Resolver | null): Promise<string> {
  const host = String(row.imap_host ?? "").trim().toLowerCase();
  if (row.imap_port !== null && row.imap_port !== undefined && Number(row.imap_port) !== IMAP_PORT) {
    throw new MailError("host_not_allowed", "Only port 993 is used.");
  }
  if (row.provider === "zoho" || row.provider === "gmail") {
    let allowed: string[];
    try {
      allowed = row.provider === "gmail"
        ? [resolvePreset("gmail", row.email_address).imapHost]
        : Object.keys(ZOHO_REGIONS).map((r) => resolvePreset("zoho", row.email_address, r).imapHost);
    } catch {
      throw new MailError("host_not_allowed");
    }
    if (!allowed.includes(host)) throw new MailError("host_not_allowed", "The stored server is not the provider's own.");
    return host;
  }
  if (row.provider !== "custom") throw new MailError("host_not_allowed");
  const checked = validateCustomHost(host);
  await resolveAndCheck(checked, resolver);
  return checked;
}

type ImapPlan =
  | { ok: true; account: AccountRow; path: string; uid: number; uidValidity: number }
  | { ok: false; why: "not_imap" | "gone" | "changed" | "disconnected" | "no_folder" };

/**
 * Whether this message can be fetched from a mailbox, and where. Rows with
 * no UID (FenceFlow mail, a send not yet seen in Sent) have no mailbox copy
 * to fetch. The folder comes from mail_folder_state -- where sync found the
 * message -- and a folder whose UIDVALIDITY has moved on means this row's
 * UID names nothing any more, which is answered without a sign-in.
 */
async function planImap(caller: MailCaller, row: MessageRow): Promise<ImapPlan> {
  const uid = uidOf(row.uid);
  const uidValidity = uidOf(row.uidvalidity);
  if (uid === null || uidValidity === null) return { ok: false, why: "not_imap" };
  if (row.server_gone_at) return { ok: false, why: "gone" };
  // RLS again: the caller's own client proves the mailbox is theirs.
  const account = await loadAccountAsCaller(caller, row.account_id) as unknown as AccountRow;
  if (account.kind !== "imap") return { ok: false, why: "not_imap" };
  if (account.status === "disconnected") return { ok: false, why: "disconnected" };

  const { data, error } = await caller.admin
    .from("mail_folder_state")
    .select("role, path, uidvalidity")
    .eq("account_id", account.id)
    .eq("role", row.folder_role)
    .maybeSingle();
  if (error) throw new MailError("server_error", "Could not read where this message is kept.");
  const state = data as { path?: unknown; uidvalidity?: unknown } | null;
  const current = uidOf(state?.uidvalidity);
  if (current !== null && current !== uidValidity) return { ok: false, why: "changed" };
  const path = usablePath(state?.path) ?? (row.folder_role === "inbox" ? "INBOX" : usablePath(account.sent_folder));
  if (!path) return { ok: false, why: "no_folder" };
  return { ok: true, account, path, uid, uidValidity };
}

// ---------------------------------------------------------------------------
// One mailbox session.
// ---------------------------------------------------------------------------

/**
 * One mailbox sign-in or Resend receiving call, from the ledger: recorded and
 * counted over the minute, then counted over the hour (recording it twice
 * would count it twice). Per company, spent before anything is read or
 * opened. Anything but a number refuses: an empty answer read as "under the
 * limit" is how limits vanish.
 */
async function spendSession(caller: MailCaller): Promise<void> {
  const refused = () =>
    new MailError(
      "rate_limited",
      `FenceFlow signs in to your mailbox at most ${MESSAGE_SESSIONS_PER_MINUTE} times a minute and ${MESSAGE_SESSIONS_PER_HOUR} an hour, so the mailbox is not locked. Wait a minute and try again.`,
    );
  const { data: minute, error } = await caller.admin.rpc("note_mail_event", {
    p_company: caller.companyId,
    p_actor: caller.uid,
    p_kind: "message_session",
    p_window: "1 minute",
  });
  if (error || typeof minute !== "number") throw new MailError("server_error");
  if (minute > MESSAGE_SESSIONS_PER_MINUTE) throw refused();
  const { data: hour, error: hourError } = await caller.admin.rpc("mail_event_count", {
    p_company: caller.companyId,
    p_kind: "message_session",
    p_window: "1 hour",
  });
  if (hourError || typeof hour !== "number") throw new MailError("server_error");
  if (hour > MESSAGE_SESSIONS_PER_HOUR) throw refused();
}

/**
 * A refused sign-in, recorded on the mailbox so the schedule stops trying
 * it. Only if nobody changed the row since we read it (an owner who has just
 * typed a new password wins) and never on a disconnected row. Transient
 * failures are left to mail-sync, which owns the `error` status.
 */
async function noteRefusal(caller: MailCaller, account: AccountRow, err: MailError, password: string | null, deps: MessageDeps): Promise<void> {
  const { error } = await caller.admin
    .from("mail_accounts")
    .update({
      status: "auth_failed",
      last_error_code: err.code,
      // Redacted again: whatever the creation site did, the stored text never
      // carries the password.
      last_error: redact(err.detail || MESSAGES[err.code], [password]) || MESSAGES[err.code],
      last_error_at: iso(deps.now()),
    })
    .eq("id", account.id)
    .eq("company_id", caller.companyId)
    .eq("updated_at", account.updated_at)
    .neq("status", "disconnected");
  if (error) console.error("mail-message: could not record a refused sign-in");
}

/**
 * Signs in to the mailbox, runs `work`, logs out. Never signs in to an
 * auth_failed mailbox. Every error that leaves here has been redacted with
 * the password, and a credentials refusal has been recorded on the row.
 */
async function withSession<T>(
  caller: MailCaller,
  account: AccountRow,
  deps: MessageDeps,
  sessionMs: number,
  work: (client: ImapClient) => Promise<T>,
): Promise<T> {
  if (account.status === "auth_failed") throw new MailError("auth_failed", NEEDS_PASSWORD);
  await spendSession(caller);
  let password: string | null = null;
  let client: ImapClient | null = null;
  let transport: MailTransport | null = null;
  try {
    const host = await imapHostFor(account, deps.resolver);
    const { data: secret, error: secretError } = await caller.admin.rpc("mail_secret_get", { p_account: account.id });
    if (secretError) throw new MailError("server_error", "Could not read the stored app password.");
    if (typeof secret !== "string" || secret === "") {
      // Nothing to sign in with, and retrying cannot help.
      throw new MailError("auth_failed", `No app password is stored for this mailbox. ${NEEDS_PASSWORD}`);
    }
    password = secret;
    transport = await deps.connect({ hostname: host, port: IMAP_PORT, limits: { sessionDeadlineMs: sessionMs } });
    client = new ImapClient(transport);
    await openSession(client, { username: String(account.username ?? ""), password });
    const out = await work(client);
    await client.logout();
    return out;
  } catch (e) {
    let err = asMailError(e);
    if (account.provider === "custom") err = forCustomHost(err, "imap");
    if (accountStatusFor(err.code) === "auth_failed") await noteRefusal(caller, account, err, password, deps);
    throw new MailError(err.code, redact(err.detail, [password]));
  } finally {
    password = null;
    if (client) client.close();
    else if (transport) transport.close();
  }
}

type ReadOutcome =
  | { state: "ok"; email: Email; flags: string[]; size: number; markError: MailErrorCode | null }
  | { state: "gone" }
  | { state: "changed" }
  | { state: "too_large"; size: number }
  | { state: "unreadable"; flags: string[] };

/**
 * Inside a session: the whole message, read-only, and proven to be the one
 * the row describes before anything is marked. \Seen is set only after the
 * Message-ID matched, so a server that reused a UID never has the wrong
 * message marked read. A failed mark does not fail the open.
 */
async function readOne(client: ImapClient, plan: Extract<ImapPlan, { ok: true }>, row: MessageRow, markSeen: boolean): Promise<ReadOutcome> {
  const r = await fetchMessage(client, { path: plan.path, uidValidity: plan.uidValidity, uid: plan.uid, markSeen: false });
  if (r.state === "gone") return { state: "gone" };
  if (r.state === "uidvalidity_changed") return { state: "changed" };
  if (r.state === "too_large") return { state: "too_large", size: r.size };
  const flags = [...r.flags];
  let email: Email;
  try {
    email = await parseMail(r.source);
  } catch {
    return { state: "unreadable", flags };
  }
  if (row.message_id_header && cleanMessageId(email.messageId) !== row.message_id_header) return { state: "changed" };
  let markError: MailErrorCode | null = null;
  if (markSeen && !flags.some((f) => f.toLowerCase() === "\\seen")) {
    try {
      const s = await setFlag(client, { path: plan.path, uidValidity: plan.uidValidity, uid: plan.uid, flag: "\\Seen", on: true });
      if (s === "ok") flags.push("\\Seen");
      else markError = "protocol_error";
    } catch (e) {
      markError = asMailError(e).code;
    }
  }
  return { state: "ok", email, flags, size: r.size ?? r.source.length, markError };
}

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

/**
 * Every part into mail-files, at most UPLOAD_CONCURRENCY at a time. A part
 * already stored at the same path (a re-fetch for a part that failed before)
 * is not uploaded again. A failed upload leaves the part `pending`, and the
 * message is still cached: "attachment" retries it.
 */
async function storeParts(caller: MailCaller, row: MessageRow, parts: ReadonlyArray<MessagePart>, prior: ReadonlyArray<StoredPart>): Promise<StoredPart[]> {
  return await mapLimit(parts, UPLOAD_CONCURRENCY, async (p): Promise<StoredPart> => {
    const base: StoredPart = { ...p.meta, storage_path: null, state: "pending" };
    if (p.content.length > ATTACHMENT_MAX_BYTES) return { ...base, state: "too_large" };
    const path = partPath(row, p.meta);
    const had = prior.find((x) => x.idx === p.meta.idx && x.state === "stored" && x.storage_path === path);
    if (had) return { ...base, storage_path: path, state: "stored" };
    const { error } = await caller.admin.storage
      .from(BUCKET)
      .upload(path, p.content, { contentType: storageContentType(p.meta.content_type), upsert: true });
    return error ? base : { ...base, storage_path: path, state: "stored" };
  });
}

/**
 * data: URLs for the inline pictures of a cached message, read back from
 * mail-files. Only stored parts that bodyFields() marked inline, of the
 * picture types, within the per-image and total caps (by their recorded
 * size, before a byte is downloaded); inlineImages() checks all of it again
 * on the bytes that actually came back. A picture that cannot be read is
 * left out: the message still opens.
 */
async function inlineFromStorage(caller: MailCaller, parts: ReadonlyArray<StoredPart>): Promise<Record<string, string>> {
  const wanted: StoredPart[] = [];
  let total = 0;
  for (const p of parts) {
    if (p.disposition !== "inline" || !p.content_id || p.state !== "stored" || !INLINE_TYPES.has(p.content_type)) continue;
    if (!safeStoragePath(p.storage_path, caller.companyId)) continue;
    if (p.size > INLINE_IMAGE_MAX_BYTES || total + p.size > INLINE_IMAGES_TOTAL_MAX_BYTES) continue;
    total += p.size;
    wanted.push(p);
  }
  if (wanted.length === 0) return Object.create(null);
  const got = await mapLimit(wanted, UPLOAD_CONCURRENCY, async (p): Promise<MessagePart | null> => {
    const { data, error } = await caller.admin.storage.from(BUCKET).download(p.storage_path as string);
    if (error || !data) return null;
    const content = new Uint8Array(await (data as Blob).arrayBuffer());
    return { meta: { ...p, size: content.length }, content };
  });
  return inlineImages(got.filter((p): p is MessagePart => p !== null));
}

// ---------------------------------------------------------------------------
// Resend (FenceFlow mail replies).
// ---------------------------------------------------------------------------

/** A body, refused once it passes `max` bytes, without buffering first. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new MailError("session_limit", "The download is larger than FenceFlow takes.");
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new MailError("session_limit", "The download is larger than FenceFlow takes.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * The only links FenceFlow will download a Resend attachment from: https,
 * resend.com or a subdomain of it, default port, no credentials in the URL.
 * The link comes from Resend's authenticated API, but it is still a URL the
 * function did not choose, and a function that fetches whatever URL it is
 * given can be pointed at the cloud's internal addresses.
 */
export function isResendDownloadUrl(raw: unknown): boolean {
  let u: URL;
  try {
    u = new URL(String(raw ?? ""));
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port !== "" && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  return h === "resend.com" || h.endsWith(".resend.com");
}

async function resendGet(deps: MessageDeps, key: string, path: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await deps.fetch(`${RESEND_API}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(OP_TIMEOUT_MS),
    });
  } catch (e) {
    throw classifyNetworkError(e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) throw new MailError("not_configured", "Resend refused the receiving key.");
    if (res.status === 404) throw new MailError("not_found", "Resend no longer has this message.");
    throw new MailError("server_busy", `Resend answered ${res.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await readCapped(res, RESEND_JSON_MAX_BYTES)));
  } catch (e) {
    if (e instanceof MailError) throw e;
    throw new MailError("protocol_error", "Resend answered with something that is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MailError("protocol_error", "Unexpected answer from Resend.");
  return parsed as Record<string, unknown>;
}

/** Downloads one attachment link. No Authorization header: a signed link
 *  carries its own signature, and our API key is never sent to a URL the
 *  API handed us. No redirects: where a redirect goes was not checked. */
async function resendDownload(deps: MessageDeps, url: string, max: number): Promise<Uint8Array> {
  if (!isResendDownloadUrl(url)) throw new MailError("host_not_allowed", "Refused an attachment link outside resend.com.");
  let res: Response;
  try {
    res = await deps.fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(OP_TIMEOUT_MS) });
  } catch (e) {
    throw classifyNetworkError(e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new MailError("server_busy", `Resend answered ${res.status}.`);
  }
  return await readCapped(res, max);
}

interface ResendAttachment {
  id: string;
  filename: string;
  size: number | null;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
  download_url: string | null;
}

function resendAttachmentsOf(list: unknown): ResendAttachment[] {
  if (!Array.isArray(list)) return [];
  const out: ResendAttachment[] = [];
  for (const item of list.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string" || !PROVIDER_ID_RE.test(a.id)) continue;
    out.push({
      id: a.id,
      filename: cleanFilename(a.filename),
      size: countOf(a.size),
      content_type: cleanType(a.content_type),
      content_disposition: typeof a.content_disposition === "string" ? a.content_disposition.toLowerCase() : null,
      content_id: a.content_id ? cleanMessageId(a.content_id) : null,
      download_url: typeof a.download_url === "string" ? a.download_url : null,
    });
  }
  return out;
}

/** Entries for a received email whose row has none yet, from the metadata
 *  Resend returns with it. All pending until downloaded. Inline by the same
 *  rule bodyFields() applies to IMAP mail: a picture type the reader shows,
 *  of known size inside the per-picture and total caps, and the first part
 *  with its Content-ID. */
export function partsFromResend(list: unknown): StoredPart[] {
  const cids = new Set<string>();
  let inlineTotal = 0;
  return resendAttachmentsOf(list).slice(0, MESSAGE_PARTS_MAX).map((a, idx): StoredPart => {
    const size = a.size ?? 0;
    const inline = a.content_disposition === "inline" && a.content_id !== null && !cids.has(a.content_id) &&
      INLINE_TYPES.has(a.content_type) && a.size !== null && size <= INLINE_IMAGE_MAX_BYTES &&
      inlineTotal + size <= INLINE_IMAGES_TOTAL_MAX_BYTES;
    if (inline) {
      cids.add(a.content_id as string);
      inlineTotal += size;
    }
    return {
      idx,
      filename: a.filename,
      content_type: a.content_type,
      size,
      content_id: a.content_id,
      disposition: inline ? "inline" : "attachment",
      storage_path: null,
      state: "pending",
      provider_id: a.id,
    };
  });
}

/** Which listed attachment an entry is: by Resend's id when the entry has
 *  one, else by exact file name and size, and only if exactly one matches. */
export function matchResendAttachment(entry: StoredPart, list: ReadonlyArray<ResendAttachment>): ResendAttachment | null {
  if (entry.provider_id) return list.find((a) => a.id === entry.provider_id) ?? null;
  const hits = list.filter((a) => a.filename === entry.filename && a.size === entry.size);
  return hits.length === 1 ? hits[0] : null;
}

async function listResendAttachments(deps: MessageDeps, key: string, emailId: string): Promise<ResendAttachment[]> {
  const all: ResendAttachment[] = [];
  let after: string | null = null;
  for (let page = 0; page < RESEND_LIST_MAX_PAGES; page++) {
    const q: string = after ? `?after=${encodeURIComponent(after)}` : "";
    const body = await resendGet(deps, key, `/emails/receiving/${encodeURIComponent(emailId)}/attachments${q}`);
    const batch = resendAttachmentsOf(body.data);
    all.push(...batch);
    if (body.has_more !== true || batch.length === 0) break;
    after = batch[batch.length - 1].id;
  }
  return all;
}

/**
 * Downloads and stores the pending parts of a received email. Answers the
 * new entries (a fresh array) and whether any changed. Throws when Resend
 * cannot be asked at all; a single part that fails stays pending.
 */
async function fillResendParts(
  caller: MailCaller,
  row: MessageRow,
  parts: ReadonlyArray<StoredPart>,
  deps: MessageDeps,
): Promise<{ parts: StoredPart[]; changed: boolean }> {
  const out = parts.map((p) => ({ ...p }));
  if (!out.some((p) => p.state === "pending")) return { parts: out, changed: false };
  const key = String(deps.env("RESEND_RECEIVING_KEY") ?? "").trim();
  if (!key) throw new MailError("not_configured", "Resend receiving is not set up on the server.");
  const emailId = typeof row.provider_message_id === "string" && PROVIDER_ID_RE.test(row.provider_message_id) ? row.provider_message_id : null;
  if (!emailId) throw new MailError("not_found", "This message has no Resend id.");

  const list = await listResendAttachments(deps, key, emailId);
  let budget = RESEND_DOWNLOAD_TOTAL_MAX_BYTES;
  let changed = false;
  for (const p of out) {
    if (p.state !== "pending") continue;
    const a = matchResendAttachment(p, list);
    if (!a || !a.download_url) continue;
    if (a.size !== null && a.size > ATTACHMENT_MAX_BYTES) {
      p.state = "too_large";
      changed = true;
      continue;
    }
    const cap = Math.min(ATTACHMENT_MAX_BYTES, budget);
    if (cap <= 0 || (a.size !== null && a.size > cap)) continue;
    let bytes: Uint8Array;
    try {
      bytes = await resendDownload(deps, a.download_url, cap);
    } catch {
      continue;
    }
    budget -= bytes.length;
    const path = partPath(row, p);
    const { error } = await caller.admin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: storageContentType(p.content_type), upsert: true });
    if (error) continue;
    p.storage_path = path;
    p.state = "stored";
    p.size = bytes.length;
    // Resend's recorded size was a claim; a picture that came back larger
    // than the reader will inline is a download instead.
    if (p.disposition === "inline" && bytes.length > INLINE_IMAGE_MAX_BYTES) p.disposition = "attachment";
    if (!p.provider_id) p.provider_id = a.id;
    changed = true;
  }
  return { parts: out, changed };
}

// ---------------------------------------------------------------------------
// Answers.
// ---------------------------------------------------------------------------

type OpenAnswer = Record<string, unknown> & { state: string; message_id: string };

async function cachedAnswer(
  caller: MailCaller,
  row: MessageRow,
  parts: ReadonlyArray<StoredPart>,
  isSeen: boolean,
  markError: MailErrorCode | null,
): Promise<OpenAnswer> {
  const images = await inlineFromStorage(caller, parts);
  return {
    state: "ok",
    message_id: row.id,
    html: row.body_html ?? null,
    text: row.body_text ?? null,
    truncated: row.body_truncated === true,
    attachments: officeParts(parts, images),
    inline_images: images,
    is_seen: isSeen,
    server_gone: !!row.server_gone_at,
    ...(markError ? { mark_error: markError } : {}),
  };
}

function tooLarge(row: MessageRow, size: number | null): OpenAnswer {
  return { state: "too_large", message_id: row.id, size };
}

// ---------------------------------------------------------------------------
// Fetching a body that is not cached yet.
// ---------------------------------------------------------------------------

interface FetchResult {
  answer: OpenAnswer;
  /** The row's entries after this fetch, when it produced any. */
  parts: StoredPart[] | null;
}

/**
 * One IMAP message: fetched, checked, parsed, its parts stored, the row
 * cached. `alreadyCached` (a re-fetch for a pending attachment) never
 * downgrades a cached body to too_large or error.
 */
async function fetchFromImap(
  caller: MailCaller,
  row: MessageRow,
  plan: Extract<ImapPlan, { ok: true }>,
  deps: MessageDeps,
  opts: { markSeen: boolean; prior: ReadonlyArray<StoredPart>; alreadyCached: boolean },
): Promise<FetchResult> {
  const got = await withSession(caller, plan.account, deps, OPEN_SESSION_MS, (client) => readOne(client, plan, row, opts.markSeen));

  if (got.state === "gone") {
    const { error } = await caller.admin.rpc("mail_mark_gone", {
      p_account: plan.account.id,
      p_role: row.folder_role,
      p_uidvalidity: plan.uidValidity,
      p_uids: [plan.uid],
    });
    if (error) console.error("mail-message: could not hide a removed message");
    return { answer: { state: "gone", message_id: row.id }, parts: null };
  }
  if (got.state === "changed") return { answer: { state: "changed", message_id: row.id }, parts: null };
  if (got.state === "too_large") {
    if (!opts.alreadyCached) await saveMessage(caller, row, { body_state: "too_large", size_bytes: got.size });
    return { answer: tooLarge(row, got.size), parts: null };
  }
  if (got.state === "unreadable") {
    if (!opts.alreadyCached) await saveMessage(caller, row, { body_state: "error", ...flagsToColumns(got.flags, row.folder_role) });
    throw new MailError("protocol_error", "This message could not be read.");
  }

  const { fields, parts } = bodyFields(got.email);
  const stored = await storeParts(caller, row, parts, opts.prior);
  const flagCols = flagsToColumns(got.flags, row.folder_role);
  const saved = await saveMessage(caller, row, {
    body_state: "cached",
    body_text: fields.body_text,
    body_html: fields.body_html,
    body_truncated: fields.body_truncated,
    snippet: fields.snippet,
    has_attachments: fields.has_attachments,
    attachments: stored,
    size_bytes: got.size,
    ...flagCols,
  });
  // The body is in hand and correct; a failed cache costs only a second
  // fetch next time, so the reader still gets it.
  if (!saved) console.error("mail-message: could not cache an opened message");
  const images = inlineImages(parts);
  return {
    answer: {
      state: "ok",
      message_id: row.id,
      html: fields.body_html,
      text: fields.body_text,
      truncated: fields.body_truncated,
      attachments: officeParts(stored, images),
      inline_images: images,
      is_seen: flagCols.is_seen ?? row.is_seen === true,
      server_gone: false,
      ...(got.markError ? { mark_error: got.markError } : {}),
    },
    parts: stored,
  };
}

/** A received FenceFlow-mail reply whose text was never cached: fetched
 *  again from Resend, with its attachments listed and stored. */
async function fetchFromResend(
  caller: MailCaller,
  row: MessageRow,
  deps: MessageDeps,
  markSeen: boolean,
  prior: ReadonlyArray<StoredPart>,
): Promise<OpenAnswer> {
  const key = String(deps.env("RESEND_RECEIVING_KEY") ?? "").trim();
  if (!key) throw new MailError("not_configured", "Resend receiving is not set up on the server.");
  const emailId = typeof row.provider_message_id === "string" && PROVIDER_ID_RE.test(row.provider_message_id) ? row.provider_message_id : null;
  if (!emailId) return { state: "unavailable", message_id: row.id, reason: "no_copy" };

  // One spend covers the whole open: the email, its attachment list, the downloads.
  await spendSession(caller);
  const email = await resendGet(deps, key, `/emails/receiving/${encodeURIComponent(emailId)}`);
  // Through bodyFields like every other body: the same caps, the same
  // plain-text fallback for HTML-only mail, the same preview.
  const { fields } = bodyFields({
    html: typeof email.html === "string" ? email.html : undefined,
    text: typeof email.text === "string" ? email.text : undefined,
    attachments: [],
  } as unknown as Email);
  let parts = prior.length ? prior.map((p) => ({ ...p })) : partsFromResend(email.attachments);
  try {
    parts = (await fillResendParts(caller, row, parts, deps)).parts;
  } catch {
    // The text is what was asked for; the attachments stay pending.
  }
  const patched: MessageRow = {
    ...row,
    body_state: "cached",
    body_text: fields.body_text,
    body_html: fields.body_html,
    body_truncated: fields.body_truncated,
  };
  const saved = await saveMessage(caller, row, {
    body_state: "cached",
    body_text: fields.body_text,
    body_html: fields.body_html,
    body_truncated: fields.body_truncated,
    snippet: fields.snippet,
    has_attachments: parts.some((p) => p.disposition === "attachment"),
    attachments: parts,
    ...(markSeen ? { is_seen: true } : {}),
  });
  if (!saved) console.error("mail-message: could not cache a received message");
  return await cachedAnswer(caller, patched, parts, saved && markSeen ? true : row.is_seen === true, null);
}

// ---------------------------------------------------------------------------
// The actions.
// ---------------------------------------------------------------------------

async function openAction(caller: MailCaller, body: Record<string, unknown>, deps: MessageDeps): Promise<OpenAnswer> {
  if (body.peek !== undefined && typeof body.peek !== "boolean") throw new MailError("bad_request", "peek must be true or false.");
  const row = await loadMessage(caller, body.message_id);
  const peek = body.peek === true;
  // Only mail that arrived counts toward unread; Sent is always read.
  const wantsSeen = !peek && row.folder_role === "inbox" && row.is_seen !== true;
  if (row.body_state === "too_large") return tooLarge(row, countOf(row.size_bytes));

  const parts = storedParts(row.attachments);
  const cached = row.body_state === "cached";
  const pending = parts.some((p) => p.state === "pending");
  // The common case: already here, already read. No mailbox session at all.
  if (cached && !wantsSeen && !(pending && row.source === "resend_inbound")) {
    return await cachedAnswer(caller, row, parts, row.is_seen === true, null);
  }

  const plan = await planImap(caller, row);
  if (plan.ok) {
    if (!cached) {
      const size = countOf(row.size_bytes);
      if (size !== null && size > OPEN_MESSAGE_MAX_BYTES) {
        // Known from the headers sync fetched: refused without a sign-in.
        await saveMessage(caller, row, { body_state: "too_large" });
        return tooLarge(row, size);
      }
      return (await fetchFromImap(caller, row, plan, deps, { markSeen: wantsSeen, prior: parts, alreadyCached: false })).answer;
    }
    // Cached; only the read mark is left to make, in the mailbox first.
    let markError: MailErrorCode | null = null;
    let isSeen = row.is_seen === true;
    try {
      const r = await withSession(caller, plan.account, deps, MARK_SESSION_MS, (client) =>
        setFlag(client, { path: plan.path, uidValidity: plan.uidValidity, uid: plan.uid, flag: "\\Seen", on: true }));
      if (r === "ok") {
        if (await saveMessage(caller, row, { is_seen: true })) isSeen = true;
        else markError = "server_error";
      } else markError = "protocol_error";
    } catch (e) {
      markError = asMailError(e).code;
    }
    return await cachedAnswer(caller, row, parts, isSeen, markError);
  }

  if (!cached) {
    if (plan.why === "gone") return { state: "gone", message_id: row.id };
    if (plan.why === "changed") return { state: "changed", message_id: row.id };
    if (plan.why === "disconnected") return { state: "unavailable", message_id: row.id, reason: "disconnected" };
    if (row.source === "resend_inbound") return await fetchFromResend(caller, row, deps, wantsSeen, parts);
    return { state: "unavailable", message_id: row.id, reason: "no_copy" };
  }

  // Cached, and no mailbox to talk to: FenceFlow mail, a disconnected
  // mailbox, a message gone from the server. FenceFlow's copy is the only
  // one, so the read mark is FenceFlow's alone.
  let current = parts;
  if (pending && row.source === "resend_inbound") {
    try {
      await spendSession(caller);
      const filled = await fillResendParts(caller, row, parts, deps);
      if (filled.changed && await saveMessage(caller, row, { attachments: filled.parts })) current = filled.parts;
    } catch {
      // Resend could not be asked, or the budget is spent; the attachments
      // stay pending and the message still opens.
    }
  }
  let isSeen = row.is_seen === true;
  if (wantsSeen && await saveMessage(caller, row, { is_seen: true })) isSeen = true;
  return await cachedAnswer(caller, row, current, isSeen, null);
}

async function markAction(caller: MailCaller, body: Record<string, unknown>, deps: MessageDeps): Promise<OpenAnswer> {
  if (typeof body.seen !== "boolean") throw new MailError("bad_request", "seen must be true or false.");
  const seen = body.seen;
  const row = await loadMessage(caller, body.message_id);
  if (row.folder_role === "sent" && !seen) throw new MailError("bad_request", "Sent mail is always shown as read.");
  if ((row.is_seen === true) === seen) return { state: "ok", message_id: row.id, is_seen: seen };

  const plan = await planImap(caller, row);
  if (plan.ok) {
    // In the mailbox first: a mark made only in FenceFlow would be undone by
    // the next sync, which copies the mailbox's flags.
    const r = await withSession(caller, plan.account, deps, MARK_SESSION_MS, (client) =>
      setFlag(client, { path: plan.path, uidValidity: plan.uidValidity, uid: plan.uid, flag: "\\Seen", on: seen }));
    if (r === "uidvalidity_changed") return { state: "changed", message_id: row.id };
  } else if (plan.why === "changed") {
    return { state: "changed", message_id: row.id };
  }
  if (!(await saveMessage(caller, row, { is_seen: seen }))) throw new MailError("server_error", "Could not save the read mark.");
  return { state: "ok", message_id: row.id, is_seen: seen };
}

async function attachmentAction(caller: MailCaller, body: Record<string, unknown>, deps: MessageDeps): Promise<Record<string, unknown>> {
  const idx = body.idx;
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx > MAX_PART_IDX) {
    throw new MailError("bad_request", "Invalid attachment number.");
  }
  const row = await loadMessage(caller, body.message_id);
  let parts = storedParts(row.attachments);
  let part = parts.find((p) => p.idx === idx);
  if (!part) throw new MailError("not_found", "That attachment was not found. Open the message first.");
  if (part.state === "too_large") {
    throw new MailError("too_large", "This attachment is over 10 MB, so FenceFlow does not keep a copy. Open it in your mailbox.");
  }

  if (part.state !== "stored") {
    // Not stored yet (an upload that failed, or a Resend download still to
    // do): try once more, now that someone actually wants it.
    const plan = await planImap(caller, row);
    if (plan.ok) {
      const r = await fetchFromImap(caller, row, plan, deps, { markSeen: false, prior: parts, alreadyCached: row.body_state === "cached" });
      if (r.answer.state === "gone") throw new MailError("not_found", "This message was deleted or moved in your mailbox.");
      if (r.answer.state === "changed") throw new MailError("not_found", "Check for new mail, then open this message again.");
      if (r.answer.state === "too_large") throw new MailError("too_large", "This message is too large to open here.");
      if (r.parts) parts = r.parts;
    } else if (row.source === "resend_inbound") {
      await spendSession(caller);
      const filled = await fillResendParts(caller, row, parts, deps);
      if (filled.changed && !(await saveMessage(caller, row, { attachments: filled.parts }))) {
        console.error("mail-message: could not record a stored attachment");
      }
      parts = filled.parts;
    }
    part = parts.find((p) => p.idx === idx);
    if (part?.state === "too_large") {
      throw new MailError("too_large", "This attachment is over 10 MB, so FenceFlow does not keep a copy. Open it in your mailbox.");
    }
    if (!part || part.state !== "stored") throw new MailError("not_found", "This attachment is not available yet. Try again in a minute.");
  }

  if (!safeStoragePath(part.storage_path, caller.companyId)) {
    console.error("mail-message: refused to sign an attachment path outside the company");
    throw new MailError("not_found");
  }
  // The file name travels in the link's download parameter, so the storage
  // server answers Content-Disposition: attachment -- the browser saves it,
  // never renders it -- and the object itself was stored with a passive
  // type or application/octet-stream.
  const { data, error } = await caller.admin.storage
    .from(BUCKET)
    .createSignedUrl(part.storage_path, SIGNED_URL_SECONDS, { download: part.filename });
  const url = (data as { signedUrl?: unknown } | null)?.signedUrl;
  if (error || typeof url !== "string" || !url) throw new MailError("server_error", "Could not make a download link.");
  return {
    state: "ok",
    message_id: row.id,
    idx: part.idx,
    url,
    filename: part.filename,
    content_type: part.content_type,
    size: part.size,
    expires_in: SIGNED_URL_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// The handler.
// ---------------------------------------------------------------------------

export async function handleRequest(req: Request, deps: MessageDeps = productionDeps()): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") throw new MailError("bad_request", "Use POST.");
    const caller = await mailCaller(req);
    const body = await readJsonBody(req);
    switch (body.action) {
      case "open":
        return json(await openAction(caller, body, deps));
      case "mark":
        return json(await markAction(caller, body, deps));
      case "attachment":
        return json(await attachmentAction(caller, body, deps));
      default:
        throw new MailError("bad_request", "Unknown action.");
    }
  } catch (e) {
    return errorResponse("mail-message", e);
  }
}

// Deno serves; under Node (tests/mail-message.test.mjs) there is no
// Deno.serve and the handler is called directly.
if (typeof denoGlobal()?.serve === "function") denoGlobal().serve((req: Request) => handleRequest(req));
