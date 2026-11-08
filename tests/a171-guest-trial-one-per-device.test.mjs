/**
 * ONE GUEST DEMO PER DEVICE.
 *
 * Owner's decision, 7 Nov 2026: somebody who installs the app gets ONE
 * 15-minute look, then buys or signs in. Before this the clock was
 * GuestSession.DURATION_MS (1 hour) in the handset's own DataStore --
 * "Device-local only, never synced" -- so deleting the app and reinstalling
 * started a fresh hour, for ever.
 *
 * WHAT IS ACTUALLY BEING DEFENDED. Not the duration, which is easy to change
 * and easy to test. The thing worth a test is that the demo CANNOT BE
 * RESTARTED: a second call for the same device must count down from the first
 * claim, never issue a new window. Everything else here exists to make sure
 * that check is not passing vacuously.
 *
 * WHY ANDROID_ID AND NOT SOMETHING STRONGER, recorded so nobody re-opens it by
 * accident: it survives deleting the app, clearing its data and reinstalling,
 * because it is keyed to the app's signing key and the device. It does NOT
 * survive a factory reset. Play Integrity's device recall is the only
 * sanctioned way to survive one, and it requires the app to be distributed
 * through Google Play -- FenceFlow is a direct APK download served by
 * apk-proxy -- and is still beta behind an interest form. Checked 7 Nov 2026
 * and parked by the owner.
 *
 * THE LIVE HALF WRITES ONE ROW AND DELETES IT. The device id is reserved
 * (ffff...), could never be a real ANDROID_ID in this project's data, and the
 * row is removed in the same run. A test that left guest rows behind would
 * slowly deny demos to devices nobody owns.
 *
 *     node --test tests/a171-guest-trial-one-per-device.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'newcrgafcptspmapacrx';
const FN = `https://${PROJECT}.supabase.co/functions/v1/guest-trial`;
/** Reserved: 16 hex f's. Not an id any real handset reports here. */
const TEST_DEVICE = 'ffffffffffff0171';

const fnSrc = readFileSync(
  join(ROOT, 'supabase/functions/guest-trial/index.ts'), 'utf8');
/** Comment lines stripped: a must-contain check that reads comments passes on its own prose. */
const fnCode = fnSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const anonKey = () => {
  const cfg = readFileSync(join(ROOT, 'website/config.js'), 'utf8');
  const m = cfg.match(/SUPABASE_KEY: *'([^']+)'/);
  if (!m) throw new Error('no anon key in website/config.js');
  return m[1];
};

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'a171-guest-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  const r = spawnSync('npx', ['--no-install', 'supabase@2.115.0', 'db', 'query',
    '--linked', '--project-ref', PROJECT, '-f', file, '--output', 'json'],
    { encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`db query failed (${r.status}): ${r.stderr || r.stdout}`);
  const t = r.stdout, i = t.indexOf('{');
  const parsed = JSON.parse(i >= 0 ? t.slice(i, t.lastIndexOf('}') + 1) : t);
  return Array.isArray(parsed) ? parsed : parsed.rows;
}

const claim = async (body) => {
  const key = anonKey();
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// ---------------------------------------------------------------------------
// THE RULES, in the source
// ---------------------------------------------------------------------------

test('it refuses to run without a pepper instead of hashing without one', () => {
  // An empty pepper makes the stored value a plain sha256 of a 16-hex string,
  // which is reversible with a rainbow table -- and stable, so the table
  // would fill with weak hashes a later fix could not undo.
  assert.match(fnCode, /if \(!url \|\| !service \|\| !pepper\)/,
    'the function no longer refuses when GUEST_TRIAL_PEPPER is unset');
  assert.match(fnCode, /sha256Hex\(pepper \+ deviceId\)/,
    'the device id is no longer peppered before hashing');
});

test('the raw device id is never written to the table', () => {
  // The row must say one thing only: this device has had its demo.
  const inserts = fnCode.match(/\.insert\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(inserts.length >= 1, 'no insert found; this check cannot run');
  for (const ins of inserts) {
    assert.ok(!/device_id/.test(ins),
      `an insert writes the raw device id: ${ins.slice(0, 120)}`);
    assert.match(ins, /device_hash/, 'the insert no longer stores the hash');
  }
});

test('a phone cannot claim more offline time than we ever grant offline', () => {
  // Reported by the app, so it is clamped, not trusted.
  assert.match(fnCode, /Math\.min\(Math\.max\(offlineRaw, 0\), OFFLINE_MS\)/,
    'offline_ms_used is no longer clamped, so a handset can report any figure');
});

test('a failed read is not treated as a device with no row', () => {
  // The quiet catastrophe: a database hiccup handing out a fresh demo every
  // time, which is precisely what this endpoint exists to prevent.
  assert.match(fnCode, /if \(readErr\)/,
    'a failed lookup now falls through to the grant path');
  assert.match(fnCode, /read_failed/, 'the failed-read answer is gone');
});

test('CORS answers the preflight before the method check', () => {
  const opts = fnCode.indexOf('req.method === "OPTIONS"');
  const post = fnCode.indexOf('req.method !== "POST"');
  assert.ok(opts >= 0 && post >= 0, 'a method check is missing');
  assert.ok(opts < post, 'the preflight collects the 405 again');
});

test('the gateway lets a guest in, because a guest has no login', () => {
  // Deployed with verification ON, every first-run device is refused 401
  // before the function runs and the demo simply never starts.
  const toml = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8');
  assert.match(toml, /\[functions\.guest-trial\][\s\S]{0,80}verify_jwt = false/,
    'guest-trial is not pinned to verify_jwt = false in config.toml');
});

// ---------------------------------------------------------------------------
// THE RULE THAT MATTERS, against the deployed function
// ---------------------------------------------------------------------------

test('LIVE: a device gets one demo, and asking again does not restart it', async (t) => {
  // Clean up whatever this test does, pass or fail.
  t.after(() => {
    try {
      runSql(`delete from public.guest_device_trials
               where device_hash in (select device_hash from public.guest_device_trials
                                      where app_version = 'a171');`);
    } catch { /* reported by the next run's leftover check */ }
  });

  const first = await claim({ device_id: TEST_DEVICE, app_version: 'a171' });
  assert.strictEqual(first.status, 200, `claim failed: ${JSON.stringify(first.json)}`);
  assert.strictEqual(first.json.allowed, true, 'a brand-new device was refused its demo');
  assert.strictEqual(first.json.remainingMs, first.json.fullMs,
    'a first claim did not get the full demo');

  const second = await claim({ device_id: TEST_DEVICE, app_version: 'a171' });
  assert.strictEqual(second.json.expiresAt && new Date(second.json.expiresAt).getTime(),
    new Date(first.json.expiresAt).getTime(),
    'asking again moved the expiry -- the demo can be restarted, which is the ' +
    'entire thing this feature exists to prevent');
  assert.ok(second.json.remainingMs <= first.json.remainingMs,
    'the second answer had MORE time left than the first');
  assert.strictEqual(second.json.reason, 'running');
});

test('LIVE: a value that is not a device identifier is refused', async () => {
  // Also the cheapest proof the endpoint is reachable at all without a login.
  const r = await claim({ device_id: 'not-a-device' });
  assert.strictEqual(r.status, 400, `expected 400, got ${r.status}`);
  assert.strictEqual(r.json.error_code, 'bad_device');
});

test('LIVE: the table is not readable with the key that ships in the app', async () => {
  // The anon key is in website/config.js and in every APK. This table records
  // devices, so it must be invisible to it -- RLS on, no policies, grants
  // revoked. Supabase hands every new public table to anon by default, and
  // leaving that in place was 14 grants on this table when measured.
  const key = anonKey();
  const res = await fetch(
    `https://${PROJECT}.supabase.co/rest/v1/guest_device_trials?select=device_hash&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  assert.notStrictEqual(res.status, 200,
    'guest_device_trials is readable with the public anon key');
});

test('no test rows are left behind', () => {
  const [row] = runSql(
    `select count(*)::int as n from public.guest_device_trials where app_version = 'a171';`);
  assert.strictEqual(Number(row.n), 0, `${row.n} a171 row(s) survived the run`);
});
