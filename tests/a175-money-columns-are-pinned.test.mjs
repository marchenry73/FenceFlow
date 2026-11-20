/**
 * THE MONEY COLUMNS A CREW PHONE MAY NOT WRITE, PINNED.
 *
 *     node --test tests/a175-money-columns-are-pinned.test.mjs
 *
 * ------------------------------------------------------------------
 * WHY THIS EXISTS
 * ------------------------------------------------------------------
 * `job_money_columns()` is the list `hold_money_columns` refuses writes to
 * from anyone who does not pass `money_caller_trusted()`. It is the only thing
 * standing between a crew handset and `jobs.amount_paid`.
 *
 * It is a hand-maintained list of column names, which is the kind of thing
 * that rots in one direction: columns get added to `jobs` over time and
 * nobody remembers to add them here. MEASURED on production, 20 Nov 2026,
 * during the A4 money audit: `cancellation_retained` (the money he KEEPS when
 * a customer cancels, and the figure `job_cancellation_terms` prefers once a
 * job is cancelled) and `materials_to_buy` (which the deposit rule reads) are
 * BOTH absent from it. Neither is reachable today because he has no CREW or
 * FOREMAN account — his roles are 8 OWNER, 2 MANAGER, 1 SALES — but both open
 * the day he adds one.
 *
 * So this file does two things, and deliberately not a third:
 *   1. It pins the list EXACTLY, so adding or removing a column is a
 *      deliberate act that turns this red and makes somebody say why.
 *   2. It asserts separately that the columns which must NEVER come off are
 *      on it — the ones that decide what a customer owes and what he has been
 *      paid. If a future edit trims the list, this names the loss.
 *
 * It does NOT assert that the two known gaps stay gaps. A test that pins a
 * defect in place goes green on the day somebody fixes it, which is the wrong
 * way round. They are named in a comment and in the overnight write-up
 * instead, and the exact-list pin above means closing them turns this red and
 * asks for the pin to be updated — which is the correct prompt.
 *
 * READ-ONLY. One `select`, no writes, no transaction needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "newcrgafcptspmapacrx";

function runSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "a175-money-"));
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

/** The live list as it stood on 20 Nov 2026, sorted. */
const PINNED = [
  "accepted_total", "amount_paid", "contract_total", "deposit_amount",
  "deposit_is_auto", "discount_percent", "gate_rate_per_ft", "is_invoiced",
  "labor_flat_fee", "labor_rate_per_ft", "markup_percent", "minimum_job_charge",
  "minimum_labor_charge", "payment_link_amount", "payment_link_url",
  "payment_status", "payments_from_processor", "pricing_tier_name",
  "quote_sent_at", "quote_token", "quote_viewed_at", "refund_reason",
  "refunded_amount", "refunded_at", "signed_contract_total",
  "supplier_quote_reference", "tax_rate_percent", "teardown_flat_fee",
  "teardown_rate_per_ft", "tip_amount", "trash_haul_fee",
];

/**
 * The ones whose absence would be a hole somebody could drive a job through.
 * Named individually rather than taken from PINNED, so that trimming PINNED
 * to match a shrunken list cannot also silence this check.
 */
const MUST_NEVER_COME_OFF = [
  "amount_paid",            // what he has been paid
  "refunded_amount",        // what went back
  "payment_status",         // whether the job reads as settled
  "contract_total",         // the price
  "accepted_total",         // the price the customer AGREED to
  "signed_contract_total",  // the price on a signature he holds
  "deposit_amount",         // what the customer is asked for up front
  "tax_rate_percent",       // every figure above depends on it
  "markup_percent",
  "discount_percent",
];

const live = () => runSql("select unnest(public.job_money_columns()) as col;")
  .map((r) => r.col).sort();

test("the money-column list is exactly what it was pinned at", () => {
  const cols = live();
  assert.deepEqual(cols, PINNED,
    "job_money_columns() has changed. That is allowed -- but it is the list that " +
    "keeps a crew handset out of jobs.amount_paid, so update PINNED here in the " +
    "same change and say in the commit why the column moved.");
});

test("the columns that must never come off are on it", () => {
  const cols = new Set(live());
  for (const c of MUST_NEVER_COME_OFF) {
    assert.ok(cols.has(c),
      `${c} is no longer protected: anyone who can update a job but cannot see ` +
      `money could write it directly.`);
  }
});

test("CONTROL: the list was really read, and a wrong name would be noticed", () => {
  // Without this, a query that returned nothing would make both checks above
  // pass by comparing two empty sets -- the failure this project keeps
  // meeting, where an empty answer reads as good news.
  const cols = live();
  assert.ok(cols.length >= 25,
    `only ${cols.length} columns came back; the list cannot have shrunk that far, ` +
    `so this is reading the wrong thing`);
  assert.ok(!cols.includes("no_such_column_xyz"),
    "control: the comparison is not matching everything");
  // And the pin is a real comparison, not a tautology: a name that is NOT in
  // the live list must be absent from PINNED too.
  assert.ok(!PINNED.includes("cancellation_retained"),
    "cancellation_retained is in PINNED but was measured as absent from the live " +
    "list -- one of the two is stale");
});
