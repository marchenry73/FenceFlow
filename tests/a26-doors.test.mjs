// a26 -- THE FIVE FUNCTION DOORS. Can a signed-in stranger reach another business
// through a SECURITY DEFINER function (or the one policy) that skips the walls the
// tables enforce?
//
// supabase_r19_function_doors.sql closes five of them (numbered as the reviewer
// numbered them; the file orders them by damage: 1, 5, 3, 2, 4):
//   1 recompute_job_totals  a stranger WRITES another business's job totals
//   5 device_keys_read      a crew login reads the unused device keys
//   3 app_errors            crash reports filed against any business, unbounded
//   2 company_allowed       any business's billing standing, by id
//   4 register_device_token any phone's push token re-pointed at the caller
// Doors 5 and 3 are written ready to apply (PART 2). Door 4 is written but HELD
// (PART 3): a real caller is at risk. Doors 1 and 2 are DRY RUN ONLY: nothing in the
// file can apply them. This test is what stands between "written" and "believed".
//
//   A. STATIC (pure, no network, about a second)
//      1. The file is inert: one transaction that ends in ROLLBACK, apply and reverse
//         in block comments, the statements PART 2/3 would commit byte for byte the
//         ones PART 1 proved, doors 1 and 2 nowhere in any apply block.
//      2. The reverse restores the deployed functions exactly: the definitions
//         embedded in it hash (md5) to the values production reports today, the
//         CRLF body of register_device_token included.
//      3. The guards read what they must: the caller's JWT through the helpers this
//         database already has, never current_user, never "auth.uid() is null" as the
//         server test, and door 1 has its NULL trap covered.
//      4. The probe is honest: every recorded check ends in a definite answer, every
//         door has attacks AND controls, every attack runs as anon or authenticated,
//         the bypass role is never assumed, every fixture is synthetic, nothing
//         destructive runs, and the number in the header is the number of rows.
//      5. The PREMISES the file's header states about who calls what are checked
//         against the source, so a new caller fails a test instead of a customer.
//
//   B. LIVE (A26_DOORS_LIVE=1, about six minutes, every run rolled back)
//      Runs PART 1 against production and demands every row PASS; proves it left
//      nothing behind; rehearses PART 2, 3 and 4 with COMMIT swapped for ROLLBACK;
//      runs PART 1 on top of already-applied doors; and runs sixteen deliberately
//      BROKEN versions of the change, demanding each one turns the right rows red: a
//      probe that stays green with the wall knocked down was never measuring the wall.
//
//   node --test tests/a26-doors.test.mjs                  STATIC only
//   A26_DOORS_LIVE=1 node --test tests/a26-doors.test.mjs STATIC + LIVE
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT = "newcrgafcptspmapacrx";
const LIVE = process.env.A26_DOORS_LIVE === "1";
const ROOT = new URL("..", import.meta.url);
const rootPath = ROOT.pathname.replace(/^\/([A-Za-z]:)/, "$1");
// A26_DOORS_SQL points the whole test at another copy of the file. It exists so the static checks can be shown to have
// teeth: run them against a copy with one thing broken and they must fail.
const SQL_URL = process.env.A26_DOORS_SQL ? pathToFileURL(process.env.A26_DOORS_SQL) : new URL("../supabase_r19_function_doors.sql", import.meta.url);
const sql = readFileSync(SQL_URL, "utf8");
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/** The md5 of pg_get_functiondef() of each function production had on 2026-09-30, before this file. */
const DEPLOYED = {
  recompute_job_totals: "47177b2717e22f59f32d62645904caaf",
  company_allowed: "58d2f4b972cf4106f95cf1981df8fd0e",
  company_is_suspended: "243565dc402ef3ed397598cd5039b8da",
  register_device_token: "9c5184da36904b48e3d1ab1db6900218",
};
const DEPLOYED_POLICY = "(company_id = current_company_id())";

// ------------------------------------------------------------ SQL scanning --
/**
 * The file as the SQL lexer sees it. Line comments and (nested) block comments are
 * removed; single-quoted strings, quoted identifiers and dollar-quoted bodies are
 * kept whole and never searched for comments (a "--" inside a body is the body's).
 */
function lex(text, { comments }) {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i], d = text[i + 1];
    if (c === "-" && d === "-") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      if (comments) out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1; i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") { depth++; i += 2; }
        else if (text[i] === "*" && text[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      out += " ";
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < text.length) { if (text[j] === "'" && text[j + 1] === "'") j += 2; else if (text[j] === "'") break; else j++; }
      out += text.slice(i, j + 1); i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j++;
      out += text.slice(i, j + 1); i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(text.slice(i, i + 80));
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        if (end < 0) throw new Error("unterminated dollar quote " + m[0]);
        out += text.slice(i, end + m[0].length); i = end + m[0].length;
        continue;
      }
    }
    out += c; i++;
  }
  return out;
}
/** What would execute: comments gone, nothing else touched. */
const executing = lex(sql, { comments: false });
/** The same with every dollar-quoted body blanked, so only top-level statements remain. */
const topLevel = executing.replace(/\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1\$/g, (m) => "$$BODY$$");
/** A function or DO body without its "--" comments (a body is text to the lexer, but its comments are not code). */
const bodyCode = (t) => t.replace(/--[^\n]*/g, "");

const part = (n) => {
  const m = sql.match(new RegExp(`/\\* PART ${n} BEGINS\\n([\\s\\S]*?)\\nPART ${n} ENDS \\*/`));
  return m ? m[1] : null;
};
const part1Start = sql.indexOf("\nbegin;\nset local lock_timeout");
const part1End = sql.indexOf("\nrollback;\n", part1Start) + "\nrollback;\n".length;
const PART1 = sql.slice(part1Start + 1, part1End);
const PART2 = part(2), PART3 = part(3), PART4 = part(4);

const blocks = (text, kind) => {
  const out = new Map(), order = [];
  for (const m of text.matchAll(new RegExp(`-- ==== ${kind} (\\d) [^\\n]*: BEGIN ====\\n([\\s\\S]*?)-- ==== ${kind} \\1: END ====\\n`, "g"))) {
    assert.ok(!out.has(m[1]), `${kind} ${m[1]} appears twice in one part`);
    out.set(m[1], m[2]); order.push(m[1]);
  }
  return { map: out, order };
};
const CHANGE1 = blocks(PART1, "FIX"), REVERSE1 = blocks(PART1, "REVERSE");

/** Every recorded check in the dry run, in order: perform pg_temp.<q|x|s|sx|b|bx>(subject, pair, role, key, ...). */
function checksOf(text) {
  const out = [];
  for (const m of text.matchAll(/^  perform pg_temp\.(q|x|s|sx|b|bx)\('((?:[^']|'')*)','((?:[^']|'')*)','((?:[^']|'')*)','((?:[^']|'')*)',/gm)) {
    out.push({ fn: m[1], subject: m[2], pair: m[3], role: m[4], k: m[5].replace(/''/g, "'") });
  }
  return out;
}
const CHECKS = checksOf(PART1);
const DIRECT_ROWS = [...PART1.matchAll(/^  insert into r\(subject,pair,role,k,got,want\) values \('/gm)].length;
const EXPECTED_ROWS = CHECKS.length + DIRECT_ROWS;

// ===================================================================== A1 ===
test("STATIC: the SQL file is an inert dry run with a commented apply and reverse", () => {
  assert.match(sql.slice(0, 1200), /STATUS: NOT APPLIED/);
  assert.ok(PART1 && PART2 && PART3 && PART4, "PART 1 to 4 are all present");
  const code = topLevel.trim();
  assert.match(code, /^begin;/i, "the first statement is begin");
  assert.equal((code.match(/\bbegin\s*;/gi) ?? []).length, 1, "exactly one top-level begin");
  assert.equal((code.match(/\brollback\s*;/gi) ?? []).length, 1, "exactly one top-level rollback");
  assert.match(code, /rollback\s*;$/i, "it ends in rollback");
  assert.ok(!/\bcommit\b/i.test(code), "nothing commits outside the block comments");
  assert.ok(!/PART [234] BEGINS/.test(executing), "PARTS 2, 3 and 4 are all inside block comments");
  for (const [n, body] of [[2, PART2], [3, PART3], [4, PART4]]) {
    assert.match(body, /^begin;\nset local lock_timeout/, `PART ${n} opens its own transaction with a lock timeout`);
    assert.match(body, /\ncommit;\s*$/, `PART ${n} commits only inside its comment`);
    assert.ok(!/\*\//.test(body), `PART ${n} contains no comment terminator that would end the block early`);
  }
  // A failed check inside an apply block must abort it, not be swallowed.
  for (const [n, body] of [[2, PART2], [3, PART3], [4, PART4]]) {
    assert.match(body, /do \$check\$[\s\S]*raise exception '[^']*nothing committed'[\s\S]*\$check\$;/, `PART ${n} checks itself and aborts before commit`);
  }
});

test("STATIC: the doors are in order of damage, and the apply blocks hold only what was proven", () => {
  assert.deepEqual(CHANGE1.order, ["1", "5", "3", "2", "4"], "THE CHANGE lists the doors in order of damage");
  assert.deepEqual(REVERSE1.order, ["1", "5", "3", "2", "4"], "THE REVERSE lists the doors in the same order");
  const p2 = blocks(PART2, "FIX"), p3 = blocks(PART3, "FIX"), p4 = blocks(PART4, "REVERSE");
  assert.deepEqual(p2.order, ["5", "3"], "PART 2 is doors 5 and 3, and only those");
  assert.deepEqual(p3.order, ["4"], "PART 3 is door 4, and only that");
  for (const n of ["5", "3"]) assert.equal(p2.map.get(n), CHANGE1.map.get(n), `door ${n}: the statements PART 2 commits are byte for byte the ones PART 1 proved`);
  assert.equal(p3.map.get("4"), CHANGE1.map.get("4"), "door 4: PART 3 is byte for byte what PART 1 proved");
  assert.deepEqual(p4.order, ["1", "5", "3", "2", "4"], "PART 4 reverses every door");
  for (const n of p4.order) assert.equal(p4.map.get(n), REVERSE1.map.get(n), `door ${n}: PART 4 is byte for byte the reverse PART 1 proved`);
  // Doors 1 and 2 have no apply block anywhere: their objects are defined only in PART 1 (the change) and PART 4 (the reverse).
  for (const [n, body] of [[2, PART2], [3, PART3]]) {
    const c = bodyCode(body);
    for (const name of ["recompute_job_totals", "company_allowed", "company_is_suspended"]) {
      assert.ok(!new RegExp(`function public\\.${name}\\b`, "i").test(c), `PART ${n} does not define ${name}: doors 1 and 2 are dry run only`);
    }
  }
  const banner = sql.slice(0, 3000).replace(/^-- ?#? ?/gm, " ").replace(/ ?#$/gm, " ").replace(/\s+/g, " ");
  assert.match(banner, /DOOR 1 \(recompute_job_totals\) and DOOR 2 \(company_allowed\): DRY RUN ONLY/, "the header says doors 1 and 2 are dry run only");
  assert.match(banner, /DOOR 4 \(push token\): HELD\. PART 3\. NOT proven safe/, "the header says door 4 is held and not proven safe");
  assert.match(banner, /DOOR 5 \(device_keys\) and DOOR 3 \(crash reports\): SAFE TO APPLY/, "the header says doors 5 and 3 are safe to apply");
});

// ===================================================================== A2 ===
test("STATIC: the reverse restores the deployed functions exactly (md5 of the embedded definitions)", () => {
  const strip = (t) => t.replace(/;\n$/, "\n");
  const r1 = REVERSE1.map.get("1");
  assert.equal(md5(strip(r1)), DEPLOYED.recompute_job_totals, "door 1's reverse is the deployed recompute_job_totals");
  const r2 = REVERSE1.map.get("2");
  const susp = r2.match(/CREATE OR REPLACE FUNCTION public\.company_is_suspended\(\)[\s\S]*?\$function\$;\n/);
  const allowed = r2.match(/CREATE OR REPLACE FUNCTION public\.company_allowed\(cid uuid\)[\s\S]*?\$function\$;\n/);
  assert.ok(susp && allowed, "door 2's reverse carries both definitions");
  assert.equal(md5(strip(susp[0])), DEPLOYED.company_is_suspended, "door 2's reverse is the deployed company_is_suspended");
  assert.equal(md5(strip(allowed[0])), DEPLOYED.company_allowed, "door 2's reverse is the deployed company_allowed");
  assert.match(r2, /drop function if exists public\.company_allowed_unchecked\(uuid\);\n$/, "door 2's reverse ends by dropping the unguarded copy");
  assert.ok(r2.indexOf(susp[0]) < r2.indexOf(allowed[0]) && r2.indexOf(allowed[0]) < r2.indexOf("drop function"), "restore the callers, then the front door, then drop the copy");
  // Door 4: the deployed body has CRLF line endings. Rebuild exactly what the SQL builds and hash what pg_get_functiondef would print.
  const r4 = REVERSE1.map.get("4");
  const def = r4.match(/execute replace\(\$def\$([\s\S]*?)\$def\$, chr\(10\), chr\(13\) \|\| chr\(10\)\);/);
  assert.ok(def, "door 4's reverse rebuilds the CRLF body with chr(13)");
  assert.ok(!r4.includes("\r"), "the SQL file itself carries no carriage return that an editor could strip");
  const at = def[1].indexOf("AS $function$");
  assert.ok(at > 0);
  const header = def[1].slice(0, at);                          // the header pg_get_functiondef prints (LF only)
  const storedBody = def[1].slice(at + "AS $function$".length).replace(/\n/g, "\r\n");   // what execute replace(...) hands to CREATE FUNCTION
  assert.ok(storedBody.endsWith("$function$"));
  const printed = header + "AS $function$" + storedBody.slice(0, -"$function$".length) + "$function$\n";   // what pg_get_functiondef prints back
  assert.equal(md5(printed), DEPLOYED.register_device_token, "door 4's reverse is the deployed register_device_token, CRLF and all");
  // Door 5 and door 3.
  assert.equal(REVERSE1.map.get("5").trim(), `alter policy device_keys_read on public.device_keys\n    using (company_id = public.current_company_id());`);
  assert.match(REVERSE1.map.get("3"), /^drop trigger if exists "00_stamp_app_error_owner" on public\.app_errors;\ndrop function if exists public\.stamp_app_error_owner\(\);\n$/);
  // PART 4's own check compares the live functions with these same constants.
  for (const [name, h] of Object.entries(DEPLOYED)) assert.ok(PART4.includes(`'${h}'`), `PART 4's closing check knows ${name}'s deployed md5`);
});

test("STATIC: the unguarded copy of company_allowed IS the deployed body, and company_is_suspended changes by one callee", () => {
  const change2 = CHANGE1.map.get("2"), rev2 = REVERSE1.map.get("2");
  const depAllowed = rev2.match(/CREATE OR REPLACE FUNCTION public\.company_allowed\(cid uuid\)[\s\S]*?\$function\$;\n/)[0];
  const depSusp = rev2.match(/CREATE OR REPLACE FUNCTION public\.company_is_suspended\(\)[\s\S]*?\$function\$;\n/)[0];
  const unchecked = change2.match(/CREATE OR REPLACE FUNCTION public\.company_allowed_unchecked\(cid uuid\)[\s\S]*?\$function\$;\n/)[0];
  assert.equal(unchecked, depAllowed.replace("public.company_allowed(cid uuid)", "public.company_allowed_unchecked(cid uuid)"), "the unchecked copy is the deployed body under a new name, nothing else");
  const newSusp = change2.match(/CREATE OR REPLACE FUNCTION public\.company_is_suspended\(\)[\s\S]*?\$function\$;\n/)[0];
  assert.equal(newSusp, depSusp.replace("public.company_allowed(", "public.company_allowed_unchecked("), "company_is_suspended differs from the deployed one only in which function it calls");
  assert.match(change2, /revoke all on function public\.company_allowed_unchecked\(uuid\) from public, anon, authenticated, service_role;/, "no client role and not the server can call the unguarded copy");
  assert.ok(change2.indexOf("company_allowed_unchecked(cid uuid)") < change2.indexOf("CREATE OR REPLACE FUNCTION public.company_allowed(cid uuid)"), "the copy exists before anything points at it");
});

// ===================================================================== A3 ===
test("STATIC: the guards read the caller's JWT through the helpers this database already has", () => {
  const f1 = bodyCode(CHANGE1.map.get("1")), f2 = bodyCode(CHANGE1.map.get("2")), f3 = bodyCode(CHANGE1.map.get("3")), f4 = bodyCode(CHANGE1.map.get("4")), f5 = bodyCode(CHANGE1.map.get("5"));
  for (const [n, f] of [[1, f1], [2, f2], [3, f3], [4, f4], [5, f5]]) {
    assert.ok(!/\bcurrent_user\b|\bsession_user\b/i.test(f), `door ${n}: no guard is written against current_user (inside a definer it is the owner)`);
    assert.ok(!/auth\.uid\(\)\s+is\s+null/i.test(f.replace(/if auth\.uid\(\) is null then\s+raise exception 'Must be signed in to register a device\.';\s+end if;/, "")), `door ${n}: auth.uid() is null is not used as the server test (it is also true for anon)`);
  }
  // door 1
  assert.match(f1, /if not coalesce\(public\.mail_is_backend\(\) or co = public\.current_company_id\(\), false\) then/, "door 1: server or member, wrapped in coalesce so a NULL company cannot walk through");
  assert.match(f1, /using errcode = '42501'/);
  assert.ok(!/is_platform_admin/.test(f1), "door 1: the money writer has no operator door");
  assert.match(f1, /security definer/i);
  assert.match(f1, /set search_path to 'public', 'pg_temp'/i);
  // door 2
  const f2b = bodyCode(CHANGE1.map.get("2").match(/CREATE OR REPLACE FUNCTION public\.company_allowed\(cid uuid\)[\s\S]*?\$function\$;\n/)[0]);
  assert.match(f2b, /public\.mail_is_backend\(\)/);
  assert.match(f2b, /cid = public\.current_company_id\(\)/);
  assert.match(f2b, /public\.is_platform_admin\(\)/);
  assert.match(f2b, /then public\.company_allowed_unchecked\(cid\)/);
  assert.match(f2b, /stable security definer/i);
  // door 3
  assert.match(f3, /before insert on public\.app_errors/i);
  assert.match(f3, /if not public\.mail_is_backend\(\) then/);
  assert.match(f3, /new\.company_id\s+:= public\.current_company_id\(\)/);
  assert.match(f3, /new\.reported_by\s+:= auth\.uid\(\)/);
  assert.ok(!/raise exception/i.test(f3), "door 3 corrects, it never refuses (a refusal would reject a whole queued batch for ever)");
  assert.match(f3, /revoke all on function public\.stamp_app_error_owner\(\) from public, anon, authenticated;/);
  for (const [col, cap] of [["message", 2000], ["stack", 20000], ["email", 320], ["where_at", 200], ["android", 200], ["version_name", 64]]) {
    assert.match(f3, new RegExp(`new\\.${col}\\s+:= left\\(new\\.${col}, ${cap}\\)`), `door 3 caps ${col} at ${cap}`);
  }
  // door 4
  assert.match(f4, /on conflict \(token\) do update/);
  assert.match(f4, /where device_tokens\.user_id = excluded\.user_id\s+or device_tokens\.company_id = excluded\.company_id;/);
  assert.match(f4, /get diagnostics n = row_count;\s+if n = 0 then\s+raise exception '[^']*'\s+using errcode = '42501';/);
  assert.ok(!/is not distinct from/i.test(f4), "door 4: equality, so a NULL company never matches a NULL company");
  // door 5: the same two roles the office RPCs serve
  assert.match(f5, /using \(company_id = public\.current_company_id\(\)\s+and public\.current_user_role\(\)::text in \('OWNER', 'MANAGER'\)\);/);
});

// ===================================================================== A4 ===
test("STATIC: every check ends in a definite answer, every door has attacks AND controls", () => {
  assert.ok(CHECKS.length > 150, `the dry run records ${CHECKS.length} checks`);
  const bySubject = new Map();
  for (const c of CHECKS) {
    assert.ok(["q", "x", "s", "sx", "b", "bx"].includes(c.fn));
    assert.ok(["fixture", "baseline", "attack", "control", "legit", "readback", "reverse", "info", "probe"].includes(c.role), `role ${c.role} is one of the known ones (${c.k})`);
    (bySubject.get(c.subject) ?? bySubject.set(c.subject, []).get(c.subject)).push(c);
  }
  for (const door of ["recompute_job_totals", "company_allowed", "app_errors", "register_device_token", "device_keys"]) {
    const rows = bySubject.get(door) ?? [];
    assert.ok(rows.some((c) => c.role === "baseline"), `${door}: the hole is reproduced on the deployed function first`);
    assert.ok(rows.some((c) => c.role === "attack"), `${door}: has attacks`);
    assert.ok(rows.filter((c) => c.role === "control").length >= 2, `${door}: has at least two controls (a refusal is never just a typo)`);
    assert.ok(rows.some((c) => c.pair === "legit" || c.role === "legit" || c.pair === "trigger"), `${door}: proves a legitimate caller still works`);
    assert.ok(rows.some((c) => c.pair === "reopened"), `${door}: proves the reverse puts the hole back`);
  }
  assert.ok((bySubject.get("recompute_job_totals") ?? []).filter((c) => c.pair === "trigger").length >= 8, "door 1: the trigger is exercised under a person's JWT, a colleague's, the server's, and none");
  // The three kinds of caller that a JWT-demanding guard would break are each exercised on door 1.
  const d1 = (bySubject.get("recompute_job_totals") ?? []).map((c) => c.k).join("\n");
  assert.match(d1, /NO JWT at all/);
  assert.match(d1, /JWT role = service role/);
  assert.match(d1, /THE TRIGGER, no JWT/);
  assert.match(d1, /THE TRIGGER, the business's own JWT/);
  assert.match(d1, /THE TRIGGER, the server's JWT/);
  assert.match(d1, /Recalculate button/);
  // The trap door 1 must not fall into.
  assert.match(d1, /current_company_id\(\) is NULL: the trap the guard must not fall into/);
  // Door 2's other callers.
  const d2 = (bySubject.get("company_allowed") ?? []).map((c) => c.k).join("\n");
  for (const re of [/admin_companies\(\)/, /attention_sweep_candidates\(\)/, /my_service_status\(\)/, /can_use_company_mail\(\)/, /company_is_suspended\(\)/, /create-payment-link, quote-view, lead-intake, mail-sync, send-follow-ups/]) {
    assert.match(d2, re, `door 2 exercises ${re}`);
  }
  // Door 3's batch, door 4's colleague, door 5's four RPCs.
  assert.match((bySubject.get("app_errors") ?? []).map((c) => c.k).join("\n"), /queued batch of three/);
  assert.match((bySubject.get("register_device_token") ?? []).map((c) => c.k).join("\n"), /SAME business takes over/);
  const d5 = (bySubject.get("device_keys") ?? []).map((c) => c.k).join("\n");
  for (const re of [/list_device_keys\(\)/, /mint_device_key\(\)/, /revoke_device_key\(\)/, /claim_device\(\)/]) assert.match(d5, re);
  assert.ok(sql.includes("bench"), "the cost of the gate is measured before and after");
});

test("STATIC: every attack runs as anon or authenticated; the bypass role is never assumed; the server is a CLAIM, not a role", () => {
  const roleSwitches = [...executing.matchAll(/set\s+(?:local\s+)?role\s+([A-Za-z_"]+)/gi)].map((m) => m[1].replace(/"/g, "").toLowerCase());
  assert.ok(roleSwitches.length >= 2);
  for (const r of roleSwitches) assert.ok(["anon", "authenticated"].includes(r), `only anon and authenticated are ever assumed, saw ${r}`);
  assert.ok(!/reset\s+role\s+service_role|set\s+session\s+authorization/i.test(executing));
  // "service_role" appears only as a JWT claim value, in has_function_privilege(), or in a REVOKE list.
  const code = bodyCode(executing);
  const uses = [...code.matchAll(/service_role/g)].length;
  const allowed = [...code.matchAll(/'\{"role":"service_role"\}'|has_function_privilege\('service_role'|authenticated, service_role;/g)].length;
  assert.equal(uses, allowed, "every mention of service_role is a claim string, a privilege lookup or a revoke list");
  // The helpers that stand in for the server set the claim and leave the role alone.
  for (const name of ["b", "bx"]) {
    const h = sql.match(new RegExp(`create function pg_temp\\.${name}\\(([\\s\\S]*?)end \\$fn\\$;`))[0];
    assert.ok(h.includes(`'{"role":"service_role"}'`), `${name} sets the server's claim`);
    assert.ok(!/set\s+(local\s+)?role/i.test(h), `${name} does not switch the database role`);
  }
  for (const name of ["q", "x"]) {
    const h = sql.match(new RegExp(`create function pg_temp\\.${name}\\(([\\s\\S]*?)end \\$fn\\$;`))[0];
    assert.match(h, /set local role anon/);
    assert.match(h, /set local role authenticated/);
  }
  // Every user-side helper call carries a specific synthetic user or the anon key (null), never anything else.
  const userCalls = [...PART1.matchAll(/^  perform pg_temp\.(q|x)\((?:'(?:[^']|'')*',){4}(null::uuid|'([0-9a-f-]{36})'::uuid),/gm)];
  assert.equal(userCalls.length, CHECKS.filter((c) => c.fn === "q" || c.fn === "x").length, "every q and x call names its caller");
  assert.ok(userCalls.length > 60);
  for (const m of userCalls) assert.ok(m[2] === "null::uuid" || /^d00d1000-0000-4000-8000-/.test(m[3]), `a user-side call names a synthetic user or anon, saw ${m[2]}`);
  // The attacks run in the user-side helpers; the owner-side helpers only read back, set up, or stand in for the server.
  for (const c of CHECKS.filter((c) => c.role === "attack")) {
    assert.ok(["q", "x", "s"].includes(c.fn), `an attack row uses a user-side helper (or reads back), saw ${c.fn}: ${c.k}`);
  }
});

test("STATIC: every fixture is synthetic, every write is to a row this file made, nothing destructive runs", () => {
  const probeBlocks = [...PART1.matchAll(/do \$probe_(before|after|reversed)\$[\s\S]*?end \$probe_\1\$;/g)].map((m) => m[0]);
  assert.equal(probeBlocks.length, 3);
  const probe = probeBlocks.join("\n");
  for (const m of probe.matchAll(/insert into auth\.users\(id,email\) values ([^;]+);/g)) {
    const rows = [...m[1].matchAll(/\('([0-9a-f-]{36})','([^']+)'\)/g)];
    assert.ok(rows.length >= 10);
    for (const [, id, email] of rows) {
      assert.match(id, /^d00d1000-0000-4000-8000-/, "synthetic user id");
      assert.match(email, /^doors-[a-z]+@probe\.invalid$/, "synthetic address on a domain that cannot exist");
    }
  }
  for (const m of probe.matchAll(/insert into public\.(?:companies|profiles|jobs)\(([^)]*)\) values([\s\S]*?);\n/g)) {
    assert.match(m[0], /d00d/, "every fixture row carries the synthetic namespace");
  }
  for (const m of probe.matchAll(/insert into public\.(companies)\([^)]*\) values([\s\S]*?);\n/g)) {
    for (const nm of m[2].matchAll(/'(PROBE-[A-Z-]+)'/g)) assert.match(nm[1], /^PROBE-DOORS-/);
  }
  // Writes after the fixtures: every update names a synthetic row; the token/key/payment inserts are synthetic.
  for (const m of probe.matchAll(/update public\.\w+ set [^;$]*?(?:where [^;$]*)/g)) {
    assert.match(m[0], /d00d|PROBE-DOORS/, `an update in the dry run must name a synthetic row: ${m[0].slice(0, 100)}`);
  }
  for (const m of probe.matchAll(/insert into public\.payment_records[^;]*/g)) assert.match(m[0], /d00d|\$\{/);
  // Nothing destructive, anywhere that executes.
  for (const bad of [/\bdelete\s+from\b/i, /\btruncate\b/i, /\bdrop\s+table\b/i, /\bdrop\s+schema\b/i, /\bdrop\s+policy\b/i, /\bdrop\s+column\b/i, /\balter\s+table\b/i, /\bdrop\s+role\b/i, /\bdrop\s+trigger\b(?![^;]*00_stamp_app_error_owner)/i]) {
    assert.ok(!bad.test(bodyCode(executing)), `nothing that executes matches ${bad}`);
  }
  const drops = [...bodyCode(executing).matchAll(/\bdrop\s+(function|trigger)\s+if\s+exists\s+([^\s;(]+)/gi)].map((m) => `${m[1]} ${m[2]}`);
  for (const d of drops) assert.ok(/company_allowed_unchecked|stamp_app_error_owner/.test(d), `the only things ever dropped are this file's own new objects, saw ${d}`);
  assert.ok(!/\bgrant\b/i.test(topLevel.replace(/grant all on r to authenticated, anon;|grant usage on sequence r_n_seq to authenticated, anon;/gi, "")), "the file grants nothing outside its own temp table");
  // Nothing about any real person or business (the names are assembled so this file does not contain them either);
  // every address in the SQL is on the domain that cannot exist; nothing in it can queue a message or an HTTP call.
  for (const [a, b] of [["Leg", "acy"], ["Hori", "zon"], ["Peter", "LLC"]]) {
    assert.ok(!new RegExp(a + b, "i").test(sql), `the file names no real business (${a}...)`);
  }
  for (const addr of sql.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g) ?? []) {
    assert.match(addr, /@probe\.invalid$/, `every address in the file is synthetic, saw one on another domain`);
  }
  assert.ok(!/net\.http_|pg_net|send_email|http_request\(/i.test(bodyCode(executing)), "nothing in the file can queue a message or an HTTP call");
});

test("STATIC: the number in the header is the number of rows the dry run records", () => {
  const m = sql.match(/(\d+) of (\d+) rows pass/);
  assert.ok(m, "the header states the dry-run result");
  assert.equal(Number(m[1]), Number(m[2]));
  assert.equal(Number(m[2]), EXPECTED_ROWS, `the header says ${m[2]} rows; the file records ${EXPECTED_ROWS}`);
  const v = sql.match(/(\d+) deliberately(?:\s|--)+broken versions/);
  assert.ok(v, "the header counts the planted failures");
  assert.equal(Number(v[1]), VARIANTS.length, "and the count is the number of planted failures this test runs");
});

// ===================================================================== A5 ===
function walk(dir, exts, skip = /node_modules|[\\/]build[\\/]|[\\/]\.git[\\/]|[\\/]\.gradle[\\/]/) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip.test(p + "/")) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts, skip));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => relative(rootPath, p).replace(/\\/g, "/");
const SOURCES = [
  ...walk(join(rootPath, "app/src/main"), [".kt"]),
  ...walk(join(rootPath, "supabase/functions"), [".ts"]),
  ...walk(join(rootPath, "website"), [".html", ".js"]),
  ...walk(join(rootPath, "scripts"), [".mjs", ".ts", ".js"]),
];
const read = (p) => readFileSync(p, "utf8");
const filesWith = (re) => SOURCES.filter((p) => re.test(read(p))).map(rel).sort();

test("PREMISE: nothing outside the database calls recompute_job_totals by name (door 1's callers are the trigger and the Recalculate function)", () => {
  assert.deepEqual(filesWith(/recompute_job_totals/), [], "no Kotlin, edge function, website page or script names it; a new caller must be checked against the guard");
  assert.deepEqual(filesWith(/recalculate_my_job_totals/), ["app/src/main/java/com/fenceestimator/app/ui/account/AccountViewModel.kt"], "the Recalculate button is the only caller of the function that calls it");
});

test("PREMISE: payment_records is written only by a signed-in member of the business or by the server (door 1's trigger sees one of those)", () => {
  const writers = filesWith(/from\(["']payment_records["']\)[\s\S]{0,80}\.(insert|upsert|update|delete)\(|from\("payment_records"\)\s*\.(insert|upsert|update|delete)\(/);
  assert.deepEqual(writers, [
    "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt",
    "supabase/functions/_shared/record-payment.ts",
    "supabase/functions/square-webhook/index.ts",
    "supabase/functions/stripe-webhook/index.ts",
    "website/dashboard.html",
  ], "the phone (EntitySync) and the dashboard as the signed-in user, and the server-side writers: each is checked below");
  for (const f of ["supabase/functions/_shared/record-payment.ts", "supabase/functions/square-webhook/index.ts", "supabase/functions/stripe-webhook/index.ts"]) {
    assert.match(read(join(rootPath, f)), /\badmin\s*\.from\("payment_records"\)\.upsert\(/, `${f} writes with its admin client`);
  }
  assert.match(read(join(rootPath, "supabase/functions/stripe-webhook/index.ts")), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(read(join(rootPath, "supabase/functions/square-webhook/index.ts")), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(read(join(rootPath, "app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt")), /SupabaseModule\.client\.postgrest\.from\("payment_records"\)/, "the phone writes as the signed-in user");
  assert.match(read(join(rootPath, "website/dashboard.html")), /db\.from\('payment_records'\)\.insert\(chunk\)/, "the dashboard writes as the signed-in user");
});

test("PREMISE: company_allowed is asked by the caller's JWT for their own business, or by the server (door 2's callers)", () => {
  const callers = filesWith(/rpc\(\s*["']company_allowed["']/);
  assert.deepEqual(callers, [
    "supabase/functions/create-payment-link/index.ts",
    "supabase/functions/invite-crew/index.ts",
    "supabase/functions/lead-intake/index.ts",
    "supabase/functions/mail-sync/index.ts",
    "supabase/functions/price-job/index.ts",
    "supabase/functions/quote-view/index.ts",
    "supabase/functions/send-follow-ups/index.ts",
  ]);
  for (const f of ["invite-crew", "price-job"]) {
    const t = read(join(rootPath, `supabase/functions/${f}/index.ts`));
    assert.match(t, /SUPABASE_ANON_KEY/, `${f} runs as the caller`);
    assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/.test(t), `${f} never holds the service role`);
    assert.match(t, /rpc\("company_allowed",\s*\{\s*cid:\s*profile\.company_id\s*\}\)/, `${f} asks about the caller's own business`);
  }
  for (const f of ["create-payment-link", "lead-intake", "quote-view", "send-follow-ups"]) {
    assert.match(read(join(rootPath, `supabase/functions/${f}/index.ts`)), /SUPABASE_SERVICE_ROLE_KEY/, `${f} asks as the server`);
  }
  assert.match(read(join(rootPath, "supabase/functions/_shared/mail/caller.ts")), /SUPABASE_SERVICE_ROLE_KEY/, "mail-sync's admin client is the server's");
  assert.match(read(join(rootPath, "supabase/functions/mail-sync/index.ts")), /triggerCaller\(req, "MAIL_SYNC_TRIGGER_SECRET"\)/);
  // The callers that treat only an explicit false as "shut" (and mail-sync, which needs an explicit true) get real answers.
  assert.match(read(join(rootPath, "supabase/functions/mail-sync/index.ts")), /data === true/, "mail-sync needs a real true, which the server path still returns");
});

test("PREMISE: the phone files crash reports as the signed-in user, in one batch, and drops the queue only after it lands (door 3)", () => {
  const writers = filesWith(/from\(["']app_errors["']\)[\s\S]{0,60}\.(insert|upsert|update)\(/);
  assert.deepEqual(writers, [
    "app/src/main/java/com/fenceestimator/app/cloud/CrashReporter.kt",
    "app/src/main/java/com/fenceestimator/app/cloud/JobSync.kt",
  ], "nothing server side writes app_errors");
  const cr = read(join(rootPath, "app/src/main/java/com/fenceestimator/app/cloud/CrashReporter.kt"));
  assert.match(cr, /SupabaseModule\.client\.postgrest\.from\("app_errors"\)\.insert\(records\)\s+\/\/[\s\S]{0,200}file\.delete\(\)/, "one batch insert, then the queue file is deleted only once it is safely up");
  assert.ok(!/reported_?by|reportedBy/.test(cr), "the phone has never sent reported_by, so stamping it changes no caller");
  assert.match(cr, /record\.companyId \?: companyId/, "each queued record carries the company stamped when it happened, which can differ from the uploader's now");
  assert.match(read(join(rootPath, "website/admin.html")), /from\('app_errors'\)\s*\n?\s*\.select\(/, "the operator's page only reads it");
  assert.ok(!/from\('app_errors'\)[\s\S]{0,40}\.(insert|update|upsert)/.test(read(join(rootPath, "website/admin.html"))));
});

test("PREMISE: the only caller of register_device_token is the sign-in, its failure is swallowed, and nothing deletes a token at sign-out (door 4's trade-off)", () => {
  const callers = filesWith(/["']register_device_token["']/);
  assert.deepEqual(callers, ["app/src/main/java/com/fenceestimator/app/cloud/SupabaseModule.kt"]);
  const sm = read(join(rootPath, "app/src/main/java/com/fenceestimator/app/cloud/SessionManager.kt"));
  assert.match(sm, /if \(profile\?\.companyId != null\) \{\s*pushTokenProvider\?\.invoke\(\)\?\.let \{ token ->\s*runCatching \{ SupabaseModule\.registerDeviceToken\(token\) \}/, "registered at every sign-in, failure swallowed");
  const kotlin = SOURCES.filter((p) => p.endsWith(".kt"));
  assert.deepEqual(kotlin.filter((p) => /from\("device_tokens"\)|deleteToken\(|device_tokens\s*WHERE/i.test(read(p))).map(rel), [], "no Kotlin deletes a device token, at sign-out or ever: that is why door 4 is held");
  assert.match(sql, /device_tokens_own_delete|sign-out|sign out/i);
});

test("PREMISE: nothing reads device_keys as the invoker (door 5)", () => {
  assert.deepEqual(filesWith(/from\(["']device_keys["']\)/), [], "no source selects the table; the office screen uses the RPCs");
  const dash = read(join(rootPath, "website/dashboard.html"));
  for (const rpc of ["list_device_keys", "mint_device_key", "revoke_device_key"]) assert.match(dash, new RegExp(`db\\.rpc\\('${rpc}'`), `the dashboard uses ${rpc}`);
  assert.match(read(join(rootPath, "app/src/main/java/com/fenceestimator/app/cloud/ServiceGate.kt")), /"claim_device"/, "the phone uses claim_device");
});

// ===================================================================== B ====
function runSql(text, label) {
  const dir = mkdtempSync(join(tmpdir(), "a26doors-"));
  const file = join(dir, "probe.sql");
  writeFileSync(file, text, "utf8");
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query", "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
      { encoding: "utf8", shell: process.platform === "win32", timeout: 300_000, maxBuffer: 64 * 1024 * 1024, cwd: rootPath });
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
const line = (x) => `[${x.subject}/${x.pair}/${x.role}] ${x.k}`;
const summaryOf = (rows) => {
  const s = rows.find((x) => x.subject === "SUMMARY");
  assert.ok(s, "the run ended with a SUMMARY row");
  const [pass, total] = s.got.split("/").map(Number);
  return { pass, total, fails: rows.filter((x) => x.result === "FAIL") };
};

/** What the live database looks like, read back after a run: the proof that a dry run left no trace. */
const TRACE_SQL = `
select 'probe users' k, count(*)::text v from auth.users where email like 'doors-%@probe.invalid'
union all select 'probe companies', count(*)::text from public.companies where name like 'PROBE-DOORS%'
union all select 'probe profiles', count(*)::text from public.profiles where full_name like 'Doors %'
union all select 'probe jobs', count(*)::text from public.jobs where customer_name = 'DOORS CUSTOMER'
union all select 'probe payments', count(*)::text from public.payment_records where recorded_by = 'DOORS' or company_id::text like 'd00d%'
union all select 'probe tokens', count(*)::text from public.device_tokens where token like 'PROBE-DOORS-%'
union all select 'probe keys', count(*)::text from public.device_keys where company_id::text like 'd00d%'
union all select 'probe crash reports', count(*)::text from public.app_errors where email like 'doors-%@probe.invalid'
union all select 'probe audit entries', count(*)::text from public.audit_log where company_id::text like 'd00d%'
union all select 'probe settings', (select count(*) from public.company_settings where company_id::text like 'd00d%')::text
union all select 'probe sweep settings', (select count(*) from public.attention_sweep_settings where company_id::text like 'd00d%')::text
union all select 'probe sync signals', (select count(*) from public.sync_signals where company_id::text like 'd00d%')::text
union all select 'queued http calls', count(*)::text from net.http_request_queue
union all select 'companies', count(*)::text from public.companies
union all select 'profiles', count(*)::text from public.profiles
union all select 'app_errors', count(*)::text from public.app_errors
union all select 'device_tokens', count(*)::text from public.device_tokens
union all select 'device_keys', count(*)::text from public.device_keys
union all select 'payment_records', count(*)::text from public.payment_records
union all select 'unchecked copy', (to_regprocedure('public.company_allowed_unchecked(uuid)') is not null)::text
union all select 'stamp function', (to_regprocedure('public.stamp_app_error_owner()') is not null)::text
union all select 'stamp trigger', exists(select 1 from pg_trigger where tgname = '00_stamp_app_error_owner')::text
union all select 'md5 recompute_job_totals', md5(pg_get_functiondef('public.recompute_job_totals(uuid,uuid)'::regprocedure))
union all select 'md5 company_allowed', md5(pg_get_functiondef('public.company_allowed(uuid)'::regprocedure))
union all select 'md5 company_is_suspended', md5(pg_get_functiondef('public.company_is_suspended()'::regprocedure))
union all select 'md5 register_device_token', md5(pg_get_functiondef('public.register_device_token(text)'::regprocedure))
union all select 'device_keys_read', (select qual from pg_policies where tablename = 'device_keys' and policyname = 'device_keys_read')
order by 1;`;
/** The keys a dry run must leave exactly as it found them. (Row totals and the HTTP queue also move with real traffic, so they are read but not compared.) */
const strict = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => /^probe |^md5 |^stamp |^unchecked|^device_keys_read$/.test(k)));
const trace = (label) => Object.fromEntries(runSql(TRACE_SQL, label).map((r) => [r.k, r.v]));

// The doors as they are deployed on the day this ran; a run before or after applying PART 2/3 gives the same answers.
const APPLIED_PARTS = (t) => ({ p2: t["stamp function"] === "true", p3: false });

test("LIVE: the premises the file rests on are what the live catalogue says", { skip: !LIVE, timeout: 300_000 }, () => {
  const rows = runSql(`
select 'current_company_id' k, pg_get_functiondef('public.current_company_id()'::regprocedure) v
union all select 'mail_is_backend', pg_get_functiondef('public.mail_is_backend()'::regprocedure)
union all select 'acl recompute', coalesce(array_to_string(proacl::text[], ' | '), 'PUBLIC') from pg_proc where oid = 'public.recompute_job_totals(uuid,uuid)'::regprocedure
union all select 'acl company_allowed', coalesce(array_to_string(proacl::text[], ' | '), 'PUBLIC') from pg_proc where oid = 'public.company_allowed(uuid)'::regprocedure
union all select 'acl attention_sweep_candidates', coalesce(array_to_string(proacl::text[], ' | '), 'PUBLIC') from pg_proc where oid = 'public.attention_sweep_candidates()'::regprocedure
union all select 'acl mail_is_backend', coalesce(array_to_string(proacl::text[], ' | '), 'PUBLIC') from pg_proc where oid = 'public.mail_is_backend()'::regprocedure
union all select 'user_role enum', (select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum where enumtypid = 'public.user_role'::regtype)
union all select 'list_device_keys roles', (select substring(pg_get_functiondef('public.list_device_keys()'::regprocedure) from 'role::text in \\(([^)]*)\\)'))
union all select 'policies calling company_is_suspended', count(*)::text from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ilike '%company_is_suspended%'
union all select 'policies mentioning company_allowed', count(*)::text from pg_policies where coalesce(qual, '') || coalesce(with_check, '') ilike '%company_allowed%'
union all select 'device_keys in realtime', count(*)::text from pg_publication_tables where tablename = 'device_keys'
union all select 'delete policy on payment_records', count(*)::text from pg_policy where polrelid = 'public.payment_records'::regclass and polpermissive and polcmd in ('d', '*')
union all select 'delete policy on companies', count(*)::text from pg_policy where polrelid = 'public.companies'::regclass and polcmd in ('d', '*')
union all select 'device_tokens_own_delete', count(*)::text from pg_policy where polrelid = 'public.device_tokens'::regclass and polname = 'device_tokens_own_delete'
union all select 'functions touching device_keys', (select string_agg(p.proname || case when p.prosecdef then '*' else '' end, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%device_keys%')
union all select 'functions calling recompute_job_totals', (select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%recompute_job_totals%' and p.proname <> 'recompute_job_totals')
union all select 'functions calling company_allowed', (select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ilike '%company_allowed%' and p.proname not in ('company_allowed', 'company_allowed_unchecked'))
union all select 'objects depending on device_keys', (select string_agg(distinct d.classid::regclass::text, ',') from pg_depend d where d.refobjid = 'public.device_keys'::regclass and d.deptype = 'n')
order by 1;`, "premises");
  const v = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  assert.match(v.current_company_id, /select company_id from profiles where id = auth\.uid\(\)/, "the helper every fix stands on is what the header says it is");
  assert.match(v.mail_is_backend, /nullif\(current_setting\('request\.jwt\.claims', true\), ''\) is null\s+or coalesce\(nullif\(current_setting\('request\.jwt\.claims', true\), ''\)::json ->> 'role', ''\) = 'service_role'/, "the server test is what the header says it is");
  assert.ok(!/authenticated=X/.test(v["acl mail_is_backend"]) && !/anon=X/.test(v["acl mail_is_backend"]), "no client can call the server test directly (definers owned by postgres can)");
  assert.match(v["acl recompute"], /authenticated=X\/postgres/); assert.match(v["acl recompute"], /service_role=X\/postgres/); assert.ok(!/anon=X|^=X|\| =X/.test(v["acl recompute"]), "anon has no EXECUTE on recompute_job_totals");
  assert.match(v["acl company_allowed"], /authenticated=X\/postgres/); assert.ok(!/anon=X/.test(v["acl company_allowed"]));
  assert.ok(!/authenticated=X|anon=X/.test(v["acl attention_sweep_candidates"]), "the sweep's reader of company_allowed is not callable by any client");
  assert.match(v["user_role enum"], /^OWNER,MANAGER,CREW,SALES,ACCOUNTANT,FOREMAN$/);
  assert.equal(v["list_device_keys roles"], "'OWNER', 'MANAGER'", "door 5 narrows the policy to exactly the roles the office RPCs already serve");
  assert.equal(v["policies calling company_is_suspended"], "21", "the per-row gate under 21 tables (the reason door 2 is split)");
  assert.equal(v["policies mentioning company_allowed"], "0", "no policy calls company_allowed directly");
  assert.equal(v["device_keys in realtime"], "0");
  assert.equal(v["delete policy on payment_records"], "0", "no login can hard-delete a payment, so the trigger never fires on a delete under a user's JWT");
  assert.equal(v["delete policy on companies"], "0", "no login can delete a business, so no cascade reaches the payment trigger");
  assert.equal(v["device_tokens_own_delete"], "1", "the policy that lets the app delete its own token at sign-out already exists");
  assert.equal(v["functions touching device_keys"], "claim_device*,list_device_keys*,mint_device_key*,revoke_device_key*", "the four functions that touch device_keys are all definers");
  assert.match(v["functions calling recompute_job_totals"], /^payment_records_recompute,recalculate_my_job_totals$/, "door 1's only callers inside the database");
  assert.equal(v["functions calling company_allowed"], "admin_companies,attention_sweep_candidates,can_use_company_mail,company_is_suspended,my_service_status", "door 2's callers inside the database");
  assert.equal(v["objects depending on device_keys"], "pg_policy", "only its own policy depends on device_keys");
});

test("LIVE: the dry run passes every row, reproduces each hole on the deployed functions, and leaves nothing behind", { skip: !LIVE, timeout: 600_000 }, () => {
  const before = trace("trace before");
  const rows = runSql(PART1, "PART 1");
  const { pass, total, fails } = summaryOf(rows);
  assert.deepEqual(fails.map(line), [], "no row fails");
  assert.equal(pass, total);
  assert.equal(total, EXPECTED_ROWS, "the run recorded exactly the rows the file declares");
  const by = (re) => rows.find((x) => re.test(line(x)));
  const applied = APPLIED_PARTS(before);
  if (!applied.p2) {
    // The holes, on the deployed functions, in the same session that then closes them.
    assert.equal(by(/attacker's owner recomputes the totals of the VICTIM's job by naming its ids \(deployed function\)/).got, "rows=1");
    assert.equal(by(/victim's cached amount_paid now reads/).got, "100", "the victim's figure moved from 0 to 100 by a stranger's call");
    assert.ok(Number(by(/audit log now carries entries that name the attacker/).got) >= 1, "and the victim's audit log names the attacker");
    assert.equal(by(/asks whether the VICTIM business is paid up \(deployed\)/).got, "true");
    assert.equal(by(/whether the SUSPENDED business is \(the answers differ/).got, "false");
    assert.equal(by(/whether an id that is no business is \(NULL\)/).got, "NULL");
    assert.equal(by(/stored as: filed against the victim/).got, "true/true/200000/400000", "a report filed against the victim, attributed to the victim's owner, 200,000 characters whole");
    assert.equal(by(/token is now addressed to the attacker's login and business/).got, "true");
    assert.equal(by(/CREW member reads the victim's device keys straight from the table \(deployed\)/).got, "2");
  }
  assert.equal(by(/mint_device_key\(\) as deployed/).got.slice(0, 9), "ERR 42883", "the known bug: mint_device_key has never worked in production");
  // The gate's cost did not move (the reason for the split). Timing is noisy, so only a wide band is asserted.
  const ms = rows.filter((x) => x.pair === "bench" && /^ms for those/.test(x.k)).map((x) => Number(x.got));
  assert.equal(ms.length, 2);
  assert.ok(ms[1] < ms[0] * 1.6 + 60, `3000 gate calls: ${ms[0]} ms deployed, ${ms[1]} ms changed: the split kept the gate's cost`);
  const after = trace("trace after");
  assert.deepEqual(strict(after), strict(before), "every function's md5, the policy, the trigger and every probe artifact are exactly as they were before the run");
  for (const k of ["probe users", "probe companies", "probe profiles", "probe jobs", "probe payments", "probe tokens", "probe keys", "probe crash reports", "probe audit entries", "probe settings", "probe sweep settings", "probe sync signals"]) {
    assert.equal(after[k], "0", `${k} left behind`);
  }
  if (!applied.p2) {
    assert.deepEqual([after["md5 recompute_job_totals"], after["md5 company_allowed"], after["md5 company_is_suspended"], after["md5 register_device_token"]], Object.values(DEPLOYED), "the four functions are the deployed ones");
    assert.equal(after.device_keys_read, DEPLOYED_POLICY);
  }
});

test("LIVE: PART 2, 3 and 4 run clean when rehearsed (COMMIT swapped for ROLLBACK) and change nothing", { skip: !LIVE, timeout: 600_000 }, () => {
  const before = trace("trace before rehearsals");
  for (const [n, body] of [[2, PART2], [3, PART3], [4, PART4]]) {
    const rehearsal = body.replace(/\ncommit;\s*$/, `\nselect 'part ${n} rehearsal ok' as result;\nrollback;\n`);
    assert.notEqual(rehearsal, body, `PART ${n} ends in commit`);
    const rows = runSql(rehearsal, `PART ${n} rehearsal`);
    assert.equal(rows[0].result, `part ${n} rehearsal ok`);
  }
  assert.deepEqual(strict(trace("trace after rehearsals")), strict(before), "the rehearsals changed nothing");
});

test("LIVE: the dry run gives the same answer on top of doors that are already applied", { skip: !LIVE, timeout: 600_000 }, () => {
  const before = trace("trace before applied-state runs");
  const body = (n) => part(n).replace(/^begin;\n/, "").replace(/\ncommit;\s*$/, "\n");
  const onTop = (nums) => "begin;\n" + nums.map(body).join("\n") + "\n" + PART1.replace(/^begin;\n/, "");
  for (const nums of [[2], [2, 3]]) {
    const rows = runSql(onTop(nums), `PART 1 on top of PART ${nums.join(" and ")}`);
    const { pass, total, fails } = summaryOf(rows);
    assert.deepEqual(fails.map(line), [], `no row fails with PART ${nums.join(" and ")} already applied`);
    assert.equal(pass, total);
  }
  assert.deepEqual(strict(trace("trace after applied-state runs")), strict(before), "and it still rolled everything back");
});

// ------------------------------------------------------- planted failures --
/** The dry run with PART 1 mutated. Every mutation must be found in PART 1, or the test itself is broken. */
const planted = (find, replace) => {
  const text = typeof find === "string" ? find : null;
  if (text !== null) {
    assert.ok(PART1.includes(text), `planted failure anchor is in PART 1: ${text.slice(0, 70)}`);
    return PART1.split(text).join(replace);
  }
  assert.ok(find.test(PART1), `planted failure pattern is in PART 1: ${find}`);
  return PART1.replace(find, replace);
};
const GUARD1 = "if not coalesce(public.mail_is_backend() or co = public.current_company_id(), false) then";
const VARIANTS = [
  { name: "door1-no-guard", why: "the recompute guard is missing altogether",
    sql: () => planted(/    if not coalesce\(public\.mail_is_backend\(\) or co = public\.current_company_id\(\), false\) then\n[\s\S]*?    end if;\n/, ""),
    red: [/recompute_job_totals\/attack\/attack/, /recompute_job_totals\/attack\/readback/] },
  { name: "door1-null-trap", why: "the guard forgets coalesce(): a person with no company sails through a NULL",
    sql: () => planted(GUARD1, "if not (public.mail_is_backend() or co = public.current_company_id()) then"),
    red: [/no profile at all/, /has no business does the same/, /passes NULL as the company/] },
  { name: "door1-needs-a-jwt", why: "the guard demands a company and never lets the server or a JWT-less trigger through",
    sql: () => planted(GUARD1, "if not coalesce(co = public.current_company_id(), false) then"),
    red: [/NO JWT at all/, /the server \(JWT role = service role, as the payment webhooks\) still recomputes/, /THE TRIGGER, no JWT/, /THE TRIGGER, the server's JWT/] },
  { name: "door1-current-user", why: "the guard is written against current_user, which inside a SECURITY DEFINER function is the owner",
    sql: () => planted(GUARD1, "if current_user = 'authenticated' and co is distinct from public.current_company_id() then"),
    red: [/recompute_job_totals\/attack\/attack/] },
  { name: "door2-no-guard", why: "company_allowed is left answering for anybody",
    sql: () => planted("select case when public.mail_is_backend()\n                  or cid = public.current_company_id()\n                  or public.is_platform_admin()\n                then public.company_allowed_unchecked(cid)\n           end;", "select public.company_allowed_unchecked(cid);"),
    red: [/company_allowed\/attack\/attack/] },
  { name: "door2-no-operator", why: "the guard forgets the operator, so admin_companies() shows every business as unknown",
    sql: () => planted("\n                  or public.is_platform_admin()", ""),
    red: [/operator asks about the victim/, /admin_companies\(\)/] },
  { name: "door2-no-server", why: "the guard forgets the server, so create-payment-link, quote-view and the sweep read NULL for every business",
    sql: () => planted("select case when public.mail_is_backend()\n                  or cid = public.current_company_id()", "select case when cid = public.current_company_id()"),
    red: [/the server \(JWT role = service role: create-payment-link/, /attention_sweep_candidates\(\)/] },
  { name: "door2-unchecked-left-callable", why: "the unguarded copy is left callable, which would re-open the door under another name",
    sql: () => planted("revoke all on function public.company_allowed_unchecked(uuid) from public, anon, authenticated, service_role;", "-- (grant left as created)"),
    red: [/sits behind a name no client can call/, /no role a client or the server connects as has a grant/] },
  { name: "door3-no-trigger", why: "the crash-report trigger is never created",
    sql: () => planted('create or replace trigger "00_stamp_app_error_owner"\n    before insert on public.app_errors\n    for each row execute function public.stamp_app_error_owner();', "select 1;"),
    red: [/app_errors\/attack\/readback/, /the new trigger is BEFORE INSERT/] },
  { name: "door3-refuses", why: "the trigger refuses a foreign company instead of correcting it, so a queued batch is rejected whole",
    sql: () => planted("        new.company_id   := public.current_company_id();", "        if new.company_id is distinct from public.current_company_id() then raise exception 'not your business' using errcode = '42501'; end if;\n        new.company_id   := public.current_company_id();"),
    red: [/a queued batch of three/] },
  { name: "door3-trusts-the-row", why: "the trigger caps sizes but leaves company_id and reported_by as the phone wrote them",
    sql: () => {
      const a = "        new.company_id   := public.current_company_id();\n", b = "        new.reported_by  := auth.uid();\n";
      assert.ok(PART1.includes(a) && PART1.includes(b));
      return PART1.split(a).join("").split(b).join("");
    },
    red: [/app_errors\/attack\/readback/] },
  { name: "door4-no-guard", why: "register_device_token still lets anyone take any token",
    sql: () => planted("        where device_tokens.user_id = excluded.user_id\n           or device_tokens.company_id = excluded.company_id;", "        ;"),
    red: [/register_device_token\/attack\/attack/] },
  { name: "door4-null-equals-null", why: "the guard uses is-not-distinct-from, so two people with no business can take each other's phones",
    sql: () => planted("device_tokens.company_id = excluded.company_id;", "device_tokens.company_id is not distinct from excluded.company_id;"),
    red: [/a NULL company never matches a NULL company/] },
  { name: "door5-policy-unchanged", why: "the device_keys policy is left as deployed",
    sql: () => planted("    using (company_id = public.current_company_id()\n           and public.current_user_role()::text in ('OWNER', 'MANAGER'));", "    using (company_id = public.current_company_id());"),
    red: [/device_keys\/attack\/attack/] },
  { name: "door5-too-narrow", why: "the policy is narrowed to the owner only, which would blind the manager's screen",
    sql: () => planted("in ('OWNER', 'MANAGER'));", "in ('OWNER'));"),
    red: [/the victim's manager still reads them/] },
  { name: "reverse-does-not-reverse", why: "the reverse of door 1 restores nothing",
    sql: () => {
      const r = REVERSE1.map.get("1");
      assert.ok(PART1.includes(r));
      return PART1.replace(r, "select 1;\n");
    },
    red: [/recompute_job_totals is the deployed function again/] },
];

test("LIVE: sixteen deliberately broken versions are each caught (the probe has teeth)", { skip: !LIVE, timeout: 1_800_000 }, () => {
  assert.equal(VARIANTS.length, 16);
  const before = trace("trace before planted failures");
  const problems = [];
  for (const v of VARIANTS) {
    const rows = runSql(v.sql(), v.name);
    const { fails } = summaryOf(rows);
    const missing = v.red.filter((re) => !fails.some((x) => re.test(line(x))));
    if (!fails.length) problems.push(`${v.name} (${v.why}): NOTHING went red`);
    else if (missing.length) problems.push(`${v.name} (${v.why}): these did not go red: ${missing.join(" ; ")}; red were: ${fails.slice(0, 6).map(line).join(" | ").slice(0, 400)}`);
  }
  assert.deepEqual(problems, [], "every planted failure is caught by the rows meant to catch it");
  assert.deepEqual(strict(trace("trace after planted failures")), strict(before), "and every one of them rolled back");
});
