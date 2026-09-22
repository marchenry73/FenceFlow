/**
 * Is this webhook really from Resend? Svix signature verification.
 *
 * resend-inbound is a public URL: anyone can POST a fake "email.received"
 * to it. Resend signs each delivery the Svix way -- HMAC-SHA256, keyed with
 * the base64 part of the endpoint's whsec_ secret, over
 * "<svix-id>.<svix-timestamp>.<raw body>" -- and sends the result in
 * svix-signature as one or more space-separated "v1,<base64>" values (more
 * than one while a secret is being rotated). A delivery is accepted when:
 *
 *  - all three headers are present and well-formed;
 *  - the timestamp is within SVIX_TOLERANCE_SECONDS of now, either way, so
 *    a captured delivery cannot be replayed later (resend-inbound also
 *    de-duplicates on svix-id);
 *  - at least one v1 signature equals the expected one, compared in
 *    constant time.
 *
 * The body must be the exact bytes received, before any JSON parsing:
 * re-serialising changes whitespace and breaks the signature, and verifying
 * a re-serialised body would prove nothing about the bytes that were sent.
 *
 * Uses WebCrypto (crypto.subtle), present in Deno and Node, and no clock:
 * the caller passes `nowSeconds`, so tests/mail-svix.test.mjs can prove the
 * 5-minute window exactly.
 */

import { MailError } from "./errors.ts";
import { SVIX_TOLERANCE_SECONDS } from "./limits.ts";

/** Longest svix-signature header looked at; a rotation carries two or three. */
const SIGNATURE_HEADER_MAX_CHARS = 2048;
const SIGNATURES_MAX = 8;
/** mail_inbound_events.svix_id is at most 200 characters. */
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const TIMESTAMP_RE = /^\d{1,12}$/;
/** A whsec_ key shorter than this is a configuration mistake, not a key. */
const MIN_KEY_BYTES = 16;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** The three headers from a Request's Headers. */
export function svixHeaders(h: { get(name: string): string | null }): SvixHeaders {
  return { id: h.get("svix-id"), timestamp: h.get("svix-timestamp"), signature: h.get("svix-signature") };
}

export type SvixFailure = "missing_headers" | "malformed" | "stale" | "bad_signature";

export type SvixResult =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: SvixFailure };

function decodeBase64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * The HMAC key inside "whsec_<base64>" (the prefix is optional, as in the
 * Svix libraries). not_configured when it is missing or not a key, so a
 * wrongly pasted secret fails loudly instead of rejecting every delivery as
 * "bad signature".
 */
export function decodeSvixSecret(secret: string | null | undefined): Uint8Array {
  const raw = String(secret ?? "").trim();
  const key = decodeBase64(raw.startsWith("whsec_") ? raw.slice(6) : raw);
  if (!key || key.length < MIN_KEY_BYTES) throw new MailError("not_configured", "RESEND_WEBHOOK_SECRET is not a whsec_ signing secret.");
  return key;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface VerifyInput {
  headers: SvixHeaders;
  /** The raw request body, exactly as received. */
  body: Uint8Array | string;
  /** RESEND_WEBHOOK_SECRET. */
  secret: string | null | undefined;
  /** Math.floor(Date.now() / 1000) in production. */
  nowSeconds: number;
  toleranceSeconds?: number;
}

/**
 * Verifies one delivery. Throws only for a missing or malformed secret
 * (our configuration); everything about the request itself is a result, so
 * the function can answer 401 without an exception path.
 */
export async function verifySvix(input: VerifyInput): Promise<SvixResult> {
  const key = decodeSvixSecret(input.secret);
  const { id, timestamp, signature } = input.headers ?? ({} as SvixHeaders);
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!ID_RE.test(id) || !TIMESTAMP_RE.test(timestamp) || signature.length > SIGNATURE_HEADER_MAX_CHARS) {
    return { ok: false, reason: "malformed" };
  }
  const ts = Number(timestamp);
  const tolerance = input.toleranceSeconds ?? SVIX_TOLERANCE_SECONDS;
  if (!Number.isFinite(input.nowSeconds) || Math.abs(input.nowSeconds - ts) > tolerance) return { ok: false, reason: "stale" };

  const candidates: Uint8Array[] = [];
  for (const part of signature.split(" ").filter(Boolean).slice(0, SIGNATURES_MAX)) {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") continue;
    const sig = decodeBase64(part.slice(comma + 1));
    if (sig) candidates.push(sig);
  }
  if (candidates.length === 0) return { ok: false, reason: "bad_signature" };

  const enc = new TextEncoder();
  const prefix = enc.encode(`${id}.${timestamp}.`);
  const body = typeof input.body === "string" ? enc.encode(input.body) : input.body;
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);

  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, signed as BufferSource));
  // Every candidate is compared, match or not, so the time taken does not
  // say which one (or whether any) matched.
  let matched = false;
  for (const c of candidates) matched = equalBytes(c, expected) || matched;
  return matched ? { ok: true, id, timestamp: ts } : { ok: false, reason: "bad_signature" };
}
