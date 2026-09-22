/**
 * An IMAP client that knows exactly the commands company email uses, and
 * no others.
 *
 * It is handed a transport (tls-transport.ts in production, a scripted fake
 * server in tests/mail-imap-client.test.mjs) and never opens a socket, reads
 * the environment or logs anything itself. What it deliberately cannot do:
 *
 *  - delete, expunge or move mail. uidStore() refuses \Deleted, and there is
 *    no EXPUNGE, MOVE, COPY or DELETE method at all. FenceFlow v1 reads a
 *    tenant's mailbox and adds to Sent; it never removes anything.
 *  - send a raw command. Every argument is built here from typed values, so
 *    nothing from a request or a stored row can smuggle a CRLF into the
 *    command stream.
 *  - remember a password in its transcript. transcript() is for debugging a
 *    failed connect; LOGIN and AUTHENTICATE lines are recorded as
 *    "[credentials hidden]" and every server line passes through
 *    errors.redact() with the password before it is kept.
 *
 * Below the class are the three sequences the edge functions run --
 * verifyMailbox() for mail-connect, syncFolder() for mail-sync,
 * fetchMessage() for mail-message -- so the tests call them with the same
 * arguments production does rather than re-creating them.
 */

import { classifyLoginFailure, MailError, redact } from "./errors.ts";
import {
  FIRST_SYNC_DAYS,
  HEADER_BLOCK_MAX_BYTES,
  HEADER_FETCH_BATCH,
  HEADERS_PER_FOLDER_PER_RUN,
  OPEN_MESSAGE_MAX_BYTES,
  SECRET_MAX_CHARS,
} from "./limits.ts";
import {
  compressUidSet,
  encodeAstring,
  filterNewUids,
  findSentFolder,
  HEADER_FIELDS,
  imapDate,
  newestUids,
  oldestUids,
  parseCapabilities,
  parseFetch,
  parseListEntry,
  parseResponse,
  parseSearch,
  parseSelect,
  quoteString,
  readRawResponse,
} from "./imap-proto.ts";
import type { FetchedMessage, ImapLiteral, ImapResponse, ListEntry, RawResponse, SelectInfo } from "./imap-proto.ts";
import type { MailTransport } from "./tls-transport.ts";

type Arg = string | ImapLiteral;

interface CommandResult {
  tagged: ImapResponse;
  untagged: ImapResponse[];
}

interface CommandOptions {
  /** Record the command as "[credentials hidden]" and never its arguments. */
  sensitive?: boolean;
  /** Called for each "+" continuation after the command line is sent. */
  onContinuation?: (r: ImapResponse) => Promise<void>;
  /** LOGOUT: an untagged BYE is the expected answer, not an error. */
  expectBye?: boolean;
}

const HIDDEN = "[credentials hidden]";
const TRANSCRIPT_MAX_LINES = 400;
/** The only flags FenceFlow ever sets or clears. */
const STORABLE_FLAGS = new Map([
  ["\\seen", "\\Seen"],
  ["\\answered", "\\Answered"],
  ["\\flagged", "\\Flagged"],
]);
const MAX_UID = 4294967295;

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function mergeFetches(list: FetchedMessage[]): FetchedMessage[] {
  // A server may answer one message twice (the data asked for, plus an
  // unsolicited flag update). Keep whatever each response supplied.
  const byUid = new Map<number, FetchedMessage>();
  for (const m of list) {
    if (m.uid === null) continue;
    const prev = byUid.get(m.uid);
    byUid.set(
      m.uid,
      prev
        ? {
          seq: m.seq,
          uid: m.uid,
          flags: m.flags ?? prev.flags,
          internalDate: m.internalDate ?? prev.internalDate,
          size: m.size ?? prev.size,
          headers: m.headers ?? prev.headers,
          source: m.source ?? prev.source,
        }
        : m,
    );
  }
  return [...byUid.values()].sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
}

export class ImapClient {
  #t: MailTransport;
  #tagN = 0;
  #caps = new Set<string>();
  #secrets: string[] = [];
  #log: string[] = [];
  #loggedOut = false;

  constructor(transport: MailTransport) {
    this.#t = transport;
  }

  get capabilities(): ReadonlySet<string> {
    return this.#caps;
  }

  /** The session so far, credentials removed. Safe to keep in a debug note;
   *  still not something to log by default. */
  transcript(): string[] {
    return [...this.#log];
  }

  close(): void {
    this.#t.close();
  }

  #record(dir: "C:" | "S:", text: string): void {
    this.#log.push(`${dir} ${redact(text, this.#secrets)}`);
    if (this.#log.length > TRANSCRIPT_MAX_LINES) this.#log.shift();
  }

  async #readResponse(): Promise<ImapResponse> {
    const raw: RawResponse = await readRawResponse(this.#t);
    this.#record("S:", raw.map((p) => (typeof p === "string" ? p : `[${p.length} bytes]`)).join(" "));
    return parseResponse(raw);
  }

  async #send(text: string, record: string | null): Promise<void> {
    await this.#t.write(`${text}\r\n`);
    if (record !== null) this.#record("C:", record);
  }

  #fail(r: ImapResponse, code: "protocol_error" | "server_busy" | "folder_missing" = "protocol_error"): MailError {
    return new MailError(code, redact(`${r.type} ${r.code ? `[${r.code}] ` : ""}${r.text}`, this.#secrets));
  }

  async #command(parts: Arg[], opts: CommandOptions = {}): Promise<CommandResult> {
    if (this.#loggedOut) throw new MailError("protocol_error", "Session already closed.");
    const tag = `A${++this.#tagN}`;
    const untagged: ImapResponse[] = [];
    const label = opts.sensitive ? `${tag} ${String(parts[0])} ${HIDDEN}` : null;
    let recordedLabel = false;
    const recordAs = (line: string) => {
      if (label === null) return line;
      if (recordedLabel) return null;
      recordedLabel = true;
      return label;
    };

    const absorb = (r: ImapResponse) => {
      if (r.type === "CAPABILITY") this.#caps = parseCapabilities(r);
      if (r.type === "BYE" && !opts.expectBye) {
        this.#t.close();
        throw this.#fail(r, "server_busy");
      }
      untagged.push(r);
    };

    let line = tag;
    for (const part of parts) {
      if (typeof part === "string") {
        line += ` ${part}`;
        continue;
      }
      const n = part.literal.length;
      // LITERAL+ lets us send without waiting; LITERAL- only up to 4096 bytes.
      const nonSync = this.#caps.has("LITERAL+") || (this.#caps.has("LITERAL-") && n <= 4096);
      line += ` {${n}${nonSync ? "+" : ""}}`;
      await this.#send(line, recordAs(line));
      if (!nonSync) {
        for (;;) {
          const r = await this.#readResponse();
          if (r.kind === "continuation") break;
          if (r.kind === "tagged") {
            if (r.tag !== tag) throw this.#fail(r);
            return { tagged: r, untagged }; // refused before the literal was sent
          }
          absorb(r);
        }
      }
      await this.#t.write(part.literal);
      this.#record("C:", opts.sensitive ? HIDDEN : `[${n} bytes]`);
      line = "";
    }
    await this.#send(line, line === "" ? null : recordAs(line));

    for (;;) {
      const r = await this.#readResponse();
      if (r.kind === "continuation") {
        if (!opts.onContinuation) throw new MailError("protocol_error", "Unexpected continuation.");
        await opts.onContinuation(r);
        continue;
      }
      if (r.kind === "tagged") {
        if (r.tag !== tag) throw this.#fail(r);
        return { tagged: r, untagged };
      }
      absorb(r);
    }
  }

  #expectOk(res: CommandResult): void {
    if (res.tagged.type !== "OK") throw this.#fail(res.tagged);
  }

  /** The server's first line. BYE (too many connections, maintenance) is
   *  server_busy; PREAUTH is refused by openSession(). */
  async greeting(): Promise<{ preauth: boolean; text: string }> {
    const r = await this.#readResponse();
    if (r.kind !== "untagged") throw new MailError("protocol_error", "No greeting.");
    if (r.type === "BYE") {
      this.#t.close();
      throw this.#fail(r, "server_busy");
    }
    if (r.type !== "OK" && r.type !== "PREAUTH") throw this.#fail(r);
    if (r.code === "CAPABILITY") this.#caps = parseCapabilities(r);
    return { preauth: r.type === "PREAUTH", text: redact(r.text) };
  }

  async capability(): Promise<ReadonlySet<string>> {
    const res = await this.#command(["CAPABILITY"]);
    this.#expectOk(res);
    return this.#caps;
  }

  /**
   * LOGIN with the user name and password as quoted strings, or as literals
   * when they are not plain 7-bit text. AUTHENTICATE PLAIN only when the
   * server has switched LOGIN off. A refusal is classified by
   * errors.classifyLoginFailure(), which defaults to auth_failed so the
   * schedule stops trying.
   */
  async login(username: string, password: string): Promise<void> {
    if (typeof username !== "string" || !username || username.length > 320) {
      throw new MailError("bad_request", "Enter the mailbox user name.");
    }
    if (typeof password !== "string" || !password || password.length > SECRET_MAX_CHARS) {
      throw new MailError("bad_request", "Enter the app password.");
    }
    if (/[\0\r\n]/.test(username) || /[\0\r\n]/.test(password)) {
      throw new MailError("bad_request", "The user name or app password contains a line break.");
    }
    const plainBlob = base64Utf8(`\0${username}\0${password}`);
    // Known before anything is sent, so even an echo in the very first reply
    // is redacted from the transcript and from any error.
    this.#secrets = [password, plainBlob];

    let res: CommandResult;
    if (this.#caps.has("LOGINDISABLED")) {
      if (!this.#caps.has("AUTH=PLAIN")) {
        throw new MailError("protocol_error", "The server offers no sign-in method FenceFlow supports.");
      }
      if (this.#caps.has("SASL-IR")) {
        res = await this.#command(["AUTHENTICATE", "PLAIN", plainBlob], { sensitive: true });
      } else {
        let answered = false;
        res = await this.#command(["AUTHENTICATE", "PLAIN"], {
          sensitive: true,
          onContinuation: async () => {
            // A second challenge means the first answer was not accepted;
            // "*" cancels rather than sending the password again.
            await this.#t.write(answered ? "*\r\n" : `${plainBlob}\r\n`);
            this.#record("C:", answered ? "*" : HIDDEN);
            answered = true;
          },
        });
      }
    } else {
      res = await this.#command(["LOGIN", encodeAstring(username), encodeAstring(password)], { sensitive: true });
    }
    if (res.tagged.type !== "OK") {
      throw classifyLoginFailure({ status: res.tagged.type, code: res.tagged.code, text: res.tagged.text }, this.#secrets);
    }
    if (res.tagged.code === "CAPABILITY") this.#caps = parseCapabilities(res.tagged);
  }

  async list(): Promise<ListEntry[]> {
    const res = await this.#command(["LIST", '""', '"*"']);
    this.#expectOk(res);
    return res.untagged.map(parseListEntry).filter((e): e is ListEntry => e !== null);
  }

  async #open(verb: "SELECT" | "EXAMINE", path: string): Promise<SelectInfo> {
    const res = await this.#command([verb, encodeAstring(path)]);
    if (res.tagged.type === "NO") throw this.#fail(res.tagged, "folder_missing");
    this.#expectOk(res);
    return parseSelect(res.untagged, res.tagged);
  }

  /** Read-only: nothing FenceFlow does after this can change the folder. */
  examine(path: string): Promise<SelectInfo> {
    return this.#open("EXAMINE", path);
  }

  /** Read-write, for the one change FenceFlow makes: setting flags. */
  select(path: string): Promise<SelectInfo> {
    return this.#open("SELECT", path);
  }

  async #uidSearch(criteria: string[]): Promise<number[]> {
    const res = await this.#command(["UID", "SEARCH", ...criteria]);
    this.#expectOk(res);
    return parseSearch(res.untagged);
  }

  uidSearchSince(since: Date): Promise<number[]> {
    return this.#uidSearch(["SINCE", imapDate(since)]);
  }

  /** UIDs above lastUid. Still needs filterNewUids(): see the "*" trap. */
  async uidSearchAbove(lastUid: number): Promise<number[]> {
    if (!Number.isInteger(lastUid) || lastUid < 0 || lastUid >= MAX_UID) return [];
    return this.#uidSearch(["UID", `${lastUid + 1}:*`]);
  }

  /** Within the window and below a UID: the backfill of a first sync. */
  async uidSearchSinceBelow(since: Date, belowUid: number): Promise<number[]> {
    if (!Number.isInteger(belowUid) || belowUid <= 1) return [];
    const uids = await this.#uidSearch(["SINCE", imapDate(since), "UID", `1:${belowUid - 1}`]);
    return uids.filter((u) => u < belowUid);
  }

  /** The highest UID in the folder, for servers that send no UIDNEXT. */
  async highestUid(): Promise<number | null> {
    const uids = await this.#uidSearch(["UID", "*"]);
    return uids.length ? Math.max(...uids) : null;
  }

  /** Finds our own sent message in Sent by the Message-ID we gave it. */
  async uidSearchMessageId(messageId: string): Promise<number[]> {
    if (typeof messageId !== "string" || !messageId || messageId.length > 998) {
      throw new MailError("bad_request", "Invalid Message-ID.");
    }
    return this.#uidSearch(["HEADER", "Message-ID", quoteString(messageId)]);
  }

  /** Header blocks, flags, date and size, without touching \Seen. Each block
   *  is at most HEADER_BLOCK_MAX_BYTES (a partial fetch): the header fields
   *  are written by whoever sent the mail, and their size is theirs to pick. */
  async uidFetchHeaders(uids: ReadonlyArray<number>): Promise<FetchedMessage[]> {
    if (uids.length === 0) return [];
    const items = `(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS.join(" ")})]<0.${HEADER_BLOCK_MAX_BYTES}>)`;
    const res = await this.#command(["UID", "FETCH", compressUidSet(uids), items]);
    this.#expectOk(res);
    const wanted = new Set(uids);
    return mergeFetches(res.untagged.map(parseFetch).filter((m): m is FetchedMessage => m !== null))
      .filter((m) => m.uid !== null && wanted.has(m.uid));
  }

  /** Flags of every message from fromUid up. The "*" trap applies here too. */
  async uidFetchFlags(fromUid: number): Promise<Array<{ uid: number; flags: string[] }>> {
    if (!Number.isInteger(fromUid) || fromUid < 1 || fromUid > MAX_UID) return [];
    const res = await this.#command(["UID", "FETCH", `${fromUid}:*`, "(UID FLAGS)"]);
    this.#expectOk(res);
    return mergeFetches(res.untagged.map(parseFetch).filter((m): m is FetchedMessage => m !== null))
      .filter((m) => m.uid !== null && m.uid >= fromUid)
      .map((m) => ({ uid: m.uid as number, flags: m.flags ?? [] }));
  }

  async #fetchOne(uid: number, items: string): Promise<FetchedMessage | null> {
    const res = await this.#command(["UID", "FETCH", compressUidSet([uid]), items]);
    this.#expectOk(res);
    return mergeFetches(res.untagged.map(parseFetch).filter((m): m is FetchedMessage => m !== null))
      .find((m) => m.uid === uid) ?? null;
  }

  /** Size and flags only, to decide whether a message may be downloaded. */
  uidFetchMeta(uid: number): Promise<FetchedMessage | null> {
    return this.#fetchOne(uid, "(UID FLAGS RFC822.SIZE)");
  }

  /** The whole message. BODY.PEEK so reading it does not mark it read. */
  uidFetchSource(uid: number): Promise<FetchedMessage | null> {
    return this.#fetchOne(uid, "(UID BODY.PEEK[])");
  }

  /** Sets or clears \Seen, \Answered or \Flagged. Needs select(), not
   *  examine(). Refuses \Deleted and every other flag. */
  async uidStore(uids: ReadonlyArray<number>, op: "+" | "-", flags: ReadonlyArray<string>): Promise<void> {
    if (op !== "+" && op !== "-") throw new MailError("bad_request", "Invalid flag change.");
    const clean = flags.map((f) => STORABLE_FLAGS.get(String(f).toLowerCase()));
    if (clean.length === 0 || clean.some((f) => f === undefined)) {
      throw new MailError("bad_request", "FenceFlow only marks mail read, answered or flagged. It never deletes or moves it.");
    }
    const res = await this.#command(["UID", "STORE", compressUidSet(uids), `${op}FLAGS.SILENT`, `(${clean.join(" ")})`]);
    this.#expectOk(res);
  }

  /** Adds a message to a folder (the Sent copy of a message sent over SMTP
   *  when the server did not keep one). Returns its UID under UIDPLUS. */
  async append(path: string, message: Uint8Array, flags: ReadonlyArray<string> = ["\\Seen"]): Promise<number | null> {
    const clean = flags.map((f) => STORABLE_FLAGS.get(String(f).toLowerCase()));
    if (clean.some((f) => f === undefined)) throw new MailError("bad_request", "Invalid flag.");
    if (!(message instanceof Uint8Array) || message.length === 0) throw new MailError("bad_request", "Empty message.");
    const res = await this.#command(["APPEND", encodeAstring(path), `(${clean.join(" ")})`, { literal: message }]);
    if (res.tagged.type === "NO" && res.tagged.code === "TRYCREATE") throw this.#fail(res.tagged, "folder_missing");
    this.#expectOk(res);
    if (res.tagged.code === "APPENDUID") {
      const uid = Number(res.tagged.codeArgs[1]);
      return Number.isInteger(uid) && uid > 0 ? uid : null;
    }
    return null;
  }

  /** Polite goodbye. Never throws: by the time it runs, the work is done. */
  async logout(): Promise<void> {
    if (this.#loggedOut) return;
    try {
      await this.#command(["LOGOUT"], { expectBye: true });
    } catch {
      // The server hung up first, or never answered. Either way we are done.
    } finally {
      this.#loggedOut = true;
      this.#t.close();
    }
  }
}

// ---------------------------------------------------------------------------
// The sequences the edge functions run.
// ---------------------------------------------------------------------------

export interface ImapCredentials {
  username: string;
  password: string;
}

/** Greeting, capabilities (unless the greeting carried them), login. */
export async function openSession(client: ImapClient, creds: ImapCredentials): Promise<void> {
  const hello = await client.greeting();
  // PREAUTH would "succeed" without ever checking the password, and then
  // FenceFlow would store a password nobody verified.
  if (hello.preauth) throw new MailError("protocol_error", "The server did not ask for a password.");
  if (client.capabilities.size === 0) await client.capability();
  await client.login(creds.username, creds.password);
}

export interface MailboxCheck {
  /** Raw path of the Sent folder, or null if none could be found. */
  sentFolder: string | null;
  inbox: SelectInfo;
  capabilities: string[];
}

/** mail-connect: prove the address and app password work, and learn where
 *  Sent is. Reads nothing but the folder list and INBOX's counters. */
export async function verifyMailbox(client: ImapClient, creds: ImapCredentials): Promise<MailboxCheck> {
  await openSession(client, creds);
  const sent = findSentFolder(await client.list());
  const inbox = await client.examine("INBOX");
  const capabilities = [...client.capabilities].sort();
  await client.logout();
  return { sentFolder: sent?.path ?? null, inbox, capabilities };
}

/** One row of mail_folder_state, as mail-sync reads it. */
export interface FolderSyncState {
  path: string;
  /** Null before the folder's first sync. */
  uidValidity: number | null;
  lastUid: number;
  backfillBelowUid: number | null;
  initialDone: boolean;
  /**
   * The newest FLAG_WINDOW cached UIDs of this folder under this
   * uidValidity that are not already marked gone. Their flags are re-read,
   * and any the server no longer has come back in goneUids.
   */
  knownUids?: ReadonlyArray<number>;
}

export interface FolderSyncResult {
  path: string;
  uidValidity: number;
  uidNext: number | null;
  exists: number;
  /** UIDVALIDITY changed: every cached UID of this folder is meaningless.
   *  mail_ingest re-binds old rows by Message-ID instead of duplicating. */
  reset: boolean;
  /** New and backfilled messages with their header blocks, ascending UID. */
  messages: FetchedMessage[];
  /** What to store back into mail_folder_state, AFTER ingest succeeds. */
  lastUid: number;
  backfillBelowUid: number | null;
  initialDone: true;
  flags: Array<{ uid: number; flags: string[] }>;
  goneUids: number[];
}

/** One UID FETCH worth of a folder, handed to SyncFolderOptions.onBatch:
 *  its messages, and the folder state that holds once they -- and every
 *  batch before them -- are stored. */
export interface FolderBatch {
  path: string;
  uidValidity: number;
  reset: boolean;
  /** This batch's messages with their header blocks, ascending UID. */
  messages: FetchedMessage[];
  lastUid: number;
  backfillBelowUid: number | null;
}

export interface SyncFolderOptions {
  /** Header blocks per UID FETCH. */
  batchSize?: number;
  /**
   * Called after each batch is fetched, before the next is asked for.
   * mail-sync stores the messages here and then moves the folder's state to
   * the batch's, so a session cut short keeps every batch it finished rather
   * than fetching them all again next run. A throw ends the sync.
   */
  onBatch?: (batch: FolderBatch) => Promise<void>;
}

/**
 * One folder's worth of mail-sync, over an open session.
 *
 * First run (or after a UIDVALIDITY reset): the newest `max` messages from
 * the last FIRST_SYNC_DAYS days; anything older in the window is left for
 * later runs through backfillBelowUid, and lastUid jumps to the top of the
 * folder so mail from before the window is never pulled in as "new".
 *
 * Later runs: UIDs above lastUid, OLDEST first and capped at `max`, so a
 * burst larger than the cap is worked through over several runs instead of
 * skipping its middle. Then backfill with whatever budget is left. Then the
 * flags of the known window, and which of those UIDs have gone.
 *
 * The header blocks come in batches of HEADER_FETCH_BATCH, in an order that
 * lets the state move after every one: new mail oldest first (lastUid climbs
 * to each batch's newest UID), then the first run's window and the backfill
 * newest first (backfillBelowUid drops to each batch's oldest UID). Whatever
 * a later batch did not reach is still above lastUid or below the backfill
 * mark, so the next run fetches it.
 *
 * Everything is read with EXAMINE and BODY.PEEK: syncing never marks
 * anything read.
 */
export async function syncFolder(
  client: ImapClient,
  state: FolderSyncState,
  now: Date,
  max: number = HEADERS_PER_FOLDER_PER_RUN,
  opts: SyncFolderOptions = {},
): Promise<FolderSyncResult> {
  max = Math.max(1, Math.floor(max));
  const size = Math.max(1, Math.floor(opts.batchSize ?? HEADER_FETCH_BATCH));
  const sel = await client.examine(state.path);
  const reset = state.uidValidity !== null && state.uidValidity !== sel.uidValidity;
  const firstRun = reset || state.uidValidity === null || !state.initialDone;
  const since = new Date(now.getTime() - FIRST_SYNC_DAYS * 86_400_000);

  // The fetches to make, in order, each with the state that holds once it
  // and every fetch before it is stored.
  const plan: Array<{ uids: number[]; lastUid: number; backfill: number | null }> = [];
  // Newest first: each batch moves the backfill mark down to its own oldest
  // UID; the last one clears the mark when nothing older is left.
  const planDownward = (uids: number[], lastUid: number, moreBelow: boolean) => {
    for (let end = uids.length; end > 0; end -= size) {
      const start = Math.max(0, end - size);
      const part = uids.slice(start, end);
      plan.push({ uids: part, lastUid, backfill: start === 0 && !moreBelow ? null : part[0] });
    }
  };

  let lastUid: number;
  let backfill: number | null;

  if (firstRun) {
    const inWindow = [...new Set(await client.uidSearchSince(since))];
    const take = newestUids(inWindow, max);
    backfill = inWindow.length > take.length ? take[0] : null;
    // Some servers answer "UID SEARCH UID *" in an empty folder with BAD.
    const top = sel.uidNext !== null ? sel.uidNext - 1 : sel.exists === 0 ? 0 : (await client.highestUid()) ?? 0;
    lastUid = Math.max(top, take.length ? take[take.length - 1] : 0, 0);
    planDownward(take, lastUid, backfill !== null);
  } else {
    const fresh = filterNewUids(await client.uidSearchAbove(state.lastUid), state.lastUid);
    const take = oldestUids(fresh, max);
    backfill = state.backfillBelowUid;
    for (let i = 0; i < take.length; i += size) {
      const part = take.slice(i, i + size);
      plan.push({ uids: part, lastUid: part[part.length - 1], backfill });
    }
    lastUid = take.length ? take[take.length - 1] : state.lastUid;
    const budget = max - take.length;
    if (backfill !== null && budget > 0) {
      const older = [...new Set(await client.uidSearchSinceBelow(since, backfill))];
      const extra = newestUids(older, budget);
      backfill = older.length > extra.length ? extra[0] : null;
      planDownward(extra, lastUid, backfill !== null);
    }
  }

  const messages: FetchedMessage[] = [];
  for (const step of plan) {
    const got = await client.uidFetchHeaders(step.uids);
    messages.push(...got);
    if (opts.onBatch) {
      await opts.onBatch({
        path: state.path,
        uidValidity: sel.uidValidity,
        reset,
        messages: got,
        lastUid: step.lastUid,
        backfillBelowUid: step.backfill,
      });
    }
  }
  messages.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));

  let flags: Array<{ uid: number; flags: string[] }> = [];
  let goneUids: number[] = [];
  const known = [...new Set(state.knownUids ?? [])].filter((u) => Number.isInteger(u) && u > 0);
  if (!reset && known.length > 0) {
    const current = await client.uidFetchFlags(Math.min(...known));
    const knownSet = new Set(known);
    const present = new Set(current.map((c) => c.uid));
    flags = current.filter((c) => knownSet.has(c.uid));
    goneUids = known.filter((u) => !present.has(u)).sort((a, b) => a - b);
  }

  return {
    path: state.path,
    uidValidity: sel.uidValidity,
    uidNext: sel.uidNext,
    exists: sel.exists,
    reset,
    messages,
    lastUid,
    backfillBelowUid: backfill,
    initialDone: true,
    flags,
    goneUids,
  };
}

export interface OpenMessageInput {
  path: string;
  uidValidity: number;
  uid: number;
  /** False for "peek": the message is read without being marked read. */
  markSeen: boolean;
  maxBytes?: number;
}

export type OpenMessageResult =
  | { state: "ok"; source: Uint8Array; flags: string[]; size: number | null }
  | { state: "gone" }
  | { state: "uidvalidity_changed" }
  | { state: "too_large"; size: number };

/**
 * mail-message: the whole of one message, if it is still there, still the
 * same message (UIDVALIDITY), and small enough. Size is asked for first so
 * an oversized message is refused before a byte of it is downloaded.
 */
export async function fetchMessage(client: ImapClient, input: OpenMessageInput): Promise<OpenMessageResult> {
  const max = input.maxBytes ?? OPEN_MESSAGE_MAX_BYTES;
  const sel = input.markSeen ? await client.select(input.path) : await client.examine(input.path);
  if (sel.uidValidity !== input.uidValidity) return { state: "uidvalidity_changed" };
  const meta = await client.uidFetchMeta(input.uid);
  if (!meta) return { state: "gone" };
  if (meta.size !== null && meta.size > max) return { state: "too_large", size: meta.size };
  const full = await client.uidFetchSource(input.uid);
  if (!full || !full.source) return { state: "gone" };
  if (full.source.length > max) return { state: "too_large", size: full.source.length };
  const flags = meta.flags ?? [];
  if (input.markSeen && !flags.some((f) => f.toLowerCase() === "\\seen")) {
    await client.uidStore([input.uid], "+", ["\\Seen"]);
    flags.push("\\Seen");
  }
  return { state: "ok", source: full.source, flags, size: meta.size };
}

/** mail-message {action:'mark'} and mail-send's \Answered on the parent. */
export async function setFlag(
  client: ImapClient,
  input: { path: string; uidValidity: number; uid: number; flag: string; on: boolean },
): Promise<"ok" | "uidvalidity_changed"> {
  // Refused before the SELECT, so a bad flag costs no round trip at all.
  if (!STORABLE_FLAGS.has(String(input.flag).toLowerCase())) {
    throw new MailError("bad_request", "FenceFlow only marks mail read, answered or flagged. It never deletes or moves it.");
  }
  const sel = await client.select(input.path);
  if (sel.uidValidity !== input.uidValidity) return "uidvalidity_changed";
  await client.uidStore([input.uid], input.on ? "+" : "-", [input.flag]);
  return "ok";
}
