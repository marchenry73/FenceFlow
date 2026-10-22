// A120 -- how many emails are left, and the two numbers that must not drift.
//
// Run with:  node --test tests/a120-mail-allowance.test.mjs
//
// "I also want to see the amount that have left after I send the mail on the
// app and on the websites" -- 20 October 2026. The counts always existed;
// mail_event_count() refuses anybody who is not the service role, so the
// office could never ask. my_mail_allowance() answers it for the signed-in
// company, and this file guards the two things that make that answer true.
//
// Source checks: nothing is executed against the database here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SQL = readFileSync(new URL("../supabase_r24_my_mail_allowance.sql", import.meta.url), "utf8");
const LIMITS = readFileSync(new URL("../supabase/functions/_shared/mail/limits.ts", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");

function constFrom(src, name) {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*(\\d[\\d_]*)`));
  assert.ok(m, `${name} is gone from limits.ts`);
  return Number(m[1].replace(/_/g, ""));
}

// ============================================ the number written twice ====

test("the caps in the migration match the caps the sender enforces", () => {
  // THE WHOLE POINT OF THIS FILE. The SQL cannot import the TypeScript, so the
  // caps are written in both. Two numbers meaning one thing drift apart, and
  // then the screen says 296 left while the server refuses at 60 -- a lie
  // about a limit that is still being enforced.
  const hour = constFrom(LIMITS, "RESEND_SENDS_PER_HOUR");
  const day = constFrom(LIMITS, "RESEND_SENDS_PER_DAY");
  assert.match(SQL, new RegExp(`'hour_cap',\\s*${hour}`),
    `the migration's hour cap does not match limits.ts (${hour})`);
  assert.match(SQL, new RegExp(`'day_cap',\\s*${day}`),
    `the migration's day cap does not match limits.ts (${day})`);
});

test("both providers are capped the same, which is what the one number assumes", () => {
  // The screen shows ONE allowance. That is only honest while smtp and resend
  // share a cap; the day they differ, the screen has to say which provider it
  // is talking about.
  assert.equal(constFrom(LIMITS, "SMTP_SENDS_PER_HOUR"), constFrom(LIMITS, "RESEND_SENDS_PER_HOUR"),
    "the two providers no longer share an hourly cap, so one number on screen is wrong for one of them");
  assert.equal(constFrom(LIMITS, "SMTP_SENDS_PER_DAY"), constFrom(LIMITS, "RESEND_SENDS_PER_DAY"),
    "the two providers no longer share a daily cap");
});

// ====================================================== the function ======

test("it counts this company only, never the platform rows", () => {
  // company_id is null marks FenceFlow's own sends. Counting those into a
  // customer's allowance would be somebody else's usage on their screen.
  // COMMENTS STRIPPED FIRST. The header explains, in words, that the
  // company_id-is-null rows are deliberately not counted -- and explaining it
  // means writing the phrase. A check that reads a comment and calls correct
  // code broken has already cost a deploy on this repo today.
  const sqlCode = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(sqlCode, /company_id is null/,
    "the allowance counts the platform's own sends");
  const bodies = sqlCode.match(/where company_id = co/g) || [];
  assert.equal(bodies.length, 4, `expected four per-company counts, found ${bodies.length}`);
});

test("it asks the same permission the sender asks", () => {
  assert.match(SQL, /can_use_company_mail\(\)/,
    "anyone signed in can read the send counts, including somebody who cannot send");
  assert.match(SQL, /current_company_id\(\)/, "it no longer scopes to the caller's company");
});

test("it cannot write, and the backend's own counter stays shut", () => {
  assert.match(SQL, /\bstable\b/i, "the function is no longer STABLE, so it could write");
  assert.match(SQL, /mail_event_count is still service-role only/,
    "nothing asserts that the backend guard survived this migration");
  assert.doesNotMatch(SQL, /create or replace function public\.mail_event_count/i,
    "the migration redefines the backend's own counter");
});

test("anon is revoked BY NAME, not only from PUBLIC", () => {
  // Supabase's default privileges grant EXECUTE to anon directly, and
  // revoking from PUBLIC does not touch a direct grant. The first version of
  // this migration proved that on itself.
  assert.match(SQL, /revoke all on function public\.my_mail_allowance\(\) from anon;/,
    "anon keeps EXECUTE; the only thing stopping a signed-out caller is a check inside the function");
  assert.match(SQL, /grant execute on function public\.my_mail_allowance\(\) to authenticated;/,
    "a signed-in person can no longer call it");
});

// ========================================================== the screen ====

test("the office reads it and never lets it hold up a send", () => {
  const i = PAGE.indexOf("async function refreshMailAllowance()");
  assert.ok(i !== -1, "refreshMailAllowance is gone");
  const fn = PAGE.slice(i, PAGE.indexOf("function mailSyncNote(", i));
  assert.match(fn, /db\.rpc\('my_mail_allowance'\)/, "it no longer calls the RPC");
  assert.match(fn, /catch \(e\)/, "a failure is no longer swallowed; a counter must not break the mailbox");
  // The send path must not await it.
  assert.match(PAGE, /refreshMailBadge\(\);[\s\S]{0,400}?refreshMailAllowance\(\);/,
    "the refresh is not in composeSent, or is no longer next to the badge refresh");
  assert.doesNotMatch(PAGE, /await refreshMailAllowance\(\)/,
    "something awaits the counter, so a slow count can delay an email");
});

test("it refreshes only on a confirmed send", () => {
  // composeSent() is reached on state === 'sent' and nowhere else. A refusal,
  // or a send that could not be confirmed, must not move the number.
  const i = PAGE.indexOf("function composeSent(c, body)");
  assert.ok(i !== -1, "composeSent is gone");
  const fn = PAGE.slice(i, i + 1400);
  assert.match(fn, /refreshMailAllowance\(\)/, "the count is not refreshed after a send");
});

test("every new word exists in all three languages", () => {
  for (const key of ["mailAllowanceDay", "mailAllowanceHour"]) {
    const n = PAGE.split(key + ":").length - 1;
    assert.equal(n, 3, `${key} appears in ${n} locales, expected 3`);
  }
});

// ---------------------------------------------------------------- canaries

test("CANARY: the drift check fails when the two files disagree", () => {
  const fakeLimits = "export const RESEND_SENDS_PER_DAY = 500;";
  const day = Number(fakeLimits.match(/= (\d+)/)[1]);
  assert.ok(!new RegExp(`'day_cap',\\s*${day}`).test(SQL),
    "a 500 cap matched the migration's 300, so the drift check proves nothing");
});

test("CANARY: the allowance arithmetic, including an empty day", () => {
  const left = (cap, used) => Math.max(0, cap - used);
  assert.equal(left(300, 4), 296, "four sent out of three hundred");
  assert.equal(left(300, 0), 300, "a company that has never sent sees the whole allowance");
  assert.equal(left(300, 400), 0, "going over does not produce a negative allowance");
  // The hour is only mentioned when it is the tighter of the two.
  const tighter = (dayLeft, hourLeft) => hourLeft < dayLeft;
  assert.equal(tighter(296, 56), true, "the hour is the binding limit and would not be shown");
  assert.equal(tighter(4, 60), false, "the day is the binding limit and the hour would be shown anyway");
});
