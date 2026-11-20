/**
 * THE DEPOSIT A CUSTOMER AGREED TO CANNOT BE RAISED BEHIND THEIR BACK.
 *
 *     node --test tests/a183-deposit-pin-is-live.test.mjs
 *
 * ------------------------------------------------------------------
 * THE DEFECT (A4 finding #7, 20 November 2026)
 * ------------------------------------------------------------------
 * `accepted_total` is frozen at approval; `deposit_amount` was not. r67 stops
 * the AUTOMATIC rule from recomputing it once the customer is in it, and does
 * nothing about a TYPED one -- so a customer who approved a $2,000 deposit
 * could be asked for $6,000 by an edit in the office, with no new approval and
 * nothing saying it changed. Reproduced on production before the fix, rolled
 * back: 840 -> 4840.
 *
 * THE RULE: once the customer is in it, the deposit may go DOWN but not UP.
 * Raising it needs a pending re-approval -- the flow that asks them again.
 *
 * ------------------------------------------------------------------
 * WHY THIS RUNS THE PROBE FILE RATHER THAN ITS OWN SQL
 * ------------------------------------------------------------------
 * Because the probe is the thing somebody runs by hand when they want to know,
 * and a test that checked a private copy would let the two drift. Same
 * arrangement as a181.
 *
 * It asserts the CONTROLS as hard as the refusal, which is the lesson from the
 * RECORD_MONEY regression earlier the same day: a guard that refuses
 * everything passes every refusal-shaped check. A pin that could not be
 * lowered, could not be set before approval, and could not be changed on a
 * re-price would satisfy case 1 and break the product.
 *
 * Read-only in effect: the probe does its writes inside BEGIN/ROLLBACK.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const PROJECT = "newcrgafcptspmapacrx";
const PROBE = "supabase_a4_deposit_pin_probe_live.sql";

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

/** Read ONCE per run. One read is one answer, and one round trip. */
const ROWS = runProbe(PROBE);

const step = (needle) => {
  const hit = ROWS.filter((r) => String(r.step).toLowerCase().includes(needle.toLowerCase()));
  assert.equal(hit.length, 1,
    `expected exactly one step matching "${needle}", found ${hit.length}: ` +
    ROWS.map((r) => r.step).join(" | "));
  return { verdict: String(hit[0].verdict), measured: String(hit[0].measured) };
};

test("the probe measured something, and did not stop at its fixture", () => {
  /* An empty answer reading as good news is the failure this project keeps
     meeting. The probe says STOP when its fixture is gone, and that is a
     failure here, not a clean sheet. */
  const stopped = ROWS.filter((r) => String(r.verdict).startsWith("STOP"));
  assert.equal(stopped.length, 0,
    `the probe stopped before measuring: ${stopped.map((r) => r.measured).join("; ")}`);
  const unmeasured = ROWS.filter((r) => String(r.verdict).startsWith("NOT MEASURED"));
  assert.equal(unmeasured.length, 0,
    `a control could not be measured, so it is not a pass: ` +
    unmeasured.map((r) => `${r.step} (${r.measured})`).join("; "));
});

test("raising the deposit on a job the customer has agreed to is HELD", () => {
  const { verdict, measured } = step("RAISE the deposit on an approved job");
  assert.match(verdict, /^HELD/,
    `the deposit moved (${measured}). A customer who agreed to one figure can be asked ` +
    `for another, with no new approval and nothing telling them. See ` +
    `supabase_a4_deposit_is_pinned_after_approval.sql.`);
});

test("CONTROL: lowering it still works -- asking for less needs nobody's permission", () => {
  const { verdict, measured } = step("LOWER the deposit on the approved job");
  assert.match(verdict, /^accepted/,
    `a smaller ask was refused (${measured}). The pin is one-directional on purpose: ` +
    `"actually, just pay $500 now" is a thing a contractor should be able to do.`);
});

test("CONTROL: the re-price route is open -- a pending re-approval lets it rise", () => {
  // Without this the fix would leave no way at all to change a deposit after
  // approval, which is not a fix, it is a wall.
  const { verdict, measured } = step("RAISE it while a re-approval is pending");
  assert.match(verdict, /^accepted/,
    `raising it during a re-approval was refused (${measured}), so there is now no way ` +
    `to change a deposit once a customer has approved`);
});

test("CONTROL: ordinary quoting is untouched", () => {
  assert.match(step("SET a deposit before approval").verdict, /^accepted/,
    "the pin is firing before anybody has agreed to anything");
  assert.match(step("an ordinary column still writes").verdict, /^accepted/,
    "nothing at all is writable, so the HELD above proves nothing");
});
