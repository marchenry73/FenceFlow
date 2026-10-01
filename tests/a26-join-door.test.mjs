// a26 -- THE JOIN DOOR. Can a stranger who holds only a company's id become that
// company's crew?
//
// The hole (proven live on 2026-09-29 by tests/a25-tenant-isolation.test.mjs, F1):
// anybody can sign up, and anybody who holds a company's id could call
// join_company(<id>) and be its CREW at once -- reading every customer's name,
// address, phone and site notes, marking a job COMPLETED, editing a customer.
// The id travels in every invite email, so the id was a password.
//
// supabase_r18_join_door.sql closes it with a separate, rotatable TEAM CODE (see
// its header for how joining worked and why this design). It is NOT APPLIED. This
// file is what stands between "written" and "safe to apply":
//
//   A. STATIC (pure, no network, ~1 s)
//      1. The SQL file is what it says it is: PART 1 is one transaction that ends
//         in ROLLBACK and cannot commit; PART 2 (apply) and PART 3 (reverse) are
//         block comments; the statements PART 2 would commit are byte for byte the
//         ones PART 1 proved; the reverse restores the deployed join_company
//         exactly (md5); nothing in what runs deletes, drops or truncates; every
//         row it writes is in the synthetic a26 namespace; the bypass role is
//         named nowhere and every attack runs as anon or authenticated.
//      2. Every attack in the dry run has a control (the same call that must work),
//         so a refusal is never just a typo.
//      3. invite-crew/index.ts is RUN (the real file, real TypeScript stripped, a
//         fake Supabase client and a fake fetch): the email carries the team code and
//         never the company id; the no-mail fallback shows the code only to somebody
//         who may see it; the caller's own client is used, never the service role;
//         an RPC failure fails closed instead of falling back to the id; a crew
//         member, a stranger, a full hour's quota and a suspended account are
//         refused before anything is sent. Each check is proven by a planted
//         failure: the old behaviour put back must be caught.
//
//   B. LIVE (A26_LIVE=1, ~3 minutes, rolled back, nothing applied)
//      Runs PART 1 against production. Every attack as the authenticated or anon
//      role with a specific user's claims, never the bypass role. Then proves it
//      left nothing behind and applied nothing. Then runs it twice more with the
//      change deliberately broken -- the old join_company put back, and a
//      shadowable one -- and demands the matching rows go red: a probe that stays
//      green with the wall knocked down was never measuring the wall.
//
//   node --test tests/a26-join-door.test.mjs               STATIC only
//   A26_LIVE=1 node --test tests/a26-join-door.test.mjs    STATIC + LIVE
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as inviteEmail from "../supabase/functions/_shared/invite-crew-email.ts";

const PROJECT = "newcrgafcptspmapacrx";
const LIVE = process.env.A26_LIVE === "1";
const SQL_URL = new URL("../supabase_r18_join_door.sql", import.meta.url);
const FN_URL = new URL("../supabase/functions/invite-crew/index.ts", import.meta.url);
const GUARD_URL = new URL("../supabase_join_company_guard.sql", import.meta.url);
const sql = readFileSync(SQL_URL, "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/** The md5 of the join_company that production has today (supabase/dev/fingerprint-prod.txt). */
const DEPLOYED_JOIN_COMPANY_MD5 = "7283468b880d459cb46fe1036405eee3";

// ------------------------------------------------------------ SQL scanning --
/**
 * The file as the SQL lexer sees it, with comments taken out. A block-comment
 * opener inside a "--" line comment does not open a block (PART 2's header
 * mentions the marker), block comments nest, and a "--" inside a quoted string is
 * not a comment. lines=false keeps the "--" comments: THE CHANGE is delimited by two.
 */
function strip(text, { lines }) {
  let out = "", i = 0, quote = false;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (!quote && c === "/" && d === "*") {
      let depth = 1; i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") { depth++; i += 2; }
        else if (text[i] === "*" && text[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      out += " ";
      continue;
    }
    if (!quote && c === "-" && d === "-") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      if (!lines) out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "'") quote = !quote;
    out += c; i++;
  }
  return out;
}
/** What a client would actually run, minus block comments only... */
const withoutBlockComments = (text) => strip(text, { lines: false });
/** ...and minus every comment. */
const code = (text) => strip(text, { lines: true });
const executing = code(sql);
const part2 = sql.match(/\/\* PART 2 BEGINS\n([\s\S]*?)\nPART 2 ENDS \*\//);
const part3 = sql.match(/\/\* PART 3 BEGINS\n([\s\S]*?)\nPART 3 ENDS \*\//);
const change = (s) => {
  const m = [...s.matchAll(/-- ==== THE CHANGE: BEGIN ====\n([\s\S]*?)-- ==== THE CHANGE: END ====/g)];
  return m.map((x) => x[1]);
};

/** Every recorded check in the dry run, in order: perform pg_temp.<q|x|s>(subject, pair, role, key, ...). */
function checksOf(text) {
  const out = [];
  for (const m of text.matchAll(/^  perform pg_temp\.([qxs])\('((?:[^']|'')*)','((?:[^']|'')*)','((?:[^']|'')*)','((?:[^']|'')*)',/gm)) {
    out.push({ fn: m[1], subject: m[2].replace(/''/g, "'"), pair: m[3], role: m[4], k: m[5].replace(/''/g, "'") });
  }
  return out;
}
const CHECKS = checksOf(sql);

// ===================================================================== A1 ===
test("STATIC: the SQL file is a rolled-back dry run with a separate, commented apply and reverse", () => {
  assert.ok(part2, "PART 2 (apply) must be a block comment opened by /* PART 2 BEGINS");
  assert.ok(part3, "PART 3 (reverse) must be a block comment opened by /* PART 3 BEGINS");
  assert.match(sql, /STATUS: NOT APPLIED/);

  // What executes: one transaction, ending in rollback, that cannot commit.
  const stmts = executing.split(";").map((x) => x.trim()).filter(Boolean);
  assert.equal(stmts[0].replace(/\s+/g, " ").startsWith("begin"), true, "the first statement is BEGIN");
  assert.equal(stmts.at(-1), "rollback", "the last statement is ROLLBACK");
  assert.equal((executing.match(/\bbegin\s*;/gi) || []).length, 1, "exactly one top-level BEGIN");
  assert.equal((executing.match(/\brollback\s*;/gi) || []).length, 1, "exactly one ROLLBACK");
  assert.doesNotMatch(executing, /\bcommit\b/i, "PART 1 must not be able to commit");
  assert.doesNotMatch(executing, /\bsavepoint\b|\bprepare\s+transaction\b/i);

  // PART 2 is the only commit, and PART 3 is the only other one.
  assert.equal((part2[1].match(/^commit;$/gm) || []).length, 1, "PART 2 commits once");
  assert.match(part2[1], /^begin;$/m);
  assert.equal((part3[1].match(/^commit;$/gm) || []).length, 1, "PART 3 commits once");
  assert.match(part3[1], /^begin;$/m);
});

test("STATIC: the statements PART 2 would commit are byte for byte the ones PART 1 proved", () => {
  const dry = change(withoutBlockComments(sql));
  const applied = change(part2[1]);
  assert.equal(dry.length, 1, "PART 1 has exactly one THE CHANGE block");
  assert.equal(applied.length, 1, "PART 2 has exactly one THE CHANGE block");
  assert.equal(applied[0], dry[0], "PART 2's change differs from PART 1's: what was proven is not what would be applied");
  assert.ok(dry[0].length > 3000, "the change block is not empty");
  // ...and it is the whole change: the table, the three functions, the door, the grants.
  for (const needle of [
    "create table if not exists public.company_join_codes",
    "enable row level security",
    "revoke all on table public.company_join_codes from public, anon, authenticated",
    "create or replace function public.crew_join_code()",
    "create or replace function public.crew_join_code_for_invite()",
    "create or replace function public.rotate_join_code()",
    "create or replace function public.join_company(",
    "revoke all on function public.crew_join_code()",
  ]) assert.ok(dry[0].includes(needle), `the change is missing: ${needle}`);
});

test("STATIC: the reverse puts the deployed join_company back byte for byte and deletes no data", () => {
  const m = part3[1].match(/as \$function\$([\s\S]*?)\$function\$;/);
  assert.ok(m, "PART 3 restores join_company");
  assert.equal(md5(m[1]), DEPLOYED_JOIN_COMPANY_MD5, "the body PART 3 restores is not the deployed one");
  const guard = readFileSync(GUARD_URL, "utf8").replace(/\r\n/g, "\n").match(/as \$function\$([\s\S]*?)\$function\$/);
  assert.equal(m[1], guard[1], "PART 3's body differs from supabase_join_company_guard.sql, the repo's record of it");
  assert.match(part3[1], /set search_path to 'public'\nas \$function\$/, "the original search_path setting is restored too");
  assert.ok(part3[1].includes(`<> '${DEPLOYED_JOIN_COMPANY_MD5}'`), "PART 3 refuses to commit unless the original is back");
  // What it removes: only the three functions this change added. The table drop is left as a comment.
  const drops = [...part3[1].matchAll(/^\s*drop\s+(\w+)\s+(?:if exists\s+)?([\w.()]+)/gim)].map((x) => `${x[1]} ${x[2]}`);
  assert.deepEqual(drops, ["function public.crew_join_code()", "function public.crew_join_code_for_invite()", "function public.rotate_join_code()"]);
  assert.match(part3[1], /^-- drop table public\.company_join_codes;$/m, "dropping the table stays a commented line");
  assert.doesNotMatch(part3[1].replace(/^--.*$/gm, ""), /\b(delete|truncate)\b|drop\s+table/i);
});

test("STATIC: nothing that runs deletes or drops, writes only synthetic rows, and never uses the bypass role", () => {
  assert.doesNotMatch(sql, /service_role/i, "the bypass role is named nowhere in the file");
  assert.doesNotMatch(executing, /\b(delete\s+from|truncate|drop|alter\s+role|alter\s+system|create\s+role|grant\s+[^;]*\bto\s+(?:postgres|public)\b)/i);
  // Every impersonated role is the anonymous or the signed-in one.
  const roles = [...executing.matchAll(/set local role (\w+)/gi)].map((x) => x[1].toLowerCase());
  assert.ok(roles.length > 0);
  assert.deepEqual([...new Set(roles)].sort(), ["anon", "authenticated"]);
  assert.doesNotMatch(executing, /\bset\s+(session\s+)?(local\s+)?session\s+authorization|\bset\s+role\b/i);
  // Every fixture row and every write onto a public table is in the a26 namespace.
  const NS = /a26[0-9a-f]0000-0000-4000-8000-[0-9a-f]{12}/;
  // (The change itself is cut out: its own insert into profiles is the join, which is not a fixture.)
  const changeText = change(withoutBlockComments(sql))[0];
  const outsideChange = withoutBlockComments(sql).replace(changeText, "");
  assert.ok(outsideChange.length < sql.length - changeText.length, "the change block was not cut out of the text being checked");
  const writes = [...code(outsideChange).matchAll(/\binsert\s+into\s+((?:public|auth)\.\w+)([\s\S]*?);/gi)];
  assert.ok(writes.length >= 9, "the fixtures are there to check");
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  for (const w of writes) {
    assert.match(w[0], NS, `an insert into ${w[1]} that is not a synthetic a26 row: ${w[0].slice(0, 120)}`);
    // Every id a fixture names -- its own, its company, its user -- is synthetic. None points at a real row.
    for (const u of w[0].match(UUID) ?? []) assert.match(u, NS, `an insert into ${w[1]} names ${u}, which is not in the a26 namespace`);
  }
  const updates = [...code(outsideChange).matchAll(/\bupdate\s+public\.(\w+)[\s\S]*?(?=\$q\$|;)/gi)];
  for (const u of updates) assert.match(u[0], NS, `an update of public.${u[1]} that is not on a synthetic a26 row`);
  // The fixtures are named as probe data.
  assert.match(executing, /PROBE-A26-VICTIM/);
  assert.match(executing, /@probe\.invalid/);
});

test("STATIC: every attack in the dry run has a control beside it, and the counts add up", () => {
  assert.ok(CHECKS.length >= 100, `only ${CHECKS.length} checks parsed`);
  const key = (c) => `${c.subject}/${c.pair}`;
  const by = new Map();
  for (const c of CHECKS) by.set(key(c), [...(by.get(key(c)) ?? []), c.role]);
  // A pair's control may be a sibling pair when the same working call is the control (say which).
  const CONTROLLED_BY = {
    "join_company/door_profile_row": "join_company/door",   // the live-call control: a wrong uuid is refused by the same door
    "join_company/guessing": "join_company/door",
    "join_company/shadow": "join_company/door",
    "join_company/removed": "join_company/legit",           // the same call with a valid code and no removal works
    "join_company/seat_cap": "join_company/legit",
    "crew_join_code/who": "crew_join_code/who",
    "rotate_join_code/who": "rotate_join_code/who",
    "join_company/replaced": "join_company/replaced",
    "company_join_codes/direct": "company_join_codes/direct",
    "join_company/cross": "join_company/cross",
    "crew_join_code_for_invite/who": "crew_join_code_for_invite/who",
  };
  const uncontrolled = [];
  for (const [k, roles] of by) {
    if (!roles.includes("probe")) continue;
    const via = CONTROLLED_BY[k] ?? k;
    if (!(by.get(via) ?? []).includes("control")) uncontrolled.push(k);
  }
  assert.deepEqual(uncontrolled, [], "an attack with no control: a refusal there could be a typo");
  // The headline pairs, each with a control of its own.
  for (const p of ["join_company/door", "join_company/reads_jobs", "join_company/reads_customers", "join_company/reads_members",
    "join_company/writes_jobs", "join_company/writes_customers", "join_company/legit", "join_company/replaced"]) {
    assert.ok(by.get(p)?.includes("control"), `${p} has no control`);
  }
  assert.ok(by.get("join_company/before")?.every((r) => r === "baseline"), "the before-the-change rows are baselines");
  // The header's claim of how many checks pass is the number the file really has.
  assert.match(sql, new RegExp(`${CHECKS.length} of ${CHECKS.length} checks pass`), "the header states a different number of checks than the file has");
});

// ===================================================================== A3 ===
// Running the REAL invite-crew/index.ts against a fake Supabase client and a fake fetch.
const COMPANY_ID = "c0000000-0000-4000-8000-0000000000c1";
const JOIN_CODE = "9e1108ed-ff97-4fdf-9b61-2dd2a069339a";
const SERVICE_CANARY = "canary-service-role-key-do-not-use";
const ANON = "anon-key";
const TOKEN = "caller-token";
const FN_SRC = readFileSync(FN_URL, "utf8");

/**
 * Loads the real function file. `plant` rewrites its source first (a known bug put
 * back), and each rewrite must land, so a renamed line cannot turn a plant into a
 * quiet no-op.
 */
function load({ plant = [], client, fetchImpl, env, logs }) {
  let js = stripTypeScriptTypes(FN_SRC);
  for (const [from, to] of plant) {
    assert.ok(js.includes(from), `plant target not found: ${from}`);
    js = js.replace(from, to);
  }
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  for (const [, list, from] of js.matchAll(importRe)) {
    const names = list.split(",").map((n) => n.trim()).filter(Boolean);
    if (/supabase-js/.test(from)) assert.deepEqual(names, ["createClient"]);
    else if (from === "../_shared/invite-crew-email.ts") assert.deepEqual(names, ["buildInviteCrewEmail"]);
    else assert.fail(`an import the harness does not supply: ${from}`);
  }
  js = js.replace(importRe, "");
  assert.doesNotMatch(js, /^import /m);
  let handler = null;
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const consoleFake = { log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  new Function("Deno", "createClient", "buildInviteCrewEmail", "fetch", "console", js)(
    Deno, client, inviteEmail.buildInviteCrewEmail, fetchImpl, consoleFake);
  assert.equal(typeof handler, "function", "Deno.serve was never called");
  return handler;
}

/** One request through the real handler. */
async function invite({
  auth = `Bearer ${TOKEN}`, body = { name: "New Guy", email: "new.guy@example.com", role: "Foreman" },
  profile = { company_id: COMPANY_ID, role: "OWNER", full_name: "Dana Lee" },
  allowed = true, mail = true, sends = 1, mayShow = true, codeError = null, codeData,
  plant = [],
} = {}) {
  const calls = { createClient: [], rpc: [], from: [], fetch: [] };
  const logs = [];
  const env = {
    SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE_CANARY,
    ...(mail ? { MAIL_API_KEY: "mail-key", MAIL_FROM: "FenceFlow <crew@fenceflowapp.com>" } : {}),
  };
  const tables = {
    profiles: profile,
    companies: { name: "Acme Fencing", phone: "561-555-0142", email: "office@acme.example" },
    app_releases: { version_name: "1.301", download_url: "https://dl.example/fenceflow.apk" },
  };
  const rpcs = {
    company_allowed: () => ({ data: allowed, error: null }),
    crew_join_code_for_invite: () => codeError
      ? { data: null, error: { message: codeError } }
      : { data: codeData !== undefined ? codeData : [{ join_code: JOIN_CODE, may_show: mayShow }], error: null },
    note_invite_send: () => ({ data: sends, error: null }),
  };
  const client = (url, key, opts) => {
    calls.createClient.push({ url, key, opts });
    const builder = (t) => {
      calls.from.push(t);
      const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: tables[t] ?? null, error: null }) };
      return q;
    };
    return {
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
      from: builder,
      rpc: async (name, args) => { calls.rpc.push({ name, args }); return (rpcs[name] ?? (() => ({ data: null, error: { message: `no such rpc ${name}` } })))(); },
    };
  };
  const fetchImpl = async (url, init) => { calls.fetch.push({ url, init }); return { ok: true, status: 200, text: async () => "" }; };
  const handler = load({ plant, client, fetchImpl, env, logs });
  const headers = new Headers(auth ? { Authorization: auth } : {});
  const res = await handler(new Request("https://f.example/invite-crew", { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, text, json, calls, logs, mailBodies: calls.fetch.map((f) => String(f.init?.body ?? "")) };
}

/** Every behaviour the real file must have. Returns the labels of the ones that failed (empty: all held). */
async function scenarios(plant = []) {
  const failed = [];
  const check = (label, cond) => { if (!cond) failed.push(label); };
  const contains = (s, needle) => String(s).includes(needle);

  // 1. The owner invites somebody. The email carries the team code and never the company id.
  const a = await invite({ plant });
  check("owner: 200 and sent", a.status === 200 && a.json?.sent === true);
  check("owner: exactly one email went out", a.calls.fetch.length === 1);
  check("owner: the email carries the team code", a.mailBodies.every((b) => contains(b, JOIN_CODE)) && a.mailBodies.length === 1);
  check("owner: the email does NOT carry the company id, anywhere", a.mailBodies.every((b) => !contains(b, COMPANY_ID)));
  check("owner: the response does not carry the company id or the code", !contains(a.text, COMPANY_ID) && !contains(a.text, JOIN_CODE));
  check("owner: the code is fetched exactly once, after the account was checked", a.calls.rpc.filter((r) => r.name === "crew_join_code_for_invite").length === 1
    && a.calls.rpc.findIndex((r) => r.name === "company_allowed") < a.calls.rpc.findIndex((r) => r.name === "crew_join_code_for_invite"));
  check("owner: the send was counted before the mail went out", a.calls.rpc.some((r) => r.name === "note_invite_send"));

  // 2. A manager invites somebody: same email, no code handed back to them.
  const m = await invite({ plant, profile: { company_id: COMPANY_ID, role: "MANAGER", full_name: "Mo" }, mayShow: false });
  check("manager: 200 and sent", m.status === 200 && m.json?.sent === true);
  check("manager: the email carries the code and not the id", m.mailBodies.length === 1 && contains(m.mailBodies[0], JOIN_CODE) && !contains(m.mailBodies[0], COMPANY_ID));

  // 3. No mail provider configured: the owner is handed the team code (never the id) to give by hand.
  const o503 = await invite({ plant, mail: false });
  check("no mail, owner: 503", o503.status === 503);
  check("no mail, owner: gets the team code", o503.json?.code === JOIN_CODE);
  check("no mail, owner: the company id appears nowhere in the response", !contains(o503.text, COMPANY_ID));
  check("no mail, owner: nothing was sent", o503.calls.fetch.length === 0);

  // 4. ...but a manager who may not be shown the code is told to ask, and is not handed it.
  const m503 = await invite({ plant, mail: false, profile: { company_id: COMPANY_ID, role: "MANAGER", full_name: "Mo" }, mayShow: false });
  check("no mail, manager: 503", m503.status === 503);
  check("no mail, manager: no code field", m503.json && !("code" in m503.json));
  check("no mail, manager: neither the code nor the company id in the response", !contains(m503.text, JOIN_CODE) && !contains(m503.text, COMPANY_ID));
  check("no mail, manager: told to ask the owner", /owner/i.test(m503.json?.error ?? ""));

  // 5. Who is refused before a code is even fetched.
  const crew = await invite({ plant, profile: { company_id: COMPANY_ID, role: "CREW", full_name: "C" } });
  check("crew: 403, no code fetched, nothing sent", crew.status === 403 && !crew.calls.rpc.some((r) => r.name === "crew_join_code_for_invite") && crew.calls.fetch.length === 0);
  const stranger = await invite({ plant, profile: { company_id: null, role: "CREW", full_name: "" } });
  check("no company: 403, no code fetched, nothing sent", stranger.status === 403 && !stranger.calls.rpc.some((r) => r.name === "crew_join_code_for_invite") && stranger.calls.fetch.length === 0);
  const suspended = await invite({ plant, allowed: false });
  check("suspended account: 403, no code fetched, nothing sent", suspended.status === 403 && !suspended.calls.rpc.some((r) => r.name === "crew_join_code_for_invite") && suspended.calls.fetch.length === 0);
  const noAuth = await invite({ plant, auth: null });
  check("no login: 401, nothing sent", noAuth.status === 401 && noAuth.calls.fetch.length === 0);
  const badEmail = await invite({ plant, body: { name: "X", email: "not-an-email" } });
  check("bad address: 400, nothing sent", badEmail.status === 400 && badEmail.calls.fetch.length === 0);

  // 6. FAILS CLOSED. If the code cannot be read (the SQL is not applied yet), nothing is sent and the id is never used instead.
  const missing = await invite({ plant, codeError: "Could not find the function public.crew_join_code_for_invite without parameters in the schema cache" });
  check("code unreadable: 500", missing.status === 500);
  check("code unreadable: nothing sent", missing.calls.fetch.length === 0);
  check("code unreadable: no company id in the response", !contains(missing.text, COMPANY_ID));
  const empty = await invite({ plant, codeData: [] });
  check("no code returned: 500 and nothing sent", empty.status === 500 && empty.calls.fetch.length === 0);
  const emptyNoMail = await invite({ plant, codeData: [], mail: false });
  check("no code returned, no mail: 500, and the id is not offered as the code", emptyNoMail.status === 500 && !contains(emptyNoMail.text, COMPANY_ID));

  // 7. The quota still holds, and is checked before anything goes out.
  const capped = await invite({ plant, sends: 21 });
  check("twenty-first invitation in an hour: 429, nothing sent", capped.status === 429 && capped.calls.fetch.length === 0);

  // 8. The caller's own client, never the service role.
  const all = [a, m, o503, m503, crew, missing];
  check("one client per request, built with the anon key and the caller's own bearer token",
    all.every((r) => r.calls.createClient.length === 1 && r.calls.createClient[0].key === ANON
      && r.calls.createClient[0].opts?.global?.headers?.Authorization === `Bearer ${TOKEN}`));
  check("the service role key never reaches a client, a request or a log",
    all.every((r) => !JSON.stringify(r.calls).includes(SERVICE_CANARY) && !r.logs.join("\n").includes(SERVICE_CANARY)));

  // 9. The code is a credential: it is not logged.
  check("the team code is never written to the log", all.every((r) => !r.logs.join("\n").includes(JOIN_CODE)));
  return failed;
}

test("STATIC: invite-crew emails the team code, never the company id, and fails closed", async () => {
  const failed = await scenarios();
  assert.deepEqual(failed, [], "the real invite-crew/index.ts does not behave as the join door requires");
});

test("STATIC: invite-crew's checks have teeth -- each old behaviour put back is caught", async () => {
  const plants = {
    "the email carries the company id again": [["code: joinCode,\n      downloadUrl", "code: companyId,\n      downloadUrl"]],
    "the no-mail fallback hands out the company id": [["          code: joinCode,\n        }, 503);", "          code: companyId,\n        }, 503);"]],
    "the no-mail fallback shows the code to a manager who may not see it": [["if (mayShowCode) {", "if (true) {"]],
    "an unreadable code falls back to the company id": [
      ["const joinCode = String(codeRow?.join_code ?? \"\").trim();", "const joinCode = String(codeRow?.join_code ?? \"\").trim() || String(profile.company_id);"],
      ["if (codeError || !joinCode) {", "if (false) {"],
    ],
    "the code is fetched for a crew member too": [["if (profile.role !== \"OWNER\" && profile.role !== \"MANAGER\") {", "if (false) {"]],
    "the code is written to the log": [["const mayShowCode = codeRow?.may_show === true;", "const mayShowCode = codeRow?.may_show === true; console.log(`code ${joinCode}`);"]],
    "the client is built with the service role key": [["Deno.env.get(\"SUPABASE_ANON_KEY\") ,", "Deno.env.get(\"SUPABASE_SERVICE_ROLE_KEY\") ,"]],
  };
  for (const [what, plant] of Object.entries(plants)) {
    const failed = await scenarios(plant);
    assert.ok(failed.length > 0, `planting "${what}" was not caught by any check`);
  }
});

test("STATIC: invite-crew no longer claims the company id is the code", () => {
  for (const stale of [
    /company's own id/i, /the id IS the code/i, /code: companyId/, /same value the Account screen's Copy\/Share/i,
    /Nowhere to record the send/i, /the limit is skipped rather than faked/i,
  ]) assert.doesNotMatch(FN_SRC, stale, `a stale claim is still in invite-crew/index.ts: ${stale}`);
  assert.match(FN_SRC, /crew_join_code_for_invite/);
  assert.doesNotMatch(FN_SRC, /SERVICE_ROLE/i, "the function never names the service role");
});

// ===================================================================== B =====
function runSql(text, label) {
  const dir = mkdtempSync(join(tmpdir(), "a26-"));
  const file = join(dir, "probe.sql");
  writeFileSync(file, text, "utf8");
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    const err = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    // A SQL error is an answer, not a flake: never retried, never read as "no rows".
    if (/Failed to run sql query|ERROR:/.test(err) && !/"rows"/.test(r.stdout ?? "")) {
      throw new Error(`${label}: the database refused it:\n${err.slice(0, 1500)}`);
    }
    if (r.status === 0) {
      const out = r.stdout ?? "";
      const a = out.indexOf("{"), b = out.lastIndexOf("}");
      if (a >= 0 && b > a) {
        const parsed = JSON.parse(out.slice(a, b + 1));
        const rows = Array.isArray(parsed) ? parsed : parsed.rows;
        if (Array.isArray(rows) && rows.length > 0) return rows;
      }
    }
    last = err.slice(0, 600);
  }
  throw new Error(`${label}: no usable answer after 3 attempts (a failed call is not an empty result): ${last}`);
}

function probeRows(text, label) {
  const rows = runSql(text, label);
  const last = rows[rows.length - 1];
  assert.equal(last.subject, "SUMMARY", `${label}: no SUMMARY row`);
  assert.equal(rows.length, CHECKS.length + 1, `${label}: ${rows.length - 1} rows came back for ${CHECKS.length} checks: a check was lost`);
  CHECKS.forEach((c, i) => {
    assert.equal(rows[i].subject, c.subject, `${label}: row ${i} is ${rows[i].subject}, expected ${c.subject}`);
    assert.equal(rows[i].k, c.k, `${label}: row ${i} is "${rows[i].k}", expected "${c.k}"`);
  });
  const [ok, total] = last.got.split("/").map(Number);
  assert.equal(total, CHECKS.length, `${label}: SUMMARY counts ${total} checks, expected ${CHECKS.length}`);
  return { rows: rows.slice(0, -1), ok, total };
}

const failing = (rows) => rows.filter((r) => r.result === "FAIL");
const where = (rows, subject, pair, role) => rows.filter((r) => r.subject === subject && r.pair === pair && (!role || r.role === role));

function state() {
  return runSql(`select
    (select md5(prosrc) from pg_proc where proname='join_company' and pronamespace='public'::regnamespace) as join_md5,
    (to_regclass('public.company_join_codes') is not null) as applied,
    (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('crew_join_code','crew_join_code_for_invite','rotate_join_code')) as new_fns,
    (select count(*) from pg_policies) as policies;`, "state")[0];
}

function assertNothingLeft(label) {
  const rows = runSql(`select
    (select count(*) from auth.users where email like 'a26-%@probe.invalid') as users,
    (select count(*) from public.companies where name like 'PROBE-A26%' or id::text like 'a26%') as companies,
    (select count(*) from public.profiles where id::text like 'a26%') as profiles,
    (select count(*) from public.jobs where id::text like 'a26%' or company_id::text like 'a26%') as jobs,
    (select count(*) from public.customers where company_id::text like 'a26%') as customers,
    (select count(*) from public.payment_records where company_id::text like 'a26%') as payments,
    (select count(*) from public.job_payments where company_id::text like 'a26%') as job_payments,
    (select count(*) from public.audit_log where company_id::text like 'a26%') as audit,
    (select count(*) from net.http_request_queue where body::text ilike '%a26%' or url ilike '%a26%') as http_calls;`, `${label}: leftover check`);
  assert.deepEqual(rows[0], { users: 0, companies: 0, profiles: 0, jobs: 0, customers: 0, payments: 0, job_payments: 0, audit: 0, http_calls: 0 },
    `${label}: the dry run left something behind (or queued an HTTP call): the rollback did not happen`);
}

let before = null;
test("LIVE: nothing is applied and the deployed join_company is the one the reverse restores", { skip: !LIVE }, () => {
  before = state();
  assert.equal(before.applied, false, "supabase_r18_join_door.sql is already applied: the baseline (the hole) can no longer be reproduced, and this suite is for the dry run");
  assert.equal(before.new_fns, 0);
  assert.equal(before.join_md5, DEPLOYED_JOIN_COMPANY_MD5, "the deployed join_company is not the body PART 3 would restore: someone changed it since this file was written");
});

test("LIVE: the dry run -- the hole is reproduced, then closed, and every legitimate path works", { skip: !LIVE, timeout: 600_000 }, () => {
  const { rows, ok, total } = probeRows(sql, "dry run");
  assert.deepEqual(failing(rows).map((r) => `${r.subject}/${r.pair}/${r.k}: ${r.got}`), [], "the dry run has failing checks");
  assert.equal(ok, total);

  // The baseline: on the DEPLOYED function the attack works. If it did not, the refusals below would prove nothing.
  const base = where(rows, "join_company", "before", "baseline");
  assert.equal(base.length, 6);
  assert.equal(base[0].got, "rows=1", "the stranger did not get in on the deployed function: the hole was not reproduced");
  assert.equal(base[1].got, "true", "...and become CREW of B");
  assert.ok(Number(base[2].got) >= 1, "...and read B's customers");
  assert.equal(base[3].got, "true", "...and mark B's job COMPLETED");
  assert.equal(base[4].got, "COMPLETED");
  assert.equal(base[5].got, "rows=1", "...and edit B's customer");

  // After: the same attack, refused, beside working controls.
  const door = where(rows, "join_company", "door");
  assert.match(door.find((r) => r.role === "probe").got, /^ERR P0001: That team code is not valid/);
  assert.match(door.find((r) => r.role === "control").got, /^ERR P0001: That team code is not valid/);
  for (const p of ["reads_jobs", "reads_customers", "reads_members", "writes_customers"]) {
    assert.ok(where(rows, "join_company", p, "probe").every((r) => r.result === "PASS"), p);
    assert.ok(where(rows, "join_company", p, "control").length >= 1 && where(rows, "join_company", p, "control").every((r) => r.result === "PASS"), `${p} control`);
  }
  assert.equal(where(rows, "join_company", "writes_jobs", "readback")[0].got, "ACCEPTED");
  const legit = where(rows, "join_company", "legit");
  assert.equal(legit[0].got, "rows=1", "a legitimate joiner with the current code did not get in");
  const owner = where(rows, "crew_join_code_for_invite", "who", "control");
  assert.deepEqual(owner.map((r) => r.got), ["true/true", "true/false", "true"]);
  assert.match(where(rows, "rotate_join_code", "who", "control")[0].got, /^[0-9a-f-]{36}$/);
});

test("LIVE: the dry run applied nothing and left nothing", { skip: !LIVE, timeout: 300_000 }, () => {
  assertNothingLeft("after the dry run");
  const after = state();
  assert.deepEqual(after, before, "the database is not exactly as it was before the dry run");
});

const SEG = /(-- 5\. THE DOOR\.[\s\S]*?)(-- 6\. WHO MAY CALL WHAT)/;

test("LIVE: the probe has teeth -- with the OLD join_company put back the attack rows go red", { skip: !LIVE, timeout: 600_000 }, () => {
  const m = part3[1].match(/(create or replace function public\.join_company\([\s\S]*?\$function\$;)/);
  assert.ok(m && SEG.test(sql));
  const sabotaged = sql.replace(SEG, (_, _door, next) => `${m[1]}\n\n${next}`);
  assert.notEqual(sabotaged, sql);
  const { rows } = probeRows(sabotaged, "old door");
  const red = failing(rows);
  const has = (subject, pair, role) => red.some((r) => r.subject === subject && r.pair === pair && r.role === role);
  assert.ok(has("join_company", "door", "probe"), "the id-only join was not caught");
  assert.ok(has("join_company", "door", "readback"), "...nor the stranger ending up in a company");
  assert.ok(has("join_company", "door_profile_row", "probe"));
  assert.ok(has("join_company", "reads_jobs", "probe"), "...nor the stranger reading B's jobs");
  assert.ok(has("join_company", "reads_customers", "probe"), "...nor B's customers");
  assert.ok(has("join_company", "reads_members", "probe"));
  assert.ok(has("join_company", "writes_customers", "probe"), "...nor editing a customer");
  assert.ok(red.some((r) => r.pair === "writes_jobs"), "...nor marking a job COMPLETED");
  // The controls beside those attacks are still green: the red comes from the door, not from a dead query.
  for (const p of ["reads_jobs", "reads_customers", "reads_members", "writes_customers", "writes_jobs"]) {
    assert.ok(where(rows, "join_company", p, "control").every((r) => r.result === "PASS"), `${p}: a control went red too, so the red is not evidence`);
  }
  assertNothingLeft("after the old-door run");
});

test("LIVE: the probe has teeth -- a door that can be shadowed with a temp table is caught", { skip: !LIVE, timeout: 600_000 }, () => {
  const sabotaged = sql.replace(SEG, (_, door, next) => `${door
    .replace("from public.company_join_codes j", "from company_join_codes j")
    .replace("set search_path = public, pg_temp\nas $function$\ndeclare\n    joining_company", "set search_path = public\nas $function$\ndeclare\n    joining_company")}${next}`);
  assert.notEqual(sabotaged, sql);
  const { rows } = probeRows(sabotaged, "shadowable door");
  const red = failing(rows);
  assert.ok(red.some((r) => r.pair === "shadow" && r.role === "probe"), "a stranger's own code table was not caught");
  assert.ok(red.some((r) => r.pair === "search_path"), "...nor the unpinned search path");
  assertNothingLeft("after the shadowable-door run");
});

test("LIVE: PART 2 (apply) then PART 3 (reverse), in one rolled-back transaction, end where they started", { skip: !LIVE, timeout: 600_000 }, () => {
  // The blocks are cut out of the comments exactly as a person would, with the two
  // marker lines gone; their own BEGIN and COMMIT are dropped so both run inside ours.
  const inner = (block) => block.replace(/^begin;\n/m, "").replace(/\ncommit;\s*$/m, "\n");
  assert.ok(/^begin;$/m.test(part2[1]) && /^commit;$/m.test(part2[1]) && /^begin;$/m.test(part3[1]) && /^commit;$/m.test(part3[1]));
  const run = `begin;
set local lock_timeout = '5s';
${inner(part2[1])}
create temp table mid as select
  (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('crew_join_code','crew_join_code_for_invite','rotate_join_code')) as new_fns,
  position('company_join_codes' in (select prosrc from pg_proc where proname='join_company' and pronamespace='public'::regnamespace)) > 0 as door_reads_code,
  (to_regclass('public.company_join_codes') is not null) as table_there;
${inner(part3[1])}
select
  (select md5(prosrc) from pg_proc where proname='join_company' and pronamespace='public'::regnamespace) as join_md5,
  (select proconfig::text from pg_proc where proname='join_company' and pronamespace='public'::regnamespace) as join_cfg,
  (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('crew_join_code','crew_join_code_for_invite','rotate_join_code')) as new_fns_after_reverse,
  has_function_privilege('anon','public.join_company(uuid,text,text)','execute') as anon_can_join,
  has_function_privilege('authenticated','public.join_company(uuid,text,text)','execute') as signed_in_can_join,
  (select new_fns from mid) as new_fns_after_apply,
  (select door_reads_code from mid) as door_read_code_after_apply,
  (select table_there from mid) as table_after_apply,
  (to_regclass('public.company_join_codes') is not null) as table_left_by_reverse;
rollback;`;
  const r = runSql(run, "apply then reverse")[0];
  assert.equal(r.new_fns_after_apply, 3, "PART 2 did not make the three functions");
  assert.equal(r.door_read_code_after_apply, true, "PART 2 did not put the new door in");
  assert.equal(r.table_after_apply, true);
  assert.equal(r.join_md5, DEPLOYED_JOIN_COMPANY_MD5, "PART 3 did not restore the deployed join_company byte for byte");
  assert.equal(r.join_cfg, "{search_path=public}", "PART 3 did not restore the original search_path setting");
  assert.equal(r.new_fns_after_reverse, 0, "PART 3 left a new function behind");
  assert.equal(r.anon_can_join, false);
  assert.equal(r.signed_in_can_join, true);
  assert.equal(r.table_left_by_reverse, true, "the reverse is documented to leave the (inert) table; it did not");
  // ...and it was all rolled back.
  assert.deepEqual(state(), before, "the database is not exactly as it was before this test");
});
