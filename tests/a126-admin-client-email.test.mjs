// A126 -- EMAILING YOUR CLIENTS FROM THE ADMIN CONSOLE, AND THE FOUR WAYS IT
// COULD GO WRONG.
//
// HIS WORDS: "Email your clients from the admin portal."
//
// This is the first thing in FenceFlow that sends mail to somebody who is not
// a customer of the person pressing the button -- it goes from the platform to
// the companies that pay for it. The things worth pinning are not the happy
// path:
//
//   1. THE RECIPIENT MUST NEVER COME FROM THE REQUEST. The console sends
//      company IDS and the address is read from the company row. Accept an
//      address in the body and this becomes an open relay with a FenceFlow
//      return address on it.
//   2. THE CLAIM MUST COME BEFORE THE SEND. Claim after sending and a double
//      click sends twice; there is no un-sending an email.
//   3. THE FALLBACK PROVIDER IS FOR "THIS SERVICE IS DOWN", NEVER FOR "THIS
//      SERVICE REFUSED IT". A refusal is a verdict -- the other provider will
//      refuse the same message for the same reason, and trying twice risks
//      sending twice.
//   4. ONE RECIPIENT PER MESSAGE. A single To: line with nine clients on it
//      shows every client who else uses FenceFlow. That is his customer list.
//
// The live database half -- the gate, the exactly-once claim, the released
// failure -- was proved against production by impersonating four callers and
// rolling back; this covers the half a source read can actually settle.
//
// Run: node --test tests/a126-admin-client-email.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const FN = read("supabase/functions/admin-mail-send/index.ts");
const SQL = read("supabase_r35_admin_client_email.sql");
const CONFIG = read("supabase/config.toml");

/** Comments out. A sentence promising a guard is not a guard. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");
const FN_CODE = code(FN);
/** SQL comments out, so a `--` line describing a rule is not the rule. */
const SQL_CODE = SQL.replace(/^\s*--.*$/gm, " ");

test("POSITIVE CONTROL: the readers found both halves", () => {
  // Without this, every assertion below passes when a path changes.
  assert.ok(FN_CODE.length > 3000, `the function read ${FN_CODE.length} chars`);
  assert.ok(SQL_CODE.length > 2000, `the migration read ${SQL_CODE.length} chars`);
  assert.match(FN_CODE, /Deno\.serve\(/, "the function has no entry point");
  assert.match(FN_CODE, /is_platform_admin/, "the function does not ask the admin gate at all");
});

test("1. the recipient is never taken from the request", () => {
  // The body may carry company_ids, a subject and a body. An ADDRESS in it
  // would make this a relay anybody with a stolen admin token could point
  // anywhere.
  const bodyReads = [...FN_CODE.matchAll(/\bbody\.(\w+)/g)].map((m) => m[1]);
  assert.ok(bodyReads.length > 0, "the function reads nothing from the request at all");
  const allowed = new Set(["client_send_id", "company_ids", "subject", "text"]);
  const extra = [...new Set(bodyReads)].filter((k) => !allowed.has(k));
  assert.deepEqual(extra, [],
    `the request body is read for ${extra.join(", ")} -- an address or recipient must never come from it`);
  // And the address actually used comes from the database function.
  assert.match(FN_CODE, /rpc\("admin_email_recipients"/,
    "the recipient list no longer comes from admin_email_recipients");
  assert.match(FN_CODE, /to: \[r\.to_email\]/,
    "the To: is no longer the address the database returned");
});

test("1b. the database refuses to hand back a test company or a missing address", () => {
  // Enforced in SQL, not in the caller, so nothing can opt out of it.
  assert.match(SQL_CODE, /c\.name not like 'ZZ TEST%'/,
    "admin_email_recipients no longer excludes test companies");
  assert.match(SQL_CODE, /c\.deleted_at is null/,
    "a removed company can be emailed again");
  assert.match(SQL_CODE, /c\.email is not null/,
    "a company with no address is no longer filtered out");
  assert.match(SQL_CODE, /is_platform_admin\(\)/,
    "admin_email_recipients no longer asks the admin gate");
});

test("2. the claim is taken BEFORE anything is posted to a provider", () => {
  // Claim after sending and a double click, a retried request or two tabs
  // each send the same notice. There is no un-sending an email.
  const claimAt = FN_CODE.indexOf('rpc("admin_claim_client_email"');
  const postAt = FN_CODE.indexOf("await post(primary");
  assert.ok(claimAt > 0, "the claim is gone");
  assert.ok(postAt > 0, "the send is gone");
  assert.ok(claimAt < postAt,
    "the provider is posted to before the claim is taken: a double click sends twice");
  // A claim that came back empty means somebody else holds it, and NOTHING
  // may be sent on this pass.
  assert.match(FN_CODE, /state: "duplicate"/,
    "a send already claimed is no longer reported as a duplicate");
  const dupAt = FN_CODE.indexOf('state: "duplicate"');
  assert.ok(dupAt < postAt || FN_CODE.slice(dupAt, postAt).includes("continue"),
    "the duplicate branch does not stop before the send");
});

test("3. the fallback provider is tried only when there was no verdict", () => {
  // "refused" is a verdict: the provider read the message and said no, and
  // the other one will say no for the same reason. Retrying a refusal through
  // a second service is how one message becomes two.
  const fb = FN_CODE.slice(
    FN_CODE.indexOf("let outcome = await post(primary"),
    FN_CODE.indexOf('if (outcome.kind === "sent")'),
  );
  assert.ok(fb.length > 80, `the fallback block read ${fb.length} chars`);
  assert.match(fb, /outcome\.kind === "unconfirmed" && fallback/,
    "the fallback is no longer gated on an unconfirmed outcome");
  assert.ok(!/outcome\.kind === "refused"/.test(fb),
    "the fallback is tried on a refusal, which risks sending the same message twice");
});

test("3b. a 4xx is a refusal and a 5xx is not", () => {
  // The distinction the whole failure model rests on. A provider that takes
  // the message and then dies may well have delivered it, so it must never be
  // reported as failed and never retried.
  const p = FN_CODE.slice(FN_CODE.indexOf("async function post("), FN_CODE.indexOf("Deno.serve("));
  assert.ok(p.length > 300, "could not find post()");
  assert.match(p, /res\.status >= 400 && res\.status < 500/,
    "the 4xx/5xx split is gone, so a timeout reads as a failure");
  assert.match(p, /kind: "unconfirmed"/, "there is no unconfirmed outcome any more");
  // A thrown fetch is unconfirmed too: the body may already be on its way.
  const thrown = p.slice(p.indexOf("catch (e)"), p.indexOf("const body"));
  assert.match(thrown, /unconfirmed/,
    "a dropped connection is treated as a failure, but the message may have gone");
});

test("3c. a verdict with no answer leaves the row in flight, never failed", () => {
  // 'sending' is what makes the console able to say "could not confirm" --
  // the one honest thing to say when nobody knows.
  assert.match(SQL_CODE, /send_state\s+text\s+not null default 'sending'/,
    "a claimed send no longer starts as sending");
  const unconf = FN_CODE.slice(FN_CODE.indexOf("} else {"), FN_CODE.length);
  assert.match(unconf, /state: "unconfirmed"/, "the unconfirmed answer is gone");
  assert.ok(!/admin_finish_client_email/.test(unconf.slice(0, unconf.indexOf("return json"))),
    "an unconfirmed send writes a verdict, which would claim to know what happened");
});

test("4. one recipient per message", () => {
  // Nine clients get nine emails. A single To: line would show each of them
  // who else uses FenceFlow.
  assert.match(FN_CODE, /for \(const r of list\)/,
    "the send no longer loops one client at a time");
  assert.ok(!/to: list\.map/.test(FN_CODE) && !/to: addresses/.test(FN_CODE),
    "every client is being put on one message, which leaks his customer list");
});

test("the admin gate is asked, and asked again inside every SQL function", () => {
  // Reaching the code is not permission. The function asks, and each of the
  // four SECURITY DEFINER functions asks again against a real session.
  assert.match(FN_CODE, /rpc\("is_platform_admin"\)/, "the function no longer asks the gate");
  assert.match(FN_CODE, /isAdmin !== true/, "the gate's answer is not checked strictly");
  for (const fn of [
    "admin_email_recipients",
    "admin_claim_client_email",
    "admin_finish_client_email",
    "admin_client_email_log",
  ]) {
    const at = SQL_CODE.indexOf(`function public.${fn}`);
    assert.ok(at > 0, `${fn} is gone`);
    const body = SQL_CODE.slice(at, at + 2200);
    assert.match(body, /security definer/,
      `${fn} is not SECURITY DEFINER, so its gate is asked of a caller who could not read the table anyway`);
    assert.match(body, /is_platform_admin\(\)/, `${fn} does not ask the admin gate`);
    assert.match(body, /set search_path = public/,
      `${fn} has no fixed search_path, which is how a definer function gets hijacked`);
  }
});

test("the table has no policies and no grants -- the functions are the only door", () => {
  // A client who could read this table would see what was sent to every
  // other client.
  assert.match(SQL_CODE, /alter table public\.admin_client_emails enable row level security/,
    "RLS is off on the admin email table");
  assert.match(SQL_CODE, /revoke all on public\.admin_client_emails from anon, authenticated/,
    "the table is still granted to ordinary sessions");
  assert.ok(!/create policy/i.test(SQL_CODE),
    "a policy was added; this table is meant to be reachable only through its functions");
  // anon may execute none of the four.
  const revokes = [...SQL_CODE.matchAll(/revoke all on function public\.(\w+)/g)].map((m) => m[1]);
  for (const fn of [
    "admin_email_recipients",
    "admin_claim_client_email",
    "admin_finish_client_email",
    "admin_client_email_log",
  ]) {
    assert.ok(revokes.includes(fn), `${fn} is not revoked from anon`);
  }
});

test("the exactly-once index is what makes the claim a claim", () => {
  assert.match(SQL_CODE, /create unique index if not exists admin_client_emails_once\s*\n?\s*on public\.admin_client_emails \(client_send_id, company_id\)/,
    "the (client_send_id, company_id) unique index is gone: two tabs can each send");
  assert.match(SQL_CODE, /on conflict \(client_send_id, company_id\) do nothing/,
    "the claim no longer relies on the conflict, so a race can claim twice");
});

test("a late verdict cannot rewrite a finished send", () => {
  const at = SQL_CODE.indexOf("function public.admin_finish_client_email");
  const body = SQL_CODE.slice(at, at + 2200);
  assert.match(body, /and send_state = 'sending'/,
    "a verdict can land on a row that was already finished, rewriting history");
});

test("the function needs a signed-in session: verify_jwt is NOT turned off for it", () => {
  // The three functions with verification off are called by Stripe, by a
  // Postgres trigger, or by a phone that has not signed in. This one is
  // pressed by a person in a browser, and turning verification off would put
  // the whole admin console behind nothing but a URL.
  assert.ok(!/\[functions\.admin-mail-send\]/.test(CONFIG),
    "admin-mail-send has an entry in config.toml -- if it sets verify_jwt=false the gate is gone");
});

test("CANARY: a request-supplied address is detected", () => {
  // The exact shape that must never ship. If this cannot be spotted, check 1
  // is decoration.
  const pretend = `
    const to = String(body.to_email ?? "");
    await post(primary, key, buildResendEmail({ to: [to] }));`;
  const reads = [...code(pretend).matchAll(/\bbody\.(\w+)/g)].map((m) => m[1]);
  const allowed = new Set(["client_send_id", "company_ids", "subject", "text"]);
  assert.deepEqual(reads.filter((k) => !allowed.has(k)), ["to_email"],
    "THE CANARY DID NOT FIRE: an address read from the request was judged acceptable");
});

test("CANARY: a claim taken after the send is detected", () => {
  const pretend = `
    const out = await post(primary, key, payload);
    const claimed = await asCaller.rpc("admin_claim_client_email", {});`;
  const c = code(pretend);
  const claimAt = c.indexOf('rpc("admin_claim_client_email"');
  const postAt = c.indexOf("await post(primary");
  assert.ok(claimAt > postAt,
    "THE CANARY DID NOT FIRE: a claim taken after the send read as taken before it");
});
