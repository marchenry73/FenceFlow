// A fix with nothing pinning it: dashboard.html's #s_email input (Settings ->
// Company email) now starts `disabled` in the MARKUP itself, and
// saveSettings() only ever writes companies.email inside
// `if (profile.role === 'OWNER')`. The comment right above the input (see
// website/dashboard.html, just above the `<input id="s_email"...>` line)
// spells out why both halves have to hold: "The only way it can ever become
// editable is loadSettings() succeeding AND confirming profile.role ===
// 'OWNER'; every other path (first paint, a failed load, a load that hasn't
// run yet) leaves it exactly as it starts here. That makes the failure mode
// 'cannot type into it' instead of 'typed into it, told Saved, nothing
// happened.'" -- a MANAGER told "Saved" over a box that quietly did nothing
// is exactly the NO FAKE FEATURES failure this wave exists to catch.
//
// Before this file, NOTHING asserted either half:
//   - every existing saveSettings() test (tests/a7-dashboard-money-
//     regressions.test.mjs) hardcodes `profile = { role: "OWNER", ... }`, so
//     the `if (profile.role === 'OWNER')` branch's FALSE path has never once
//     run in this suite;
//   - no test reads the raw HTML and checks the input's default `disabled`
//     attribute -- delete it from the markup and the whole suite (this one
//     included, before today) stays green, because loadSettings() usually
//     sets `.disabled` correctly at runtime anyway. The attribute only
//     matters on the paths the comment names (first paint, a failed load),
//     which is exactly why it is easy to delete by accident and have nothing
//     notice.
//
// Same grab()/new Function() idiom as tests/a7-dashboard-money-regressions.
// test.mjs -- the REAL saveSettings() lifted out of dashboard.html, not a
// reimplementation. This file only READS website/dashboard.html; it does not
// modify it.
//
// Run:
//   node --test tests/a10-company-email-manager-guard.test.mjs
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
const grabConst = (name) => {
  let start = src.indexOf("const " + name + "=");
  if (start < 0) start = src.indexOf("const " + name + " =");
  if (start < 0) throw new Error("not found: " + name);
  const end = src.indexOf(";\n", start);
  if (end < 0) throw new Error("no terminator for: " + name);
  return src.slice(start, end + 1);
};

// =============================================================================
// Half 1 -- the markup itself starts disabled
// =============================================================================

test("dashboard.html's #s_email input starts disabled in the markup (before any JS runs, not just after loadSettings())", () => {
  const tagStart = src.indexOf('<input id="s_email"');
  assert.ok(tagStart >= 0, "the #s_email input moved or was renamed -- update this test's anchor");
  const tagEnd = src.indexOf(">", tagStart);
  assert.ok(tagEnd >= 0, "unterminated <input id=\"s_email\"> tag");
  const tag = src.slice(tagStart, tagEnd + 1);
  assert.match(tag, /\bdisabled\b/,
    "the #s_email input must start disabled in the HTML itself -- first paint, and any path where " +
    "loadSettings() fails or hasn't run yet, must leave it un-editable rather than relying only on " +
    "loadSettings() to lock it down at runtime. Got tag: " + tag);
});

// =============================================================================
// Half 2 -- the save path's role check, run for real with a non-owner
// =============================================================================

const fakeEl = (props = {}) => ({ value: "", ...props });

function makeDb() {
  const state = { companiesUpdate: null };
  return {
    state,
    rpc: (name) => {
      if (name === "save_company_settings") return Promise.resolve({ error: null });
      if (name === "my_setup_progress") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from: (table) => ({
      update: (patch) => ({
        eq: (col, val) => {
          if (table === "companies") state.companiesUpdate = { patch, col, val };
          // saveSettings() now reads the affected rows back with .select('id')
          // before treating the write as a success (see the comment above that
          // call in website/dashboard.html, and tests/a10-admin-save-zero-rows.
          // test.mjs for the admin-side twin of this fix), so a bare
          // Promise.resolve({error:null}) here is one link short of the real
          // chain: the OWNER path below calls .eq(...).select('id') and dies on
          // "select is not a function" before it reaches a single assertion.
          // The MANAGER test never notices, because a non-OWNER never reaches
          // this call at all -- profile.role === 'OWNER' gates the whole branch.
          // That is exactly why the OWNER "control" test below is the
          // LOAD-BEARING half of this file: it is the only subtest that
          // actually drives a write through this stand-in, so it is the only
          // one that can tell a real "MANAGER correctly blocked" result apart
          // from a harness that silently records nothing for anybody. A
          // negative result (MANAGER writes nothing) proves nothing on its own
          // when the positive control that should have written something is
          // dead -- same shape as tests/a8-company-email-guard.test.mjs's
          // makeAdminDb(), which offers both links for the same reason.
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

// Same harness shape as tests/a7-dashboard-money-regressions.test.mjs's
// buildSaveSettings(), with `role` exposed as a parameter instead of
// hardcoded to "OWNER" -- that hardcoding is exactly why the false path of
// `if (profile.role === 'OWNER')` had never run anywhere in this suite.
function buildSaveSettings(fnSrc, { emailValue, role }) {
  const els = { s_email: fakeEl({ value: emailValue }) };
  const $ = (id) => els[id] || (els[id] = fakeEl());
  const db = makeDb();
  const profile = { role, company_id: "co-1" };
  const msgCalls = [];
  const msg = (el, text, kind) => { msgCalls.push({ el, text, kind }); };
  const tr = (key, ...args) => key + (args.length ? "|" + args.join("|") : "");
  const saveSettings = new Function(
    "canEdit", "$", "db", "profile", "msg", "tr", "buildTemplates", "renderSetup",
    grabConst("SET") + "\n" + grabConst("SET_NUM") + "\n" + fnSrc + "\nreturn saveSettings;"
  )(() => true, $, db, profile, msg, tr, [], () => {});
  return { saveSettings, db, msgCalls };
}

test("a MANAGER's saveSettings() writes nothing to companies.email, even with a valid address sitting in the (disabled) box", async () => {
  // The box holds a perfectly valid address -- e.g. left over from before the
  // field was disabled for this viewer, or set by something other than
  // typing. The point of this test is the ROLE gate, not the email-shape
  // guard tests/a7-dashboard-money-regressions.test.mjs already covers, so a
  // valid value isolates the two: if this failed because of shape, that
  // would be the wrong defect.
  const { saveSettings, db, msgCalls } = buildSaveSettings(grab("saveSettings"), {
    emailValue: "owner@fenceflow.com", role: "MANAGER",
  });
  await saveSettings();
  assert.equal(db.state.companiesUpdate, null,
    "companies.email must not be written at all for a non-OWNER -- RLS would silently filter it to zero " +
    "rows changed even if it were attempted, which is the exact 'empty answer reads as good news' trap " +
    "the comment above the input warns about");
  // And no fake claim: the manager must not be told their (disabled, so
  // untouched) email box specifically saved or failed -- the general
  // settings-saved message, same as if the email field did not exist for them.
  const last = msgCalls[msgCalls.length - 1];
  assert.doesNotMatch(last.text, /settingsEmail(Blank|Invalid)Msg/,
    "a manager was never allowed to touch this field -- it must not be told the box was blank or invalid");
  assert.equal(last.kind, "ok");
});

test("control: an OWNER with the same valid address DOES have it written (isolates the MANAGER result to the role check, not a harness bug)", async () => {
  const { saveSettings, db } = buildSaveSettings(grab("saveSettings"), {
    emailValue: "owner@fenceflow.com", role: "OWNER",
  });
  await saveSettings();
  assert.equal(db.state.companiesUpdate?.patch.email, "owner@fenceflow.com",
    "sanity: the same harness, same address, OWNER role, must write it -- otherwise the MANAGER " +
    "test above could be passing for the wrong reason");
});
