// a89 -- the migration audit must not report a LIVE guard as missing.
//
// WHY THIS EXISTS. scripts/audit-unapplied-migrations.mjs is the instrument
// that decides which migrations get put in front of the owner as "never
// applied". It compared a repo file's `create trigger protect_customer_identity`
// against the live trigger list by EXACT name -- and the applied trigger is
// named `00_protect_customer_identity`, because triggers fire in alphabetical
// order and the guards were deliberately prefixed. So the audit reported a
// guard that exists, and does its job, as absent.
//
// That is the worst place for this tool to be blind. Measured against live on
// 2026-10-31, SEVENTEEN triggers carry such a prefix and they are almost all
// the money and identity guards: 00_hold_line_item_prices, 00_protect_job_money,
// 00_hold_quote_gate, 00_hold_material_price, 00_hold_contract_columns,
// 10_reapproval_resolve, 90_mark_change_orders_accepted. An audit whose false
// alarms land exactly on the guards spends the owner's trust on nothing, and
// the next true finding reads like the last false one.
//
// THE OPPOSITE ERROR IS WORSE, which is why the fix is narrow and why this file
// spends most of its checks on the narrowness rather than the tolerance: a
// loose suffix match would let `trigger:push` count `job-change-push` as
// present, and a genuinely missing trigger -- the half-applied
// zz_deposit_follows_price, whose absence means a money rule has never fired --
// would be silently hidden.
//
// This does NOT grep the script for the fix. It EXTRACTS the shipped block and
// runs it, so what is under test is the behaviour, not a comment claiming it.
//
//     node --test tests/a89-audit-reads-prefixed-triggers.test.mjs   (no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = readFileSync(join(ROOT, "scripts/audit-unapplied-migrations.mjs"), "utf8")
  .replace(/\r\n/g, "\n");

/**
 * The shipped normalisation + canary, lifted out by its own boundaries.
 * Taken from the row loop through the end of the canary loop, so the test
 * cannot drift from the code: if the block moves or is deleted, the extraction
 * fails loudly rather than passing vacuously.
 */
function extractBlock(src) {
  const start = src.indexOf("for (const x of rows) {");
  assert.ok(start > 0, "the trigger-normalisation loop is gone from the audit script");
  // End at the size refusal that follows, NOT at the next const: including
  // that refusal made the block exit(2) on any small fabricated fixture, which
  // read exactly like the canary firing. A boundary that swallows a second
  // guard turns every check here into a test of the wrong thing.
  const end = src.indexOf("\nif (live.size < 50)", start);
  assert.ok(end > start, "could not find the end of the block (the size refusal that follows it)");
  return src.slice(start, end);
}

const BLOCK = extractBlock(SRC);

/**
 * Run the extracted block against a fabricated live set. `process` and
 * `console` are SHADOWED as parameters, so the block's own canary cannot kill
 * this test process -- its exit becomes a thrown ExitCalled we can assert on.
 */
function runBlock(liveNames, { loosen = false } = {}) {
  const live = new Set(liveNames);
  const rows = liveNames.map((n) => {
    const [kind, ...rest] = n.split(":");
    return { kind, name: rest.join(":") };
  });
  let code = BLOCK;
  if (loosen) {
    // Plant the mistake the narrowness is there to prevent.
    const target = "  if (bare !== x.name) live.add(`trigger:${bare}`);";
    code = code.replace(target, target +
      "\n  for (const part of String(x.name).split(/[_-]/)) live.add(`trigger:${part}`);");
    assert.notEqual(code, BLOCK,
      "the loosening did not take, so the canary check below proves nothing");
  }
  const errors = [];
  const fakeProcess = { exit: (c) => { const e = new Error("ExitCalled"); e.code = c; throw e; } };
  const fakeConsole = { error: (m) => errors.push(String(m)) };
  const fn = new Function("rows", "live", "process", "console", code);
  let exited = null;
  try { fn(rows, live, fakeProcess, fakeConsole); }
  catch (e) { if (e.message !== "ExitCalled") throw e; exited = e.code; }
  return { live, errors, exited };
}

test("0. the block was really extracted, so every check below runs shipped code", () => {
  assert.match(BLOCK, /replace\(\/\^\[0-9\]\+_\/, ""\)/,
    "the extracted block does not contain the prefix strip -- the extraction is wrong");
  assert.match(BLOCK, /canary/i, "the extracted block does not contain the canary");
  assert.ok(BLOCK.length < 2000,
    `extracted ${BLOCK.length} chars -- that is more than the block, the boundaries are wrong`);
  // The boundary bug that made check 1 fail for the wrong reason: the slice
  // reached past the canary into the size refusal, so a one-row fixture
  // exited 2 and looked like a loose match.
  assert.doesNotMatch(BLOCK, /live\.size < 50/,
    "the extraction reaches past the canary into the size refusal -- small fixtures will exit(2) for an unrelated reason");
});

test("1. a prefixed live trigger is recognised as the guard the file declares", () => {
  // The real case: views_and_admin_patch declares protect_customer_identity,
  // live holds 00_protect_customer_identity, and the guard IS doing its job.
  const { live, exited } = runBlock(["trigger:00_protect_customer_identity"]);
  assert.equal(exited, null, "the canary fired on the correct, narrow version");
  assert.ok(live.has("trigger:protect_customer_identity"),
    "the audit still reads the live customer-identity guard as missing -- the exact bug this file exists for");
  // And every prefix form actually in use, not just the one that was found.
  for (const [liveName, declared] of [
    ["trigger:00_hold_line_item_prices", "trigger:hold_line_item_prices"],
    ["trigger:00_protect_job_money", "trigger:protect_job_money"],
    ["trigger:10_reapproval_resolve", "trigger:reapproval_resolve"],
    ["trigger:90_mark_change_orders_accepted", "trigger:mark_change_orders_accepted"],
  ]) {
    const r = runBlock([liveName]);
    assert.ok(r.live.has(declared), `${liveName} is not matched to ${declared}`);
  }
});

test("2. the match is NARROW -- a shared suffix is still absent", () => {
  const { live } = runBlock(["trigger:00_protect_customer_identity"]);
  for (const near of ["trigger:customer_identity", "trigger:identity",
                      "trigger:protect", "trigger:protect_customer"]) {
    assert.ok(!live.has(near),
      `${near} counted as live off 00_protect_customer_identity -- a genuinely missing trigger would be hidden`);
  }
});

test("3. the deposit trigger, which is genuinely missing, STAYS missing", () => {
  // This is the money case. deposit_follows_price() the FUNCTION is live;
  // no trigger in public carries 'deposit' or 'zz' under any name, which was
  // confirmed against live by pattern rather than by exact name. If the
  // tolerance ever grew enough to match this, the owner would be told a money
  // rule is in effect when it has never fired once.
  const { live } = runBlock([
    "function:deposit_follows_price",
    "trigger:00_protect_job_money",
    "trigger:jobs_touch_updated_at",
  ]);
  assert.ok(!live.has("trigger:zz_deposit_follows_price"),
    "the audit now thinks the deposit trigger is applied; it is not, and the deposit rule has never fired");
  assert.ok(!live.has("trigger:deposit_follows_price"),
    "a function with that name made the audit believe a trigger of that name exists");
});

test("4. only triggers are normalised -- a function keeps its exact name", () => {
  // A function called 00_something is not a thing, but the guard against
  // kind-blindness is free, and the cost of getting it wrong is a function
  // reported present because another one shares its tail.
  const { live } = runBlock(["function:00_seed_starting_catalog"]);
  assert.ok(!live.has("function:seed_starting_catalog"),
    "the normalisation is being applied to functions too, which is not what was measured or intended");
});

test("5. CANARY: the loose version is caught, and caught by the shipped canary", () => {
  const { exited, errors } = runBlock(["trigger:00_protect_customer_identity"], { loosen: true });
  assert.equal(exited, 2,
    "canary: a loose suffix match did NOT make the audit refuse -- its own guard against hiding a real absence is dead");
  assert.ok(errors.some((e) => /too loose/.test(e)),
    `canary: the audit exited without saying why; got ${JSON.stringify(errors)}`);
});

test("6. the audit still refuses to report when the live read looks empty", () => {
  // Unrelated to the prefix fix, and the reason this script was ever
  // trustworthy: an empty live set reads as "every migration is unapplied".
  // Checked on code with comments stripped, so the sentence above cannot
  // satisfy it.
  const code = SRC.replace(/^[ \t]*\/\/.*$/gm, "");
  assert.match(code, /if \(live\.size < 50\)/,
    "the empty-result refusal is gone, so a failed query would report all 346 files as unapplied");
  assert.match(code, /if \(r\.status !== 0\)/,
    "the exit-status check is gone, so an error response would be parsed as an empty result");
});
