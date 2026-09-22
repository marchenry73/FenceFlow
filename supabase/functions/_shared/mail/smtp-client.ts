/**
 * An SMTP submission client for port 465, knowing exactly what company
 * email sends and nothing else.
 *
 * Like imap-client.ts it is handed a transport (tls-transport.ts in
 * production, a scripted fake server in tests/mail-smtp.test.mjs) and never
 * opens a socket, reads the environment or logs anything. What it
 * guarantees:
 *
 *  - Nothing goes out half-addressed. Every recipient is offered before
 *    DATA; the first one the server refuses triggers RSET and the whole
 *    send fails with recipient_rejected, naming that address.
 *  - The envelope sender is whatever the caller passes, which mail-send
 *    always sets to the account's own address. Bcc exists only here, as
 *    RCPT TO commands; mime-build never writes a Bcc header.
 *  - No command can be smuggled. Addresses go through mime-build's strict
 *    normalizeAddress (no CR, LF, space or angle bracket); the EHLO name is
 *    checked; the message must be 7-bit with CRLF line ends only -- a bare
 *    CR or LF is refused rather than repaired, because "\n.\n" is exactly
 *    how SMTP smuggling ends one message early and starts another. Lines
 *    starting with "." are doubled (RFC 5321 4.5.2).
 *  - The password never reaches the transcript or an error. AUTH lines are
 *    recorded as "[credentials hidden]", and every server line passes
 *    through errors.redact() with the password and the SASL blob.
 *  - A send whose outcome is unknown says so. Once the message body starts
 *    going out, a timeout or dropped connection throws SmtpUnconfirmed, and
 *    mail-send leaves the row 'sending' ("could not confirm; check Sent")
 *    instead of calling it failed and inviting a second copy.
 *
 * Replies are classified by errors.classifySmtpFailure(): anything refused
 * at AUTH except 421/454 is smtp_auth_failed, which the schedule never
 * retries.
 */

import { classifySmtpFailure, MailError, redact } from "./errors.ts";
import type { SmtpStage } from "./errors.ts";
import { MAX_RECIPIENTS_SMTP, SECRET_MAX_CHARS } from "./limits.ts";
import { normalizeAddress } from "./mime-build.ts";
import type { MailTransport } from "./tls-transport.ts";

/** What FenceFlow calls itself in EHLO. Submission servers authenticate the
 *  user, not the client name, so one fixed name serves every tenant. */
export const EHLO_NAME = "fenceflowapp.com";
/** Lines in one reply. A long EHLO list is about 20. */
const MAX_REPLY_LINES = 64;
const TRANSCRIPT_MAX_LINES = 200;
const HIDDEN = "[credentials hidden]";
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REPLY_RE = /^(\d{3})(?:([ -])(.*))?$/;

export interface SmtpReply {
  code: number;
  /** Text of every line, reply codes removed. */
  lines: string[];
}

/** The server may have accepted the message: the body went out and no
 *  verdict came back. Never retried automatically. */
export class SmtpUnconfirmed extends MailError {
  readonly unconfirmed = true;
  constructor(cause: MailError) {
    super(cause.code, cause.detail);
    this.name = "SmtpUnconfirmed";
  }
}

export function isUnconfirmed(e: unknown): e is SmtpUnconfirmed {
  return e instanceof SmtpUnconfirmed;
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * The DATA payload: `message` with every line that starts with "." given a
 * second one, a CRLF added if it does not end with one, and the ".\r\n"
 * terminator. Refuses (server_error: mime-build never produces them) NUL,
 * any byte above 0x7F, and any CR or LF that is not part of a CRLF.
 */
export function dotStuff(message: Uint8Array): Uint8Array {
  if (!(message instanceof Uint8Array) || message.length === 0) throw new MailError("bad_request", "Empty message.");
  let dots = 0;
  for (let i = 0; i < message.length; i++) {
    const b = message[i];
    if (b === 0 || b > 0x7f) throw new MailError("server_error", "The message is not 7-bit text.");
    if (b === 13 && message[i + 1] !== 10) throw new MailError("server_error", "The message has a bare CR.");
    if (b === 10 && message[i - 1] !== 13) throw new MailError("server_error", "The message has a bare LF.");
    if (b === 46 && (i === 0 || message[i - 1] === 10)) dots++;
  }
  const endsWithCrlf = message.length >= 2 && message[message.length - 2] === 13 && message[message.length - 1] === 10;
  const out = new Uint8Array(message.length + dots + (endsWithCrlf ? 0 : 2) + 3);
  let o = 0;
  for (let i = 0; i < message.length; i++) {
    const b = message[i];
    if (b === 46 && (i === 0 || message[i - 1] === 10)) out[o++] = 46;
    out[o++] = b;
  }
  if (!endsWithCrlf) {
    out[o++] = 13;
    out[o++] = 10;
  }
  out[o++] = 46;
  out[o++] = 13;
  out[o++] = 10;
  return out;
}

export interface SmtpCredentials {
  username: string;
  password: string;
}

export class SmtpClient {
  #t: MailTransport;
  #ehloName: string;
  #ext = new Map<string, string>();
  #secrets: string[] = [];
  #log: string[] = [];
  #closed = false;

  constructor(transport: MailTransport, opts: { ehloName?: string } = {}) {
    const name = String(opts.ehloName ?? EHLO_NAME).toLowerCase();
    if (!HOST_RE.test(name)) throw new MailError("server_error", "Invalid EHLO name.");
    this.#t = transport;
    this.#ehloName = name;
  }

  /** EHLO keywords (upper-case) and their parameters. */
  get extensions(): ReadonlyMap<string, string> {
    return this.#ext;
  }

  /** SASL mechanisms the server offers, upper-case. */
  get authMechanisms(): string[] {
    return (this.#ext.get("AUTH") ?? "").toUpperCase().split(/\s+/).filter(Boolean);
  }

  /** The server's SIZE limit in bytes, or null when it declares none. */
  get sizeLimit(): number | null {
    const n = Number((this.#ext.get("SIZE") ?? "").trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  /** The session so far, credentials removed and never the message body. */
  transcript(): string[] {
    return [...this.#log];
  }

  close(): void {
    this.#closed = true;
    this.#t.close();
  }

  #record(dir: "C:" | "S:", text: string): void {
    this.#log.push(`${dir} ${redact(text, this.#secrets)}`);
    if (this.#log.length > TRANSCRIPT_MAX_LINES) this.#log.shift();
  }

  async #send(line: string, record: string = line): Promise<void> {
    if (this.#closed) throw new MailError("connect_failed", "The connection is closed.");
    await this.#t.write(`${line}\r\n`);
    this.#record("C:", record);
  }

  async #reply(): Promise<SmtpReply> {
    const lines: string[] = [];
    let code = 0;
    for (;;) {
      const raw = await this.#t.readLine();
      this.#record("S:", raw);
      const m = REPLY_RE.exec(raw);
      if (!m) throw new MailError("protocol_error", redact(`Unexpected reply: ${raw}`, this.#secrets));
      const c = Number(m[1]);
      if (lines.length > 0 && c !== code) throw new MailError("protocol_error", "Reply codes changed inside one reply.");
      code = c;
      lines.push(m[3] ?? "");
      if (m[2] !== "-") return { code, lines };
      if (lines.length >= MAX_REPLY_LINES) {
        this.close();
        throw new MailError("session_limit", "The server sent an overlong reply.");
      }
    }
  }

  #fail(stage: SmtpStage, r: SmtpReply): MailError {
    return this.failure(stage, r);
  }

  /** A reply as the MailError it amounts to, with the password and SASL
   *  blob redacted. `about` (e.g. the refused address) leads the detail. */
  failure(stage: SmtpStage, r: SmtpReply, about = ""): MailError {
    const text = `${about ? `${about}: ` : ""}${r.lines.join(" ")}`;
    return classifySmtpFailure({ stage, code: r.code, text }, this.#secrets);
  }

  /** Server text made safe to store: redacted with this session's secrets. */
  safeText(text: string): string {
    return redact(text, this.#secrets);
  }

  async #expect(stage: SmtpStage, ok: (code: number) => boolean): Promise<SmtpReply> {
    const r = await this.#reply();
    if (!ok(r.code)) throw this.#fail(stage, r);
    return r;
  }

  /** 220, or server_busy (421) / protocol_error. */
  async greeting(): Promise<void> {
    await this.#expect("greeting", (c) => c === 220);
  }

  /** EHLO, and the extensions it lists. HELO is never tried: without ESMTP
   *  there is no AUTH, and without AUTH nothing can be sent. */
  async ehlo(): Promise<void> {
    await this.#send(`EHLO ${this.#ehloName}`);
    const r = await this.#expect("ehlo", (c) => c === 250);
    this.#ext = new Map();
    for (const line of r.lines.slice(1)) {
      // "AUTH=PLAIN LOGIN" is the pre-standard spelling some servers still send.
      const m = /^([A-Za-z0-9][A-Za-z0-9-]*)(?:[ =](.*))?$/.exec(line.trim());
      if (!m) continue;
      const key = m[1].toUpperCase();
      const params = (m[2] ?? "").trim();
      const prev = this.#ext.get(key);
      this.#ext.set(key, prev && params ? `${prev} ${params}` : params || prev || "");
    }
  }

  /**
   * AUTH PLAIN with an initial response (one round trip), or AUTH LOGIN when
   * the server offers only that. A 334 after the PLAIN blob means the server
   * wants something more than PLAIN has to give; "*" cancels rather than
   * sending the password a second time.
   */
  async authenticate(creds: SmtpCredentials): Promise<void> {
    const { username, password } = creds ?? ({} as SmtpCredentials);
    if (typeof username !== "string" || !username || username.length > 320) {
      throw new MailError("bad_request", "Enter the mailbox user name.");
    }
    if (typeof password !== "string" || !password || password.length > SECRET_MAX_CHARS) {
      throw new MailError("bad_request", "Enter the app password.");
    }
    if (/[\0\r\n]/.test(username) || /[\0\r\n]/.test(password)) {
      throw new MailError("bad_request", "The user name or app password contains a line break.");
    }
    const blob = base64Utf8(`\0${username}\0${password}`);
    // Known before anything is sent, so an echo in the very first reply is
    // already redacted.
    this.#secrets = [password, blob];

    const mechs = this.authMechanisms;
    if (mechs.includes("PLAIN")) return this.authPlain(blob);
    if (mechs.includes("LOGIN")) return this.#authLogin(username, password);
    throw new MailError("protocol_error", "The outgoing server offers no sign-in method FenceFlow supports.");
  }

  /** AUTH PLAIN. Exposed for tests; authenticate() is what the sequences call. */
  async authPlain(blob: string): Promise<void> {
    await this.#send(`AUTH PLAIN ${blob}`, `AUTH PLAIN ${HIDDEN}`);
    const r = await this.#reply();
    if (r.code === 334) {
      await this.#send("*");
      await this.#reply();
      throw new MailError("protocol_error", "The outgoing server did not accept AUTH PLAIN.");
    }
    if (r.code !== 235) throw this.#fail("auth", r);
  }

  async #authLogin(username: string, password: string): Promise<void> {
    await this.#send("AUTH LOGIN");
    let r = await this.#reply();
    if (r.code !== 334) throw this.#fail("auth", r);
    await this.#send(base64Utf8(username), HIDDEN);
    r = await this.#reply();
    if (r.code !== 334) throw this.#fail("auth", r);
    await this.#send(base64Utf8(password), HIDDEN);
    r = await this.#reply();
    if (r.code !== 235) throw this.#fail("auth", r);
  }

  async mailFrom(address: string, size: number | null): Promise<void> {
    const from = normalizeAddress(address);
    const sizeParam = size !== null && this.#ext.has("SIZE") ? ` SIZE=${size}` : "";
    await this.#send(`MAIL FROM:<${from}>${sizeParam}`);
    await this.#expect("mail", (c) => c === 250);
  }

  /** 250 or 251 is accepted; anything else comes back for the caller to
   *  decide (sendMessage RSETs and aborts). */
  async rcptTo(address: string): Promise<SmtpReply> {
    await this.#send(`RCPT TO:<${normalizeAddress(address)}>`);
    return await this.#reply();
  }

  async rset(): Promise<void> {
    await this.#send("RSET");
    await this.#reply();
  }

  /** DATA, the stuffed message, and the server's verdict on it. */
  async data(stuffed: Uint8Array): Promise<SmtpReply> {
    await this.#send("DATA");
    await this.#expect("data", (c) => c === 354);
    try {
      await this.#t.write(stuffed);
      this.#record("C:", `[message, ${stuffed.length} bytes]`);
      const r = await this.#reply();
      if (r.code !== 250) throw this.#fail("data", r);
      return r;
    } catch (e) {
      // A refusal after the full stop is definite. Anything else from here
      // on (timeout, hang-up, garbled reply) leaves the outcome unknown.
      if (e instanceof MailError && !(e.code === "timeout" || e.code === "connect_failed" || e.code === "session_limit" || e.code === "protocol_error")) {
        throw e;
      }
      throw new SmtpUnconfirmed(e instanceof MailError ? e : new MailError("connect_failed"));
    }
  }

  /** Polite goodbye. Never throws: by the time it runs, the work is done. */
  async quit(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#send("QUIT");
      await this.#reply();
    } catch {
      // The server hung up first. Nothing is lost.
    } finally {
      this.close();
    }
  }
}

// ---------------------------------------------------------------------------
// The sequences the edge functions run.
// ---------------------------------------------------------------------------

/** Greeting, EHLO, AUTH. */
export async function openSmtpSession(client: SmtpClient, creds: SmtpCredentials): Promise<void> {
  await client.greeting();
  await client.ehlo();
  await client.authenticate(creds);
}

/** mail-connect: prove the address and app password can send. Nothing is
 *  sent; the session ends after AUTH. */
export async function verifySmtp(client: SmtpClient, creds: SmtpCredentials): Promise<{ authMechanisms: string[]; sizeLimit: number | null }> {
  try {
    await openSmtpSession(client, creds);
  } catch (e) {
    client.close();
    throw e;
  }
  const out = { authMechanisms: client.authMechanisms, sizeLimit: client.sizeLimit };
  await client.quit();
  return out;
}

export interface SmtpEnvelope {
  /** Always the account's own address. */
  from: string;
  /** To, Cc and Bcc together. */
  recipients: ReadonlyArray<string>;
}

export interface SmtpSendResult {
  /** The server's acceptance line, redacted (often carries its queue id). */
  response: string;
  recipients: number;
}

/**
 * mail-send over an account's own SMTP server: everything is checked before
 * the greeting is even read, then MAIL FROM, every RCPT, DATA. The first
 * refused recipient means RSET and recipient_rejected, and no DATA is ever
 * sent. A message larger than the server's SIZE is refused before MAIL FROM.
 */
export async function sendMessage(
  client: SmtpClient,
  creds: SmtpCredentials,
  envelope: SmtpEnvelope,
  message: Uint8Array,
): Promise<SmtpSendResult> {
  const from = normalizeAddress(envelope?.from);
  if (!Array.isArray(envelope?.recipients)) throw new MailError("bad_request", "Add at least one recipient.");
  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const r of envelope.recipients) {
    const a = normalizeAddress(r);
    if (seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    recipients.push(a);
  }
  if (recipients.length === 0) throw new MailError("bad_request", "Add at least one recipient.");
  if (recipients.length > MAX_RECIPIENTS_SMTP) throw new MailError("bad_request", `At most ${MAX_RECIPIENTS_SMTP} recipients.`);
  const stuffed = dotStuff(message);

  try {
    await openSmtpSession(client, creds);
    const limit = client.sizeLimit;
    if (limit !== null && message.length > limit) {
      await client.quit();
      throw new MailError("too_large", `The outgoing server accepts at most ${limit} bytes.`);
    }
    await client.mailFrom(from, message.length);
    for (const r of recipients) {
      const reply = await client.rcptTo(r);
      if (reply.code === 250 || reply.code === 251) continue;
      const refused = client.failure("rcpt", reply, r);
      try {
        await client.rset();
      } catch {
        // The transaction is abandoned either way; QUIT below closes it.
      }
      await client.quit();
      throw refused;
    }
    const accepted = await client.data(stuffed);
    await client.quit();
    return { response: client.safeText(`${accepted.code} ${accepted.lines.join(" ")}`), recipients: recipients.length };
  } catch (e) {
    // Hanging up abandons any open transaction: the server discards a
    // message it has not seen the final full stop of.
    client.close();
    throw e;
  }
}
