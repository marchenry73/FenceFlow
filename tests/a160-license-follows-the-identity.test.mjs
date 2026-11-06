/**
 * THE LICENCE NUMBER THE APP SHOWS IS NOT THE ONE FENCEFLOW PRINTS.
 *
 * MARCH, 6 Nov 2026: "Fix the licence two-store split too."
 *
 * The licence lives in company_settings -> 'license_number' (what the phone
 * and the office Settings panel write and show) and in companies.license_no
 * (what everything outside them reads). Measured against the live project on
 * 6 Nov, before the fix: the column was blank for all 12 companies while 2
 * held a licence in the blob, and 0 disagreed. Two customer-facing readers
 * take the blank one -- hoa-letter/index.ts puts it on a letter to an HOA, and
 * _shared/job-spec.ts omits its `License:` line entirely.
 *
 * WHY IT SURVIVED FIVE WEEKS. supabase_company_business_record.sql (29 Sept)
 * named all three identity fields and chose mirroring. r62 implemented two and
 * excluded the licence, saying companies "has no such column" -- a sentence
 * that was false when written. So this file asserts the CORRECTION as well as
 * the code: a wrong reason that reads as a decision is what stopped anyone
 * looking again.
 *
 * WHAT IS CHECKED HERE AND WHAT IS CHECKED LIVE. These are checks on r69 and
 * r62 as FILES -- that the change says what it must say before anyone runs it.
 * The behaviour (blob -> column, a licence-only write -> blob, a blank losing
 * to a real licence, and a positive control with the trigger dropped) was
 * proved against the live project inside BEGIN/ROLLBACK, and the probe's own
 * canary was watched to bite. a84 is where live identity parity is guarded.
 *
 *     node --test tests/a160-license-follows-the-identity.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(path.join(ROOT, f), 'utf8');

const R69 = read('supabase_r69_license_follows_the_identity.sql');
const R62 = read('supabase_r62_one_company_identity.sql');

/** r69 with every comment line stripped, so no check can be satisfied by prose.
 *  Three separate checks in one day have passed by matching a comment that
 *  described the code instead of the code. */
const r69Code = R69.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

test('the mirror pushes the blob licence into companies.license_no', () => {
  assert.match(r69Code, /update companies set license_no = btrim\(s_license\)/,
    'the direction that matters today -- the phone and the office both write the blob');
});

test('the mirror pushes companies.license_no into the blob', () => {
  assert.match(r69Code, /jsonb_build_object\('license_number', btrim\(new\.license_no\)\)/,
    'a licence set in the admin console would never reach the phone');
});

test('the trigger fires on license_no, or the function change is inert', () => {
  // THE HALF THAT WOULD HAVE MADE EVERYTHING ELSE HERE A LIE. The live trigger
  // was `AFTER UPDATE OF name, phone`, a column list: teaching the function
  // about the licence and leaving the list alone gives a mirror that satisfies
  // both tests above and never runs on a licence-only write.
  const trig = r69Code.match(/create trigger companies_mirror_identity[\s\S]*?;/);
  assert.ok(trig, 'r69 no longer recreates companies_mirror_identity');
  assert.match(trig[0], /after update of name, phone, license_no on public\.companies/i,
    'license_no is missing from the trigger column list, so a licence-only ' +
    'write still does not fire the mirror -- the exact way this fix becomes inert');
});

test('a blank never overwrites a real licence, on either side', () => {
  // Same rule as name and phone: absence is not an instruction to delete. A
  // licence prints on a contract.
  const pushes = r69Code.match(/coalesce\(btrim\([^)]*license[^)]*\), ''\) <> ''/gi) || [];
  assert.ok(pushes.length >= 3,
    `expected the non-blank guard on each licence write, found ${pushes.length}`);
});

test('the backfill only fills blanks, and never picks between two real licences', () => {
  const fill = r69Code.slice(r69Code.indexOf('update companies c'));
  assert.match(fill, /coalesce\(btrim\(c\.license_no\), ''\) = ''/,
    'the backfill does not require the target to be blank, so it can overwrite ' +
    'a licence somebody deliberately set');
});

test('r69 proves its own work, and the proof is not vacuous', () => {
  assert.match(R69, /raise exception 'r69 CANARY/,
    'no canary: the parity check reads true on an empty table and says nothing');
  assert.match(r69Code, /< 2 then[\s\S]{0,200}raise exception 'r69: fewer than the 2 measured licences survive/,
    'nothing stops a "fix" that satisfies parity by blanking both licences');
  assert.match(r69Code, /pg_get_triggerdef\(oid\) ilike '%UPDATE OF name, phone, license_no%'/,
    'r69 does not verify its own trigger column list after running');
});

test("r62's false reason for excluding the licence is corrected, not just removed", () => {
  // ASSERTED, because the wrong reason is the actual root cause: it read as a
  // considered decision, so nobody re-opened it. If someone trims this comment
  // back to a tidy one-liner, the next person inherits the same silence.
  assert.match(R62, /CORRECTED 6 Nov 2026/,
    'the correction note is gone from r62');
  assert.match(R62, /THAT WAS NEVER TRUE/,
    'r62 no longer records that its stated reason was false');
  assert.ok(!/it exists only in the settings blob,\s*\n--\s*companies has no such column, so there is nothing to keep in step/.test(R62),
    'the false sentence is still present in r62 as if it were true');
  assert.match(R62, /r69_license_follows_the_identity/,
    'r62 does not point at the change that fixed it');
});

test('r69 records what it deliberately leaves open', () => {
  // The first-ever settings save INSERTs the row, and both triggers are
  // UPDATE-only, so that one save still does not reach companies. Said out
  // loud beats a reader assuming the field is now wholly safe.
  assert.match(R69, /STILL OPEN/,
    'r69 claims completeness it does not have');
  assert.match(R69, /INSERTS the company_settings row/,
    'the insert-only gap is not recorded, so it reads as covered');
});
