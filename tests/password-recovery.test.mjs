/**
 * A page that can SEND a password-reset email must also be able to HONOUR one.
 *
 * dashboard.html called resetPasswordForEmail() and stopped there. The mail
 * went out, the contractor followed the link, Supabase handed the page a
 * recovery session in the URL hash -- and the page, which knew nothing about
 * recovery, simply saw a signed-in user and opened the office. Nothing asked
 * for a new password, so the forgotten password was still the password and
 * the phone app, which is the actual product, stayed locked out. The only
 * visible symptom was a reset that appeared to work.
 *
 * Nothing could fail here, which is why it survived. There is no error, no
 * exception and no empty screen: the success path and the broken path look
 * identical from the outside. So the check has to be structural. A page that
 * calls resetPasswordForEmail carries all three pieces or it is broken:
 *
 *   1. resetPasswordForEmail  -- sends the mail
 *   2. type=recovery          -- notices the link coming back
 *   3. updateUser             -- actually changes the password
 *
 * Deliberately shallow: it proves the pieces are on the page, not that they
 * are wired to each other. That is the trade that makes it cheap enough to
 * never be deleted, and it is exactly the check that would have caught this
 * the day it was written.
 */
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const WEBSITE = new URL("../website/", import.meta.url);

/**
 * Comments are stripped; strings are NOT.
 *
 * Both halves of that matter. Comments must go, because three of these pages
 * discuss `type=recovery` and `updateUser` in prose -- a check that counted
 * prose would pass on a page that only talks about recovery, which is very
 * nearly the bug it is looking for. Strings must stay, because a gate may
 * legitimately be written `hash.includes('type=recovery')` rather than as a
 * regular expression, and blanking strings would fail a page that is right.
 *
 * Same comment-stripping shape as dashboard-undefined-calls.test.mjs, which
 * has run over these same files for months.
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1 ");
}

/** Inline <script> bodies plus any local module files the page loads. */
function pageCode(html, readLocal) {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]);
  const external = [...html.matchAll(/<script[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/g)]
    .map((m) => m[1])
    .filter((rel) => !/^https?:|^\/\//.test(rel))
    .map((rel) => readLocal(rel));
  return stripComments([...inline, ...external].join("\n"));
}

/**
 * The whole rule, in one place so the planted failures below exercise the
 * same code the real pages do. Returns the list of what is missing; an empty
 * list means the page is either complete or not in the business of sending
 * reset mail at all.
 */
function recoveryGaps(code) {
  if (!/\bresetPasswordForEmail\s*\(/.test(code)) return [];
  const gaps = [];
  if (!/type=recovery/.test(code)) {
    gaps.push("sends reset mail but never looks for type=recovery coming back");
  }
  if (!/\bupdateUser\s*\(/.test(code)) {
    gaps.push("sends reset mail but never calls updateUser, so no password can be set");
  }
  return gaps;
}

const HTML_FILES = readdirSync(WEBSITE).filter((f) => f.endsWith(".html")).sort();
const readLocal = (rel) => {
  try { return readFileSync(new URL(rel, WEBSITE), "utf8"); } catch { return ""; }
};
const PAGES = HTML_FILES.map((file) => ({
  file,
  code: pageCode(readFileSync(new URL(file, WEBSITE), "utf8"), readLocal),
}));

test("every page that sends a password-reset email can also set the password", () => {
  const broken = [];
  for (const { file, code } of PAGES) {
    for (const gap of recoveryGaps(code)) broken.push(`website/${file}: ${gap}`);
  }
  assert.deepEqual(broken, [], "\n  " + broken.join("\n  ") + "\n");
});

test("the sweep is not vacuous -- some page really does send reset mail", () => {
  const senders = PAGES
    .filter(({ code }) => /\bresetPasswordForEmail\s*\(/.test(code))
    .map(({ file }) => file);
  // A rule that applies to nothing passes for ever without meaning anything.
  // Both consoles send reset mail today; if that ever drops to zero, this
  // test wants a human to look rather than to go quietly green.
  assert.ok(
    senders.length >= 2,
    `expected the office and staff consoles to send reset mail; found ${JSON.stringify(senders)}`,
  );
  assert.ok(senders.includes("dashboard.html"), "the office console should be one of them");
  assert.ok(senders.includes("admin.html"), "the staff console should be one of them");
});

test("PLANTED FAILURE: a page that only sends the mail is caught", () => {
  // This is dashboard.html exactly as it stood before this fix: the send, and
  // nothing else. If the check above can pass this, it can pass the bug.
  const planted = stripComments(`
    <script type="module">
      // a comment mentioning type=recovery and updateUser, which must not count
      $('forgotLink').addEventListener('click', async () => {
        const { error } = await db.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + location.pathname
        });
      });
    </script>
  `);
  const gaps = recoveryGaps(planted);
  assert.equal(gaps.length, 2, `expected both gaps, got ${JSON.stringify(gaps)}`);
  assert.match(gaps[0], /type=recovery/);
  assert.match(gaps[1], /updateUser/);
});

test("PLANTED FAILURE: half a fix is still caught", () => {
  // The likelier regression: somebody adds the gate and forgets the panel, or
  // adds the panel and drops the gate. Either half alone is still a reset
  // that cannot complete.
  const gateOnly = `
    const inRecovery = /type=recovery/.test(location.hash);
    await db.auth.resetPasswordForEmail(email, {});
  `;
  const updateOnly = `
    await db.auth.resetPasswordForEmail(email, {});
    await db.auth.updateUser({ password: p });
  `;
  assert.deepEqual(recoveryGaps(gateOnly).length, 1, "gate without updateUser must fail");
  assert.match(recoveryGaps(gateOnly)[0], /updateUser/);
  assert.deepEqual(recoveryGaps(updateOnly).length, 1, "updateUser without a gate must fail");
  assert.match(recoveryGaps(updateOnly)[0], /type=recovery/);
});

test("a complete page passes, and a page that sends no reset mail is left alone", () => {
  // The other side of the planted failures: proof the rule is not simply
  // always-fail. A green result has to be reachable, and a page with no reset
  // button at all must not be dragged into this.
  const complete = `
    await db.auth.resetPasswordForEmail(email, {});
    const inRecovery = /type=recovery/.test(location.hash);
    await db.auth.updateUser({ password: p });
  `;
  assert.deepEqual(recoveryGaps(complete), []);
  assert.deepEqual(recoveryGaps("const x = 1; render();"), []);
});

test("the office console carries all three pieces", () => {
  // Named rather than left to the sweep, because this is the page the P0 was
  // about. A rename that quietly drops dashboard.html out of the file list
  // would take the sweep with it and say nothing.
  const office = PAGES.find((p) => p.file === "dashboard.html");
  assert.ok(office, "website/dashboard.html is missing");
  assert.match(office.code, /\bresetPasswordForEmail\s*\(/);
  assert.match(office.code, /type=recovery/);
  assert.match(office.code, /\bupdateUser\s*\(/);
  // The listener is the belt to the hash check's braces: it is what catches a
  // recovery session if the link shape ever changes underneath the page.
  assert.match(office.code, /PASSWORD_RECOVERY/);
});
