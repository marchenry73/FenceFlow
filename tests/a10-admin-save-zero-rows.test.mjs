// DEFECT (this wave) -- admin.html's saveEdit() claimed a save had happened
// whenever the write came back with no error, and never asked whether it had
// actually changed a row.
//
// companies_platform_admin_all is `for all using (is_platform_admin())` with
// no separate WITH CHECK (supabase_platform_admin_patch.sql), and
// is_platform_admin() is the platform-admin flag AND admin_second_factor_ok()
// (supabase_r7_admin_second_factor.sql). Postgres RLS applies a USING clause
// on UPDATE as a plain row filter: a row the policy excludes is simply not in
// the affected set. There is no exception, no error field -- PostgREST
// answers with `data: []` and `error: null`, which is indistinguishable from
// "there was nothing to change" using only `{ error }`. So the one moment
// this admin's OWN session can lose the row -- the second factor going stale
// between secondFactorFresh() and the request landing -- silently discarded
// the plan, the price, the grace date, the notes and the billing email, and
// the dialog closed reporting success anyway.
//
// Same grab()/new Function() idiom as tests/a8-company-email-guard.test.mjs:
// these run the REAL saveEdit() lifted out of website/admin.html, not a
// reimplementation that could silently drift from what ships. Every
// behavioural claim below is paired with a PLANTED FAILURE that reconstructs
// admin.html's pre-fix saveEdit() (the exact text this file carried before
// this wave's fix -- see git history of website/admin.html) and proves this
// same test would have caught it -- a check that cannot go red is not a
// check (see MEMORY.md "Audit blind spots").
//
// Run:
//   node tests/a10-admin-save-zero-rows.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adminSrc = readFileSync("website/admin.html", "utf8");

// Brace-counted function extraction, identical to
// tests/a8-company-email-guard.test.mjs's makeGrab().
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
// The fix is actually present in the shipped saveEdit()
// =============================================================================

test("admin.html's saveEdit() reads back affected rows with .select() before claiming success", () => {
  const body = adminGrab("saveEdit");
  assert.match(
    body,
    /\.update\(patch\)\.eq\('id',\s*editing\.id\)\.select\(/,
    "the companies update must chain .select(...) so PostgREST returns the rows it actually touched"
  );
});

test("admin.html's saveEdit() treats zero returned rows as a failure, not a success", () => {
  const body = adminGrab("saveEdit");
  // Whatever the exact variable name, the function must branch on the
  // returned rows being empty and stop before closing the dialog.
  assert.match(
    body,
    /savedRows|data:\s*\w+.*select\('id'\)/s,
    "sanity: saveEdit must destructure the rows .select() returns"
  );
  assert.match(
    body,
    /if\s*\(\s*!savedRows\s*\|\|\s*!savedRows\.length\s*\)/,
    "saveEdit must explicitly check for an empty result before treating the write as done"
  );
});

// =============================================================================
// End to end -- the real saveEdit(), run for real, against a fake PostgREST
// that behaves exactly the way a zero-row RLS match behaves: no error, empty
// data. This is the shape admin_second_factor_ok() going stale produces.
// =============================================================================

const fakeEl = (props = {}) => ({ value: "", textContent: "", disabled: false, checked: false, ...props });

// updateResult is whatever the final .select(...) call should resolve to --
// { data: [...], error: null } for a real success, { data: [], error: null }
// for the zero-row RLS-filtered case this defect is about, or
// { data: null, error: {...} } for an ordinary failure.
function makeAdminDb(updateResult) {
  const state = { companiesUpdate: null, selectedCols: null };
  return {
    state,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => ({
          select: (cols) => {
            if (table === "companies") state.companiesUpdate = { patch, col, val };
            state.selectedCols = cols;
            return Promise.resolve(updateResult);
          },
        }),
      }),
    }),
  };
}

// Same shape as a8's buildSaveEdit(): editing.stripe_subscription_id is set
// so the plan/price branch is skipped, and grace_ends_at is left unchanged,
// so no moneyChanges confirmation fires -- this test is about the row-count
// check, not the money-change dialog (a1) or the email guard (a8), which are
// already covered elsewhere. contactEmailValue defaults to a valid address so
// emailSkippedMsg never masks what this test is checking.
function buildSaveEdit(fnSrc, { contactEmailValue = "owner@fenceflow.com", updateResult } = {}) {
  const editing = {
    id: "co-1", name: "Test Co", stripe_subscription_id: "sub_locked",
    grace_ends_at: null, subscription_plan: "", monthly_price: 0,
  };
  const els = {
    e_contact: fakeEl({ value: contactEmailValue }),
    e_email: fakeEl({ value: "" }),
    e_grace: fakeEl({ value: "" }),
    e_notes: fakeEl({ value: "" }),
    e_passfee: fakeEl({ disabled: true }),
    e_plan: fakeEl({ value: "" }),
    e_price: fakeEl({ value: "0" }),
    editMsg: fakeEl(),
  };
  const dialog = { closed: false };
  els.editDialog = { close: () => { dialog.closed = true; } };
  const $ = (id) => els[id] || (els[id] = fakeEl());
  const db = makeAdminDb(updateResult);
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const money = (n) => "$" + Number(n).toFixed(2);
  const ask = async () => true;
  const secondFactorFresh = async () => true;
  const loadAllCalls = { count: 0 };
  const loadAll = async () => { loadAllCalls.count++; };
  const saveEdit = new Function(
    "editing", "$", "db", "ask", "secondFactorFresh", "tr", "money", "loadAll",
    adminGrab("isValidCompanyEmail") + "\n" + fnSrc + "\nreturn saveEdit;"
  )(editing, $, db, ask, secondFactorFresh, tr, money, loadAll);
  return { saveEdit, db, els, dialog, loadAllCalls };
}

test("a real save (one row returned) closes the dialog", async () => {
  const { saveEdit, dialog, els, loadAllCalls } = await buildSaveEdit(adminGrab("saveEdit"), {
    updateResult: { data: [{ id: "co-1" }], error: null },
  });
  await saveEdit();
  assert.equal(dialog.closed, true, "a genuine one-row save must close the dialog");
  // The dialog closing is what the admin actually sees; editMsg is left
  // holding tr('savingEllipsis') underneath a dialog that is no longer open,
  // exactly as it did before this wave -- not a regression this fix touches.
  assert.doesNotMatch(els.editMsg.textContent, /editSaveNoRowsMsg/);
  assert.equal(loadAllCalls.count, 1);
});

test("DEFECT (admin.html): zero rows returned -- as a lapsed second factor produces -- is NOT reported as success", async () => {
  const { saveEdit, dialog, els } = await buildSaveEdit(adminGrab("saveEdit"), {
    updateResult: { data: [], error: null }, // no error field at all -- the exact PostgREST shape of an RLS-filtered UPDATE
  });
  await saveEdit();
  assert.equal(dialog.closed, false, "the dialog must NOT close on a write that changed nothing");
  assert.match(
    els.editMsg.textContent, /editSaveNoRowsMsg/,
    "the admin must be told the save did not happen, naming a likely cause -- not left with a blank or generic message"
  );
});

test("DEFECT (admin.html): a null data array (same shape) is also NOT reported as success", async () => {
  const { saveEdit, dialog, els } = await buildSaveEdit(adminGrab("saveEdit"), {
    updateResult: { data: null, error: null },
  });
  await saveEdit();
  assert.equal(dialog.closed, false);
  assert.match(els.editMsg.textContent, /editSaveNoRowsMsg/);
});

test("an ordinary PostgREST error is still reported as its own message, not the zero-rows message", async () => {
  const { saveEdit, dialog, els } = await buildSaveEdit(adminGrab("saveEdit"), {
    updateResult: { data: null, error: { message: "connection reset" } },
  });
  await saveEdit();
  assert.equal(dialog.closed, false);
  assert.equal(els.editMsg.textContent, "connection reset");
});

// =============================================================================
// PLANTED FAILURE -- proves this suite would have caught the bug as it shipped
// =============================================================================

test("PLANTED FAILURE: the pre-fix admin.html saveEdit reports success on a zero-row RLS-filtered update", async () => {
  const real = adminGrab("saveEdit");
  // Exactly what this file carried before this wave's fix: the update has no
  // .select(), so the only thing checked is `error`, and the dialog closes
  // and loadAll() runs unconditionally once there is none -- regardless of
  // how many rows the write actually touched.
  const old = `async function saveEdit() {
  if (!editing) return;
  $('editMsg').textContent = tr('savingEllipsis');
  const patch = {
    billing_email: $('e_email').value.trim(),
    grace_ends_at: $('e_grace').value ? new Date($('e_grace').value).toISOString() : null,
    admin_notes: $('e_notes').value,
    ...($('e_passfee').disabled ? {} : { pass_card_fee: $('e_passfee').checked })
  };
  if (!editing.stripe_subscription_id) {
    patch.subscription_plan = $('e_plan').value.trim();
    patch.monthly_price = Number($('e_price').value || 0);
  }
  let emailSkippedMsg = '';
  const newContactEmail = $('e_contact').value.trim();
  if (newContactEmail === '') {
    emailSkippedMsg = tr('editEmailBlankMsg');
  } else if (!isValidCompanyEmail(newContactEmail)) {
    emailSkippedMsg = tr('editEmailInvalidMsg', newContactEmail);
  } else {
    patch.email = newContactEmail;
  }
  if (!(await secondFactorFresh())) return;
  const { error } = await db.from('companies').update(patch).eq('id', editing.id);
  if (error) { $('editMsg').textContent = error.message; return; }
  if (emailSkippedMsg) {
    $('editMsg').textContent = emailSkippedMsg;
    await loadAll();
    return;
  }
  $('editDialog').close();
  await loadAll();
}`;
  assert.notEqual(old, real, "the plant must actually differ from the shipped function");
  assert.doesNotMatch(old, /\.select\(/, "sanity: the plant must remove the .select() row check entirely");

  // makeAdminDb's chain requires a .select() call to resolve -- the pre-fix
  // code never calls it, so the fake db is built one link shorter here,
  // ending the chain at .eq() the way the real pre-fix query did.
  const state = { companiesUpdate: null };
  const db = {
    state,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => {
          if (table === "companies") state.companiesUpdate = { patch, col, val };
          // The exact shape PostgREST returns for an UPDATE with no rows
          // matching the RLS policy's USING clause: no error, no data.
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };

  const editing = {
    id: "co-1", name: "Test Co", stripe_subscription_id: "sub_locked",
    grace_ends_at: null, subscription_plan: "", monthly_price: 0,
  };
  const els = {
    e_contact: fakeEl({ value: "owner@fenceflow.com" }),
    e_email: fakeEl({ value: "" }),
    e_grace: fakeEl({ value: "" }),
    e_notes: fakeEl({ value: "" }),
    e_passfee: fakeEl({ disabled: true }),
    e_plan: fakeEl({ value: "" }),
    e_price: fakeEl({ value: "0" }),
    editMsg: fakeEl(),
  };
  const dialog = { closed: false };
  els.editDialog = { close: () => { dialog.closed = true; } };
  const $ = (id) => els[id] || (els[id] = fakeEl());
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const ask = async () => true;
  const secondFactorFresh = async () => true;
  const loadAll = async () => {};
  const saveEditOld = new Function(
    "editing", "$", "db", "ask", "secondFactorFresh", "tr", "loadAll",
    adminGrab("isValidCompanyEmail") + "\n" + old + "\nreturn saveEdit;"
  )(editing, $, db, ask, secondFactorFresh, tr, loadAll);

  await saveEditOld();
  // This is the bug: a write that changed nothing at all is reported exactly
  // like a real save -- the dialog closes, and nothing on screen says the
  // plan, price, grace date, notes or billing email were never written.
  assert.equal(dialog.closed, true, "sanity: the pre-fix code really does close the dialog with zero rows changed");
  assert.doesNotMatch(
    els.editMsg.textContent, /editSaveNoRowsMsg/,
    "sanity: the pre-fix code has no way to say the write matched no row -- this key does not even exist to it"
  );
});
