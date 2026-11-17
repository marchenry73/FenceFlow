/**
 * THE LOCKED SCREEN NEVER NOTICED IT HAD BEEN UNLOCKED.
 *
 * REPORTED 17 Nov 2026: "I extend my trial from the phone and it did not work
 * on the website, Still locked out."
 *
 * MEASURED against the live project: the extension worked. Legacy Solutions'
 * trial was moved to 2 Dec by admin_extend_trial and company_allowed() answered
 * TRUE; the website was signed in as that company's OWNER (the most recent
 * sign-in, one minute after the extension). The server had already let him
 * back in. What stayed locked was the TAB: checkService() runs once, before
 * anything loads, and the office had been opened while the trial was expired.
 *
 * The screen does have a "Check again" button. But the reported flow -- open
 * the office, see it locked, pick up the phone, extend, come back -- is exactly
 * the one where nobody presses it, and from where he stood the extension had
 * simply failed.
 *
 * watchForUnblock() re-asks when the tab comes back into view or regains focus,
 * and once a minute while visible, and reloads on a CONFIRMED allowed:true.
 *
 * Behavioural: the real function is lifted out of dashboard.html and run
 * against a fake document, window, timer and checkService, so the rules below
 * are tested as the page executes them rather than as strings it contains.
 *
 *     node --test tests/a172-locked-screen-notices-unlock.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'website/dashboard.html'), 'utf8');

const grab = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
};

/**
 * A fresh page each time: the function keeps a once-only flag at module level,
 * so each scenario needs its own copy of it.
 */
function page({ answers, hidden = false }) {
  const listeners = { doc: {}, win: {} };
  const intervals = [];
  let reloads = 0, asked = 0;
  const document = {
    hidden,
    addEventListener: (ev, fn) => { (listeners.doc[ev] ||= []).push(fn); },
  };
  const window = { addEventListener: (ev, fn) => { (listeners.win[ev] ||= []).push(fn); } };
  const location = { reload: () => { reloads++; } };
  const setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  const checkService = async () => { asked++; return answers.shift() ?? { allowed: false }; };

  const run = new Function('document', 'window', 'location', 'setInterval', 'checkService',
    'let unblockWatchInstalled = false;\n' + grab('watchForUnblock') +
    '\nreturn watchForUnblock;');
  const watch = run(document, window, location, setInterval, checkService);

  const fire = async (where, ev) => {
    for (const fn of (listeners[where][ev] || [])) await fn();
    await new Promise(r => setImmediate(r));
  };
  return {
    watch, document, intervals, fire,
    tick: async () => { for (const t of intervals) await t.fn(); await new Promise(r => setImmediate(r)); },
    get reloads() { return reloads; }, get asked() { return asked; }, listeners,
  };
}

test('CANARY: the function is really there and installs its listeners', () => {
  const p = page({ answers: [] });
  p.watch();
  assert.ok(p.listeners.doc.visibilitychange?.length, 'no visibilitychange listener');
  assert.ok(p.listeners.win.focus?.length, 'no focus listener');
  assert.strictEqual(p.intervals.length, 1, 'no periodic re-check');
  assert.strictEqual(p.intervals[0].ms, 60000, 'the re-check is not once a minute');
});

test('coming back to the tab after unlocking elsewhere lets you in', async () => {
  // The reported flow, end to end: the tab was locked, the server now says yes.
  const p = page({ answers: [{ allowed: true }] });
  p.watch();
  await p.fire('doc', 'visibilitychange');
  assert.strictEqual(p.reloads, 1,
    'returning to the tab after the account was switched back on did not reload -- ' +
    'the office stays locked over an account that is already allowed');
});

test('focus alone is enough, for a window that never went hidden', async () => {
  const p = page({ answers: [{ allowed: true }] });
  p.watch();
  await p.fire('win', 'focus');
  assert.strictEqual(p.reloads, 1);
});

test('and the minute timer catches it with no interaction at all', async () => {
  const p = page({ answers: [{ allowed: true }] });
  p.watch();
  await p.tick();
  assert.strictEqual(p.reloads, 1);
});

test('still locked means it stays put -- no reload', async () => {
  const p = page({ answers: [{ allowed: false }] });
  p.watch();
  await p.fire('doc', 'visibilitychange');
  assert.strictEqual(p.asked, 1, 'it did not ask the server');
  assert.strictEqual(p.reloads, 0, 'it reloaded a page that is still locked -- a reload loop');
});

test('a failed check is never read as "you are in"', async () => {
  // checkService answers {allowed:false, unknown:true} when it cannot reach the
  // server. Even a malformed allowed:true alongside unknown must not count.
  const p = page({ answers: [{ allowed: false, unknown: true }, { allowed: true, unknown: true }] });
  p.watch();
  await p.fire('doc', 'visibilitychange');
  await p.fire('win', 'focus');
  assert.strictEqual(p.reloads, 0,
    'an unreachable server let the page reload as if access had been restored');
});

test('a hidden tab is not polled', async () => {
  const p = page({ answers: [{ allowed: true }], hidden: true });
  p.watch();
  await p.tick();
  assert.strictEqual(p.asked, 0, 'a background tab is asking the server every minute');
});

test('installed once, however many times the locked screen is drawn', () => {
  const p = page({ answers: [] });
  p.watch(); p.watch(); p.watch();
  assert.strictEqual(p.listeners.doc.visibilitychange.length, 1,
    'every redraw of the locked screen stacks another listener and another timer');
  assert.strictEqual(p.intervals.length, 1);
});

test('the locked screen actually starts the watch', () => {
  // watchForUnblock being correct is worth nothing if showBlocked never calls it.
  const body = grab('showBlocked').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.match(body, /watchForUnblock\(\)/,
    'showBlocked no longer starts the re-check, so the screen is back to never noticing');
});
