/**
 * One TLS connection to a mail server, with every limit enforced in one place.
 *
 * connectTls() is the only function here that touches Deno: it opens
 * Deno.connectTls with the runtime's default certificate checks (the
 * certificate must be valid for the host name, which is also what defeats a
 * name re-pointed at an internal address after hosts.ts resolved it). There
 * is no STARTTLS path and no way to turn verification off.
 *
 * Everything else is StreamTransport, which wraps anything shaped like a
 * Deno.Conn -- read into a buffer, write a buffer, close -- and gives the
 * protocol code the only two operations it needs: read one line, read
 * exactly N bytes. Each of those is bounded four ways:
 *
 *  - per operation: OP_TIMEOUT_MS, after which the socket is closed;
 *  - per session: SESSION_DEADLINE_MS from connect, however busy it was;
 *  - per session: SESSION_BYTE_CAP bytes read in total;
 *  - per piece: MAX_LINE_BYTES for a line, MAX_LITERAL_BYTES for a literal.
 *
 * Because StreamTransport never names Deno, the Node tests run the real
 * reader against scripted fake servers (tests/mail-imap-client.test.mjs),
 * including servers that stall, flood, or offer a 50 MB literal.
 */

import { classifyNetworkError, MailError } from "./errors.ts";
import {
  IMAP_PORT,
  MAX_LINE_BYTES,
  MAX_LITERAL_BYTES,
  OP_TIMEOUT_MS,
  SESSION_BYTE_CAP,
  SESSION_DEADLINE_MS,
  SMTP_PORT,
} from "./limits.ts";

/** The subset of Deno.Conn the transport uses. Fakes implement just this. */
export interface ByteConn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

export interface TransportLimits {
  opTimeoutMs: number;
  sessionDeadlineMs: number;
  byteCap: number;
  maxLineBytes: number;
  maxLiteralBytes: number;
}

export const DEFAULT_TRANSPORT_LIMITS: TransportLimits = {
  opTimeoutMs: OP_TIMEOUT_MS,
  sessionDeadlineMs: SESSION_DEADLINE_MS,
  byteCap: SESSION_BYTE_CAP,
  maxLineBytes: MAX_LINE_BYTES,
  maxLiteralBytes: MAX_LITERAL_BYTES,
};

/** What imap-client.ts and smtp-client.ts are handed. */
export interface MailTransport {
  readLine(): Promise<string>;
  readBytes(n: number): Promise<Uint8Array>;
  write(data: string | Uint8Array): Promise<void>;
  close(): void;
  readonly bytesRead: number;
}

const CHUNK = 64 * 1024;
const MIN_FREE = 4 * 1024;

export class StreamTransport implements MailTransport {
  #conn: ByteConn;
  #limits: TransportLimits;
  #deadline: number;
  #buf: Uint8Array = new Uint8Array(CHUNK);
  #start = 0;
  #end = 0;
  #bytesRead = 0;
  #closed = false;
  #decoder = new TextDecoder("utf-8", { fatal: false });
  #encoder = new TextEncoder();

  constructor(conn: ByteConn, limits: Partial<TransportLimits> = {}, startedAt: number = Date.now()) {
    this.#conn = conn;
    this.#limits = { ...DEFAULT_TRANSPORT_LIMITS, ...limits };
    this.#deadline = startedAt + this.#limits.sessionDeadlineMs;
  }

  get bytesRead(): number {
    return this.#bytesRead;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // Already closed by the far end; nothing left to release.
    }
  }

  /** Runs one socket operation against the shorter of the operation timeout
   *  and what is left of the session. Any failure closes the socket, so a
   *  half-read response can never be mistaken for the next one. */
  async #timed<T>(op: Promise<T>): Promise<T> {
    const left = this.#deadline - Date.now();
    if (left <= 0) {
      op.catch(() => {});
      this.close();
      throw new MailError("session_limit", "The mail session ran out of time.");
    }
    const bySession = left < this.#limits.opTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(bySession ? new MailError("session_limit", "The mail session ran out of time.") : new MailError("timeout")),
        Math.min(left, this.#limits.opTimeoutMs),
      );
    });
    try {
      return await Promise.race([op, expired]);
    } catch (e) {
      this.close();
      throw classifyNetworkError(e);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #readInto(p: Uint8Array): Promise<number> {
    if (this.#closed) throw new MailError("connect_failed", "The connection is closed.");
    const n = await this.#timed(this.#conn.read(p));
    if (n === null || n === 0) {
      this.close();
      throw new MailError("connect_failed", "The server closed the connection.");
    }
    this.#bytesRead += n;
    if (this.#bytesRead > this.#limits.byteCap) {
      this.close();
      throw new MailError("session_limit", "The server sent more than one session allows.");
    }
    return n;
  }

  #ensureSpace(): void {
    if (this.#buf.length - this.#end >= MIN_FREE) return;
    const used = this.#end - this.#start;
    if (this.#start > 0) {
      this.#buf.copyWithin(0, this.#start, this.#end);
      this.#start = 0;
      this.#end = used;
      if (this.#buf.length - this.#end >= MIN_FREE) return;
    }
    // Doubling keeps a long line at O(n) copies instead of O(n^2).
    const next = new Uint8Array(Math.max(this.#buf.length * 2, used + CHUNK));
    next.set(this.#buf.subarray(0, used));
    this.#buf = next;
  }

  async readLine(): Promise<string> {
    let scanned = 0; // bytes after #start already searched for LF
    for (;;) {
      const lf = this.#buf.subarray(this.#start + scanned, this.#end).indexOf(10);
      if (lf >= 0) {
        const at = this.#start + scanned + lf;
        const end = at > this.#start && this.#buf[at - 1] === 13 ? at - 1 : at;
        const line = this.#decoder.decode(this.#buf.subarray(this.#start, end));
        this.#start = at + 1;
        if (this.#start === this.#end) this.#start = this.#end = 0;
        return line;
      }
      scanned = this.#end - this.#start;
      if (scanned > this.#limits.maxLineBytes) {
        this.close();
        throw new MailError("session_limit", "The server sent a line longer than allowed.");
      }
      this.#ensureSpace();
      this.#end += await this.#readInto(this.#buf.subarray(this.#end));
    }
  }

  async readBytes(n: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(n) || n < 0) throw new MailError("protocol_error", "Invalid literal length.");
    if (n > this.#limits.maxLiteralBytes) {
      this.close();
      throw new MailError("session_limit", `The server offered ${n} bytes in one piece.`);
    }
    const out = new Uint8Array(n);
    const have = Math.min(n, this.#end - this.#start);
    out.set(this.#buf.subarray(this.#start, this.#start + have));
    this.#start += have;
    if (this.#start === this.#end) this.#start = this.#end = 0;
    // Large literals are read straight into their own buffer rather than
    // through #buf: a 10 MB message costs one allocation, not a growing copy.
    let filled = have;
    while (filled < n) filled += await this.#readInto(out.subarray(filled));
    return out;
  }

  async write(data: string | Uint8Array): Promise<void> {
    if (this.#closed) throw new MailError("connect_failed", "The connection is closed.");
    const bytes = typeof data === "string" ? this.#encoder.encode(data) : data;
    let off = 0;
    while (off < bytes.length) {
      const n = await this.#timed(this.#conn.write(bytes.subarray(off)));
      if (!n || n < 0) {
        this.close();
        throw new MailError("connect_failed", "The server stopped accepting data.");
      }
      off += n;
    }
  }
}

function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MailError("timeout")), ms);
  });
  return Promise.race([op, expired]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface ConnectOptions {
  /** A preset from hosts.ts, or a custom host that has passed
   *  validateCustomHost() and resolveAndCheck(). */
  hostname: string;
  port: number;
  limits?: Partial<TransportLimits>;
}

/**
 * Opens an implicit-TLS connection and completes the handshake before
 * returning, so a bad certificate is reported as tls_failed at connect time
 * rather than as a confusing read error later.
 */
export async function connectTls(opts: ConnectOptions): Promise<StreamTransport> {
  // Belt and braces: hosts.ts already refused all of this for custom hosts.
  if (opts.port !== IMAP_PORT && opts.port !== SMTP_PORT) {
    throw new MailError("host_not_allowed", "Only ports 993 and 465 are used.");
  }
  const hostname = String(opts.hostname ?? "").toLowerCase();
  if (!hostname || /[\s:/[\]%@]/.test(hostname) || /^[0-9.]+$/.test(hostname)) {
    throw new MailError("host_not_allowed");
  }
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  if (!D || typeof D.connectTls !== "function") throw new MailError("not_configured", "No TLS sockets in this runtime.");

  const limits = { ...DEFAULT_TRANSPORT_LIMITS, ...(opts.limits ?? {}) };
  const startedAt = Date.now();
  const connecting: Promise<ByteConn & { handshake?: () => Promise<unknown> }> = D.connectTls({ hostname, port: opts.port });

  let conn: ByteConn & { handshake?: () => Promise<unknown> };
  try {
    conn = await withTimeout(connecting, limits.opTimeoutMs);
  } catch (e) {
    // If the connect completes after we gave up, close it rather than leak it.
    connecting.then((c) => c.close()).catch(() => {});
    throw classifyNetworkError(e);
  }
  try {
    if (typeof conn.handshake === "function") await withTimeout(conn.handshake(), limits.opTimeoutMs);
  } catch (e) {
    try {
      conn.close();
    } catch {
      // Nothing left to release.
    }
    throw classifyNetworkError(e);
  }
  return new StreamTransport(conn, limits, startedAt);
}
