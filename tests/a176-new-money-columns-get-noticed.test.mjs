/**
 * A NEW MONEY COLUMN ON `jobs` MUST NOT ARRIVE UNPROTECTED AND UNNOTICED.
 *
 *     node --test tests/a176-new-money-columns-get-noticed.test.mjs
 *
 * ------------------------------------------------------------------
 * WHY, AND WHY IT IS NOT THE SAME AS a175
 * ------------------------------------------------------------------
 * a175 pins `job_money_columns()` so a column cannot be REMOVED from the
 * protection list unnoticed. Nothing stopped the other direction: a new money
 * column being ADDED to `jobs` and never put on the list at all. That is
 * exactly how two of them got through, found during the A4 audit on
 * 20 Nov 2026 — `cancellation_retained` (the money he keeps when a customer
 * cancels) and `materials_to_buy` (which the deposit rule reads).
 *
 * THE TRAP THIS FILE IS BUILT AROUND. The obvious implementation is a regular
 * expression over column names — amount, total, price, fee, deposit… I wrote
 * that first and it MISSED `materials_to_buy`, which carries no money word in
 * its name and feeds the deposit a customer is asked for. A name-shaped
 * detector cannot be trusted to find money.
 *
 * So there are two checks, and the second is the one that actually holds:
 *   1. the money-NAMED columns that are unprotected are exactly the ones
 *      listed here, each with a reason — so a new `*_amount` is loud;
 *   2. the COLUMN COUNT of `jobs` is pinned — so ANY new column at all, named
 *      anything, turns this red and makes somebody say which group it is in.
 *
 * (2) is deliberately blunt. It will go red for a column that has nothing to
 * do with money, and the answer then is one line in NOT_MONEY below plus a
 * bumped count. That is the cost of catching the next `materials_to_buy`, and
 * on a table that decides what customers are charged it is worth paying.
 *
 * READ-ONLY.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "newcrgafcptspmapacrx";

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "a176-cols-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, sql, "utf8");
  const r = spawnSync("npx", ["--no-install", "supabase@2.115.0", "db", "query",
    "--linked", "--project-ref", PROJECT, "-f", file, "--output", "json"],
    { encoding: "utf8", shell: process.platform === "win32", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`db query failed (${r.status}): ${r.stderr || r.stdout}`);
  const t = r.stdout, i = t.indexOf("{");
  const parsed = JSON.parse(i >= 0 ? t.slice(i, t.lastIndexOf("}") + 1) : t);
  const rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) throw new Error("no rows in: " + t.slice(0, 300));
  return rows;
}

/** Columns on `jobs` as of 20 Nov 2026. Bump deliberately, never to go green. */
const COLUMN_COUNT = 128;

/**
 * Money-named columns that are NOT on the protection list because they are
 * not money. Each one needs a reason, so that adding to this list is an
 * argument rather than a shrug.
 */
const NOT_MONEY = {
  calibration_known_feet: "a measurement off the drawing, in feet",
  grid_feet_per_square: "drawing scale",
  signed_linear_feet: "feet of fence on the signature, not a price",
  teardown_feet: "feet of old fence, not a price",
  priced_at: "a timestamp saying WHEN it was priced",
  priced_by: "who priced it",
  material_prices_confirmed_at: "a timestamp",
};

/**
 * Money-named columns that ARE money and are NOT protected. Each is a known
 * gap, written up in OVERNIGHT_2026-11-19.md, waiting on the owner.
 *
 * This is an inventory, not a pin on the defect: when one is fixed this test
 * goes red saying "it is protected now, take it out of here", which is the
 * right prompt. A new entry appearing without a decision is the thing being
 * guarded against.
 */
const KNOWN_UNPROTECTED_MONEY = {
  cancellation_retained:
    "the money he KEEPS when a customer cancels; job_cancellation_terms " +
    "prefers the stored figure once cancelled, so overwriting it with 0 makes " +
    "the refund due everything they paid",
  dispute_amount: "the amount under chargeback; written by the webhooks",
  labor_cost: "what the labour cost; feeds job costing and profit",
};

const MONEY_NAMED = /(amount|total|price|fee|deposit|rate|paid|refund|retain|charge|tax|markup|discount|tip|invoice|owed|cost)/;

/**
 * Read ONCE per run and reused. Same reason as a175: one read is one answer,
 * and two concurrent round trips here were enough to tip another database-
 * backed test over its timeout when this file was first added to the suite.
 */
const COLUMNS = runSql(
  "select c.column_name, (c.column_name = any(public.job_money_columns())) as protected " +
  "from information_schema.columns c " +
  "where c.table_schema='public' and c.table_name='jobs';"
);
const columns = () => COLUMNS;

test("every money-NAMED column is protected, or listed here with a reason", () => {
  const all = columns();
  assert.ok(all.length > 50, `only ${all.length} columns came back -- reading the wrong table`);

  const unprotectedMoneyNamed = all
    .filter((c) => !c.protected && MONEY_NAMED.test(c.column_name))
    .map((c) => c.column_name)
    .sort();

  const accounted = [...Object.keys(NOT_MONEY), ...Object.keys(KNOWN_UNPROTECTED_MONEY)].sort();

  assert.deepEqual(unprotectedMoneyNamed, accounted,
    "an unprotected money-named column on `jobs` is not accounted for. If it is money, " +
    "put it on job_money_columns(). If it is not, add it to NOT_MONEY here WITH A REASON. " +
    "If it is money that cannot be protected yet, add it to KNOWN_UNPROTECTED_MONEY and " +
    "write it up.");
});

test("the column count is pinned, so a column a regex would miss is still noticed", () => {
  // This is the check that would have caught `materials_to_buy`, which carries
  // no money word and feeds the deposit a customer is asked for.
  const all = columns();
  assert.equal(all.length, COLUMN_COUNT,
    `jobs has ${all.length} columns, pinned at ${COLUMN_COUNT}. A column was added or ` +
    "removed. Decide which group it belongs to -- protected money, NOT_MONEY, or a known " +
    "gap -- then bump COLUMN_COUNT in the same change. Do not bump it to go green.");
});

test("CONTROL: the detector can see a money name, and the lists are not empty", () => {
  // Without this, a regex that matched nothing would make check 1 compare two
  // empty lists and pass for ever.
  assert.ok(MONEY_NAMED.test("amount_paid"), "the money-name detector does not match amount_paid");
  assert.ok(MONEY_NAMED.test("cancellation_retained"), "the detector does not match cancellation_retained");
  assert.ok(!MONEY_NAMED.test("customer_name"), "the detector matches a plainly non-money column");
  // And the documented hole in the detector, pinned so nobody trusts it too far.
  assert.ok(!MONEY_NAMED.test("materials_to_buy"),
    "materials_to_buy now matches the money-name regex. Good -- but the comment at the top " +
    "of this file explains why the count pin exists BECAUSE it did not. Update that comment.");
  assert.ok(Object.keys(KNOWN_UNPROTECTED_MONEY).length > 0,
    "the known-gaps list is empty; if the gaps were closed, this test should have been "
    + "rewritten rather than emptied");
});
