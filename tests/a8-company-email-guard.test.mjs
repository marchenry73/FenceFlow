// DEFECT 1 (this wave) -- the admin console could still wipe a company's
// email. Last wave closed this hole in dashboard.html's Business Settings
// (saveSettings(), see tests/a7-dashboard-money-regressions.test.mjs DEFECT
// 1): a blank or malformed box is skipped, with a message saying why, rather
// than written straight through. admin.html's saveEdit() writes the exact
// same NOT-NULL companies.email column, under a policy that lets the
// platform admin update ANY company -- not just the one its own owner can
// reach -- so the same hole was open for every company on the platform.
//
// website/dashboard.html and website/admin.html are two separate static
// pages that cannot import from each other, so the fix is necessarily a
// COPY: a same-named, same-bodied isValidCompanyEmail() in both files. A
// copy-paste is how the labour formula drifted into three copies
// (tests/a7-dashboard-money-regressions.test.mjs DEFECT 2), so this file's
// job is to make that drift impossible to land silently: it reads BOTH
// files, extracts isValidCompanyEmail() from each, and fails if their
// bodies ever say something different OR if either page's save path stops
// calling it before writing companies.email.
//
// Same grab()/new Function() idiom as tests/a7-dashboard-money-regressions.
// test.mjs -- these run the REAL functions lifted out of the two HTML
// files, not a reimplementation that could silently drift from what ships.
// Every behavioural claim below is paired with a PLANTED FAILURE that
// reconstructs admin.html's pre-fix saveEdit() and proves this same test
// would have caught it -- a check that cannot go red is not a check
// (see MEMORY.md "Audit blind spots").
//
// Run:
//   node tests/a8-company-email-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dashSrc = readFileSync("website/dashboard.html", "utf8");
const adminSrc = readFileSync("website/admin.html", "utf8");

// Brace-counted function extraction, identical to
// tests/a7-dashboard-money-regressions.test.mjs's grab(), parameterised over
// which file's source to read from.
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
const dashGrab = makeGrab(dashSrc);
const adminGrab = makeGrab(adminSrc);

const norm = (s) => s.replace(/\s+/g, " ").trim();

// =============================================================================
// Both pages define the SAME validator
// =============================================================================

test("isValidCompanyEmail exists in both dashboard.html and admin.html", () => {
  assert.doesNotThrow(() => dashGrab("isValidCompanyEmail"));
  assert.doesNotThrow(() => adminGrab("isValidCompanyEmail"));
});

test("isValidCompanyEmail has the identical body in both files -- this is the drift guard", () => {
  const dashFn = norm(dashGrab("isValidCompanyEmail"));
  const adminFn = norm(adminGrab("isValidCompanyEmail"));
  assert.equal(
    adminFn, dashFn,
    "admin.html's isValidCompanyEmail must read exactly like dashboard.html's -- " +
    "if this fails, one was edited without the other and the guard has silently diverged"
  );
});

// Required behaviour, run against BOTH files' own extracted copy -- not a
// shared reimplementation, so each file is proven on its own, not just
// proven equal to the other.
const REFUSE = {
  "empty": "",
  "whitespace only": "   ",
  "no domain suffix": "owner@fenceflow",
  "no at-sign": "ownerfenceflow.com",
  "nothing before the at-sign": "@fenceflow.com",
  "contains a space": "owner @fenceflow.com",
};
const ACCEPT = {
  "an ordinary address": "owner@fenceflow.com",
  "a plus tag": "owner+billing@fenceflow.com",
  "a subdomain": "owner@mail.fenceflow.com",
};

for (const [label, src, grab] of [["dashboard.html", dashSrc, dashGrab], ["admin.html", adminSrc, adminGrab]]) {
  const isValidCompanyEmail = new Function(grab("isValidCompanyEmail") + "\nreturn isValidCompanyEmail;")();

  for (const [why, value] of Object.entries(REFUSE)) {
    test(`${label}: isValidCompanyEmail refuses ${why} (${JSON.stringify(value)})`, () => {
      assert.equal(isValidCompanyEmail(value), false);
    });
  }
  for (const [why, value] of Object.entries(ACCEPT)) {
    test(`${label}: isValidCompanyEmail still accepts ${why} (${JSON.stringify(value)})`, () => {
      assert.equal(isValidCompanyEmail(value), true);
    });
  }
}

// =============================================================================
// Both save paths actually CALL the validator -- defining it and forgetting
// to wire it in is the same silent drift by another route.
// =============================================================================

// dashboard.html declares isValidCompanyEmail NESTED inside saveSettings
// itself (see the comment at its call site) rather than at module scope, so
// that tests/a7-dashboard-money-regressions.test.mjs -- which already lifts
// saveSettings() out whole to run it standalone -- keeps working unchanged;
// a module-scope helper would leave that existing test calling into a
// ReferenceError. That means the definition header ("function
// isValidCompanyEmail(email)") is itself part of saveSettings' extracted
// text, so checking for the bare string "isValidCompanyEmail(" would pass
// even if the CALL were deleted. Requiring the call's own argument name
// (newEmail, from `$('s_email')?.value.trim()`) distinguishes an actual
// call site from the definition alone.
test("dashboard.html's saveSettings() calls isValidCompanyEmail before writing companies.email", () => {
  assert.match(dashGrab("saveSettings"), /isValidCompanyEmail\(newEmail\)/);
});
test("admin.html's saveEdit() calls isValidCompanyEmail before writing companies.email", () => {
  assert.match(adminGrab("saveEdit"), /isValidCompanyEmail\(newContactEmail\)/);
});

// =============================================================================
// admin.html's saveEdit(), end to end -- the actual write path, run for real
// =============================================================================

const fakeEl = (props = {}) => ({ value: "", textContent: "", disabled: false, checked: false, ...props });

function makeAdminDb() {
  const state = { companiesUpdate: null };
  return {
    state,
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => {
          if (table === "companies") state.companiesUpdate = { patch, col, val };
          // saveEdit() reads the affected rows back with .select('id') now, so a
          // write the row filter silently matched nothing cannot be reported as a
          // success. This stand-in therefore has to offer that third link AND stay
          // awaitable on its own, for the call sites that do not read rows back.
          // Without the link every subtest here died on "select is not a function"
          // before it reached a single assertion -- which reads as four failures of
          // the email guard rather than as a stand-in that is a link short.
          const rows = { data: [{ id: val }], error: null };
          return {
            select: () => Promise.resolve(rows),
            then: (res, rej) => Promise.resolve({ error: null }).then(res, rej),
          };
        },
      }),
    }),
  };
}

// Builds a runnable saveEdit() bound to fresh stand-ins, from whatever
// source string is passed in (the real, current one by default -- the
// PLANTED FAILURE test below passes a deliberately reverted one instead).
// editing.stripe_subscription_id is set so the plan/price branch is skipped
// and grace_ends_at is left unchanged, so no moneyChanges confirmation is
// triggered -- this test is about the email guard, not the money-change
// dialog, which a1/whichever other suite already covers.
function buildSaveEdit(fnSrc, { contactEmailValue }) {
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
  const db = makeAdminDb();
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

test("DEFECT 1 (admin.html): a blank company-email box saves nothing to companies.email, and says why", async () => {
  const { saveEdit, db, els, dialog } = await buildSaveEdit(adminGrab("saveEdit"), { contactEmailValue: "  " });
  await saveEdit();
  assert.equal(db.state.companiesUpdate?.patch.email, undefined, "companies.email must not be in the patch");
  assert.match(els.editMsg.textContent, /editEmailBlankMsg/);
  assert.equal(dialog.closed, false, "the dialog must stay open so the admin sees why the email did not save");
});

test("DEFECT 1 (admin.html): an address with no domain suffix saves nothing to companies.email, and says why", async () => {
  const { saveEdit, db, els, dialog } = await buildSaveEdit(adminGrab("saveEdit"), { contactEmailValue: "owner@fenceflow" });
  await saveEdit();
  assert.equal(db.state.companiesUpdate?.patch.email, undefined, "companies.email must not be in the patch");
  assert.match(els.editMsg.textContent, /editEmailInvalidMsg\|owner@fenceflow/);
  assert.equal(dialog.closed, false);
});

test("DEFECT 1 (admin.html): the other fields still save when the email is skipped", async () => {
  const { saveEdit, db, els } = await buildSaveEdit(adminGrab("saveEdit"), { contactEmailValue: "" });
  els.e_email.value = "billing@fenceflow.com";
  els.e_notes.value = "left a voicemail";
  await saveEdit();
  assert.equal(db.state.companiesUpdate.patch.billing_email, "billing@fenceflow.com");
  assert.equal(db.state.companiesUpdate.patch.admin_notes, "left a voicemail");
  assert.equal("email" in db.state.companiesUpdate.patch, false);
});

test("DEFECT 1 (admin.html): a real address still saves, and the dialog closes as normal", async () => {
  const { saveEdit, db, dialog } = await buildSaveEdit(adminGrab("saveEdit"), { contactEmailValue: "owner@fenceflow.com" });
  await saveEdit();
  assert.equal(db.state.companiesUpdate?.patch.email, "owner@fenceflow.com");
  assert.equal(dialog.closed, true);
});

test("PLANTED FAILURE: the pre-fix admin.html saveEdit wipes the address on a blank box", async () => {
  const real = adminGrab("saveEdit");
  // Exactly what shipped before this wave's fix (reconstructed directly,
  // rather than derived from `real` by regex, so the plant is immune to
  // this file's own CRLF/whitespace and cannot accidentally end up
  // identical to the fixed version): companies.email written straight from
  // the trimmed box, inside the patch object itself, no blank guard, no
  // shape check, and no isValidCompanyEmail call anywhere.
  const old = `async function saveEdit() {
  if (!editing) return;
  $('editMsg').textContent = tr('savingEllipsis');
  const patch = {
    email: $('e_contact').value.trim(),
    billing_email: $('e_email').value.trim(),
    grace_ends_at: $('e_grace').value ? new Date($('e_grace').value).toISOString() : null,
    admin_notes: $('e_notes').value,
    ...($('e_passfee').disabled ? {} : { pass_card_fee: $('e_passfee').checked })
  };
  if (!editing.stripe_subscription_id) {
    patch.subscription_plan = $('e_plan').value.trim();
    patch.monthly_price = Number($('e_price').value || 0);
  }
  if (!(await secondFactorFresh())) return;
  const { error } = await db.from('companies').update(patch).eq('id', editing.id);
  if (error) { $('editMsg').textContent = error.message; return; }
  $('editDialog').close();
  await loadAll();
}`;
  assert.notEqual(old, real, "the plant must actually change the function");
  assert.doesNotMatch(old, /isValidCompanyEmail\(/, "sanity: the plant must remove the guard entirely");
  const { saveEdit, db } = await buildSaveEdit(old, { contactEmailValue: "  " });
  await saveEdit();
  assert.equal(db.state.companiesUpdate?.patch.email, "", "the old code writes an empty string over the real address");
});
