/**
 * THE RECORD_MONEY GATE, MEASURED ON THE LIVE DATABASE, BOTH WAYS.
 *
 *     node --test tests/a181-record-money-gate-is-live.test.mjs
 *
 * ------------------------------------------------------------------
 * WHY TWO DIRECTIONS, AND WHY THAT IS THE WHOLE POINT
 * ------------------------------------------------------------------
 * The gate can fail in two opposite ways, and neither failure looks like the
 * other from outside:
 *
 *   TOO WEAK  -- a manager marks a job paid in full with nothing behind it.
 *                That was the live defect found by the A4 audit on 20 Nov
 *                2026, proved as a real manager in a rolled-back transaction.
 *
 *   TOO HARD  -- a manager records a $250 cash payment, the ledger row lands,
 *                and the job's figure never moves. That is what the FIRST
 *                version of the fix actually did, in production, for about
 *                forty minutes. `recompute_job_totals()` derives amount_paid
 *                from `payment_records`, and it is SECURITY DEFINER -- but
 *                `record_money_trusted()` reads `request.jwt.claims`, which a
 *                definer function does not change. So the recompute ran inside
 *                the manager's own session and its write was reverted.
 *
 * A test that only checked the first direction would have passed while the
 * second was broken, which is exactly what happened. Both are asserted here,
 * against the LIVE functions, and the third case below is the one that tells
 * "frozen at the old value" apart from "corrected to the ledger".
 *
 * ------------------------------------------------------------------
 * HOW
 * ------------------------------------------------------------------
 * By running the two probe FILES that live beside the fix, rather than a copy
 * of their SQL -- so the thing this test checks is the thing somebody runs by
 * hand when they want to know. Each probe impersonates a real profile chosen
 * BY PROPERTY (never by name), does its writes inside BEGIN/ROLLBACK, and
 * carries its own positive controls: a price column that must still write, an
 * ordinary column that must still write, a cross-company write that must be
 * refused (which is what shows the probe ran UNDER row-level security rather
 * than around it), and an OWNER who must not be locked out.
 *
 * This file asserts on those controls too. A probe whose fixture went missing
 * reports "STOP - not a pass", and that is treated as a failure here, because
 * an empty answer reading as good news is the failure this project keeps
 * meeting.
 *
 * Nothing is kept: every probe ends in ROLLBACK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const PROJECT = "newcrgafcptspmapacrx";

/** Runs a probe FILE from the repo root and returns its rows. */
function runProbe(file) {
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`${file} failed (${r.status}): ${r.stderr || r.stdout}`);
  const t = r.stdout, i = t.indexOf("{");
  const parsed = JSON.parse(i >= 0 ? t.slice(i, t.lastIndexOf("}") + 1) : t);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${file} returned no rows: ` + t.slice(0, 400));
  }
  return rows;
}

/**
 * Both probes read ONCE per run and reused by every check.
 *
 * Not only for speed. Two reads are two snapshots, so the checks could in
 * principle disagree with each other about what the gate does -- and adding
 * uncached database round trips to this suite has already tipped another
 * database-backed test over its timeout once.
 */
const HOLD = runProbe("supabase_a4_record_money_probe_live.sql");
const LEDGER = runProbe("supabase_a4_ledger_route_probe_live.sql");

/** The verdict for a step whose name contains `needle`. */
const verdictFor = (rows, needle) => {
  const hit = rows.filter((r) => String(r.step).toLowerCase().includes(needle.toLowerCase()));
  assert.equal(hit.length, 1,
    `expected exactly one step matching "${needle}", found ${hit.length}: ` +
    rows.map((r) => r.step).join(" | "));
  return { verdict: String(hit[0].verdict), measured: String(hit[0].measured) };
};

const noProbeStopped = (rows, file) => {
  const stopped = rows.filter((r) => String(r.verdict).startsWith("STOP"));
  assert.equal(stopped.length, 0,
    `${file} stopped before measuring anything (${stopped.map((r) => r.measured).join("; ")}). ` +
    `That is NOT a pass: its fixture -- a MANAGER with a company, and a job in it -- ` +
    `has gone. Fix the fixture or the probe; do not read the silence as clean.`);
};

// ----------------------------------------------------------- TOO WEAK -----

test("a MANAGER cannot declare money on a job by hand", () => {
  noProbeStopped(HOLD, "the hand-write probe");
  const { verdict, measured } = verdictFor(HOLD, "UPDATE amount_paid / payment_status as MANAGER");
  assert.match(verdict, /^HELD/,
    `a manager's hand write moved the money columns (${measured}). ` +
    `money_caller_trusted() accepts SEE_MONEY, a READ permission; declaring money ` +
    `needs RECORD_MONEY. See supabase_a4_record_money_is_a_write_permission.sql.`);
});

test("the MANAGER really is a manager who sees money but may not record it", () => {
  // The fixture, asserted: without this the HELD above could be a profile
  // that was refused for some entirely different reason.
  assert.equal(verdictFor(HOLD, "MANAGER holds SEE_MONEY").measured, "true",
    "the probe's manager cannot see money at all, so HELD proves nothing about RECORD_MONEY");
  assert.equal(verdictFor(HOLD, "MANAGER holds RECORD_MONEY").measured, "false",
    "the probe's manager holds RECORD_MONEY, so of course the write was allowed");
});

// ----------------------------------------------------------- TOO HARD -----

test("a MANAGER can still record a cash payment, and the job's figure follows it", () => {
  noProbeStopped(LEDGER, "the ledger-route probe");
  const { verdict, measured } = verdictFor(LEDGER, "records $250 CASH in the ledger");
  assert.match(verdict, /^FOLLOWED THE LEDGER/,
    `a manager recorded cash and the job's figure did not move (${measured}). ` +
    `recompute_job_totals() runs inside the caller's own session, so a hold that ` +
    `freezes amount_paid at its old value reverts the recompute too. See ` +
    `supabase_a4_record_money_follows_the_ledger.sql.`);
});

test("a hand write is corrected TO THE LEDGER, not frozen at the old value", () => {
  /* This is the check that tells the two implementations apart. Freezing at
     OLD and recomputing from the ledger both make the first test pass; only
     recomputing survives this one, and only recomputing lets the cash show. */
  const { verdict, measured } = verdictFor(LEDGER, "hand write 99999 after the cash row");
  assert.match(verdict, /^CORRECTED TO THE LEDGER/,
    `a typed figure did not land on the ledger's answer (${measured})`);
});

// ----------------------------------------------------------- controls -----

test("CONTROL: the probes ran under row-level security, not around it", () => {
  for (const [rows, name] of [[HOLD, "hand-write probe"], [LEDGER, "ledger-route probe"]]) {
    const { verdict } = verdictFor(rows, "another company");
    assert.match(verdict, /^refused/,
      `${name}: a cross-company write was NOT refused, so every refusal it reports ` +
      `could be an artefact of running with too much power rather than a permission result`);
  }
});

test("CONTROL: managers still price jobs, and owners are not locked out", () => {
  assert.match(verdictFor(HOLD, "writes a PRICE column").verdict, /^accepted/,
    "the gate has taken pricing away from managers, which is not what was wrong");
  assert.match(verdictFor(LEDGER, "writes contract_total").verdict, /^accepted/,
    "the gate has taken pricing away from managers, which is not what was wrong");
  assert.match(verdictFor(HOLD, "the OWNER writes amount_paid").verdict, /^accepted/,
    "the OWNER cannot declare money on his own jobs");
  assert.match(verdictFor(LEDGER, "the OWNER writes amount_paid").verdict, /^accepted/,
    "the OWNER cannot declare money on his own jobs");
  assert.match(verdictFor(HOLD, "writes an ordinary column").verdict, /^accepted/,
    "nothing at all is writable, so the refusals above prove nothing");
});

test("CONTROL: the escape hatch works, so this is a decision and not a wall", () => {
  // Without this, the only way to let a trusted manager mark a job paid would
  // be to take the gate off for everybody.
  assert.match(verdictFor(HOLD, "+RECORD_MONEY override").verdict, /^accepted/,
    "a +RECORD_MONEY override does not let a named manager through, so the gate " +
    "cannot be granted per person the way every other permission can");
});
