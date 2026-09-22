/**
 * mail-sync -- brings new mail from each connected mailbox into FenceFlow.
 *
 * Headers only. For every company mailbox connected over IMAP it logs in,
 * reads INBOX and the Sent folder with EXAMINE (read-only) and BODY.PEEK (so
 * nothing is marked read), hands the header blocks to mail_ingest, copies
 * read/answered/flagged changes for the newest cached messages, hides the
 * ones the mailbox no longer has, and remembers where it got to in
 * mail_folder_state. Bodies are fetched only when someone opens a message
 * (mail-message). Nothing here can delete, move or send mail: imap-client.ts
 * has no command for it.
 *
 * TWO DOORS, chosen by one header. A request that carries x-fenceflow-trigger
 * is the scheduled door and never falls through to the other one:
 *
 *  - Office door (Authorization: Bearer <user JWT>). mailCaller() is the
 *    whole gate: getUser, then can_use_company_mail() asked with the
 *    caller's own token, then the service role, and only then. The list of
 *    mailboxes is read through the caller's client, so RLS proves they are
 *    the caller's company; every service-role query after that also filters
 *    company_id itself. All of the company's mailboxes (at most 3) run in
 *    parallel and the answer comes within OFFICE_SYNC_BUDGET_MS: each mail
 *    session is cut to fit, and a cut session keeps what it finished.
 *    Answers {accounts: [{id, status, new, busy?, unfinished?, error_code?}]}.
 *  - Scheduled door (x-fenceflow-trigger = MAIL_SYNC_TRIGGER_SECRET, hashed
 *    and compared in constant time by triggerCaller; an unset secret refuses
 *    everything). Called by .github/workflows/mail-sync.yml every 10 minutes.
 *    Syncs due mailboxes oldest first, one at a time, at most
 *    TRIGGER_SYNC_MAX_ACCOUNTS. `auth_failed` mailboxes are never tried --
 *    presenting a refused password every ten minutes is how Zoho or Google
 *    locks a mailbox -- and `error` ones wait ERROR_BACKOFF_MINUTES.
 *    Answers COUNTS ONLY: the repository is public, so the workflow's log is
 *    too, and no account id, address, host or server text may reach it.
 *    {action:'reach'} runs the reachability probe instead (below).
 *
 * TIME. Supabase answers 504 to any function that has not responded within
 * 150 s, whatever the plan (the request idle timeout), and the workflow
 * reads that as a failed run. The design's 300 s for the scheduled door
 * (TRIGGER_SYNC_BUDGET_MS) cannot be answered inside that, so the door stops
 * STARTING mailboxes after TRIGGER_START_BUDGET_MS and cuts every mail
 * session so it ends by TRIGGER_RESPONSE_BUDGET_MS; whatever is left is the
 * oldest next run and goes first then. A session cut by our own budget is
 * not the mailbox's fault: its status is not set to `error`.
 *
 * ORDER, so a crash never loses or duplicates mail: header blocks come in
 * batches of HEADER_FETCH_BATCH, and after each one mail_ingest stores it and
 * only then does the folder's mail_folder_state move past it. mail_ingest
 * de-duplicates on (folder, UIDVALIDITY, UID), so a run that dies anywhere
 * repeats at most the batch it was on. Each block is capped at
 * HEADER_BLOCK_MAX_BYTES, so no sender can make a batch too big to finish. One sync per
 * mailbox at a time: mail_claim_sync() holds a lock for the whole session,
 * then shortens it to MANUAL_SYNC_LOCK_SECONDS from the start, which is also
 * the office's "Check for new mail" rate limit.
 *
 * THE PASSWORD is read from Vault (mail_secret_get, service role only) after
 * the gate and the lock, handed to the IMAP login and to redact(), and to
 * nothing else. It is never logged, stored, returned or put in an error:
 * imap-client.ts hides the LOGIN line in its transcript and redacts every
 * server line, and anything written to last_error is redacted again here.
 *
 * STORED HOSTS ARE CHECKED AGAIN on every sync, not trusted from the row: a
 * preset account must still name its provider's own server (hosts.ts), and a
 * custom host is re-validated and re-resolved, so a name re-pointed at a
 * private address since it was connected is refused before any socket
 * opens. Errors about reaching a custom host are collapsed the same way
 * mail-connect collapses them (errors.forCustomHost).
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { corsHeaders, errorResponse, json, mailCaller, readJsonBody, triggerCaller } from "../_shared/mail/caller.ts";
import {
  accountStatusFor,
  classifyNetworkError,
  forCustomHost,
  MailError,
  MESSAGES,
  redact,
} from "../_shared/mail/errors.ts";
import type { MailErrorCode } from "../_shared/mail/errors.ts";
import { denoResolver, resolveAndCheck, resolvePreset, validateCustomHost, ZOHO_REGIONS } from "../_shared/mail/hosts.ts";
import type { Resolver } from "../_shared/mail/hosts.ts";
import { ImapClient, openSession, syncFolder } from "../_shared/mail/imap-client.ts";
import type { FolderBatch, FolderSyncResult, FolderSyncState } from "../_shared/mail/imap-client.ts";
import { findSentFolder } from "../_shared/mail/imap-proto.ts";
import {
  ERROR_BACKOFF_MINUTES,
  FLAG_WINDOW,
  HEADERS_PER_FOLDER_PER_RUN,
  IMAP_PORT,
  MANUAL_SYNC_LOCK_SECONDS,
  OFFICE_SYNC_BUDGET_MS,
  SESSION_DEADLINE_MS,
  TRIGGER_SYNC_BUDGET_MS,
  TRIGGER_SYNC_MAX_ACCOUNTS,
} from "../_shared/mail/limits.ts";
import { flagsToColumns, parseMail, toRow } from "../_shared/mail/message-meta.ts";
import type { IngestRow, OwnMailboxes } from "../_shared/mail/message-meta.ts";
import { SmtpClient } from "../_shared/mail/smtp-client.ts";
import { connectTls } from "../_shared/mail/tls-transport.ts";
import type { ConnectOptions, MailTransport } from "../_shared/mail/tls-transport.ts";

// ---------------------------------------------------------------------------
// Numbers that belong to this function alone. Everything shared is in
// limits.ts.
// ---------------------------------------------------------------------------

/** The scheduled door starts no new mailbox after this long... */
export const TRIGGER_START_BUDGET_MS = Math.min(TRIGGER_SYNC_BUDGET_MS, 90_000);
/** ...and every mail session it runs has ended by this long, leaving ~20 s
 *  of the gateway's 150 s for the last database writes and the answer. */
export const TRIGGER_RESPONSE_BUDGET_MS = 130_000;
/** A mailbox is not started with less than this left: a login alone can
 *  take several round trips, and a session cut at once achieves nothing. */
export const MIN_SESSION_MS = 15_000;
/** The lock outlives the session by this much, covering the database work
 *  that follows the last socket operation. */
const LOCK_MARGIN_SECONDS = 30;
/** The schedule leaves a mailbox alone for this long after it was synced
 *  (by the schedule or by someone opening the Email tab). */
export const TRIGGER_MIN_INTERVAL_MINUTES = 5;
/** Candidates read per status when looking for due mailboxes. Ordered oldest
 *  first, so the ones that are due come first. */
const DUE_SCAN_LIMIT = 100;
/** PostgREST answers at most 1000 rows; the stale-UID sweep pages by that. */
const STALE_PAGE = 1000;
const STALE_MAX_PAGES = 20;
/** Codes that mean FenceFlow's own side failed, not a tenant's mailbox. Any
 *  of these makes the scheduled run answer ok:false, so the workflow fails
 *  and somebody hears of it. A tenant's wrong password must not. */
const OUR_SIDE: ReadonlySet<MailErrorCode> = new Set<MailErrorCode>(["server_error", "not_configured"]);

// ---------------------------------------------------------------------------
// What the function needs from the outside world, so the Node tests can give
// it a fake mailbox, a fake resolver and a fake clock and call the real
// handler exactly as the gateway does.
// ---------------------------------------------------------------------------

export interface SyncDeps {
  connect: (opts: ConnectOptions) => Promise<MailTransport>;
  resolver: Resolver | null;
  /** Plain TCP connect for the reach probe's negative controls, which name
   *  fixed hosts and ports below. Nothing else calls it. */
  tcpProbe: (hostname: string, port: number, timeoutMs: number) => Promise<void>;
  now: () => number;
  env: (name: string) => string | undefined;
}

// deno-lint-ignore no-explicit-any
const denoGlobal = (): any => (globalThis as any).Deno;

async function denoTcpProbe(hostname: string, port: number, timeoutMs: number): Promise<void> {
  const D = denoGlobal();
  if (!D || typeof D.connect !== "function") throw new MailError("not_configured", "No TCP sockets in this runtime.");
  const connecting: Promise<{ close(): void }> = D.connect({ hostname, port, transport: "tcp" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const conn = await Promise.race([
      connecting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MailError("timeout")), timeoutMs);
      }),
    ]);
    conn.close();
  } catch (e) {
    connecting.then((c) => c.close()).catch(() => {});
    throw classifyNetworkError(e);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function productionDeps(): SyncDeps {
  return {
    connect: connectTls,
    resolver: denoResolver(),
    tcpProbe: denoTcpProbe,
    now: () => Date.now(),
    env: (name) => denoGlobal()?.env?.get(name) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function ts(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A UID or UIDVALIDITY read back from the database (bigint arrives as a
 *  JSON number), or null. */
function uidOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 4294967295 ? n : null;
}

/** A folder path fit for mail_folder_state and mail_accounts.sent_folder
 *  (both refuse control characters and anything over 300 characters). */
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
  if (/TimedOut|ConnectionRefused|ConnectionReset|ConnectionAborted|NotConnected|BrokenPipe|InvalidData|UnexpectedEof|Interrupted/.test(name)) {
    return classifyNetworkError(e);
  }
  return new MailError("server_error");
}

// ---------------------------------------------------------------------------
// Which server a stored account may be synced from.
// ---------------------------------------------------------------------------

export interface StoredAccount {
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

const ACCOUNT_COLUMNS =
  "id, company_id, kind, provider, email_address, username, imap_host, imap_port, sent_folder, status, updated_at";

/**
 * The IMAP host to connect to for this row, re-checked now. A preset row
 * must name exactly the host hosts.ts would pick for its address today (in
 * any offered Zoho region); a custom row goes through validateCustomHost and
 * resolveAndCheck again, so a name that now points somewhere private is
 * refused before any socket opens.
 */
export async function imapHostFor(row: StoredAccount, resolver: Resolver | null): Promise<string> {
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

// ---------------------------------------------------------------------------
// Database steps. Every one checks its error: an ignored error here reads as
// "nothing new", which is the bug class that has hidden failures before.
// ---------------------------------------------------------------------------

/** Every address the company sends from (all its mail_accounts, any kind or
 *  status), plus FenceFlow's inbound reply domain: never counterparts. */
async function ownMailboxes(admin: SupabaseClient, companyId: string, deps: SyncDeps): Promise<OwnMailboxes> {
  const { data, error } = await admin.from("mail_accounts").select("email_address").eq("company_id", companyId);
  if (error) throw new MailError("server_error", "Could not read the company's mailboxes.");
  const inbound = String(deps.env("MAIL_INBOUND_DOMAIN") ?? "").trim().toLowerCase();
  return {
    addresses: ((data ?? []) as Array<{ email_address?: unknown }>).map((r) => String(r.email_address ?? "")).filter(Boolean),
    domains: inbound ? [inbound] : [],
  };
}

interface FolderStateRow {
  role: string;
  path: string;
  uidvalidity: unknown;
  last_uid: unknown;
  backfill_below_uid: unknown;
  initial_done: unknown;
}

async function loadFolderStates(admin: SupabaseClient, accountId: string): Promise<Map<string, FolderStateRow>> {
  const { data, error } = await admin
    .from("mail_folder_state")
    .select("role, path, uidvalidity, last_uid, backfill_below_uid, initial_done")
    .eq("account_id", accountId);
  if (error) throw new MailError("server_error", "Could not read where the last sync stopped.");
  return new Map(((data ?? []) as FolderStateRow[]).map((r) => [r.role, r]));
}

/** The state syncFolder starts from. A row for a different path (the Sent
 *  folder was renamed or found again) is a fresh start: UIDs of one folder
 *  mean nothing in another. */
export function folderStartState(row: FolderStateRow | undefined, path: string): { state: FolderSyncState; pathChanged: boolean } {
  const fresh: FolderSyncState = { path, uidValidity: null, lastUid: 0, backfillBelowUid: null, initialDone: false };
  if (!row) return { state: fresh, pathChanged: false };
  if (row.path !== path) return { state: fresh, pathChanged: true };
  const lastUid = Number(row.last_uid);
  return {
    state: {
      path,
      uidValidity: uidOf(row.uidvalidity),
      lastUid: Number.isInteger(lastUid) && lastUid >= 0 ? lastUid : 0,
      backfillBelowUid: uidOf(row.backfill_below_uid),
      initialDone: row.initial_done === true,
    },
    pathChanged: false,
  };
}

/** The newest FLAG_WINDOW cached UIDs of a folder under one UIDVALIDITY that
 *  are not already hidden: the ones whose flags and presence are re-read. */
async function knownUids(
  admin: SupabaseClient,
  companyId: string,
  accountId: string,
  role: string,
  uidValidity: number,
): Promise<number[]> {
  const { data, error } = await admin
    .from("mail_messages")
    .select("uid")
    .eq("company_id", companyId)
    .eq("account_id", accountId)
    .eq("folder_role", role)
    .eq("uidvalidity", uidValidity)
    .is("server_gone_at", null)
    .not("uid", "is", null)
    .order("uid", { ascending: false })
    .limit(FLAG_WINDOW);
  if (error) throw new MailError("server_error", "Could not read the cached messages.");
  return ((data ?? []) as Array<{ uid: unknown }>).map((r) => uidOf(r.uid)).filter((u): u is number => u !== null);
}

const EMPTY = new Uint8Array(0);

/** Header blocks as mail_ingest rows. A block postal-mime cannot read still
 *  becomes a row (no subject, no sender), because the folder's last_uid
 *  moves past it either way and a skipped message would be lost for good;
 *  opening it later parses the whole message. */
export async function rowsFor(
  result: Pick<FolderSyncResult, "messages" | "uidValidity">,
  role: "inbox" | "sent",
  own: OwnMailboxes,
  now: Date,
): Promise<IngestRow[]> {
  const rows: IngestRow[] = [];
  for (const m of result.messages) {
    let email;
    try {
      email = await parseMail(m.headers ?? EMPTY);
    } catch {
      email = await parseMail(EMPTY);
    }
    try {
      rows.push(toRow(email, m, { folderRole: role, uidValidity: result.uidValidity, own, now }));
    } catch {
      // No usable UID: nothing to key it on, and imap-client already drops these.
    }
  }
  return rows;
}

/** Stores the rows; answers how many were new. mail_ingest answers one row
 *  per input row, and anything else is treated as a failure rather than as
 *  "nothing new". */
async function ingest(admin: SupabaseClient, accountId: string, rows: IngestRow[]): Promise<number> {
  const { data, error } = await admin.rpc("mail_ingest", { p_account: accountId, p_rows: rows });
  if (error) throw new MailError("server_error", "Could not store the fetched mail.");
  if (!Array.isArray(data) || data.length !== rows.length) {
    throw new MailError("server_error", "Storing the fetched mail gave an unexpected answer.");
  }
  return (data as Array<{ inserted?: unknown }>).filter((r) => r.inserted === true).length;
}

/** The FETCH (FLAGS) answer in mail_set_flags' own key names: seen, answered,
 *  flagged. (Not the column names: the function reads these keys, and a
 *  payload keyed is_seen would change nothing and report no error.) */
export function flagPayload(flags: FolderSyncResult["flags"], role: "inbox" | "sent"): Array<{ uid: number; seen?: boolean; answered?: boolean; flagged?: boolean }> {
  return flags.map((f) => {
    const c = flagsToColumns(f.flags, role);
    return { uid: f.uid, seen: c.is_seen, answered: c.is_answered, flagged: c.is_flagged };
  });
}

async function setFlags(admin: SupabaseClient, accountId: string, role: string, uidValidity: number, payload: unknown[]): Promise<void> {
  const { error } = await admin.rpc("mail_set_flags", {
    p_account: accountId,
    p_role: role,
    p_uidvalidity: uidValidity,
    p_flags: payload,
  });
  if (error) throw new MailError("server_error", "Could not update read and flagged marks.");
}

async function markGone(admin: SupabaseClient, accountId: string, role: string, uidValidity: number, uids: number[]): Promise<number> {
  const { data, error } = await admin.rpc("mail_mark_gone", {
    p_account: accountId,
    p_role: role,
    p_uidvalidity: uidValidity,
    p_uids: uids,
  });
  if (error) throw new MailError("server_error", "Could not hide removed messages.");
  return typeof data === "number" ? data : 0;
}

/**
 * After a UIDVALIDITY reset (or a Sent folder found at a new path), every
 * cached UID of the old numbering is meaningless: it cannot be opened,
 * marked or checked for removal any more. mail_ingest has already re-bound
 * the messages this run fetched again (same Message-ID) to their new UIDs;
 * the rest are hidden like removed mail. Hiding is not deleting: when a
 * later run backfills one of them, mail_ingest re-binds it and clears
 * server_gone_at. Pages by marking, so each query returns the next batch.
 */
async function hideStaleUids(
  admin: SupabaseClient,
  companyId: string,
  accountId: string,
  role: string,
  current: number,
): Promise<number> {
  let hidden = 0;
  for (let page = 0; page < STALE_MAX_PAGES; page++) {
    const { data, error } = await admin
      .from("mail_messages")
      .select("uid, uidvalidity")
      .eq("company_id", companyId)
      .eq("account_id", accountId)
      .eq("folder_role", role)
      .neq("uidvalidity", current)
      .is("server_gone_at", null)
      .not("uid", "is", null)
      .limit(STALE_PAGE);
    if (error) throw new MailError("server_error", "Could not read the cached messages.");
    const rows = (data ?? []) as Array<{ uid: unknown; uidvalidity: unknown }>;
    if (rows.length === 0) break;
    const byValidity = new Map<number, number[]>();
    for (const r of rows) {
      const v = uidOf(r.uidvalidity);
      const u = uidOf(r.uid);
      if (v === null || u === null || v === current) continue;
      byValidity.set(v, [...(byValidity.get(v) ?? []), u]);
    }
    let changed = 0;
    for (const [v, uids] of byValidity) changed += await markGone(admin, accountId, role, v, uids);
    hidden += changed;
    // Nothing changed means the same page would come back: stop, don't spin.
    if (changed === 0 || rows.length < STALE_PAGE) break;
  }
  return hidden;
}

/** Where a folder's sync stands: a whole run's result, or one batch's. */
type FolderPosition = Pick<FolderBatch, "path" | "uidValidity" | "lastUid" | "backfillBelowUid">;

async function saveFolderState(admin: SupabaseClient, accountId: string, role: string, r: FolderPosition, nowMs: number): Promise<void> {
  const { error } = await admin.from("mail_folder_state").upsert(
    {
      account_id: accountId,
      role,
      path: r.path,
      uidvalidity: r.uidValidity,
      last_uid: r.lastUid,
      backfill_below_uid: r.backfillBelowUid,
      initial_done: true,
      updated_at: iso(nowMs),
    },
    { onConflict: "account_id,role" },
  );
  if (error) throw new MailError("server_error", "Could not record where this sync stopped.");
}

/**
 * The account's closing write, made only if nobody else changed the row
 * while we worked (updated_at is what we last saw) and never on a
 * disconnected row. An owner who disconnects mid-sync, or types a new app
 * password while an old one is failing, wins: their row stands and only our
 * lock is let go.
 */
async function closeAccount(
  admin: SupabaseClient,
  companyId: string,
  accountId: string,
  seenUpdatedAt: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await admin
    .from("mail_accounts")
    .update(patch)
    .eq("id", accountId)
    .eq("company_id", companyId)
    .eq("updated_at", seenUpdatedAt)
    .neq("status", "disconnected")
    .select("id");
  if (!error && Array.isArray(data) && data.length === 1) return true;
  await releaseLock(admin, companyId, accountId, patch.sync_lock_until as string);
  return false;
}

async function releaseLock(admin: SupabaseClient, companyId: string, accountId: string, until: string): Promise<void> {
  const { error } = await admin.from("mail_accounts").update({ sync_lock_until: until }).eq("id", accountId).eq("company_id", companyId);
  // The lock expires on its own; a failed release costs one skipped sync.
  if (error) console.error("mail-sync: could not release a sync lock");
}

// ---------------------------------------------------------------------------
// One mailbox.
// ---------------------------------------------------------------------------

export type AccountOutcome =
  | { kind: "synced"; status: string; newInbox: number; newSent: number; unfinished: boolean }
  | { kind: "busy" }
  | { kind: "skipped"; status: string; reason: string }
  | { kind: "failed"; status: string | null; code: MailErrorCode; newInbox: number; newSent: number };

export interface AccountJob {
  admin: SupabaseClient;
  companyId: string;
  accountId: string;
  own: OwnMailboxes;
  deps: SyncDeps;
  /** Epoch ms by which this mailbox's mail session must have ended. */
  sessionEnd: number;
}

interface FolderContext {
  admin: SupabaseClient;
  companyId: string;
  accountId: string;
  own: OwnMailboxes;
  deps: SyncDeps;
  client: ImapClient;
  states: Map<string, FolderStateRow>;
  /** New messages stored so far, per folder. Counted batch by batch, so a
   *  session cut halfway still reports what it stored. */
  stored: { inbox: number; sent: number };
}

/**
 * One folder: each batch of header blocks is stored, then (only then) the
 * folder's state moves past it. After a UIDVALIDITY reset, or a Sent folder
 * found at a new path, the old numbering's rows are hidden before the new
 * UIDVALIDITY is first saved: once it is saved, no later run knows there was
 * a reset to clean up after.
 */
async function syncOneFolder(ctx: FolderContext, role: "inbox" | "sent", path: string): Promise<void> {
  const { state, pathChanged } = folderStartState(ctx.states.get(role), path);
  if (state.uidValidity !== null) {
    state.knownUids = await knownUids(ctx.admin, ctx.companyId, ctx.accountId, role, state.uidValidity);
  }
  const now = ctx.deps.now();
  let staleHidden = false;
  const advance = async (at: FolderPosition & { reset: boolean }) => {
    if (!staleHidden && (at.reset || pathChanged)) {
      await hideStaleUids(ctx.admin, ctx.companyId, ctx.accountId, role, at.uidValidity);
      staleHidden = true;
    }
    await saveFolderState(ctx.admin, ctx.accountId, role, at, ctx.deps.now());
  };
  const result = await syncFolder(ctx.client, state, new Date(now), HEADERS_PER_FOLDER_PER_RUN, {
    onBatch: async (batch) => {
      const rows = await rowsFor(batch, role, ctx.own, new Date(now));
      if (rows.length) ctx.stored[role] += await ingest(ctx.admin, ctx.accountId, rows);
      await advance(batch);
    },
  });
  if (result.flags.length) await setFlags(ctx.admin, ctx.accountId, role, result.uidValidity, flagPayload(result.flags, role));
  if (result.goneUids.length) await markGone(ctx.admin, ctx.accountId, role, result.uidValidity, result.goneUids);
  // Also the only save for a run that fetched nothing (a first run over an
  // empty window still has to record the folder's top UID).
  await advance(result);
}

/** Records a Sent folder found by LIST. Answers the row's new updated_at, or
 *  null when it could not be recorded (the folder is still synced this run,
 *  and found again next run). */
async function saveSentFolder(
  admin: SupabaseClient,
  companyId: string,
  accountId: string,
  seenUpdatedAt: string,
  path: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("mail_accounts")
    .update({ sent_folder: path })
    .eq("id", accountId)
    .eq("company_id", companyId)
    .eq("updated_at", seenUpdatedAt)
    .neq("status", "disconnected")
    .select("updated_at");
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  return typeof data[0]?.updated_at === "string" ? data[0].updated_at : null;
}

async function discoverSent(client: ImapClient): Promise<string | null> {
  return usablePath(findSentFolder(await client.list())?.path ?? null);
}

/**
 * Syncs one mailbox, start to finish, and records the outcome on its row.
 * Never throws: every failure becomes an outcome, and a failure that is the
 * mailbox's (refused password, unreachable server) becomes its status.
 */
export async function syncAccount(job: AccountJob): Promise<AccountOutcome> {
  const { admin, companyId, accountId, deps } = job;
  const claimedAt = deps.now();
  const budgetMs = Math.min(SESSION_DEADLINE_MS, job.sessionEnd - claimedAt);
  if (budgetMs < MIN_SESSION_MS) return { kind: "skipped", status: "", reason: "no_time" };

  const { data: claimed, error: claimError } = await admin.rpc("mail_claim_sync", {
    p_account: accountId,
    p_seconds: Math.ceil(budgetMs / 1000) + LOCK_MARGIN_SECONDS,
  });
  if (claimError) return { kind: "failed", status: null, code: "server_error", newInbox: 0, newSent: 0 };
  // Exactly true. Anything else (false, null) is someone else's sync, the
  // rate limit, or a row that stopped being syncable.
  if (claimed !== true) return { kind: "busy" };
  const releaseAt = iso(claimedAt + MANUAL_SYNC_LOCK_SECONDS * 1000);

  // Read AFTER the claim: the claim itself touched updated_at, and the row
  // may have changed since the list it came from.
  const { data: fresh, error: readError } = await admin
    .from("mail_accounts")
    .select(ACCOUNT_COLUMNS)
    .eq("id", accountId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (readError || !fresh) {
    await releaseLock(admin, companyId, accountId, releaseAt);
    return readError
      ? { kind: "failed", status: null, code: "server_error", newInbox: 0, newSent: 0 }
      : { kind: "skipped", status: "", reason: "gone" };
  }
  const row = fresh as StoredAccount;
  if (row.kind !== "imap" || row.status === "disconnected" || row.status === "auth_failed") {
    await releaseLock(admin, companyId, accountId, releaseAt);
    return { kind: "skipped", status: row.status, reason: row.status === "auth_failed" ? "needs_new_password" : "not_syncable" };
  }

  let seenUpdatedAt = row.updated_at;
  let password: string | null = null;
  let client: ImapClient | null = null;
  let transport: MailTransport | null = null;
  let loggedIn = false;
  // Set when the session is shorter than SESSION_DEADLINE_MS because of OUR
  // budget: the epoch ms at which the transport will cut it.
  let budgetCutAt: number | null = null;
  const stored = { inbox: 0, sent: 0 };
  try {
    const host = await imapHostFor(row, deps.resolver);
    const { data: secret, error: secretError } = await admin.rpc("mail_secret_get", { p_account: accountId });
    if (secretError) throw new MailError("server_error", "Could not read the stored app password.");
    if (typeof secret !== "string" || secret === "") {
      // Nothing to log in with. Retrying cannot help, so this is a
      // credentials problem for scheduling purposes: enter a new password.
      throw new MailError("auth_failed", "No app password is stored for this mailbox. Enter a new app password.");
    }
    password = secret;
    const states = await loadFolderStates(admin, accountId);

    // Measured here, not at the claim: the transport's clock starts now.
    const connectAt = deps.now();
    const sessionMs = Math.min(SESSION_DEADLINE_MS, job.sessionEnd - connectAt);
    if (sessionMs < MIN_SESSION_MS) {
      budgetCutAt = connectAt;
      throw new MailError("session_limit", "No time left for this mailbox in this run.");
    }
    if (sessionMs < SESSION_DEADLINE_MS) budgetCutAt = connectAt + sessionMs;
    transport = await deps.connect({ hostname: host, port: IMAP_PORT, limits: { sessionDeadlineMs: sessionMs } });
    client = new ImapClient(transport);
    await openSession(client, { username: String(row.username ?? ""), password });
    loggedIn = true;
    const ctx: FolderContext = { admin, companyId, accountId, own: job.own, deps, client, states, stored };

    let sentPath = usablePath(row.sent_folder);
    if (!sentPath) {
      sentPath = await discoverSent(client);
      if (sentPath) seenUpdatedAt = (await saveSentFolder(admin, companyId, accountId, seenUpdatedAt, sentPath)) ?? seenUpdatedAt;
    }

    await syncOneFolder(ctx, "inbox", "INBOX");

    if (sentPath && sentPath.toUpperCase() !== "INBOX") {
      try {
        await syncOneFolder(ctx, "sent", sentPath);
      } catch (e) {
        if (!(e instanceof MailError) || e.code !== "folder_missing") throw e;
        // Renamed or removed since it was found. Look once more; a mailbox
        // with no Sent folder at all still syncs its INBOX.
        const again = await discoverSent(client);
        if (again && again !== sentPath && again.toUpperCase() !== "INBOX") {
          seenUpdatedAt = (await saveSentFolder(admin, companyId, accountId, seenUpdatedAt, again)) ?? seenUpdatedAt;
          await syncOneFolder(ctx, "sent", again);
        }
      }
    }

    await client.logout();
    await closeAccount(admin, companyId, accountId, seenUpdatedAt, {
      status: "connected",
      last_error_code: null,
      last_error: null,
      last_error_at: null,
      last_synced_at: iso(deps.now()),
      sync_lock_until: releaseAt,
    });
    return { kind: "synced", status: "connected", newInbox: stored.inbox, newSent: stored.sent, unfinished: false };
  } catch (e) {
    let err = asMailError(e);
    if (row.provider === "custom") err = forCustomHost(err, "imap");

    // Cut by OUR budget (the office's 60 s, the schedule's answer deadline),
    // not by a slow server. Finished folders are already saved and the rest
    // continues next run. If the login had succeeded the mailbox is fine and
    // says so; if not, nothing was proved either way and its status stands.
    const cutByBudget = err.code === "session_limit" && budgetCutAt !== null && deps.now() >= budgetCutAt - 2_000;
    if (cutByBudget) {
      if (!loggedIn) {
        await releaseLock(admin, companyId, accountId, releaseAt);
        return { kind: "synced", status: row.status, newInbox: stored.inbox, newSent: stored.sent, unfinished: true };
      }
      await closeAccount(admin, companyId, accountId, seenUpdatedAt, {
        status: "connected",
        last_error_code: null,
        last_error: null,
        last_error_at: null,
        sync_lock_until: releaseAt,
      });
      return { kind: "synced", status: "connected", newInbox: stored.inbox, newSent: stored.sent, unfinished: true };
    }

    const status = accountStatusFor(err.code);
    if (OUR_SIDE.has(err.code)) console.error(`mail-sync: ${accountId} ${err.code}`);
    await closeAccount(admin, companyId, accountId, seenUpdatedAt, {
      status,
      last_error_code: err.code,
      // Redacted again: whatever the creation site did, the stored text
      // never carries the password.
      last_error: redact(err.detail || MESSAGES[err.code], [password]) || MESSAGES[err.code],
      last_error_at: iso(deps.now()),
      sync_lock_until: releaseAt,
    });
    return { kind: "failed", status, code: err.code, newInbox: stored.inbox, newSent: stored.sent };
  } finally {
    password = null;
    if (client) client.close();
    else if (transport) transport.close();
  }
}

// ---------------------------------------------------------------------------
// The office door.
// ---------------------------------------------------------------------------

export interface OfficeAccountResult {
  id: string;
  status: string;
  /** New messages stored in INBOX by this run. */
  new: number;
  busy?: true;
  unfinished?: true;
  skipped?: string;
  error_code?: MailErrorCode;
  message?: string;
}

function officeView(id: string, listedStatus: string, o: AccountOutcome): OfficeAccountResult {
  switch (o.kind) {
    case "synced":
      return { id, status: o.status, new: o.newInbox, ...(o.unfinished ? { unfinished: true as const } : {}) };
    case "busy":
      // Someone else's sync is running, or one finished under a minute ago.
      return { id, status: listedStatus, new: 0, busy: true };
    case "skipped":
      return { id, status: o.status || listedStatus, new: 0, skipped: o.reason };
    case "failed":
      return { id, status: o.status ?? listedStatus, new: o.newInbox, error_code: o.code, message: MESSAGES[o.code] };
  }
}

async function officeDoor(req: Request, deps: SyncDeps, startedAt: number): Promise<Response> {
  const caller = await mailCaller(req);
  const body = await readJsonBody(req);
  if (body.action !== undefined && body.action !== "sync") throw new MailError("bad_request", "Unknown action.");

  // Through the caller's own client: RLS (company AND the mail gate) decides
  // which mailboxes exist for them.
  const { data, error } = await caller.userClient
    .from("mail_accounts")
    .select("id, status")
    .eq("company_id", caller.companyId)
    .eq("kind", "imap")
    .in("status", ["connected", "error", "auth_failed"]);
  if (error) throw new MailError("server_error");
  const listed = (data ?? []) as Array<{ id: string; status: string }>;
  if (listed.length === 0) return json({ accounts: [] });

  const own = await ownMailboxes(caller.admin, caller.companyId, deps);
  const sessionEnd = startedAt + OFFICE_SYNC_BUDGET_MS;
  const accounts = await Promise.all(listed.map(async (a): Promise<OfficeAccountResult> => {
    // Never retried from here either: a new password goes through mail-connect.
    if (a.status === "auth_failed") return { id: a.id, status: "auth_failed", new: 0, skipped: "needs_new_password" };
    const outcome = await syncAccount({ admin: caller.admin, companyId: caller.companyId, accountId: a.id, own, deps, sessionEnd });
    return officeView(a.id, a.status, outcome);
  }));
  return json({ accounts });
}

// ---------------------------------------------------------------------------
// The scheduled door.
// ---------------------------------------------------------------------------

interface DueAccount {
  id: string;
  company_id: string;
  lastAttempt: number;
}

/**
 * Mailboxes the schedule should sync now, oldest attempt first: `connected`
 * ones not synced in the last TRIGGER_MIN_INTERVAL_MINUTES, and `error` ones
 * whose last failure is older than ERROR_BACKOFF_MINUTES. `auth_failed` and
 * `disconnected` are never read at all. Two queries, because a failed attempt
 * leaves last_synced_at old: ordering both kinds by it would put every
 * backed-off error first and could starve healthy mailboxes.
 */
export async function dueAccounts(admin: SupabaseClient, nowMs: number): Promise<DueAccount[]> {
  const cols = "id, company_id, status, last_synced_at, last_error_at, sync_lock_until";
  const [connected, errored] = await Promise.all([
    admin.from("mail_accounts").select(cols).eq("kind", "imap").eq("status", "connected")
      .order("last_synced_at", { ascending: true, nullsFirst: true }).limit(DUE_SCAN_LIMIT),
    admin.from("mail_accounts").select(cols).eq("kind", "imap").eq("status", "error")
      .order("last_error_at", { ascending: true, nullsFirst: true }).limit(DUE_SCAN_LIMIT),
  ]);
  if (connected.error || errored.error) throw new MailError("server_error", "Could not list mailboxes.");
  type Row = { id: string; company_id: string; status: string; last_synced_at: unknown; last_error_at: unknown; sync_lock_until: unknown };
  const syncedBefore = nowMs - TRIGGER_MIN_INTERVAL_MINUTES * 60_000;
  const failedBefore = nowMs - ERROR_BACKOFF_MINUTES * 60_000;
  const rows = [
    ...((connected.data ?? []) as Row[]).filter((r) => r.status === "connected" && (ts(r.last_synced_at) ?? 0) < syncedBefore),
    ...((errored.data ?? []) as Row[]).filter((r) => r.status === "error" && (ts(r.last_error_at) ?? 0) < failedBefore),
  ];
  return rows
    .filter((r) => (ts(r.sync_lock_until) ?? 0) <= nowMs)
    .map((r) => ({
      id: String(r.id),
      company_id: String(r.company_id),
      lastAttempt: Math.max(ts(r.last_synced_at) ?? 0, ts(r.last_error_at) ?? 0),
    }))
    .sort((a, b) => a.lastAttempt - b.lastAttempt);
}

/** What the scheduled door answers. Counts and fixed codes only. `ok` must
 *  stay the FIRST key (here and in reach()): the workflow reads the verdict
 *  from the first bytes of the body, because a reach answer also carries an
 *  "ok" inside every target. */
export interface TriggerSummary {
  ok: boolean;
  action: "sync";
  due: number;
  started: number;
  synced: number;
  unfinished: number;
  new_messages: number;
  busy: number;
  skipped: number;
  company_not_allowed: number;
  failed: number;
  failure_codes: Record<string, number>;
  deferred: number;
  stopped_early?: string;
}

async function triggerDoor(admin: SupabaseClient, body: Record<string, unknown>, deps: SyncDeps, startedAt: number): Promise<Response> {
  if (body.action === "reach") return json(await reach(deps));
  if (body.action !== undefined && body.action !== "sync") throw new MailError("bad_request", "Unknown action.");

  const due = await dueAccounts(admin, deps.now());
  const out: TriggerSummary = {
    ok: true,
    action: "sync",
    due: due.length,
    started: 0,
    synced: 0,
    unfinished: 0,
    new_messages: 0,
    busy: 0,
    skipped: 0,
    company_not_allowed: 0,
    failed: 0,
    failure_codes: {},
    deferred: 0,
  };
  const fail = (code: MailErrorCode) => {
    out.failed++;
    out.failure_codes[code] = (out.failure_codes[code] ?? 0) + 1;
    if (OUR_SIDE.has(code)) out.ok = false;
  };
  const allowedCache = new Map<string, boolean | null>();
  const ownCache = new Map<string, OwnMailboxes>();
  const responseBy = startedAt + TRIGGER_RESPONSE_BUDGET_MS;

  for (let i = 0; i < due.length; i++) {
    const a = due[i];
    const now = deps.now();
    if (out.started >= TRIGGER_SYNC_MAX_ACCOUNTS) {
      out.deferred = due.length - i;
      break;
    }
    if (now - startedAt >= TRIGGER_START_BUDGET_MS || responseBy - now < MIN_SESSION_MS) {
      out.deferred = due.length - i;
      out.stopped_early = `Stopped starting mailboxes after ${Math.round((now - startedAt) / 1000)} s to answer inside Supabase's time limit; the rest are synced first next run.`;
      break;
    }

    // A suspended or lapsed company gets no work done on its behalf.
    if (!allowedCache.has(a.company_id)) {
      const { data, error } = await admin.rpc("company_allowed", { cid: a.company_id });
      allowedCache.set(a.company_id, error ? null : data === true);
    }
    const allowed = allowedCache.get(a.company_id);
    if (allowed === null) {
      fail("server_error");
      continue;
    }
    if (!allowed) {
      out.company_not_allowed++;
      continue;
    }

    let own = ownCache.get(a.company_id);
    if (!own) {
      try {
        own = await ownMailboxes(admin, a.company_id, deps);
      } catch {
        fail("server_error");
        continue;
      }
      ownCache.set(a.company_id, own);
    }

    out.started++;
    const o = await syncAccount({ admin, companyId: a.company_id, accountId: a.id, own, deps, sessionEnd: responseBy });
    if (o.kind === "synced") {
      out.synced++;
      out.new_messages += o.newInbox;
      if (o.unfinished) out.unfinished++;
    } else if (o.kind === "busy") out.busy++;
    else if (o.kind === "skipped") out.skipped++;
    else fail(o.code);
  }
  return json(out);
}

// ---------------------------------------------------------------------------
// {action:'reach'}: can this runtime reach the preset mail servers at all?
//
// The Track 0 probe, kept as a regression check the workflow runs daily.
// Preset hosts only (derived from hosts.ts, so it checks exactly what the
// office offers), no credentials, nothing from the request: greeting, then
// CAPABILITY or EHLO, then LOGOUT or QUIT. Negative controls prove a failure
// is reported as a failure -- a probe whose every target "passes" proves
// nothing unless something that must fail, fails, for a network reason.
// ---------------------------------------------------------------------------

const REACH_OP_TIMEOUT_MS = 10_000;
const REACH_SESSION_MS = 30_000;
const REACH_TCP_TIMEOUT_MS = 5_000;
/** Failures that come from the network, which is what a negative control
 *  must produce. A missing socket API "fails" too, and proves nothing. */
const NETWORK_FAILURES: ReadonlySet<MailErrorCode> = new Set<MailErrorCode>(["connect_failed", "timeout", "tls_failed", "dns_failed"]);

interface ReachTarget {
  host: string;
  port: number;
  protocol: "imap" | "smtp";
}

export function reachTargets(): ReachTarget[] {
  const out: ReachTarget[] = [];
  for (const region of Object.keys(ZOHO_REGIONS)) {
    // An organisation domain picks imappro/smtppro, a Zoho address imap/smtp.
    for (const sample of ["reach@example.com", "reach@zohomail.com"]) {
      const p = resolvePreset("zoho", sample, region);
      out.push({ host: p.imapHost, port: p.imapPort, protocol: "imap" }, { host: p.smtpHost, port: p.smtpPort, protocol: "smtp" });
    }
  }
  const g = resolvePreset("gmail", "reach@gmail.com");
  out.push({ host: g.imapHost, port: g.imapPort, protocol: "imap" }, { host: g.smtpHost, port: g.smtpPort, protocol: "smtp" });
  return out;
}

/** Fixed. Must fail, each for a network reason. */
export const REACH_NEGATIVE_CONTROLS: ReadonlyArray<{ host: string; port: number; via: "tls" | "tcp"; why: string }> = [
  { host: "reach-probe.invalid", port: IMAP_PORT, via: "tls", why: "a name that can never resolve (RFC 6761), through the same path as the targets" },
  { host: "smtp.zoho.com", port: 587, via: "tcp", why: "port 587, which Supabase blocks outbound" },
  { host: "imap.gmail.com", port: 9, via: "tcp", why: "a closed port" },
];

function safeTokens(list: Iterable<string>): string[] {
  return [...list].map(String).filter((s) => /^[A-Za-z0-9=+._ -]{1,60}$/.test(s)).slice(0, 40);
}

interface ReachResult {
  host: string;
  port: number;
  protocol: "imap" | "smtp";
  ok: boolean;
  ms: number;
  error_code?: MailErrorCode;
  capabilities?: string[];
}

async function probeTarget(t: ReachTarget, deps: SyncDeps): Promise<ReachResult> {
  const started = deps.now();
  let transport: MailTransport | null = null;
  try {
    transport = await deps.connect({
      hostname: t.host,
      port: t.port,
      limits: { opTimeoutMs: REACH_OP_TIMEOUT_MS, sessionDeadlineMs: REACH_SESSION_MS },
    });
    let caps: string[];
    if (t.protocol === "imap") {
      const c = new ImapClient(transport);
      await c.greeting();
      if (c.capabilities.size === 0) await c.capability();
      caps = [...c.capabilities];
      await c.logout();
    } else {
      const s = new SmtpClient(transport);
      await s.greeting();
      await s.ehlo();
      caps = [...s.extensions.entries()].map(([k, v]) => (k === "AUTH" && v ? `AUTH ${v.toUpperCase()}` : k));
      await s.quit();
    }
    return { ...t, ok: true, ms: deps.now() - started, capabilities: safeTokens(caps) };
  } catch (e) {
    return { ...t, ok: false, ms: deps.now() - started, error_code: e instanceof MailError ? e.code : classifyNetworkError(e).code };
  } finally {
    transport?.close();
  }
}

export async function reach(deps: SyncDeps) {
  const D = denoGlobal();
  const targets = await Promise.all(reachTargets().map((t) => probeTarget(t, deps)));
  const negative_controls = await Promise.all(REACH_NEGATIVE_CONTROLS.map(async (n) => {
    const started = deps.now();
    let code: MailErrorCode | null = null;
    try {
      if (n.via === "tls") {
        const r = await probeTarget({ host: n.host, port: n.port, protocol: "imap" }, deps);
        code = r.ok ? null : r.error_code ?? "connect_failed";
      } else {
        await deps.tcpProbe(n.host, n.port, REACH_TCP_TIMEOUT_MS);
      }
    } catch (e) {
      code = e instanceof MailError ? e.code : classifyNetworkError(e).code;
    }
    const failedAsExpected = code !== null && NETWORK_FAILURES.has(code);
    return { host: n.host, port: n.port, via: n.via, why: n.why, failed_as_expected: failedAsExpected, error_code: code, ms: deps.now() - started };
  }));
  return {
    ok: targets.every((t) => t.ok) && negative_controls.every((n) => n.failed_as_expected),
    action: "reach" as const,
    runtime: {
      connect_tls: typeof D?.connectTls === "function",
      start_tls: typeof D?.startTls === "function",
      resolve_dns: typeof D?.resolveDns === "function",
    },
    targets,
    negative_controls,
  };
}

// ---------------------------------------------------------------------------
// The handler.
// ---------------------------------------------------------------------------

export async function handleRequest(req: Request, deps: SyncDeps = productionDeps()): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const startedAt = deps.now();
  try {
    if (req.method !== "POST") throw new MailError("bad_request", "Use POST.");
    if (req.headers.has("x-fenceflow-trigger")) {
      // The secret is checked before the body is read or any client exists.
      const { admin } = await triggerCaller(req, "MAIL_SYNC_TRIGGER_SECRET");
      return await triggerDoor(admin, await readJsonBody(req), deps, startedAt);
    }
    return await officeDoor(req, deps, startedAt);
  } catch (e) {
    return errorResponse("mail-sync", e);
  }
}

// Deno serves; under Node (tests/mail-sync.test.mjs) there is no Deno.serve
// and the handler is called directly.
if (typeof denoGlobal()?.serve === "function") denoGlobal().serve((req: Request) => handleRequest(req));
