// DEFECT 1 (this wave) -- website/admin.html's Pricing Drift panel has a
// SECOND button that claims a save it cannot make, in the same shape the
// company Save button had before tests/a10-admin-save-zero-rows.test.mjs:
// "Mark seen" wrote straight to pricing_drift and judged success on the
// absence of an error alone.
//
// Confirmed LIVE against the real database, with a positive control, before
// this fix was written (see this wave's findings for the full probe): the
// only UPDATE policy pricing_drift carries is
//   pricing_drift_update (update)
//     using (company_id = current_company_id()
//            and current_user_role() in ('OWNER','MANAGER'))
//     with check (company_id = current_company_id())
// -- company-scoped to the row's own owner/manager. There is a SELECT policy
// for the platform admin (pricing_drift_admin_read, using
// (is_platform_admin())) but NO admin UPDATE policy at all. So a platform
// admin's click on a client company's drift row matches zero rows: no error,
// no data -- exactly what a real success looks like to a caller that only
// checks `{ error }`. It was latent only because pricing_drift held zero rows
// at the time; it bites on the first drift row belonging to a company other
// than the admin's own. supabase_admin_drift_mark_seen_patch.sql adds the
// missing policy, additively, UNAPPLIED -- this test does not depend on it
// and must keep passing (refusing correctly) whether or not it is ever run.
//
// Same grab()/new Function() idiom as tests/a10-admin-save-zero-rows.test.mjs
// and tests/a8-company-email-guard.test.mjs: this runs the REAL renderDrift()
// lifted out of website/admin.html -- including the click handler it wires up
// via document.querySelectorAll(...).forEach(b => b.addEventListener(...)) --
// not a reimplementation that could silently drift from what ships. A fake
// button captures the real handler so the test can invoke it directly,
// without a DOM. Every behavioural claim below is paired with a PLANTED
// FAILURE that reconstructs the pre-fix click handler and proves this same
// test would have caught it (see MEMORY.md "Audit blind spots").
//
// Run:
//   node tests/a12-admin-drift-mark-seen-zero-rows.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adminSrc = readFileSync("website/admin.html", "utf8");

// Brace-counted function extraction, identical to tests/a10-admin-save-zero-rows
// .test.mjs's makeGrab() and tests/a8-company-email-guard.test.mjs's.
function makeGrab(src) {
  return (name) => {
    let start = src.indexOf("function " + name + "(");
    if (start < 0) throw new Error("not found: " + name + " in this file");
    if (src.slice(start - 6, start) === "async ") start -= 6;
    let i = src.indexOf("{", src.indexOf(")", start)), depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
    }
    throw new Error("unbalanced: " + name);
  };
}
const adminGrab = makeGrab(adminSrc);

// =============================================================================
// The fix is actually present in the shipped click handler
// =============================================================================

test("admin.html's drift 'Mark seen' handler reads back affected rows with .select() before claiming success", () => {
  const body = adminGrab("renderDrift");
  assert.match(
    body,
    /\.update\(\{\s*seen_at:[^}]*\}\)\.eq\('id',\s*b\.dataset\.driftSeen\)\.select\(/,
    "the pricing_drift update must chain .select(...) so PostgREST returns the rows it actually touched"
  );
});

test("admin.html's drift 'Mark seen' handler treats zero returned rows as a failure, not a success", () => {
  const body = adminGrab("renderDrift");
  assert.match(
    body,
    /if\s*\(\s*!data\s*\|\|\s*!data\.length\s*\)/,
    "the handler must explicitly check for an empty result before treating the mark-seen as done"
  );
  assert.match(
    body,
    /driftMarkNoRowsMsg/,
    "the zero-rows branch must say something distinct from driftMarkFailed (a real PostgREST error) and from silence"
  );
});

// =============================================================================
// End to end -- the real renderDrift(), run for real, with a fake button that
// captures the real click handler and a fake db shaped exactly like a
// zero-row RLS-filtered update: no error, empty data.
// =============================================================================

function fakeButton(id) {
  const handlers = {};
  return {
    dataset: { driftSeen: id },
    textContent: "",
    addEventListener(evt, fn) { handlers[evt] = fn; },
    _fire(evt) { return handlers[evt](); },
  };
}

// updateResult is whatever the final .select(...) call should resolve to --
// { data: [{ id }], error: null } for a real success, { data: [], error: null }
// for the zero-row RLS-filtered case this defect is about, or
// { data: null, error: {...} } for an ordinary failure.
function makeDriftDb(updateResult) {
  const state = { driftUpdate: null };
  return {
    state,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => ({
          select: (cols) => {
            if (table === "pricing_drift") state.driftUpdate = { patch, col, val };
            return Promise.resolve(updateResult);
          },
        }),
      }),
    }),
  };
}

// Builds a runnable renderDrift() bound to fresh stand-ins, from whatever
// source string is passed in (the real, current one by default -- the
// PLANTED FAILURE test below passes a deliberately reverted one instead).
// $, tr, esc, money and day are stand-ins the same way tr and money are
// stood in for in tests/a10-admin-save-zero-rows.test.mjs -- none of them is
// what this defect is about, only the click handler's own row-count check is.
function buildRenderDrift(fnSrc, { driftRows, updateResult }) {
  const els = { driftNote: { innerHTML: "" }, driftRows: { innerHTML: "" } };
  const $ = (id) => els[id] || (els[id] = { innerHTML: "" });
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const esc = (s) => String(s ?? "");
  const money = (n) => "$" + Number(n || 0).toFixed(2);
  const day = (v) => String(v ?? "");
  const db = makeDriftDb(updateResult);
  const buttons = driftRows.map((r) => fakeButton(r.id));
  const document = { querySelectorAll: (sel) => (sel === "[data-drift-seen]" ? buttons : []) };
  const loadDriftCalls = { count: 0 };
  const loadDrift = async () => { loadDriftCalls.count++; };
  let drift = driftRows;
  const renderDrift = new Function(
    "$", "tr", "esc", "money", "day", "document", "db", "drift", "loadDrift",
    fnSrc + "\nreturn renderDrift;"
  )($, tr, esc, money, day, document, db, drift, loadDrift);
  renderDrift();
  return { renderDrift, buttons, db, loadDriftCalls };
}

const oneRow = [{
  id: "drift-1", company_id: "co-victim", job_sync_id: "job-1",
  office_total: 21500, phone_total: 21000, office_engine: "office_v1",
  phone_engine: "phone_v1", noted_at: "2026-09-20T00:00:00Z",
}];

test("a real mark-seen (one row returned) leaves the button intact and reloads drift", async () => {
  const { buttons, loadDriftCalls } = await buildRenderDrift(adminGrab("renderDrift"), {
    driftRows: oneRow,
    updateResult: { data: [{ id: "drift-1" }], error: null },
  });
  await buttons[0]._fire("click");
  assert.equal(loadDriftCalls.count, 1, "a genuine one-row mark-seen must reload the drift list");
  assert.doesNotMatch(buttons[0].textContent, /driftMarkNoRowsMsg|driftMarkFailed/);
});

test("DEFECT (admin.html): zero rows returned -- the shape a missing admin UPDATE policy produces -- is NOT reported as success", async () => {
  const { buttons, loadDriftCalls } = await buildRenderDrift(adminGrab("renderDrift"), {
    driftRows: oneRow,
    updateResult: { data: [], error: null }, // no error field at all -- the exact PostgREST shape of an RLS-filtered UPDATE
  });
  await buttons[0]._fire("click");
  assert.equal(loadDriftCalls.count, 0, "the list must NOT be reloaded as if the mark-seen worked");
  assert.match(
    buttons[0].textContent, /driftMarkNoRowsMsg/,
    "the admin must be told the mark-seen did not happen, naming the missing policy -- not left with a blank button or a generic 'it worked'"
  );
});

test("DEFECT (admin.html): a null data array (same shape) is also NOT reported as success", async () => {
  const { buttons, loadDriftCalls } = await buildRenderDrift(adminGrab("renderDrift"), {
    driftRows: oneRow,
    updateResult: { data: null, error: null },
  });
  await buttons[0]._fire("click");
  assert.equal(loadDriftCalls.count, 0);
  assert.match(buttons[0].textContent, /driftMarkNoRowsMsg/);
});

test("an ordinary PostgREST error is still reported via driftMarkFailed, not the zero-rows message", async () => {
  const { buttons, loadDriftCalls } = await buildRenderDrift(adminGrab("renderDrift"), {
    driftRows: oneRow,
    updateResult: { data: null, error: { message: "connection reset" } },
  });
  await buttons[0]._fire("click");
  assert.equal(loadDriftCalls.count, 0);
  assert.match(buttons[0].textContent, /driftMarkFailed\|connection reset/);
  assert.doesNotMatch(buttons[0].textContent, /driftMarkNoRowsMsg/);
});

// =============================================================================
// PLANTED FAILURE -- proves this suite would have caught the bug as it shipped
// =============================================================================

test("PLANTED FAILURE: the pre-fix click handler reports success on a zero-row RLS-filtered update", async () => {
  const real = adminGrab("renderDrift");
  // Exactly what this file carried before this wave's fix: the update has no
  // .select(), so the only thing checked is `error`, and loadDrift()+renderDrift()
  // run unconditionally once there is none -- regardless of how many rows the
  // write actually touched. Trimmed to just the parts this test exercises
  // (the note/table rendering above the click handler is irrelevant to it and
  // is left out here, same as a10's planted saveEdit leaves out unrelated
  // branches) -- what matters is the update chain and the success check.
  const old = `function renderDrift() {
  document.querySelectorAll('[data-drift-seen]').forEach(b =>
    b.addEventListener('click', async () => {
      const { error } = await db.from('pricing_drift')
        .update({ seen_at: new Date().toISOString() }).eq('id', b.dataset.driftSeen);
      if (error) { b.textContent = tr('driftMarkFailed', error.message); return; }
      await loadDrift(); renderDrift();
    }));
}`;
  assert.notEqual(old.replace(/\s+/g, " "), real.replace(/\s+/g, " "), "the plant must actually differ from the shipped function");
  assert.doesNotMatch(old, /\.select\(/, "sanity: the plant must remove the .select() row check entirely");

  // makeDriftDb's chain requires a .select() call to resolve -- the pre-fix
  // code never calls it, so the fake db is built one link shorter here,
  // ending the chain at .eq() the way the real pre-fix query did.
  const state = { driftUpdate: null };
  const db = {
    state,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => {
          if (table === "pricing_drift") state.driftUpdate = { patch, col, val };
          // The exact shape PostgREST returns for an UPDATE with no rows
          // matching the RLS policy's USING clause: no error, no data.
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
  const button = fakeButton("drift-1");
  const document = { querySelectorAll: (sel) => (sel === "[data-drift-seen]" ? [button] : []) };
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const loadDriftCalls = { count: 0 };
  const loadDrift = async () => { loadDriftCalls.count++; };
  const renderDriftOld = new Function(
    "document", "db", "tr", "loadDrift",
    old + "\nreturn renderDrift;"
  )(document, db, tr, loadDrift);
  renderDriftOld();

  await button._fire("click");
  // This is the bug: a write that changed nothing at all is reported exactly
  // like a real success -- loadDrift() runs, and nothing on the button or
  // anywhere else says the row was never marked seen.
  assert.equal(loadDriftCalls.count, 1, "sanity: the pre-fix code really does treat zero rows as success");
  assert.doesNotMatch(
    button.textContent, /driftMarkNoRowsMsg/,
    "sanity: the pre-fix code has no way to say the write matched no row -- this key does not even exist to it"
  );
});
