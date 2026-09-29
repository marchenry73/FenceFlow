// DEFECT (this wave) -- website/dashboard.html's retireJobCost() soft-deletes
// an expenses row and judged the write on the absence of an error alone, the
// same shape tests/a12-dash-zero-row-writes.test.mjs already fixed in
// saveSettings/wizPatchJob/applyJobBatch. expenses_update
// (supabase_schema.sql) is a plain `company_id = current_company_id()` row
// filter with no separate WITH CHECK, so Postgres RLS applies it on UPDATE as
// a row filter: a row it excludes is simply not in the affected set -- no
// exception, no error field, PostgREST answers with `data: []` (or, with no
// .select() at all, `data: null`) and `error: null`. That can happen here
// from another device retiring (or already having retired) the same cost
// between this page loading it and the button being pressed, or this
// person's access to the job's company changing mid-session.
//
// What makes this ONE worse than its four siblings (toggleCatalogActive,
// retireCatalogItem, retireTierRow, retireSupplierDialog -- all fixed in an
// earlier wave, none of which read the row back either): every one of those
// four calls its own refresher (refreshCatalog/refreshTiers/
// refreshManufacturers) unconditionally right after the write, which re-pulls
// the true row from the database in the same call -- so a silently-refused
// write there never leaves the screen showing something the database
// disagrees with; the screen just reports back the real, unchanged state.
// retireJobCost has no such refresher: `expenses` is a module-level array
// (see the `let ... expenses=[] ...` declaration) repopulated only by the
// top-level loadAll(), so its own local optimistic
// `expenses = expenses.filter(...)` was the ONLY place that array could ever
// be corrected -- and a zero-row match left it wrong until the next full
// page load, with the cost still on the server the whole time.
//
// Run:
//   node tests/a18-dash-cost-delete-zero-row.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("website/dashboard.html", "utf8");

const grab = (name) => {
  let start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  if (src.slice(start - 6, start) === "async ") start -= 6;
  let i = src.indexOf("{", src.indexOf(")", start)), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};

const tr = (key) => key;

/**
 * A minimal `db.from('expenses').update(...).eq(...).eq(...).select()`
 * chain. `updateResult` is exactly the shape PostgREST answers with --
 * `{ data: [...], error: null }` for a real match, `{ data: [], error: null }`
 * for an RLS-filtered zero-row match, and `{ data: null, error: null }` for
 * the same zero-row case when nothing ever calls `.select()` at all (the
 * pre-fix code's own path, exercised by the planted failure below).
 */
function makeExpensesDb(updateResult) {
  const state = { updateCalls: [] };
  return {
    state,
    from: (table) => ({
      update: (patch) => ({
        eq: (colA, valA) => ({
          eq: (colB, valB) => {
            state.updateCalls.push({ table, patch, colA, valA, colB, valB });
            return {
              select: () => Promise.resolve(updateResult),
              // The pre-fix code never calls .select() at all -- it awaits
              // the .eq().eq() chain directly, so it must also be thenable.
              then: (res, rej) => Promise.resolve({ error: updateResult.error ?? null }).then(res, rej),
            };
          },
        }),
      }),
    }),
  };
}

/**
 * Wraps the real (or planted) retireJobCost text in a sandbox and exposes a
 * `getExpenses()` closure -- `expenses = expenses.filter(...)` inside the
 * function reassigns the SANDBOX's own local parameter binding, which is
 * otherwise invisible from outside once the call returns.
 */
function buildRetireJobCost(fnSrc, { updateResult, startingExpenses }) {
  const db = makeExpensesDb(updateResult);
  const profile = { company_id: "co-1" };
  const openJob = { sync_id: "job-1" };
  const msgCalls = [];
  const msg = (id, text, kind) => msgCalls.push({ id, text, kind });
  const renderCalls = [];
  const renderJobCosts = (sid) => renderCalls.push(sid);
  const wrapper = new Function(
    "db", "profile", "openJob", "expenses", "canEdit", "msg", "tr", "renderJobCosts", "console",
    `"use strict"; ${fnSrc}\nreturn { retireJobCost, getExpenses: () => expenses };`
  )(db, profile, openJob, startingExpenses.slice(), () => true, msg, tr, renderJobCosts, console);
  return { wrapper, db, msgCalls, renderCalls };
}

const oneRow = () => [{ sync_id: "cost-1", company_id: "co-1", category: "MISC", amount: 40 }];

test("retireJobCost() reads the row back with .select() before removing it from the screen", () => {
  const body = grab("retireJobCost");
  assert.match(
    body,
    /\.update\(\{[^}]*\}\)\s*\n?\s*\.eq\('company_id',\s*profile\.company_id\)\.eq\('sync_id',\s*syncId\)\s*\n?\s*\.select\(\)/,
    "the expenses update must chain .select() so PostgREST returns the rows it actually touched"
  );
  assert.match(
    body,
    /if\s*\(\s*!data\s*\|\|\s*!data\.length\s*\)/,
    "retireJobCost must explicitly check for an empty result before removing the row from the screen"
  );
});

test("a real one-row retirement removes the cost from the screen and reports no error", async () => {
  const { wrapper, db, msgCalls, renderCalls } = buildRetireJobCost(grab("retireJobCost"), {
    updateResult: { data: [{ sync_id: "cost-1", deleted_at: "now" }], error: null },
    startingExpenses: oneRow(),
  });
  await wrapper.retireJobCost("cost-1");
  assert.deepEqual(db.state.updateCalls[0].valB, "cost-1");
  assert.equal(wrapper.getExpenses().length, 0, "the row must be gone from the screen once the write really matched");
  assert.equal(msgCalls.length, 0, "a real success raises no error message");
  assert.deepEqual(renderCalls, ["job-1"], "the row list must still be re-rendered on success");
});

test("DEFECT: an RLS-filtered zero-row update (data: []) does NOT remove the row from the screen", async () => {
  const { wrapper, msgCalls } = buildRetireJobCost(grab("retireJobCost"), {
    updateResult: { data: [], error: null }, // exact PostgREST shape of an RLS-filtered UPDATE: no error, no rows
    startingExpenses: oneRow(),
  });
  await wrapper.retireJobCost("cost-1");
  assert.equal(
    wrapper.getExpenses().length, 1,
    "the row must stay on screen when the server did not actually change it -- removing it here is the false save"
  );
  const last = msgCalls[msgCalls.length - 1];
  assert.match(last.text, /jobCostRetireNothingChangedErr/, "the owner must be told the removal did not take");
  assert.equal(last.kind, "err");
});

test("a null data (no .select() ever reaching PostgREST) is also NOT reported as success", async () => {
  const { wrapper, msgCalls } = buildRetireJobCost(grab("retireJobCost"), {
    updateResult: { data: null, error: null },
    startingExpenses: oneRow(),
  });
  await wrapper.retireJobCost("cost-1");
  assert.equal(wrapper.getExpenses().length, 1);
  assert.match(msgCalls[msgCalls.length - 1].text, /jobCostRetireNothingChangedErr/);
});

test("a real database error still surfaces the error and leaves the row alone", async () => {
  const { wrapper, msgCalls } = buildRetireJobCost(grab("retireJobCost"), {
    updateResult: { data: null, error: { message: "network down" } },
    startingExpenses: oneRow(),
  });
  await wrapper.retireJobCost("cost-1");
  assert.equal(wrapper.getExpenses().length, 1);
  assert.deepEqual(msgCalls[msgCalls.length - 1], { id: "jcMsg", text: "network down", kind: "err" });
});

test("PLANTED FAILURE: the pre-fix retireJobCost removes the row on a zero-row RLS-filtered update", async () => {
  const real = grab("retireJobCost");
  // Exactly what website/dashboard.html carried before this wave's fix: no
  // .select(), so the only thing checked is `error`.
  const old = real.replace(
    /const \{ data, error \} = await db\.from\('expenses'\)\s*\n\s*\.update\(\{ deleted_at: new Date\(\)\.toISOString\(\), deleted_by: 'office dashboard' \}\)\s*\n\s*\.eq\('company_id', profile\.company_id\)\.eq\('sync_id', syncId\)\s*\n\s*\.select\(\);\s*\n\s*if\(error\)\{ msg\('jcMsg', error\.message, 'err'\); return; \}\s*\n\s*if\(!data \|\| !data\.length\)\{ msg\('jcMsg', tr\('jobCostRetireNothingChangedErr'\), 'err'\); return; \}\s*\n/,
    "  const { error } = await db.from('expenses')\n" +
    "    .update({ deleted_at: new Date().toISOString(), deleted_by: 'office dashboard' })\n" +
    "    .eq('company_id', profile.company_id).eq('sync_id', syncId);\n" +
    "  if(error){ msg('jcMsg', error.message, 'err'); return; }\n"
  );
  assert.notEqual(old, real, "the plant must actually change the function");
  assert.doesNotMatch(old, /jobCostRetireNothingChangedErr/, "sanity: the plant must remove the row-count check entirely");

  const { wrapper, msgCalls } = buildRetireJobCost(old, {
    updateResult: { error: null }, // the pre-fix code never calls .select(), so it only ever sees this
    startingExpenses: oneRow(),
  });
  await wrapper.retireJobCost("cost-1");
  // This is the bug: a write RLS matched zero rows against is treated
  // exactly like a real delete -- the row vanishes from the screen.
  assert.equal(wrapper.getExpenses().length, 0, "sanity: the pre-fix code really does remove the row here");
  assert.equal(msgCalls.length, 0, "sanity: the pre-fix code raises no error either -- a fully silent false save");
});
