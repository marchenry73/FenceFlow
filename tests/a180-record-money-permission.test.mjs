/**
 * RECORD_MONEY: THE WRITE PERMISSION BEHIND "THIS JOB IS PAID".
 *
 *     node --test tests/a180-record-money-permission.test.mjs
 *
 * ------------------------------------------------------------------
 * THE DEFECT, from the A4 money audit (20 Nov 2026)
 * ------------------------------------------------------------------
 * money_caller_trusted() was
 *     claims are empty OR is_service_role() OR has_permission('SEE_MONEY')
 * and has_permission grants SEE_MONEY to OWNER, MANAGER, SALES and
 * ACCOUNTANT. jobs.amount_paid and jobs.payment_status are both on
 * job_money_columns(), but that list is only held against callers who FAIL
 * money_caller_trusted(). So a READ permission was the WRITE gate, and any
 * manager could mark any job paid in full with no payment anywhere, no ledger
 * row and nothing to recompute it. Proved on production as a real manager, in
 * a rolled-back transaction, with a cross-company write refused as the
 * control.
 *
 * The fix adds RECORD_MONEY, held by OWNER and ACCOUNTANT only, and holds
 * seven "money has arrived" columns against it.
 *
 * ------------------------------------------------------------------
 * WHAT THIS FILE GUARDS, AND WHY EACH ONE
 * ------------------------------------------------------------------
 * 1. The two role tables -- Kotlin's `defaultPermissions` and the server's
 *    has_permission() -- say the same thing. They are two copies of one
 *    answer, which is this project's recurring failure shape, and when they
 *    drift the app shows a control the server refuses.
 * 2. RECORD_MONEY is on ACCOUNTANT and on no other non-OWNER role. A future
 *    edit putting it back on MANAGER should be a deliberate act.
 * 3. No permission name contains another. Overrides are matched by substring
 *    (`position('+' || perm in overrides)`), so a name that is a substring of
 *    another silently grants or revokes the wrong thing. SEE_MONEY and
 *    RECORD_MONEY are the near miss.
 * 4. Every received-money column is also on job_money_columns(). If one were
 *    not, a crew phone would reach it through the wider gate's absence.
 * 5. The app hides the control rather than showing one the server reverts.
 *
 * READ-ONLY: this reads source files. It does not touch the database, and it
 * does not require the fix to have been applied to production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

const KOTLIN = read("app/src/main/java/com/fenceestimator/app/cloud/Permissions.kt");
const SQL = read("supabase_a4_record_money_is_a_write_permission.sql");
const SCREEN = read("app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt");
const SESSION = read("app/src/main/java/com/fenceestimator/app/cloud/SessionManager.kt");

/** Kotlin and SQL alike are read with comments stripped, so a name that
 *  appears only in prose can never be mistaken for a name in the code --
 *  the trap where a check matches its own explanation. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n")
    .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

// ------------------------------------------------------- the two tables ---

/** Every Permission the Kotlin enum declares. */
function kotlinPermissionNames() {
  const body = codeOnly(KOTLIN);
  const start = body.indexOf("enum class Permission(");
  assert.ok(start > 0, "the Permission enum is gone or renamed");
  const end = body.indexOf("companion object", start);
  const names = [...body.slice(start, end).matchAll(/^\s{4}([A-Z][A-Z_]+)\(/gm)].map((m) => m[1]);
  assert.ok(names.length > 10, `only found ${names.length} permissions -- the parse is wrong`);
  return names;
}

/** What each role starts with, per the Kotlin table. */
function kotlinRoleTable() {
  const body = codeOnly(KOTLIN);
  const start = body.indexOf("val UserRole.defaultPermissions");
  assert.ok(start > 0, "the role table is gone or renamed");
  const table = body.slice(start);
  const out = {};
  /* Scanned with balanced parentheses rather than a lazy regex. The first
     version of this used `setOf\(([\s\S]*?)\n\s*\)`, which silently skipped
     UserRole.CREW because its whole set fits on one line -- a parse that
     dropped a role and still looked like it had read the table. */
  for (const m of table.matchAll(/UserRole\.([A-Z]+)\s*->\s*setOf\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    while (i < table.length && depth > 0) {
      if (table[i] === "(") depth++;
      else if (table[i] === ")") depth--;
      i++;
    }
    assert.equal(depth, 0, `unbalanced setOf( for ${m[1]}`);
    out[m[1]] = [...table.slice(from, i - 1).matchAll(/Permission\.([A-Z_]+)/g)]
      .map((x) => x[1]).sort();
  }
  assert.ok(table.includes("UserRole.OWNER -> Permission.ALL"), "OWNER is no longer everything");
  return out;
}

/** What each role gets, per the has_permission() body in the fix. */
function sqlRoleTable() {
  const body = codeOnly(SQL);
  const start = body.indexOf("function public.has_permission(perm text)");
  assert.ok(start > 0, "has_permission is not in the fix file");
  const chunk = body.slice(start);
  const out = {};
  for (const m of chunk.matchAll(/when '([A-Z]+)' then perm in \(([\s\S]*?)\)/g)) {
    out[m[1]] = [...m[2].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
  }
  assert.ok(chunk.includes("when 'OWNER' then true"), "OWNER is no longer everything on the server");
  return out;
}

test("the app's role table and the server's say the same thing", () => {
  const kt = kotlinRoleTable();
  const sql = sqlRoleTable();

  assert.deepEqual(Object.keys(sql).sort(), ["ACCOUNTANT", "CREW", "FOREMAN", "MANAGER", "SALES"],
    "the server names a different set of roles than this test knows about");
  assert.deepEqual(Object.keys(kt).sort(), Object.keys(sql).sort(),
    "the app and the server disagree about which roles exist");

  for (const role of Object.keys(sql)) {
    assert.deepEqual(kt[role], sql[role],
      `${role} differs between the app and the server. Two copies of one answer have ` +
      `drifted: the app will show a control the server refuses, or hide one it allows.`);
  }
});

test("CONTROL: both tables were really parsed, and are not empty", () => {
  // Without this, two failed parses would compare {} to {} and pass for ever.
  const kt = kotlinRoleTable();
  const sql = sqlRoleTable();
  assert.ok(kt.MANAGER.length >= 10, `MANAGER parsed as ${kt.MANAGER.length} permissions in Kotlin`);
  assert.ok(sql.MANAGER.length >= 10, `MANAGER parsed as ${sql.MANAGER.length} permissions in SQL`);
  assert.ok(kt.CREW.includes("RECORD_FIELD_WORK"));
  assert.ok(sql.CREW.includes("RECORD_FIELD_WORK"));
  // And the tables really distinguish roles, rather than returning one answer.
  assert.notDeepEqual(sql.MANAGER, sql.CREW);
});

// ------------------------------------------------------- RECORD_MONEY -----

test("RECORD_MONEY exists, and only the accountant has it by role", () => {
  assert.ok(kotlinPermissionNames().includes("RECORD_MONEY"),
    "the app no longer declares RECORD_MONEY");

  const sql = sqlRoleTable();
  assert.ok(sql.ACCOUNTANT.includes("RECORD_MONEY"),
    "writing down what arrived is the accountant's job");
  for (const role of ["MANAGER", "SALES", "FOREMAN", "CREW"]) {
    assert.ok(!sql[role].includes("RECORD_MONEY"),
      `${role} can mark a job paid in full with no money behind it again. If that is ` +
      `wanted, give it to a named person with a +RECORD_MONEY override instead of ` +
      `handing it to every ${role}.`);
  }
});

test("MANAGER keeps everything else, including taking payments", () => {
  // The fix must be narrow. A manager who lost REQUEST_PAYMENT could not ask
  // a customer for money at all, which is not what was wrong.
  const sql = sqlRoleTable();
  for (const kept of ["SEE_MONEY", "EDIT_JOBS", "REQUEST_PAYMENT", "SEE_REPORTS",
                      "EDIT_CATALOG_AND_SETTINGS", "APPROVE_TIME"]) {
    assert.ok(sql.MANAGER.includes(kept), `MANAGER lost ${kept}, which the fix had no business touching`);
  }
});

test("no permission name contains another, so overrides cannot grant the wrong one", () => {
  /* `position('+' || perm in overrides)` is a substring search. If one name
     were inside another, "+SEE_MONEY" in the overrides column would answer
     true for a different permission. SEE_MONEY and RECORD_MONEY are the near
     miss this fix created, and they are safe only because the search includes
     the leading sign. */
  const names = kotlinPermissionNames();
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      assert.ok(!b.includes(a),
        `${a} is a substring of ${b}: an override naming one would match the other`);
    }
  }
  // CONTROL: the comparison is real -- it would catch a name that IS inside
  // another, which is what the loop above is for.
  assert.ok("RECORD_MONEY".includes("MONEY"),
    "the substring test is not doing what this control expects");
  assert.ok(!names.includes("MONEY"), "a bare MONEY permission would break override matching");
  assert.ok(names.length > 10, `only ${names.length} names parsed`);
});

// ------------------------------------------------------- the two lists ----

function sqlArray(fnName) {
  const body = codeOnly(SQL);
  const i = body.indexOf(`function public.${fnName}()`);
  assert.ok(i > 0, `${fnName} is not in the fix file`);
  const open = body.indexOf("select array[", i);
  const close = body.indexOf("]", open);
  assert.ok(open > 0 && close > open, `could not read ${fnName}'s array`);
  return [...body.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

test("every received-money column is also a money column", () => {
  const received = sqlArray("job_received_money_columns");
  // job_money_columns() is unchanged by this fix and lives where it always
  // did; tests/a175 pins the live list. Read here from the LIVE list's pin so
  // the two files cannot disagree about what the wider list holds.
  const pinned = read("tests/a175-money-columns-are-pinned.test.mjs");
  const wider = [...pinned.slice(pinned.indexOf("const PINNED = ["),
                                pinned.indexOf("];", pinned.indexOf("const PINNED = [")))
    .matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

  assert.ok(received.length >= 5, `only ${received.length} received-money columns parsed`);
  assert.ok(wider.length >= 25, `only ${wider.length} money columns parsed from a175`);

  for (const c of received) {
    assert.ok(wider.includes(c),
      `${c} is held against RECORD_MONEY but is not on job_money_columns(), so a crew ` +
      `phone -- which never reaches the RECORD_MONEY check at all -- can write it freely`);
  }
});

test("the received-money list is the arrival columns, and not the price ones", () => {
  const received = sqlArray("job_received_money_columns");
  for (const c of ["amount_paid", "payment_status", "refunded_amount", "tip_amount"]) {
    assert.ok(received.includes(c), `${c} must be held: it says money arrived or went back`);
  }
  for (const c of ["contract_total", "deposit_amount", "markup_percent", "tax_rate_percent",
                   "labor_rate_per_ft", "discount_percent"]) {
    assert.ok(!received.includes(c),
      `${c} is a PRICE. Holding it against RECORD_MONEY takes pricing away from managers, ` +
      `which is not what was wrong.`);
  }
});

// ------------------------------------------------------------ the app -----

test("the app hides the payment-status control instead of showing one that reverts", () => {
  const code = codeOnly(SCREEN);
  assert.match(code, /val canSetPaymentStatus = editable && session\.canRecordMoney/,
    "the payment-status gate is gone; the dropdown would be shown to somebody whose " +
    "choice the server quietly puts back, which is worse than no dropdown");
  assert.match(code, /if \(canSetPaymentStatus\) \{/,
    "canSetPaymentStatus is computed but nothing is gated on it");
  assert.match(codeOnly(SESSION), /val canRecordMoney: Boolean get\(\) = can\(Permission\.RECORD_MONEY\)/,
    "SessionManager no longer answers canRecordMoney");
});

test("the deposit field is NOT gated on RECORD_MONEY", () => {
  /* A deposit is what the customer is ASKED for -- a price. Gating it would
     take pricing away from managers, which this fix has no business doing.
     Named here so a later tidy-up that collapses the two flags back into one
     has to argue with this test. */
  const code = codeOnly(SCREEN);
  const i = code.indexOf("R.string.jd_deposit_amount");
  assert.ok(i > 0, "the deposit field is gone, so this test proves nothing");
  const region = code.slice(Math.max(0, i - 1200), i);
  assert.ok(region.includes("if (editable) {"),
    "the deposit field is no longer behind the plain `editable` flag");
  assert.ok(!region.includes("if (canSetPaymentStatus) {") ||
            region.lastIndexOf("if (editable) {") > region.lastIndexOf("if (canSetPaymentStatus) {"),
    "the deposit field has been pulled behind the RECORD_MONEY gate");
});
