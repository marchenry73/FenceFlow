// Connects a company's own mailbox to FenceFlow, checks it, changes its app
// password, disconnects it, and tells the office what company email can do
// right now. It never sends or reads mail: mail-sync, mail-message and
// mail-send do that, with what this function stored.
//
//   POST { action: "status" }                                   any mail user
//   POST { action: "connect", provider: "zoho"|"gmail"|"custom",
//          email, password, zoho_region?, display_name?,
//          imap_host?, smtp_host? }                             OWNER
//   POST { action: "check", account_id }                        OWNER
//   POST { action: "replace_password", account_id, password }   OWNER
//   POST { action: "disconnect", account_id }                   OWNER
//   POST { action: "set_display", account_id,
//          display_name?, signature? }                          OWNER
//
// One door: the signed-in office. verify_jwt is off in config.toml because
// the browser's CORS preflight carries no token; mailCaller() is the bouncer
// (getUser on the bearer, then can_use_company_mail() asked as the caller,
// which must answer exactly true). Only after that does a service-role
// client exist, and every write made with it filters company_id itself.
// Any account named by id is read through the CALLER's client first, so RLS
// proves it is theirs before the service role goes near its password.
//
// THE APP PASSWORD. The owner types it; it arrives once, in this request's
// body, over HTTPS. It is used for exactly two sign-ins -- IMAP, then SMTP
// only if IMAP accepted it -- and stored only if both worked, through
// mail_secret_put (Vault, service role only). It is never logged, never put
// in a response, and every error that might carry server text is redacted
// with it (errors.redact) before it reaches last_error or the office. No
// request body is ever logged. "check" reads the stored one back through
// mail_secret_get and holds it only for the length of the check.
//
// LOCKOUT. Zoho and Google lock a mailbox that keeps presenting a wrong
// password. So: IMAP is tried first and SMTP never sees a password IMAP
// refused (one failed sign-in, not two); nothing here retries; connect,
// check and replace_password share one budget of CONNECT_ATTEMPTS_PER_HOUR
// per company from the mail_events ledger, spent before any connection
// opens, refused attempts included; and a check that is refused marks the
// account auth_failed, which the scheduled sync never retries.
//
// WHERE IT CONNECTS. Zoho and Gmail hosts are fixed in hosts.ts and never
// come from the request. "Other" hosts are shape-checked, refused if they
// are Microsoft's, and resolved -- any private or reserved address refuses
// the name -- and that is done again on every check, not just at connect,
// because where a name points can change after the owner typed it. Ports
// are 993 and 465 with implicit TLS and a certificate valid for the name.
// Failures to reach an owner-typed host come back as one detail-free answer
// (errors.forCustomHost), so this form cannot be used to map which machines
// on the internet listen on those ports.
//
// ORDER OF WRITES on a new connection: the row is created 'disconnected'
// (invisible to sync, outside the three-mailbox cap), the password goes into
// Vault, and only then does the row go live -- which is where the database
// trigger enforces the cap. If anything after the insert fails, the password
// is forgotten and the row this request made is removed, so a failed connect
// leaves neither a live mailbox with no password nor a password with no live
// mailbox.

import {
  corsHeaders,
  errorResponse,
  isUuid,
  json,
  loadAccountAsCaller,
  mailCaller,
  readJsonBody,
} from "../_shared/mail/caller.ts";
import type { MailCaller } from "../_shared/mail/caller.ts";
import { accountStatusFor, forCustomHost, MailError, MESSAGES, redact } from "../_shared/mail/errors.ts";
import type { MailErrorCode } from "../_shared/mail/errors.ts";
import {
  denoResolver,
  normalizeMailbox,
  planConnection,
  resolveAndCheck,
  resolvePreset,
  validateCustomHost,
  ZOHO_REGIONS,
} from "../_shared/mail/hosts.ts";
import type { MailHosts } from "../_shared/mail/hosts.ts";
import { ImapClient, verifyMailbox } from "../_shared/mail/imap-client.ts";
import {
  CONNECT_ATTEMPTS_PER_HOUR,
  IMAP_PORT,
  MAX_IMAP_ACCOUNTS_PER_COMPANY,
  SECRET_MAX_CHARS,
  SIGNATURE_MAX_CHARS,
  SMTP_PORT,
} from "../_shared/mail/limits.ts";
import { cleanDisplayName, fenceflowFrom, isValidAddress } from "../_shared/mail/mime-build.ts";
import { fenceflowReplyTo } from "../_shared/mail/reply.ts";
import { SmtpClient, verifySmtp } from "../_shared/mail/smtp-client.ts";
import { connectTls } from "../_shared/mail/tls-transport.ts";

type Row = Record<string, unknown>;

const FN = "mail-connect";

/** Session ceiling for each of the two test sign-ins. They run back to
 *  back, so together they stay well inside the edge runtime's 150 s. */
const VERIFY_SESSION_MS = 55_000;

/** What the office is shown of a mailbox. Picked field by field, so a row
 *  read with select("*") can never hand out inbound_token, the user name or
 *  the sync lock by accident. */
const PUBLIC_ACCOUNT_FIELDS = [
  "id",
  "kind",
  "provider",
  "email_address",
  "display_name",
  "signature",
  "imap_host",
  "smtp_host",
  "imap_port",
  "smtp_port",
  "sent_folder",
  "status",
  "last_error_code",
  "last_error",
  "last_error_at",
  "last_synced_at",
  "connected_at",
  "updated_at",
];
const ACCOUNT_SELECT = PUBLIC_ACCOUNT_FIELDS.join(", ");

function publicAccount(row: Row): Row {
  const out: Row = {};
  for (const f of PUBLIC_ACCOUNT_FIELDS) out[f] = row[f] ?? null;
  return out;
}

/** mail_accounts.email_address's own check constraint. hosts.ts accepts a
 *  little more (quotes, non-ASCII), and the address is MAIL FROM on every
 *  send, so it must pass this and mime-build's strict sender check too. */
const STORED_EMAIL_RE = /^[a-z0-9.!#$%&'*+\/=?^_{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Codes that describe the mailbox or the way to it, and so belong in the
 *  account's status. The rest (a bad request, our own failure, the rate
 *  limit) say nothing about the mailbox and never touch it. */
const MAILBOX_CODES = new Set<MailErrorCode>([
  "auth_failed",
  "imap_disabled_or_plan",
  "smtp_auth_failed",
  "tls_failed",
  "timeout",
  "dns_failed",
  "connect_failed",
  "smtp_587_only",
  "host_not_allowed",
  "microsoft_oauth_only",
  "server_busy",
  "protocol_error",
  "folder_missing",
  "session_limit",
]);

const LIMIT_TEXT = `A company can connect at most ${MAX_IMAP_ACCOUNTS_PER_COMPANY} mailboxes. Disconnect one first.`;

function hasOwn(o: Row, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function env(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

function requireOwner(caller: MailCaller): void {
  if (!caller.isOwner) throw new MailError("owner_only");
}

// ---------------------------------------------------------------------------
// Input.
// ---------------------------------------------------------------------------

function mailboxAddress(raw: unknown): string {
  const { address } = normalizeMailbox(raw);
  if (address.length > 254 || !STORED_EMAIL_RE.test(address) || !isValidAddress(address)) {
    throw new MailError("bad_request", "Enter the mailbox's full email address.");
  }
  return address;
}

/**
 * The app password as typed, checked for what Vault and the protocols will
 * refuse, BEFORE it is presented to any server -- a password that verifies
 * but cannot be stored would be one sign-in spent for nothing. The ends are
 * trimmed because a pasted password often brings a space or line break
 * along and no app password begins or ends with one; nothing inside is
 * touched (Google shows its app passwords in groups of four).
 */
function appPassword(raw: unknown): string {
  if (typeof raw !== "string") throw new MailError("bad_request", "Enter the app password.");
  const p = raw.replace(/^\s+|\s+$/g, "");
  if (!p) throw new MailError("bad_request", "Enter the app password.");
  if (p.length > SECRET_MAX_CHARS) throw new MailError("bad_request", "That app password is too long.");
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(p)) {
    throw new MailError("bad_request", "The app password contains a character that cannot be used.");
  }
  return p;
}

function displayNameOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || raw.length > 500) throw new MailError("bad_request", "Enter a shorter sender name.");
  return cleanDisplayName(raw) || null;
}

/** Plain text, several lines. Line breaks are kept (as LF); every other
 *  control character and the invisible direction overrides are dropped.
 *  Refused rather than cut when too long: a signature silently losing its
 *  last line is worse than being told. */
function signatureOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new MailError("bad_request", "The signature must be text.");
  const s = raw
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[ ]+$/gm, "")
    .trim();
  if (Array.from(s).length > SIGNATURE_MAX_CHARS) {
    throw new MailError("bad_request", `The signature can be at most ${SIGNATURE_MAX_CHARS} characters.`);
  }
  return s || null;
}

/** A folder path from LIST, if the column will take it. */
function cleanFolderPath(path: string | null): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 300) return null;
  // deno-lint-ignore no-control-regex
  return /[\u0000-\u001f\u007f]/.test(path) ? null : path;
}

// ---------------------------------------------------------------------------
// Talking to the mailbox.
// ---------------------------------------------------------------------------

/** A MailError as told about this connection. Anything else is our own bug
 *  and stays one (server_error), never "could not reach the mail server". */
function asServerFailure(e: unknown, hosts: MailHosts, stage: "imap" | "smtp"): unknown {
  if (!(e instanceof MailError)) return e;
  return hosts.custom ? forCustomHost(e, stage) : e;
}

/**
 * Signs in to IMAP (and learns where Sent is), then -- only if IMAP accepted
 * the password -- to SMTP. Reads nothing but the folder list and INBOX's
 * counters, and sends nothing. Throws the classified MailError.
 */
async function verifyServers(hosts: MailHosts, username: string, password: string): Promise<{ sentFolder: string | null }> {
  const creds = { username, password };
  const limits = { sessionDeadlineMs: VERIFY_SESSION_MS };
  let sentFolder: string | null = null;

  let imap: ImapClient | null = null;
  try {
    imap = new ImapClient(await connectTls({ hostname: hosts.imapHost, port: hosts.imapPort, limits }));
    sentFolder = cleanFolderPath((await verifyMailbox(imap, creds)).sentFolder);
  } catch (e) {
    throw asServerFailure(e, hosts, "imap");
  } finally {
    imap?.close();
  }

  let smtp: SmtpClient | null = null;
  try {
    smtp = new SmtpClient(await connectTls({ hostname: hosts.smtpHost, port: hosts.smtpPort, limits }));
    await verifySmtp(smtp, creds);
  } catch (e) {
    throw asServerFailure(e, hosts, "smtp");
  } finally {
    smtp?.close();
  }
  return { sentFolder };
}

/** True when a stored preset host pair is exactly what hosts.ts would pick
 *  for this address today. */
function presetMatches(provider: "zoho" | "gmail", email: string, imapHost: string, smtpHost: string): boolean {
  const regions = provider === "zoho" ? Object.keys(ZOHO_REGIONS) : ["us"];
  return regions.some((region) => {
    try {
      const h = resolvePreset(provider, email, region);
      return h.imapHost === imapHost && h.smtpHost === smtpHost;
    } catch {
      return false;
    }
  });
}

/**
 * The hosts of a stored account, re-vetted before use. Only this function's
 * service-role writes ever set them, but a check is where a custom host's
 * DNS would have been re-pointed at something internal, so custom names are
 * resolved and judged again, and preset rows must still name the preset.
 */
async function hostsForAccount(row: Row): Promise<MailHosts> {
  const provider = String(row.provider ?? "");
  const imapHost = String(row.imap_host ?? "").toLowerCase();
  const smtpHost = String(row.smtp_host ?? "").toLowerCase();
  if (row.imap_port !== IMAP_PORT || row.smtp_port !== SMTP_PORT) throw new MailError("host_not_allowed");
  if (provider === "zoho" || provider === "gmail") {
    if (!presetMatches(provider, String(row.email_address ?? ""), imapHost, smtpHost)) throw new MailError("host_not_allowed");
    return { provider, imapHost, smtpHost, imapPort: IMAP_PORT, smtpPort: SMTP_PORT, custom: false };
  }
  if (provider !== "custom") throw new MailError("host_not_allowed");
  const imap = validateCustomHost(imapHost);
  const smtp = validateCustomHost(smtpHost);
  const resolver = denoResolver();
  await Promise.all([resolveAndCheck(imap, resolver), resolveAndCheck(smtp, resolver)]);
  return { provider: "custom", imapHost: imap, smtpHost: smtp, imapPort: IMAP_PORT, smtpPort: SMTP_PORT, custom: true };
}

// ---------------------------------------------------------------------------
// Database. Every service-role query filters company_id = caller.companyId.
// ---------------------------------------------------------------------------

/** One connection attempt from the ledger. Refused attempts count too, so
 *  hammering the form burns the budget. An answer that is not a number
 *  refuses: an empty answer read as "under the limit" is how limits vanish. */
async function spendConnectAttempt(caller: MailCaller): Promise<void> {
  const { data, error } = await caller.admin.rpc("note_mail_event", {
    p_company: caller.companyId,
    p_actor: caller.uid,
    p_kind: "connect_attempt",
    p_window: "1 hour",
  });
  if (error || typeof data !== "number") throw new MailError("server_error");
  if (data > CONNECT_ATTEMPTS_PER_HOUR) throw new MailError("rate_limited");
}

async function putSecret(caller: MailCaller, accountId: string, password: string): Promise<void> {
  const { error } = await caller.admin.rpc("mail_secret_put", { p_account: accountId, p_secret: password });
  // The SQL reports a Vault failure by SQLSTATE only and never repeats the
  // value; its text is still neither passed on nor logged.
  if (error) throw new MailError("server_error");
}

async function forgetSecret(caller: MailCaller, accountId: string): Promise<boolean> {
  const { data, error } = await caller.admin.rpc("mail_secret_forget", { p_account: accountId });
  if (error) throw new MailError("server_error");
  return data === true;
}

/** Sync starts a folder afresh: after the mailbox moved to another server or
 *  user (every stored UID means nothing there), or after Sent moved. The
 *  messages already fetched stay; mail_ingest re-binds them by Message-ID
 *  rather than duplicating them. mail_folder_state has no company_id: the
 *  account id always comes from a row already proven to be this company's. */
async function resetFolderState(caller: MailCaller, accountId: string, which: "all" | "sent"): Promise<void> {
  let q = caller.admin.from("mail_folder_state").delete().eq("account_id", accountId);
  if (which === "sent") q = q.eq("role", "sent");
  const { error } = await q;
  if (error) throw new MailError("server_error");
}

interface WriteGuard {
  /** Update only while the row still has this status. */
  status?: string;
  /** Update only while the row does not have this status. */
  notStatus?: string;
}

/** Updates one of the caller's company's mailboxes and returns the row. No
 *  row back means it changed underneath us (disconnected meanwhile). */
async function writeAccount(caller: MailCaller, id: string, patch: Row, guard: WriteGuard = {}): Promise<Row> {
  let q = caller.admin.from("mail_accounts").update(patch).eq("id", id).eq("company_id", caller.companyId);
  if (guard.status) q = q.eq("status", guard.status);
  if (guard.notStatus) q = q.neq("status", guard.notStatus);
  const { data, error } = await q.select("*").maybeSingle();
  if (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    // 23505: the partial unique index -- this address is already live.
    if (code === "23505") throw new MailError("bad_request", "This mailbox is already connected.");
    // 23514 when a row goes live is the trigger's three-mailbox cap (a
    // connect racing another); anywhere else it is a column check.
    if (code === "23514") {
      throw new MailError("bad_request", patch.status === "connected" && guard.status === "disconnected"
        ? LIMIT_TEXT
        : "Those details cannot be saved. Check the address and server names.");
    }
    throw new MailError("server_error");
  }
  if (!data) throw new MailError("not_found", "That mailbox changed while this was running. Try again.");
  return data as Row;
}

/** A mailbox of the caller's company, read under their RLS, that has an app
 *  password to check: an IMAP account that is not disconnected. */
async function loadImapAccount(caller: MailCaller, accountId: unknown): Promise<Row> {
  const row = await loadAccountAsCaller(caller, accountId);
  if (row.kind !== "imap") throw new MailError("bad_request", "FenceFlow mail has no mailbox or app password of its own.");
  if (row.status === "disconnected") throw new MailError("not_found", "That mailbox is disconnected. Connect it again.");
  return row;
}

/** A check or a new password worked: the account is connected again, with
 *  the Sent folder the server reports now. Never revives a mailbox the
 *  owner disconnected while this was running. */
async function markConnected(caller: MailCaller, row: Row, sentFolder: string | null): Promise<Row> {
  if ((row.sent_folder ?? null) !== sentFolder) await resetFolderState(caller, String(row.id), "sent");
  return await writeAccount(
    caller,
    String(row.id),
    { status: "connected", sent_folder: sentFolder, last_error_code: null, last_error: null, last_error_at: null },
    { notStatus: "disconnected" },
  );
}

/** A check that failed on the mailbox's side is written to the account, so
 *  the office shows it and the schedule stops (auth_failed) or backs off
 *  (error). Best effort: the failure itself is what the owner is told. */
async function recordFailure(caller: MailCaller, row: Row, err: MailError, secrets: ReadonlyArray<string>): Promise<void> {
  if (!MAILBOX_CODES.has(err.code)) return;
  try {
    const { error } = await caller.admin.from("mail_accounts").update({
      status: accountStatusFor(err.code),
      last_error_code: err.code,
      last_error: redact(err.detail, secrets) || MESSAGES[err.code],
      last_error_at: new Date().toISOString(),
    }).eq("id", String(row.id)).eq("company_id", caller.companyId).neq("status", "disconnected");
    if (error) console.error(`${FN}: could not record a failed check`);
  } catch {
    console.error(`${FN}: could not record a failed check`);
  }
}

/**
 * One audit_log row, in the same shape set_mail_access writes. Best effort:
 * the change has already happened, and failing the request now would tell
 * the owner it had not. The password is never a value here -- replacing it
 * is recorded as the word "replaced".
 */
async function audit(
  caller: MailCaller,
  row: Row,
  action: "insert" | "update",
  field: string,
  oldValue: string | null,
  newValue: string | null,
): Promise<void> {
  try {
    const { data } = await caller.admin.auth.admin.getUserById(caller.uid);
    const { error } = await caller.admin.from("audit_log").insert({
      company_id: caller.companyId,
      actor: caller.uid,
      actor_email: data?.user?.email ?? null,
      table_name: "mail_accounts",
      record_id: String(row.id),
      action,
      field,
      old_value: oldValue,
      new_value: newValue,
      label: String(row.email_address ?? ""),
    });
    if (error) console.error(`${FN}: audit_log write failed`);
  } catch {
    console.error(`${FN}: audit_log write failed`);
  }
}

/** Gmail always files what its SMTP sends in Sent, so mail-send never
 *  appends a copy there. Anyone else is learned on the first send. */
function savesSentDefault(provider: unknown): boolean | null {
  return provider === "gmail" ? true : null;
}

function movedServer(row: Row, fields: Row): boolean {
  return row.imap_host !== fields.imap_host || row.username !== fields.username;
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

async function status(caller: MailCaller): Promise<Response> {
  const { data: rows, error } = await caller.userClient
    .from("mail_accounts").select(ACCOUNT_SELECT)
    .eq("company_id", caller.companyId).neq("status", "disconnected")
    .order("connected_at", { ascending: true });
  if (error || !Array.isArray(rows)) throw new MailError("server_error");
  const accounts = (rows as Row[]).filter((r) => r.kind === "imap");
  let fenceflowId = (rows as Row[]).find((r) => r.kind === "fenceflow")?.id ?? null;

  // FenceFlow mail can send only with a Resend key and a MAIL_FROM that
  // holds a real address; mail-send refuses on exactly the same test.
  let from: { name: string; address: string } | null = null;
  if (env("MAIL_API_KEY")) {
    try {
      from = fenceflowFrom(caller.companyName, env("MAIL_FROM"), env("MAIL_FROM_NAME") || "FenceFlow");
    } catch {
      from = null;
    }
  }

  // Replies come back into FenceFlow only once receiving is configured AND
  // a signed webhook has proven it (resend-inbound sets inbound_verified_at).
  const inboundDomain = env("MAIL_INBOUND_DOMAIN").toLowerCase();
  let inboundReady = false;
  if (inboundDomain && env("RESEND_WEBHOOK_SECRET") && env("RESEND_RECEIVING_KEY")) {
    const { data: settings, error: sErr } = await caller.admin
      .from("mail_platform_settings").select("inbound_verified_at").eq("id", 1).maybeSingle();
    if (sErr) throw new MailError("server_error");
    inboundReady = Boolean((settings as Row | null)?.inbound_verified_at);
  }

  // The routing token is needed only for the preview of an inbound Reply-To,
  // and only then is the company's FenceFlow-mail row created (race-safe, by
  // the RPC). It is read with the service role: the office never sees it
  // except inside that preview.
  let inboundToken: string | null = null;
  if (from && inboundReady) {
    const { data: id, error: fErr } = await caller.admin.rpc("mail_fenceflow_account", {
      p_company: caller.companyId,
      p_email: from.address,
    });
    if (fErr || !isUuid(id)) throw new MailError("server_error");
    const { data: ff, error: tErr } = await caller.admin
      .from("mail_accounts").select("inbound_token").eq("id", id).eq("company_id", caller.companyId).maybeSingle();
    if (tErr) throw new MailError("server_error");
    inboundToken = typeof (ff as Row | null)?.inbound_token === "string" ? String((ff as Row).inbound_token) : null;
    fenceflowId = id;
  }

  const reply = fenceflowReplyTo({ inboundReady, inboundDomain, inboundToken, replyToken: null, companyEmail: caller.companyEmail });
  return json({
    can_manage: caller.isOwner,
    accounts: accounts.map(publicAccount),
    max_accounts: MAX_IMAP_ACCOUNTS_PER_COMPANY,
    providers: {
      // Only regions the reach probe has proven. "Other" needs DNS to vet
      // the host, so it is offered only where the runtime can resolve.
      zoho_regions: Object.keys(ZOHO_REGIONS),
      custom: denoResolver() !== null,
    },
    fenceflow: {
      send_available: from !== null,
      from_name: from?.name ?? null,
      from_address: from?.address ?? null,
      account_id: fenceflowId,
      inbound_ready: inboundReady,
      reply_mode: from ? reply.mode : null,
      reply_to_preview: from ? reply.replyTo : null,
      // FenceFlow mail with nowhere honest for a reply to go is refused by
      // mail-send; the office says "Add your business email first".
      needs_company_email: from !== null && reply.mode === "unavailable",
    },
  });
}

async function connect(caller: MailCaller, body: Row): Promise<Response> {
  requireOwner(caller);
  const provider = String(body.provider ?? "");
  if (provider !== "zoho" && provider !== "gmail" && provider !== "custom") {
    throw new MailError("bad_request", "Choose Zoho Mail, Gmail or another mail server.");
  }
  const address = mailboxAddress(body.email);
  const password = appPassword(body.password);
  const displayName = hasOwn(body, "display_name") ? displayNameOrNull(body.display_name) : undefined;

  const { data, error } = await caller.userClient
    .from("mail_accounts").select("*").eq("company_id", caller.companyId).eq("kind", "imap");
  if (error || !Array.isArray(data)) throw new MailError("server_error");
  const rows = data as Row[];
  const live = rows.filter((r) => r.status !== "disconnected");
  const current = live.find((r) => r.email_address === address) ?? null;
  // Checked before an attempt is spent or a socket opened. The trigger
  // enforces it again when the row goes live.
  if (!current && live.length >= MAX_IMAP_ACCOUNTS_PER_COMPANY) throw new MailError("bad_request", LIMIT_TEXT);

  await spendConnectAttempt(caller);
  const hosts = await planConnection(
    { provider, email: address, zohoRegion: body.zoho_region, imapHost: body.imap_host, smtpHost: body.smtp_host },
    denoResolver(),
  );
  const { sentFolder } = await verifyServers(hosts, address, password);

  const fields: Row = {
    provider: hosts.provider,
    username: address,
    imap_host: hosts.imapHost,
    smtp_host: hosts.smtpHost,
    imap_port: hosts.imapPort,
    smtp_port: hosts.smtpPort,
    sent_folder: sentFolder,
  };
  if (displayName !== undefined) fields.display_name = displayName;
  const nowIso = new Date().toISOString();
  const goLive: Row = {
    status: "connected",
    connected_by: caller.uid,
    connected_at: nowIso,
    disconnected_by: null,
    disconnected_at: null,
    last_error_code: null,
    last_error: null,
    last_error_at: null,
  };

  // The same address is already connected: a new password, or new hosts.
  if (current) {
    const id = String(current.id);
    const moved = movedServer(current, fields);
    await putSecret(caller, id, password);
    if (moved) await resetFolderState(caller, id, "all");
    else if ((current.sent_folder ?? null) !== sentFolder) await resetFolderState(caller, id, "sent");
    let saved: Row;
    try {
      saved = await writeAccount(
        caller,
        id,
        { ...fields, ...goLive, ...(moved ? { smtp_saves_sent: savesSentDefault(hosts.provider) } : {}) },
        { notStatus: "disconnected" },
      );
    } catch (e) {
      // Disconnected while we were signing in: the password just stored
      // belongs to nothing live, so it goes.
      if (e instanceof MailError && e.code === "not_found") await forgetSecret(caller, id).catch(() => false);
      throw e;
    }
    await audit(caller, saved, "update", "status", String(current.status), "connected");
    return json({ ok: true, account: publicAccount(saved), sent_folder_found: sentFolder !== null });
  }

  // Connected before and disconnected since: the same row comes back, so
  // the mail already fetched for it stays with it.
  const dormant = rows
    .filter((r) => r.status === "disconnected" && r.email_address === address)
    .sort((a, b) => String(b.connected_at ?? "").localeCompare(String(a.connected_at ?? "")))[0] ?? null;

  let row: Row;
  let created = false;
  if (dormant) {
    const moved = movedServer(dormant, fields);
    row = await writeAccount(
      caller,
      String(dormant.id),
      { ...fields, ...(moved ? { smtp_saves_sent: savesSentDefault(hosts.provider) } : {}) },
      { status: "disconnected" },
    );
    if (moved) await resetFolderState(caller, String(row.id), "all");
    else if ((dormant.sent_folder ?? null) !== sentFolder) await resetFolderState(caller, String(row.id), "sent");
  } else {
    const { data: inserted, error: insErr } = await caller.admin.from("mail_accounts").insert({
      company_id: caller.companyId,
      kind: "imap",
      email_address: address,
      ...fields,
      smtp_saves_sent: savesSentDefault(hosts.provider),
      status: "disconnected",
      connected_by: caller.uid,
    }).select("*").single();
    if (insErr || !inserted) {
      const code = String((insErr as { code?: unknown } | null)?.code ?? "");
      if (code === "23514") throw new MailError("bad_request", "Those details cannot be saved. Check the address and server names.");
      throw new MailError("server_error");
    }
    row = inserted as Row;
    created = true;
  }

  let saved: Row;
  try {
    await putSecret(caller, String(row.id), password);
    saved = await writeAccount(caller, String(row.id), goLive, { status: "disconnected" });
  } catch (e) {
    // Nothing half-connected is left behind: no password for a row that is
    // not live, and no empty row made by this request.
    try {
      await forgetSecret(caller, String(row.id));
    } catch {
      console.error(`${FN}: cleanup after a failed connect could not forget the password`);
    }
    if (created) {
      const { error: delErr } = await caller.admin.from("mail_accounts").delete()
        .eq("id", String(row.id)).eq("company_id", caller.companyId).eq("status", "disconnected");
      if (delErr) console.error(`${FN}: cleanup after a failed connect could not remove the row`);
    }
    throw e;
  }
  await audit(caller, saved, dormant ? "update" : "insert", "status", dormant ? "disconnected" : null, "connected");
  return json({ ok: true, account: publicAccount(saved), sent_folder_found: sentFolder !== null });
}

async function check(caller: MailCaller, body: Row, secrets: string[]): Promise<Response> {
  requireOwner(caller);
  const row = await loadImapAccount(caller, body.account_id);
  await spendConnectAttempt(caller);
  const { data: secret, error } = await caller.admin.rpc("mail_secret_get", { p_account: String(row.id) });
  if (error) throw new MailError("server_error");
  if (typeof secret !== "string" || !secret) {
    const missing = new MailError("auth_failed", "No app password is stored for this mailbox. Enter a new app password.");
    await recordFailure(caller, row, missing, []);
    throw missing;
  }
  secrets.push(secret);
  try {
    const hosts = await hostsForAccount(row);
    const { sentFolder } = await verifyServers(hosts, String(row.username ?? ""), secret);
    const saved = await markConnected(caller, row, sentFolder);
    return json({ ok: true, account: publicAccount(saved), sent_folder_found: sentFolder !== null });
  } catch (e) {
    if (e instanceof MailError) await recordFailure(caller, row, e, secrets);
    throw e;
  }
}

async function replacePassword(caller: MailCaller, body: Row): Promise<Response> {
  requireOwner(caller);
  const row = await loadImapAccount(caller, body.account_id);
  const password = appPassword(body.password);
  await spendConnectAttempt(caller);
  const hosts = await hostsForAccount(row);
  // A new password that does not work changes nothing: the stored one and
  // the account's status stay exactly as they were.
  const { sentFolder } = await verifyServers(hosts, String(row.username ?? ""), password);
  await putSecret(caller, String(row.id), password);
  let saved: Row;
  try {
    saved = await markConnected(caller, row, sentFolder);
  } catch (e) {
    if (e instanceof MailError && e.code === "not_found") await forgetSecret(caller, String(row.id)).catch(() => false);
    throw e;
  }
  await audit(caller, saved, "update", "app_password", null, "replaced");
  return json({ ok: true, account: publicAccount(saved), sent_folder_found: sentFolder !== null });
}

async function disconnect(caller: MailCaller, body: Row): Promise<Response> {
  requireOwner(caller);
  const row = await loadAccountAsCaller(caller, body.account_id);
  if (row.kind !== "imap") {
    throw new MailError("bad_request", "FenceFlow mail is not a connected mailbox, so there is nothing to disconnect.");
  }
  // The password goes first. If forgetting it fails, the mailbox is not
  // reported as disconnected while its password is still in Vault.
  const forgotten = await forgetSecret(caller, String(row.id));
  let saved = row;
  if (row.status !== "disconnected") {
    saved = await writeAccount(caller, String(row.id), {
      status: "disconnected",
      disconnected_by: caller.uid,
      disconnected_at: new Date().toISOString(),
      last_error_code: null,
      last_error: null,
      last_error_at: null,
    });
    await audit(caller, saved, "update", "status", String(row.status), "disconnected");
  }
  return json({ ok: true, account: publicAccount(saved), password_forgotten: forgotten });
}

async function setDisplay(caller: MailCaller, body: Row): Promise<Response> {
  requireOwner(caller);
  const row = await loadImapAccount(caller, body.account_id);
  const patch: Row = {};
  if (hasOwn(body, "display_name")) patch.display_name = displayNameOrNull(body.display_name);
  if (hasOwn(body, "signature")) patch.signature = signatureOrNull(body.signature);
  if (Object.keys(patch).length === 0) throw new MailError("bad_request", "Nothing to change.");
  const saved = await writeAccount(caller, String(row.id), patch, { notStatus: "disconnected" });
  return json({ ok: true, account: publicAccount(saved) });
}

// ---------------------------------------------------------------------------
// The door.
// ---------------------------------------------------------------------------

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error_code: "bad_request", message: MESSAGES.bad_request }, 405);

  // Every secret this request holds, for redacting whatever goes back.
  const secrets: string[] = [];
  try {
    // Who is asking comes first: nobody's body is read before the gate.
    const caller = await mailCaller(req);
    const body = await readJsonBody(req);
    if (typeof body.password === "string") secrets.push(body.password, body.password.trim());

    switch (String(body.action ?? "")) {
      case "status":
        return await status(caller);
      case "connect":
        return await connect(caller, body);
      case "check":
        return await check(caller, body, secrets);
      case "replace_password":
        return await replacePassword(caller, body);
      case "disconnect":
        return await disconnect(caller, body);
      case "set_display":
        return await setDisplay(caller, body);
      default:
        throw new MailError("bad_request", "Unknown action.");
    }
  } catch (e) {
    return errorResponse(FN, e, secrets);
  }
}

Deno.serve(handle);
