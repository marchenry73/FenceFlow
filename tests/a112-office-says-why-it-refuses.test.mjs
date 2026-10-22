// A112 -- when the office refuses, it has to say WHICH login it is refusing
// and whose fault it is.
//
// Run with:  node --test tests/a112-office-says-why-it-refuses.test.mjs
//
// 21 October 2026: "There are a lot of things that I am restricted on because
// I do not have access" and "The save cannot save because I do not have
// access, but I am the OWNER."
//
// The database was ruled out as the owner account itself -- auth.uid()
// confirmed, current_user_role() OWNER, company_is_suspended() false, both
// write predicates satisfied, has_permission true, with a canary asserting the
// role was not crew -- and every public table was swept for the
// partial-column-grant shape that took company email down the day before
// (supabase_check_column_grants.sql, now a standing check). The page was
// refusing, and the page could not say why. These are the three things that
// made it able to.
//
// Source checks: this page is not executed here. Each check is paired with a
// canary that sabotages a copy and asserts the check would have gone red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PAGE = "website/dashboard.html";
const src = readFileSync(new URL("../" + PAGE, import.meta.url), "utf8");

/** The region between two landmarks, so a check reads the code it is about. */
function region(from, to) {
  const i = src.indexOf(from);
  assert.ok(i !== -1, `landmark gone: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j !== -1, `landmark gone: ${to}`);
  return src.slice(i, j);
}

test("the page was found and is the office, not something else", () => {
  assert.ok(src.length > 500_000, `${PAGE} is only ${src.length} bytes`);
  assert.match(src, /const canEdit = \(\) =>/, "canEdit() is gone; these checks are pinned to names that moved");
});

test("a failed profile read stops, and does not fall into the new-company branch", () => {
  const r = region("const {data:prof", "if(!profile||!profile.company_id){");
  assert.match(r, /error:\s*profErr/, "the profiles read still discards its error");
  assert.match(r, /if\s*\(\s*profErr\s*\)/, "nothing branches on that error");
  // The important half: it must RETURN. Falling through leaves profile null,
  // which reads as "no company yet" -- the branch that offers to create one.
  const guard = r.slice(r.indexOf("if(profErr)"));
  assert.match(guard, /return;/, "the failed-read branch does not return, so it still falls through");
  assert.match(guard, /showRoleStrip/, "the failed read says nothing on screen");
});

test("a login that cannot edit is told so across the top, not only in a panel", () => {
  const r = region("if(canEdit()) hideRoleStrip();", "await initMail();");
  assert.match(r, /showRoleStrip\('warn',\s*tr\('roleStripReadOnly',\s*whoAmI\(\)\)\)/,
    "the strip no longer names the account");
  assert.ok(src.includes('id="roleStrip"'), "the strip element itself is gone");
});

test("a missing GRANT is not reported as the account's fault", () => {
  const r = region("const TECH_ERRORS = [", "];");
  const grantAt = r.indexOf("errGrantMissing");
  const rlsAt = r.indexOf("errPermission");
  assert.ok(grantAt !== -1, "errGrantMissing is gone");
  assert.ok(rlsAt !== -1, "errPermission is gone");
  // Order is the whole point: the generic row-level pattern would otherwise
  // swallow "permission denied for column ..." first and call it the account.
  assert.ok(grantAt < rlsAt, "the row-level pattern is matched before the grant one, so a grant gap is still blamed on the account");
  assert.doesNotMatch(r, /row-level security\|permission denied for/,
    "the two causes are back in one pattern, which is what mis-blamed the owner");
});

test("a row-level refusal names the login it refused", () => {
  const r = region("const TECH_ERRORS = [", "];");
  assert.match(r, /'errPermission',\s*\(\)\s*=>\s*\[whoAmI\(\)\]/, "errPermission no longer passes the account");
  assert.match(src, /errPermission:'Your account is not allowed to make this change\. You are signed in as %s/,
    "the English wording no longer says who is signed in");
});

test("every new string exists in all three languages", () => {
  for (const key of ["errGrantMissing", "roleStripReadOnly", "roleStripLoadFailed", "roleStripSignOut"]) {
    const n = src.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} appears in ${n} locales, expected 3 (en, es, fr)`);
  }
});

test("plainError can actually substitute the argument", () => {
  const r = region("const hit = TECH_ERRORS.find", "}");
  assert.match(r, /hit\[2\]\s*\?\s*hit\[2\]\(/, "the third element is never called, so %s would print literally");
  assert.match(r, /tr\(hit\[1\],\s*\.\.\.args\)/, "the arguments are not passed to tr()");
});

test("a sentence our own SQL raised is not replaced by a sentence about the account", () => {
  // COMMENT LINES STRIPPED FIRST. The code block explains at length which
  // patterns were removed and why, so the words themselves are in the
  // region -- and a check that reads a comment and calls correct code
  // broken has cost a day here before.
  const r = region("const TECH_ERRORS = [", "];")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  // 42 functions in this database raise with errcode 42501 AND a message
  // written for the reader. Matching the bare code threw all of them away.
  assert.doesNotMatch(r, /insufficient_privilege/,
    "the error CODE is matched again, so every deliberate message raised with it is replaced by a line about the account");
  assert.doesNotMatch(r, /42501/,
    "the bare 42501 is matched again -- that is the code our own functions raise with");
  assert.match(r, /\[\/row-level security\/i, 'errPermission'/,
    "the canonical row-level wording is no longer matched, so the one message no human can read now reaches the screen raw");
});

test("the two phrasings that SHOULD be rewritten still are", () => {
  // Postgres and PostgREST write these themselves; nobody can act on them.
  const rls = /row-level security/i;
  const grant = /permission denied for (?:table|column|relation|function|schema|sequence|type)\s*"?([A-Za-z0-9_.]+)"?/i;
  assert.ok(rls.test('new row violates row-level security policy for table "jobs"'), "the RLS wording is not matched");
  assert.ok(grant.test("permission denied for column logo_path"), "the grant wording is not matched");
  // ...and a sentence one of our functions raised is matched by NEITHER.
  for (const own of ["Sign in first.", "Only owners and managers can change business settings.",
                     "Only a FenceFlow admin may change company access."]) {
    assert.ok(!rls.test(own) && !grant.test(own), `"${own}" would still be replaced`);
  }
});

// ---------------------------------------------------------------- canaries

test("CANARY: the order check fails when the patterns are swapped back", () => {
  const sabotaged = "const TECH_ERRORS = [\n" +
    "    [/row-level security|insufficient_privilege/i, 'errPermission', () => [whoAmI()]],\n" +
    "    [/permission denied for/i, 'errGrantMissing', () => ['x']],\n" +
    "];";
  const r = sabotaged.slice(sabotaged.indexOf("const TECH_ERRORS = ["), sabotaged.indexOf("];"));
  assert.ok(r.indexOf("errGrantMissing") > r.indexOf("errPermission"),
    "the canary did not reproduce the wrong order, so the real check proves nothing");
});

test("CANARY: the fall-through check fails when the return is removed", () => {
  const guard = "if(profErr){ showRoleStrip('err', 'x'); }";
  assert.doesNotMatch(guard, /return;/,
    "a guard with no return was not detected, so the real check has no teeth");
});
