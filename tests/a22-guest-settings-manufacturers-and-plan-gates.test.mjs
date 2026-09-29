// Static, source-text verification for this wave's three owned-file guest
// gates:
//
//   1. SettingsScreen.kt -- the company profile fields (business name, owner,
//      phone, email, license) are rendered inert (enabled = editable) for a
//      guest demo session rather than refused silently or left writable.
//   2. SettingsScreen.kt's pricing tiers (add, the tap-to-edit/delete card,
//      and copy-starting-tiers) and ManufacturersScreen.kt (add, tap-to-edit)
//      have their action controls absent for a guest, matching the existing
//      editable-flag pattern (InventoryScreen, SupplierPricesScreen) rather
//      than a new one. Manufacturers' existing canDelete permission gate is
//      asserted UNCHANGED.
//   3. CrewFencePlanScreen.kt's RequestChangeCard -- the "Ask to change the
//      plan" button is absent for a guest, and the line of copy that
//      promises "they will see it straight away" (false for a guest, who
//      never syncs) is swapped for a guest-specific string rather than left
//      standing next to a missing button.
//
// Written in Node rather than only as a Kotlin unit test for the same reason
// as tests/a18-dash-guest-vm-guard-text.test.mjs: this wave's hard rules
// forbid running gradlew while other tracks edit Kotlin (a Gradle invocation
// compiles the whole app), so a JVM-backed Kotlin test cannot actually be run
// right now. These checks are plain text operations over the real .kt/.xml
// source -- matching braces, extracting a named function's body, checking a
// guard sits WHERE it must rather than merely appearing somewhere in the
// file -- runnable with `node --test tests/a22-guest-settings-manufacturers-and-plan-gates.test.mjs`
// with no JVM. They are not a substitute for a real Kotlin compile+test pass
// once gradlew is safe to run again; they are what can actually be executed
// and re-run in the meantime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_ROOT = "app/src/main/java/com/fenceestimator/app";
const RES_ROOT = "app/src/main/res";
const src = (rel) => readFileSync(`${APP_ROOT}/${rel}`, "utf8");

// ---- small text-scanning helpers (same technique as a18's own port of
// GuestReadOnlyTest.kt's matchingClose/functionBody/block) ----

function matchingClose(text, openIndex, openChar, closeChar) {
  let depth = 0, i = openIndex;
  while (i < text.length) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function functionBody(text, name, from = 0) {
  const sig = new RegExp(
    "(private |internal |protected )?(suspend )?fun\\s+" +
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      "\\s*\\("
  );
  const m = sig.exec(text.slice(from));
  if (!m) throw new Error("the function I was checking is gone or was renamed: " + name);
  const sigStart = from + m.index;
  const parenOpen = sigStart + m[0].length - 1;
  const parenClose = matchingClose(text, parenOpen, "(", ")");
  if (parenClose < 0) throw new Error("unbalanced parens in signature of " + name);
  const braceOpen = text.indexOf("{", parenClose);
  if (braceOpen < 0) throw new Error("no body follows the signature of " + name);
  const braceClose = matchingClose(text, braceOpen, "{", "}");
  if (braceClose < 0) throw new Error("unbalanced braces in body of " + name);
  return text.slice(sigStart, braceClose + 1);
}

/** Extracts the `{ ... }` block that starts at `marker`'s own trailing `{`. */
function block(text, marker, what, from = 0) {
  const start = text.indexOf(marker, from);
  if (start < 0) throw new Error("the gate I was checking for is gone or moved: " + what + " (looked for: `" + marker + "`)");
  const open = start + marker.length - 1;
  if (text[open] !== "{") throw new Error("marker for " + what + " must end in the block's own `{`: `" + marker + "`");
  const close = matchingClose(text, open, "{", "}");
  if (close < 0) throw new Error("unbalanced braces after " + what);
  return { text: text.slice(start, close + 1), end: close + 1 };
}

function count(text, needle) {
  let c = 0, i = 0;
  while (true) {
    i = text.indexOf(needle, i);
    if (i < 0) return c;
    c++;
    i += needle.length;
  }
}

function line(text, needle) {
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error("not found: " + needle);
  const start = text.lastIndexOf("\n", idx) + 1;
  const end = text.indexOf("\n", idx);
  return text.slice(start, end < 0 ? text.length : end);
}

// =============================================================================
// 1. SettingsScreen.kt -- company profile fields
// =============================================================================

test("SettingsScreen defines the guest-demo editable flag off session.isGuestDemo, not a permission", () => {
  const body = functionBody(src("ui/settings/SettingsScreen.kt"), "SettingsScreen");
  assert.ok(
    body.includes("val editable = !session.isGuestDemo"),
    "SettingsScreen must gate on the guest-demo predicate itself"
  );
});

test("all five company-profile fields pass enabled = editable, on the same call", () => {
  const body = functionBody(src("ui/settings/SettingsScreen.kt"), "SettingsScreen");
  for (const key of ["biz_name", "biz_owner", "biz_phone", "biz_email", "biz_license"]) {
    const fieldLine = line(body, `stableKey = "${key}"`).trim();
    assert.ok(
      fieldLine.startsWith("DraftTextField("),
      `${key} must still be a DraftTextField call`
    );
    assert.ok(
      fieldLine.includes("enabled = editable"),
      `${key}'s DraftTextField call must pass enabled = editable so it renders inert, not refused silently, for a guest`
    );
  }
});

test("PLANTED FAILURE: a field missing enabled = editable is caught", () => {
  const fake = `DraftTextField(stableKey = "biz_name", initialValue = local.businessName, label = "x", modifier = Modifier.fillMaxWidth()) { local = local.copy(businessName = it) }`;
  assert.ok(!fake.includes("enabled = editable"), "sanity: the planted line really is missing the gate");
});

// =============================================================================
// 2a. SettingsScreen.kt -- pricing tiers: add, tap-to-edit/delete, copy-starting
// =============================================================================

test("pricing tiers: add, copy-starting-tiers and the per-tier edit door are each behind their own if (editable), in source order, and values stay visible either way", () => {
  const body = functionBody(src("ui/settings/SettingsScreen.kt"), "SettingsScreen");

  assert.strictEqual(
    count(body, "if (editable) {"),
    3,
    "expected exactly three `if (editable) {` gates in SettingsScreen: copy-starting-tiers, the tier row's edit door, and add-pricing-tier"
  );

  let cursor = 0;
  const copyGate = block(body, "if (editable) {", "copy-starting-tiers gate", cursor);
  assert.ok(
    copyGate.text.includes("showCopyStartingTiersConfirm = true"),
    "the first if (editable) gate must be the copy-starting-tiers button"
  );
  cursor = copyGate.end;

  const editDoorGate = block(body, "if (editable) {", "tier row edit-door gate", cursor);
  assert.ok(
    editDoorGate.text.includes("Card(onClick = { editingTier = tier }"),
    "the second if (editable) gate must be the tier row's onClick, the only door to EditTierDialog (Save AND Delete both live behind it)"
  );
  cursor = editDoorGate.end;

  // Immediately after that gate, the else-branch fallback must still render
  // the tier's own name/summary read-only -- "values readable, controls
  // absent", not the whole row disappearing.
  // block() returns text up to and including the gate's own closing `}`, so
  // what follows starts with the ` else {` half of that same statement.
  const afterEditDoor = body.slice(editDoorGate.end, editDoorGate.end + 200);
  assert.ok(
    afterEditDoor.trimStart().startsWith("else {"),
    "the tier row's editable gate must have an else branch immediately after it"
  );
  assert.ok(
    afterEditDoor.includes("Card(modifier = Modifier.fillMaxWidth()) { tierRow() }"),
    "the else branch must still render the tier's name/summary via the same tierRow() content"
  );
  assert.strictEqual(count(body, "tierRow()"), 2, "tierRow() must be reused by both the clickable and read-only Card, not duplicated content");

  const addGate = block(body, "if (editable) {", "add-pricing-tier gate", cursor);
  assert.ok(
    addGate.text.includes("showNewTier = true"),
    "the third if (editable) gate must be the add-pricing-tier button"
  );
});

test("PLANTED FAILURE: a control hoisted outside its if (editable) block is not found inside it", () => {
  const fakeBody = [
    "if (editable) {",
    "    Text(\"placeholder\")",
    "}",
    "OutlinedButton(onClick = { showNewTier = true }) { Text(\"Add\") }",
  ].join("\n");
  const gate = block(fakeBody, "if (editable) {", "planted add-tier gate");
  assert.ok(
    !gate.text.includes("showNewTier = true"),
    "a button hoisted after the gate's closing brace must NOT be found inside the gated block"
  );
});

// =============================================================================
// 2b. ManufacturersScreen.kt -- add (FAB) and tap-to-edit; delete untouched
// =============================================================================

test("ManufacturersScreen gates add (FAB) and the tap-to-edit door on editable, and leaves the existing canDelete permission gate alone", () => {
  const body = functionBody(src("ui/manufacturers/ManufacturersScreen.kt"), "ManufacturersScreen");

  assert.ok(body.includes("val editable = !session.isGuestDemo"), "must gate on the guest-demo predicate, not a permission");
  assert.ok(body.includes("val canDelete = session.canDelete"), "the pre-existing, correct delete permission gate must be unchanged");

  let cursor = 0;
  const fabGate = block(body, "if (editable) {", "FAB add gate", cursor);
  assert.ok(fabGate.text.includes("FloatingActionButton(onClick = { showNew = true })"), "the first if (editable) gate must be the add FAB");
  cursor = fabGate.end;

  const rowGate = block(body, "if (editable) {", "manufacturer row edit-door gate", cursor);
  assert.ok(
    rowGate.text.includes("Card(onClick = { editing = m }"),
    "the second if (editable) gate must be the manufacturer row's onClick, the only door to EditManufacturerDialog's Save"
  );

  const afterRowGate = body.slice(rowGate.end, rowGate.end + 200);
  assert.ok(afterRowGate.trimStart().startsWith("else {"), "the row's editable gate must have an else branch immediately after it");
  assert.ok(
    afterRowGate.includes("Card(modifier = Modifier.fillMaxWidth()) { row() }"),
    "the else branch must still render the manufacturer's name/contact info via the same row() content"
  );
  assert.strictEqual(count(body, "row()"), 2, "row() must be reused by both the clickable and read-only Card");

  // canDelete must still reach EditManufacturerDialog unchanged, from both
  // the editing-existing and creating-new call sites.
  assert.strictEqual(
    count(body, "canDelete = canDelete"),
    2,
    "canDelete must still be threaded to EditManufacturerDialog from both call sites, untouched by this wave's fix"
  );
});

// =============================================================================
// 3. CrewFencePlanScreen.kt -- RequestChangeCard
// =============================================================================

test("RequestChangeCard gates its button on editable (guest-demo predicate), positioned to actually guard the button, and swaps the false 'they will see it' copy for a guest", () => {
  const body = functionBody(src("ui/crew/CrewFencePlanScreen.kt"), "RequestChangeCard");

  assert.ok(body.includes("val editable = !session.isGuestDemo"), "must gate on the guest-demo predicate, not a permission");
  assert.ok(
    body.includes("!editable -> R.string.crew_plan_guest_no_office"),
    "must show a guest-specific line instead of the real crew_plan_ask_office copy"
  );
  assert.ok(
    body.includes("else -> R.string.crew_plan_ask_office"),
    "real crew (editable) must still see the original ask_office copy -- this wave must not change real-crew behaviour"
  );

  const gate = block(body, "if (editable && !sent && !jobGone) {", "request-change button gate");
  assert.ok(
    gate.text.includes("onClick = { showDialog = true }"),
    "the button that opens the request dialog must sit INSIDE the editable guard, not merely somewhere in the file"
  );
});

test("PLANTED FAILURE: a button hoisted above its guard is not found inside it", () => {
  const fakeBody = [
    "OutlinedButton(onClick = { showDialog = true }) { Text(\"Ask\") }",
    "if (editable && !sent && !jobGone) {",
    "    Text(\"placeholder\")",
    "}",
  ].join("\n");
  const gate = block(fakeBody, "if (editable && !sent && !jobGone) {", "planted request-change gate");
  assert.ok(
    !gate.text.includes("onClick = { showDialog = true }"),
    "a button hoisted before the guard must NOT be found inside the gated block"
  );
});

// =============================================================================
// 4. The new guest string: defined key-for-key in all three locales this app
//    ships (values, values-es, values-fr), referenced exactly once.
// =============================================================================

test("crew_plan_guest_no_office exists in all three shipped locales and is referenced exactly once from Kotlin", () => {
  const key = "crew_plan_guest_no_office";
  for (const dir of ["values", "values-es", "values-fr"]) {
    const xml = readFileSync(`${RES_ROOT}/${dir}/strings_guest.xml`, "utf8");
    assert.strictEqual(
      count(xml, `name="${key}"`),
      1,
      `${dir}/strings_guest.xml must define ${key} exactly once`
    );
    // A raw, un-escaped apostrophe inside a double-quoted Android string
    // value is a compile-time resource error, not merely a style nit -- the
    // whole reason this wave's floor commit called out 33 missing keys as a
    // hard compile failure. Check the value itself, not just its presence.
    const valueMatch = new RegExp(`name="${key}">([^<]*)</string>`).exec(xml);
    assert.ok(valueMatch, `${dir}/strings_guest.xml must have a well-formed <string> element for ${key}`);
    const value = valueMatch[1];
    assert.ok(!/(^|[^\\])'/.test(value), `${dir}'s ${key} value must escape every apostrophe as \\'`);
  }

  const refCount =
    count(src("ui/crew/CrewFencePlanScreen.kt"), `R.string.${key}`);
  assert.strictEqual(refCount, 1, `${key} must be referenced exactly once, from CrewFencePlanScreen.kt`);
});
