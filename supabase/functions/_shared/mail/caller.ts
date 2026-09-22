/**
 * Who is calling a mail function, and whether they may touch company email.
 *
 * Every office-facing mail function (mail-connect, mail-sync's office door,
 * mail-message, mail-send) starts with mailCaller(req). It is the ONLY way
 * those functions get a service-role client, and it hands one back only
 * after all of this has passed, in this order:
 *
 *  1. A bearer token is present. verify_jwt is off for these functions in
 *     config.toml (the browser's CORS preflight carries no token), so this
 *     code is the bouncer, exactly as in invite-crew.
 *  2. auth.getUser() accepts the token.
 *  3. public.can_use_company_mail() -- called through a client built from
 *     the caller's OWN token, so it judges them, not the service role --
 *     answers exactly `true`. Not truthy: `true`. An error, a null, or a
 *     missing function all refuse. (An empty answer read as good news is
 *     the bug class that opened gates here before.)
 *  4. Their profile has a company. When the function says so, their role
 *     is OWNER.
 *
 * The admin client that comes back bypasses RLS, so every query made with
 * it must filter company_id = caller.companyId explicitly; loadAccountAsCaller()
 * reads a mail_accounts row through the caller's own client first, so RLS
 * proves the row is theirs before the service role goes near its secret.
 *
 * Also here: the scheduled door's shared-secret check, the capped JSON body
 * reader, and the CORS/JSON/error responses every mail function returns.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { errorBody, MailError, toMailError } from "./errors.ts";
import { REQUEST_JSON_MAX_BYTES } from "./limits.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * The response for anything thrown. Pass every secret the handler held
 * (the app password, a SASL blob): the detail is redacted with them again
 * here even though the creation site should already have done it. Logs
 * the function name and error code only -- never a request body, never
 * server text that has not been through redact().
 */
export function errorResponse(fn: string, e: unknown, secrets: ReadonlyArray<string | null | undefined> = []): Response {
  const err = toMailError(e);
  const body = errorBody(err, secrets);
  if (!(e instanceof MailError)) {
    // Our own bug. The message of a non-MailError can carry anything (a
    // supabase-js error echoes the query), so only its type is logged.
    console.error(`${fn}: unexpected ${(e as { name?: string })?.name ?? typeof e}`);
  } else if (err.status >= 500) {
    console.error(`${fn}: ${body.error_code}${body.detail ? ` (${body.detail})` : ""}`);
  }
  return json(body, err.status);
}

/**
 * The request body as a JSON object, refusing anything over maxBytes
 * WITHOUT buffering it first: the stream is read in pieces and abandoned the
 * moment the cap is passed.
 */
export async function readJsonBody(req: Request, maxBytes: number = REQUEST_JSON_MAX_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new MailError("too_large", "Request body too large.");
  if (!req.body) return {};
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MailError("too_large", "Request body too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  let parsed: unknown;
  try {
    parsed = bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  } catch {
    throw new MailError("bad_request", "Request body is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MailError("bad_request", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export interface MailCaller {
  uid: string;
  companyId: string;
  role: string;
  isOwner: boolean;
  companyName: string;
  /** companies.email, trimmed, or null. FenceFlow mail's Reply-To. */
  companyEmail: string | null;
  /** The caller's own client: every read runs under their RLS. */
  userClient: SupabaseClient;
  /** Service role. Only ever handed out after the gate; every query made
   *  with it must filter company_id = companyId itself. */
  admin: SupabaseClient;
}

interface Env {
  url: string;
  anonKey: string;
  serviceKey: string;
}

function readEnv(): Env {
  // deno-lint-ignore no-explicit-any
  const env = (globalThis as any).Deno?.env;
  const url = env?.get("SUPABASE_URL");
  const anonKey = env?.get("SUPABASE_ANON_KEY");
  const serviceKey = env?.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) throw new MailError("not_configured", "Supabase environment missing.");
  return { url, anonKey, serviceKey };
}

const NO_SESSION_PERSIST = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/**
 * The gate. Throws a MailError (no_session 401, mail_forbidden 403,
 * owner_only 403, server_error 500) or returns a caller who has passed.
 */
export async function mailCaller(req: Request, opts: { requireOwner?: boolean } = {}): Promise<MailCaller> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (!m) throw new MailError("no_session");
  const jwt = m[1];
  const env = readEnv();

  const userClient = createClient(env.url, env.anonKey, {
    ...NO_SESSION_PERSIST,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  }) as SupabaseClient;

  const { data: userData, error: authError } = await userClient.auth.getUser(jwt);
  const uid = userData?.user?.id;
  if (authError || !uid) throw new MailError("no_session");

  const { data: allowed, error: gateError } = await userClient.rpc("can_use_company_mail");
  if (gateError) {
    console.error("mail caller: can_use_company_mail failed");
    throw new MailError("server_error");
  }
  if (allowed !== true) throw new MailError("mail_forbidden");

  const { data: profile, error: profileError } = await userClient
    .from("profiles").select("company_id, role").eq("id", uid).maybeSingle();
  if (profileError) throw new MailError("server_error");
  const companyId = profile?.company_id ? String(profile.company_id) : "";
  const role = String(profile?.role ?? "");
  if (!companyId) throw new MailError("mail_forbidden");
  if (opts.requireOwner && role !== "OWNER") throw new MailError("owner_only");

  const { data: company, error: companyError } = await userClient
    .from("companies").select("name, email").eq("id", companyId).maybeSingle();
  if (companyError || !company) throw new MailError("server_error");

  const admin = createClient(env.url, env.serviceKey, NO_SESSION_PERSIST) as SupabaseClient;
  const email = String(company.email ?? "").trim();
  return {
    uid,
    companyId,
    role,
    isOwner: role === "OWNER",
    companyName: String(company.name ?? "").trim(),
    companyEmail: email || null,
    userClient,
    admin,
  };
}

/**
 * A mail_accounts row, read through the caller's own client so RLS (company
 * plus the mail gate) decides whether it exists for them. Use this before
 * reading the account's secret with the admin client; never look an account
 * up by id with the admin client alone.
 */
export async function loadAccountAsCaller(caller: MailCaller, accountId: unknown): Promise<Record<string, unknown>> {
  if (!isUuid(accountId)) throw new MailError("bad_request", "Invalid mailbox id.");
  const { data, error } = await caller.userClient
    .from("mail_accounts").select("*").eq("id", accountId).eq("company_id", caller.companyId).maybeSingle();
  if (error) throw new MailError("server_error");
  if (!data) throw new MailError("not_found");
  return data as Record<string, unknown>;
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/**
 * The scheduled door's shared secret (x-fenceflow-trigger). Both sides are
 * hashed first and the digests compared in constant time, so neither the
 * content nor the LENGTH of the expected secret leaks through timing (the
 * older secretMatches() in send-follow-ups returns early on a length
 * mismatch). An unset or empty expected secret never matches anything.
 */
export async function triggerSecretMatches(supplied: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(String(supplied ?? "")), sha256(expected)]);
  let diff = supplied ? 0 : 1;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * The scheduled door (mail-sync called from GitHub Actions). The same rule
 * as mailCaller: the service-role client exists only after the check, here
 * the x-fenceflow-trigger header against the named function secret
 * (MAIL_SYNC_TRIGGER_SECRET). An unset secret refuses everything with
 * not_configured rather than opening the door.
 */
export async function triggerCaller(req: Request, secretName: string): Promise<{ admin: SupabaseClient }> {
  // deno-lint-ignore no-explicit-any
  const expected = (globalThis as any).Deno?.env?.get(secretName);
  if (!expected) throw new MailError("not_configured", `${secretName} is not set.`);
  const env = readEnv();
  if (!(await triggerSecretMatches(req.headers.get("x-fenceflow-trigger"), expected))) throw new MailError("no_session");
  return { admin: createClient(env.url, env.serviceKey, NO_SESSION_PERSIST) as SupabaseClient };
}
