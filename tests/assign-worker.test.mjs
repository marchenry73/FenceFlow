// Attaching a crew member to a shift that has none -- website/dashboard.html's
// correct-a-shift sheet.
//
// Three shifts on the live database carry a blank employee_sync_id. They
// belong to nobody, so every per-person hours and pay total leaves them out,
// and until the worker field existed nothing in the product could attach one:
// the sheet edited start, end, break and reason only, and the phone can fix a
// shift only while the device that recorded it still has it marked blocked.
//
// The logic under test is LIFTED OUT OF THE PAGE by name rather than
// reimplemented here. A reimplementation is the failure this repo has been
// bitten by twice: forty-three parser tests passed against a copy of a rule
// the app never called that way, and a checker that skips a case reports zero
// failures for it. Extracting the real source means an edit to dashboard.html
// is an edit to what these assertions run.
//
// What the assertions are held against is the server, not this file's opinion.
// public.time_entry_needs_a_person()'s UPDATE branch refuses a blank
// employee_sync_id, refuses one naming somebody outside the company, and only
// checks at all when the value actually changes. Proven live on 2026-09-18
// inside a rolled-back transaction impersonating the real OWNER: attaching a
// crew member to all three real blank rows was allowed (3 rows), blank was
// refused 23514, another company's person was refused 23514, and the positive
// control -- the same owner with a -APPROVE_TIME override moving approved_at --
// was refused 42501, proving the approval guard was live throughout.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = readFileSync(new URL("../website/dashboard.html", import.meta.url), "utf8");

/** Pulls one top-level `function name(...) { ... }` out of the page by
 *  brace-matching, so the text under test is the page's own text. Throws if the
 *  function is gone -- a rename must break this test loudly rather than leave it
 *  silently testing nothing. */
function lift(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.notEqual(at, -1, `dashboard.html no longer defines function ${name}() -- ` +
    `if it was renamed, rename it here too; if it was deleted, this test is the wrong shape`);
  let i = SRC.indexOf("{", at), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > 0, `could not brace-match ${name}() in dashboard.html`);
  return SRC.slice(at, end);
}

// blankWorkerId is a dependency of the other three, so all four load together
// into one scope. No DOM, no Supabase, no clock: if any of them ever reaches
// for one, this import fails and says so, which is the point of keeping them
// pure.
const { blankWorkerId, shiftNeedsAWorker, crewChoicesForShift, planWorkerChange } =
  new Function(
    [lift("blankWorkerId"), lift("shiftNeedsAWorker"),
     lift("crewChoicesForShift"), lift("planWorkerChange"),
     "return { blankWorkerId, shiftNeedsAWorker, crewChoicesForShift, planWorkerChange };"].join("\n")
  )();

// The company's own roster, shaped like the page's `employees` array.
const ROSTER = [
  { sync_id: "e-zoe",   name: "Zoe Alvarez", is_active: true },
  { sync_id: "e-ben",   name: "Ben Carter",  is_active: true },
  { sync_id: "e-quit",  name: "Dana Ortiz",  is_active: false },
];
const OUTSIDER = "e-other-company";

/* ---- which shifts have nobody on them --------------------------------- */

test("a blank, whitespace or missing employee_sync_id is a shift with nobody on it", () => {
  assert.equal(shiftNeedsAWorker({ employee_sync_id: "" }), true);
  assert.equal(shiftNeedsAWorker({ employee_sync_id: null }), true);
  assert.equal(shiftNeedsAWorker({ employee_sync_id: undefined }), true);
  assert.equal(shiftNeedsAWorker({}), true);
  // btrim(x, ' \t\r\n') is what the server's guard applies, so a value made
  // only of those four characters is blank on both sides of the wire.
  assert.equal(shiftNeedsAWorker({ employee_sync_id: "  \t\r\n " }), true);
  assert.equal(shiftNeedsAWorker({ employee_sync_id: "e-zoe" }), false);
  // Padded but real: the server keeps it (btrim only trims the ends), and so
  // must this, or the office would offer to "attach" somebody already there.
  assert.equal(shiftNeedsAWorker({ employee_sync_id: " e-zoe " }), false);
});

test("the three real rows, as the database holds them, read as needing a worker", () => {
  // Shape and values taken from the live rows on 2026-09-18: employee_sync_id
  // is the empty string (never a dangling reference), and all three are
  // already approved, which is exactly what made this look impossible.
  const real = [
    { id: "30418598", employee_sync_id: "", approved_at: "2026-08-21 03:25:53.548+00", ended_at: "2026-08-17 16:33:00+00" },
    { id: "e62e0383", employee_sync_id: "", approved_at: "2026-08-21 03:25:53.548+00", ended_at: "2026-08-18 23:04:39.15+00" },
    { id: "ba6f9511", employee_sync_id: "", approved_at: "2026-08-28 18:49:43.304+00", ended_at: "2026-08-28 18:49:20.605+00" },
  ];
  assert.deepEqual(real.filter(shiftNeedsAWorker).map((t) => t.id),
    ["30418598", "e62e0383", "ba6f9511"]);
});

/* ---- what the sheet is allowed to offer -------------------------------- */

test("the choices never include a blank option", () => {
  const choices = crewChoicesForShift(ROSTER, "");
  assert.ok(choices.length > 0);
  assert.equal(choices.some((c) => blankWorkerId(c.value) === ""), false,
    "a blank choice is a choice the server refuses with 23514");
});

test("current crew come first, by name, then people off the crew", () => {
  assert.deepEqual(crewChoicesForShift(ROSTER, "").map((c) => c.value),
    ["e-ben", "e-zoe", "e-quit"]);
  assert.deepEqual(crewChoicesForShift(ROSTER, "").map((c) => c.gone),
    [false, false, true]);
});

test("somebody off the crew is still offered -- an August shift can be theirs", () => {
  assert.ok(crewChoicesForShift(ROSTER, "").some((c) => c.value === "e-quit"));
});

test("a worker the roster no longer lists at all is kept as their own choice", () => {
  // Deleted crew are filtered out of the page's roster read (deleted_at is
  // null), so without this the select would fall to selectedIndex -1 and the
  // next save would move the shift onto whoever sorted first -- the same trap
  // the job editor's assignee select was fixed for.
  const choices = crewChoicesForShift(ROSTER, "e-deleted");
  assert.equal(choices.filter((c) => c.value === "e-deleted").length, 1);
  assert.equal(choices.find((c) => c.value === "e-deleted").missing, true);
});

test("an empty roster offers nothing rather than an empty-valued option", () => {
  assert.deepEqual(crewChoicesForShift([], ""), []);
  assert.deepEqual(crewChoicesForShift(null, ""), []);
});

/* ---- what gets sent ---------------------------------------------------- */

test("attaching a crew member to a blank shift sends employee_sync_id and nothing else", () => {
  const plan = planWorkerChange({ employee_sync_id: "" }, "e-zoe", ROSTER);
  assert.equal(plan.problem, null);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.patch, { employee_sync_id: "e-zoe" });
});

test("hourly_rate is never sent -- the server stamps it from the employee row", () => {
  // stamp_time_entry_rate() rewrites hourly_rate from the employee record on
  // every write (proved live: attaching a 44.25/h person to a 31.50/h shift
  // left the row at 44.25 without the office sending a rate). A rate sent from
  // here would be thrown away, and this screen must not carry rates at all --
  // it is reachable by roles the SEE_PAY read policy hides them from.
  for (const chosen of ["e-zoe", "e-quit"]) {
    const plan = planWorkerChange({ employee_sync_id: "" }, chosen, ROSTER);
    assert.deepEqual(Object.keys(plan.patch), ["employee_sync_id"]);
  }
});

test("correcting a wrong worker sends the new one", () => {
  const plan = planWorkerChange({ employee_sync_id: "e-ben" }, "e-zoe", ROSTER);
  assert.deepEqual(plan.patch, { employee_sync_id: "e-zoe" });
  assert.equal(plan.changed, true);
});

test("leaving the worker alone sends no worker key at all", () => {
  const plan = planWorkerChange({ employee_sync_id: "e-zoe" }, "e-zoe", ROSTER);
  assert.equal(plan.problem, null);
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.patch, {});
  assert.equal("employee_sync_id" in plan.patch, false,
    "an absent key is how the server decides to skip its own check");
});

test("a shift naming somebody the roster no longer lists can still have its times corrected", () => {
  // The server only validates when the value changes, so an unchanged value
  // pointing at deleted crew must not be refused by our own check -- otherwise
  // a since-deleted person's shifts become permanently uneditable.
  const plan = planWorkerChange({ employee_sync_id: "e-deleted" }, "e-deleted", ROSTER);
  assert.equal(plan.problem, null);
  assert.deepEqual(plan.patch, {});
});

test("blank is refused, and refused as a key rather than as a sentence", () => {
  for (const chosen of ["", null, undefined, "  \t "]) {
    const plan = planWorkerChange({ employee_sync_id: "" }, chosen, ROSTER);
    assert.equal(plan.patch, null);
    assert.equal(plan.problem, "fixTimeWorkerRequired");
  }
  // A key, not a sentence, or the refusal reverts to English for a Spanish or
  // French manager the moment it is shown.
  assert.match(planWorkerChange({ employee_sync_id: "" }, "", ROSTER).problem,
    /^[a-zA-Z]+$/);
});

test("clearing an existing worker back to blank is refused", () => {
  const plan = planWorkerChange({ employee_sync_id: "e-zoe" }, "", ROSTER);
  assert.equal(plan.patch, null);
  assert.equal(plan.problem, "fixTimeWorkerRequired");
});

test("somebody outside the company is refused", () => {
  const plan = planWorkerChange({ employee_sync_id: "" }, OUTSIDER, ROSTER);
  assert.equal(plan.patch, null);
  assert.equal(plan.problem, "fixTimeWorkerNotOurs");
});

test("every refusal key the logic can return exists in all three languages", () => {
  // A key that does not exist falls back to English, then to '' -- an empty
  // error message reads as a save that worked.
  const keys = [...new Set(
    [["", ""], ["e-zoe", ""], ["", OUTSIDER]]
      .map(([now, chosen]) => planWorkerChange({ employee_sync_id: now }, chosen, ROSTER).problem)
      .filter(Boolean)
  )];
  assert.ok(keys.length >= 2, `expected more than one refusal, saw ${JSON.stringify(keys)}`);
  for (const lang of ["en", "es", "fr"]) {
    const at = SRC.indexOf(`\n  ${lang}: {`);
    assert.notEqual(at, -1, `the ${lang} table is missing`);
    const table = SRC.slice(at, SRC.indexOf("\n  },", at));
    for (const k of keys) {
      assert.ok(table.includes(k + ":"), `${lang} has no ${k}`);
    }
  }
});

/* ---- proof the assertions above can fail ------------------------------- */

test("PLANTED FAILURE: a worker field that offers a blank option is caught", () => {
  // The single most likely way to build this field is to copy the job
  // editor's assignee select, which opens with `<option value="">Unassigned`.
  // Here that option is a guaranteed 23514 from the server, so the check that
  // no choice is blank has to be able to see it.
  const withBlank = (roster, current) =>
    [{ value: "", name: "Unassigned", gone: false }].concat(crewChoicesForShift(roster, current));
  const offered = withBlank(ROSTER, "");
  assert.equal(offered.some((c) => blankWorkerId(c.value) === ""), true,
    "the blank-option check is vacuous -- it did not see a blank option that is there");
  // And the real implementation must not be that.
  assert.equal(crewChoicesForShift(ROSTER, "").some((c) => blankWorkerId(c.value) === ""), false);
});

test("PLANTED FAILURE: a permissive validator that waves blank through is caught", () => {
  // A plan() that only checks membership, forgetting that blank is its own
  // refusal, would let the office save a shift still belonging to nobody --
  // the exact bug this whole feature exists to close.
  const permissive = (shift, chosen, roster) =>
    (roster || []).some((e) => String(e.sync_id) === String(chosen))
      ? { patch: { employee_sync_id: chosen }, problem: null, changed: true }
      : { patch: {}, problem: null, changed: false };
  const bad = permissive({ employee_sync_id: "" }, "", ROSTER);
  const good = planWorkerChange({ employee_sync_id: "" }, "", ROSTER);
  assert.equal(bad.problem, null, "the planted-permissive version is meant to be wrong");
  assert.notEqual(good.problem, bad.problem,
    "the real validator agrees with the permissive one -- blank is not being refused");
});

test("PLANTED FAILURE: sending hourly_rate alongside the worker is caught", () => {
  const withRate = (shift, chosen, roster) => {
    const plan = planWorkerChange(shift, chosen, roster);
    return plan.patch ? { ...plan, patch: { ...plan.patch, hourly_rate: 44.25 } } : plan;
  };
  assert.deepEqual(Object.keys(withRate({ employee_sync_id: "" }, "e-zoe", ROSTER).patch),
    ["employee_sync_id", "hourly_rate"]);
  assert.deepEqual(Object.keys(planWorkerChange({ employee_sync_id: "" }, "e-zoe", ROSTER).patch),
    ["employee_sync_id"]);
});

/* ---- the page actually wires it up ------------------------------------- */

test("the sheet's worker select exists and saveFixTime routes through planWorkerChange", () => {
  assert.match(SRC, /<select id="fixTimeWorker">/,
    "the correct-a-shift sheet has no worker select");
  assert.match(SRC, /planWorkerChange\(t, \$\('fixTimeWorker'\)\.value, employees\)/,
    "saveFixTime does not run the choice through planWorkerChange");
  assert.match(SRC, /\.\.\.worker\.patch/,
    "saveFixTime builds a patch that cannot carry the worker");
});

test("the save is judged on rows changed, not on the absence of an error", () => {
  // A PostgREST update that matches nothing returns 200, an empty body and no
  // error -- the shift deleted from a phone since the page loaded, or hidden
  // from this reader by the pay-visibility read policy. Announcing "Shift
  // corrected" for that is the bug class this repo has been bitten by four
  // times: an empty answer read as good news.
  const save = lift("saveFixTime");
  assert.match(save, /\.update\(patch\)\.eq\('id', t\.id\)\.select\('id'\)/,
    "the update does not ask which rows it changed");
  assert.match(save, /!changedRows \|\| !changedRows\.length/,
    "nothing checks the row count before announcing success");
  for (const lang of ["en", "es", "fr"]) {
    const at = SRC.indexOf(`\n  ${lang}: {`);
    assert.ok(SRC.slice(at, SRC.indexOf("\n  },", at)).includes("fixTimeNothingChangedErr:"),
      `${lang} has no fixTimeNothingChangedErr, so the message would be empty`);
  }
});

test("the orphan-shifts list hands each row an assign action", () => {
  assert.match(SRC, /fixShiftId: t\.id/,
    "the orphan rows are still read-only");
  assert.match(SRC, /data-xp-fix=/,
    "showExplain never renders the assign button");
  assert.match(SRC, /openFixTime\(b\.dataset\.xpFix\)/,
    "the assign button is not wired to the sheet");
});

test("the assign button is gated on the same permission openFixTime is", () => {
  // openFixTime() returns early for anyone who is not OWNER or MANAGER. A
  // button offered to somebody that check will refuse does nothing at all when
  // pressed, which reads as a broken page rather than as a missing permission.
  const at = SRC.indexOf("data-xp-fix=");
  const around = SRC.slice(Math.max(0, at - 600), at);
  assert.match(around, /r\.fixShiftId && canEdit\(\)/,
    "the assign button is not gated on canEdit()");
});

test("the name shown for an unattributed shift is a tr() key, not a hardcoded word", () => {
  // Every shift with nobody on it used to read 'Unknown' in the Time, Timesheet
  // and Pay tables -- in English whatever language the office was in, and the
  // same word as a shift belonging to somebody whose crew record was deleted.
  // One of those two is fixable here and the other is not.
  // Comments stripped first: the function's own comment says the word
  // 'Unknown' to explain what it stopped doing, and a check that reads prose as
  // code fails for the wrong reason.
  const who = lift("shiftWhoName").replace(/\/\/[^\n]*/g, "");
  assert.equal(who.includes("'Unknown'"), false,
    "shiftWhoName still falls back to a hardcoded English word");
  assert.match(who, /tr\(\s*shiftNeedsAWorker\(t\)\s*\?/,
    "shiftWhoName does not tell 'nobody on it' apart from 'name not on hand'");
  for (const lang of ["en", "es", "fr"]) {
    const at = SRC.indexOf(`\n  ${lang}: {`);
    const table = SRC.slice(at, SRC.indexOf("\n  },", at));
    for (const k of ["timeWhoNobody", "timeWhoGone"]) {
      assert.ok(table.includes(k + ":"), `${lang} has no ${k}`);
    }
  }
});

test("no rate, and no employee pay field, is rendered into the worker select", () => {
  // The page's own pay gating (time_entries_pay_needs_see_pay, and the
  // time_entries_crew view that drops hourly_rate) exists so a role without
  // SEE_PAY never has the numbers. A select built from `employees` could
  // reintroduce them in a label; this reads the actual option-building source.
  const build = SRC.slice(SRC.indexOf("$('fixTimeWorker').innerHTML"),
                          SRC.indexOf("$('fixTimeWorker').value"));
  assert.ok(build.length > 40, "could not find the option-building source");
  for (const pay of ["hourly_rate", "per_foot_rate", "pay_type", "money("]) {
    assert.equal(build.includes(pay), false, `the worker select renders ${pay}`);
  }
});
