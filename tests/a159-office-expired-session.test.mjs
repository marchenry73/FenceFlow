/**
 * THE OFFICE CALLED AN EXPIRED SESSION A PERMISSION PROBLEM.
 *
 * MARCH, 6 Nov 2026: "I am the owner on the website and I am not able to
 * modify or upload. that has been an ongoing issue, I have no idea why."
 *
 * MEASURED, against the live project, with his own signed-in session:
 *   - reads of companies succeed              (200, the data is all there)
 *   - update companies set license_no = ''    (200, one row)
 *   - upload into company-logos/<his company> (200, then removed again)
 * So nothing about his account or the policies refuses him. What refused him
 * was a session that had expired while the tab sat open: every policy on this
 * project resolves the caller through auth.uid(), which is NULL on a dead
 * token, so the row fails the policy and Postgres answers "row-level
 * security" -- a sentence about rows, for a problem about sign-in.
 *
 * plainError() is supposed to catch exactly that, and could not, because
 * hasLiveSession() only asked whether a session OBJECT was present:
 *
 *     return !!(db.auth.currentSession && db.auth.currentSession.access_token)
 *
 * supabase-js keeps currentSession in memory and in localStorage after it has
 * expired -- that cached copy is what a refresh is attempted FROM -- so an
 * hour-dead session answered `true`, and both callers took the "he is signed
 * in, so this is about his account" branch. The expired case is the ONLY case
 * either caller exists to recognise, so the guard was inert in precisely the
 * state it was written for. That is why the message had been wrong for weeks
 * and why no amount of looking at his permissions could explain it.
 *
 * These are behavioural: hasLiveSession and plainError are lifted out of the
 * page and called, rather than grepped for, because the defect was a true
 * source line that computed the wrong answer -- a wording check could not
 * have seen it and did not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, '..', 'website', 'dashboard.html');
const src = fs.readFileSync(PAGE, 'utf8');

/** The source of one top-level `function name(){...}`, by brace counting. */
function fnSource(name) {
  const head = 'function ' + name + '(';
  const i = src.indexOf(head);
  assert.notStrictEqual(i, -1, name + '() is gone from dashboard.html');
  let depth = 0, j = src.indexOf('{', i);
  const start = j;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  assert.ok(j > start, 'could not find the end of ' + name + '()');
  return src.slice(i, j);
}

const NOW = 1_700_000_000_000;            // fixed, so nothing here depends on the clock
const secs = ms => Math.floor(ms / 1000);

/** A supabase-js-shaped client holding `session` as its cached session. */
function clientWith(session) {
  return { auth: { currentSession: session } };
}

/** hasLiveSession(), called with `db` bound and Date.now() pinned to NOW. */
function askLive(session) {
  const real = Date.now;
  Date.now = () => NOW;
  try {
    return new Function('db', fnSource('hasLiveSession') + '\nreturn hasLiveSession();')(
      clientWith(session)
    );
  } finally { Date.now = real; }
}

const EXPIRED = { access_token: 'a.b.c', expires_at: secs(NOW) - 3600 };
const LIVE    = { access_token: 'a.b.c', expires_at: secs(NOW) + 1800 };

test('a session that expired an hour ago is not a live session', () => {
  // THE WHOLE BUG. This read `true` for weeks, which is why a dead token was
  // reported as an account that is not allowed to upload.
  assert.strictEqual(askLive(EXPIRED), false,
    'an expired session still reads as live, so every refusal it causes is ' +
    'reported as a permission problem -- the exact failure March chased for weeks');
});

test('a session expiring in half an hour IS a live session', () => {
  // The other half: a genuine permission refusal must keep saying so.
  assert.strictEqual(askLive(LIVE), true,
    'a valid session reads as dead, which would send every refusal to "sign in again"');
});

test('no session at all is not a live session', () => {
  assert.strictEqual(askLive(null), false);
  assert.strictEqual(askLive({ expires_at: secs(NOW) + 1800 }), false,
    'a session with no access_token reads as live');
});

test('expiry is read from the token when the session does not carry one', () => {
  // expires_at is absent on some stored sessions. The access token always
  // carries its own exp, and it is the authority the SERVER uses.
  const jwt = exp => 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.y';
  assert.strictEqual(askLive({ access_token: jwt(secs(NOW) - 3600) }), false,
    'an expired token with no expires_at reads as live');
  assert.strictEqual(askLive({ access_token: jwt(secs(NOW) + 1800) }), true,
    'a valid token with no expires_at reads as dead');
});

test('an expiry that cannot be read is not treated as expired', () => {
  // Deliberately the OLD behaviour when the answer is unknown: this change
  // narrows the live case to "provably expired", and never invents a sign-in
  // problem out of a session it could not measure. Three states, not two.
  assert.strictEqual(askLive({ access_token: 'not-a-jwt' }), true,
    'an unmeasurable session is called dead, which fabricates a sign-in problem');
});

test('a row-level refusal on an expired session reads as sign in again', () => {
  // End to end through the real plainError, with the real TECH_ERRORS table.
  const tr = (k, ...a) => [k, ...a].join('|');
  const run = (session, text) => {
    const real = Date.now;
    Date.now = () => NOW;
    try {
      return new Function('db', 'tr', 'profile', 'signedInEmail', 'reportOfficeError',
        fnSource('hasLiveSession') + '\n' + fnSource('whoAmI') + '\n' +
        fnSource('plainError') + '\nreturn plainError(' + JSON.stringify(text) + ');'
      )(clientWith(session), tr, { role: 'OWNER' }, 'marc@fenceflowapp.com', () => {});
    } finally { Date.now = real; }
  };
  const ROW = 'new row violates row-level security policy for table "objects"';

  assert.strictEqual(run(EXPIRED, ROW), 'errSession',
    'an expired session uploading a logo is still told his account is not allowed');
  assert.strictEqual(run(LIVE, ROW), 'errPermission|marc@fenceflowapp.com (OWNER)',
    'a real permission refusal no longer names the account that was refused');

  // And the message names the account, which for weeks it could not: whoAmI()
  // read a global `user` that only ever existed inside boot().
  assert.ok(!run(LIVE, ROW).includes('?'),
    'the refusal still cannot say which login it refused');
});
