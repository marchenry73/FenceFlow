// Static, source-text verification for this wave's four owned files:
//
//   1. PersonalSettingsScreen.kt / PersonalSettingsViewModel.kt -- the real
//      guest write that outlives the demo. Three earlier reviews checked
//      whether a guest could reach the company-profile screen (they cannot)
//      and stopped there; nothing ever checked the screen a guest is ACTUALLY
//      routed to. Auto-lock minutes and biometric unlock are security
//      settings for the phone itself, written to on-device storage the demo
//      wipe never touches, so they are now refused for a guest -- visibly
//      inert in the screen, and independently refused in the view model's
//      save() so a UI bypass still changes nothing. Theme and language stay
//      editable (the documented, deliberate choice).
//
//   2. SurveyDrawScreen.kt / strings_satellite.xml (all three locales) -- the
//      satellite tile-budget note, previously a hardcoded English Kotlin
//      literal, is now a real translated string resource, and the three
//      guest/delete/calibration gates this wave was told not to disturb are
//      checked as still present.
//
// Written in Node rather than only as a Kotlin unit test for the same reason
// as tests/a18-dash-guest-vm-guard-text.test.mjs and
// tests/a22-guest-settings-manufacturers-and-plan-gates.test.mjs: this wave's
// hard rules forbid running gradlew while other tracks edit Kotlin (a Gradle
// invocation compiles the whole app), so a JVM-backed Kotlin test cannot
// actually be run right now. These checks are plain text operations over the
// real .kt/.xml source -- matching braces, extracting a named function's
// body, checking a guard sits WHERE it must rather than merely appearing
// somewhere in the file -- runnable with
// `node --test tests/a23-personal-settings-guest-lock-and-satellite-note.test.mjs`
// with no JVM. They are not a substitute for a real Kotlin compile+test pass
// once gradlew is safe to run again; they are what can actually be executed
// and re-run in the meantime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_ROOT = "app/src/main/java/com/fenceestimator/app";
const RES_ROOT = "app/src/main/res";
const src = (rel) => readFileSync(`${APP_ROOT}/${rel}`, "utf8");
const res = (rel) => readFileSync(`${RES_ROOT}/${rel}`, "utf8");

// ---- small text-scanning helpers (same technique a22 ported from
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

function count(text, needle) {
  let c = 0, i = 0;
  while (true) {
    i = text.indexOf(needle, i);
    if (i < 0) return c;
    c++;
    i += needle.length;
  }
}

/** Every <string name="X">...</string> in an Android resource file, as {name: value}. */
function stringMap(xml) {
  const out = {};
  const re = /<string name="([^"]+)">([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2];
  return out;
}

/** No `<!--...-->` block may contain a literal `--` -- invalid XML, and this
 *  exact project has broken a Gradle build on it before. */
function assertNoDoubleHyphenComments(xml, label) {
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(xml))) {
    assert.ok(!m[1].includes("--"), `${label}: an XML comment contains a double hyphen: ${m[1].slice(0, 80)}`);
  }
}

// =============================================================================
// 1a. PersonalSettingsScreen.kt -- the guest gate on the two security fields
// =============================================================================

const screenSrc = src("ui/settings/PersonalSettingsScreen.kt");
const screenBody = functionBody(screenSrc, "PersonalSettingsScreen");

test("PersonalSettingsScreen defines securityLocked off session.isGuestDemo, not a permission", () => {
  assert.ok(
    screenBody.includes("val securityLocked = session.isGuestDemo"),
    "PersonalSettingsScreen must gate on the guest-demo predicate itself, the same pattern SettingsScreen's `editable` already uses"
  );
});

test("theme and language stay unconditionally editable -- only auto-lock and biometric are gated", () => {
  const themeIdx = screenBody.indexOf("settings_theme");
  const languageIdx = screenBody.indexOf("settings_language");
  const securityIdx = screenBody.indexOf("R.string.set_security)");
  assert.ok(themeIdx > 0 && languageIdx > themeIdx, "expected the appearance card's theme then language dropdowns");
  assert.ok(securityIdx > languageIdx, "expected the security card to come after appearance");
  const appearanceSlice = screenBody.slice(themeIdx, securityIdx);
  assert.ok(
    !appearanceSlice.includes("securityLocked"),
    "the appearance section (theme/language) must never reference securityLocked -- this wave's decision is that a guest may change theme and language"
  );
});

test("PLANTED FAILURE: a theme dropdown gated on securityLocked would be caught", () => {
  const fake = `if (!securityLocked) { SettingsEnumDropdown("Theme", themes, local.themeMode, {}) { } }`;
  assert.ok(fake.includes("securityLocked"), "sanity: the planted line really would trip the check above");
});

test("auto-lock: securityLocked renders a disabled, read-only OutlinedTextField instead of the live dropdown", () => {
  assert.strictEqual(
    count(screenBody, "if (securityLocked) {"),
    2,
    "expected exactly two `if (securityLocked) {` blocks: the explanatory Text, and the auto-lock control swap"
  );
  const idx = screenBody.indexOf("OutlinedTextField(");
  assert.ok(idx > 0, "expected an inert OutlinedTextField standing in for the auto-lock dropdown");
  const close = matchingClose(screenBody, screenBody.indexOf("(", idx), "(", ")");
  const call = screenBody.slice(idx, close + 1);
  assert.ok(call.includes("readOnly = true"), "the inert auto-lock field must be readOnly");
  assert.ok(call.includes("enabled = false"), "the inert auto-lock field must be visibly disabled, not just readOnly (readOnly alone still looks tappable)");
});

test("auto-lock: the real, editable SettingsEnumDropdown is still offered when NOT securityLocked", () => {
  assert.ok(
    screenBody.includes("} else {\n                        SettingsEnumDropdown("),
    "expected the live dropdown in the else branch of the securityLocked check, same options list as before"
  );
});

test("PLANTED FAILURE: an auto-lock control with no enabled=false is caught", () => {
  const fake = `OutlinedTextField(value = x, onValueChange = {}, readOnly = true, label = { Text("Auto-lock") })`;
  assert.ok(!fake.includes("enabled = false"), "sanity: the planted line really is missing the disable");
});

test("biometric: the Switch is disabled for a guest via enabled = !securityLocked, not hidden", () => {
  const switchIdx = screenBody.indexOf("Switch(\n");
  assert.ok(switchIdx > 0, "expected the biometric Switch composable");
  const close = matchingClose(screenBody, screenBody.indexOf("(", switchIdx), "(", ")");
  const call = screenBody.slice(switchIdx, close + 1);
  assert.ok(call.includes("checked = local.biometricUnlockEnabled"), "must still be bound to the loaded value");
  assert.ok(call.includes("enabled = !securityLocked"), "the biometric Switch must be disabled for a guest, matching the auto-lock control's treatment");
});

test("PLANTED FAILURE: a biometric Switch with no enabled clause is caught", () => {
  const fake = `Switch(checked = local.biometricUnlockEnabled, onCheckedChange = { change(local.copy(biometricUnlockEnabled = it)) })`;
  assert.ok(!fake.includes("enabled = !securityLocked"), "sanity: the planted line really is missing the gate");
});

test("a guest-specific explanation is shown when securityLocked, using a real string resource", () => {
  assert.ok(
    screenBody.includes("stringResource(R.string.pset_guest_security_locked)"),
    "expected the locked-security explanation to be a translated string, not a Kotlin literal"
  );
});

// =============================================================================
// 1b. PersonalSettingsViewModel.kt -- the write is refused independently of the UI
// =============================================================================

const vmSrc = src("ui/settings/PersonalSettingsViewModel.kt");
const saveBody = functionBody(vmSrc, "save");

test("PersonalSettingsViewModel.save reads guest state fresh from the store, not from a passed-in flag", () => {
  assert.ok(saveBody.includes("settingsStore.profile.first()"), "must read the live profile, not trust a stale caller-remembered value");
  assert.ok(saveBody.includes("GuestSession.isActive("), "must use the one canonical guest-active predicate, not a re-derived check");
});

test("auto-lock minutes and biometric unlock are held at the CURRENT stored value while a guest session is active", () => {
  assert.ok(
    /autoLockMinutes\s*=\s*if\s*\(\s*guestActive\s*\)\s*current\.autoLockMinutes\s*else\s*prefs\.autoLockMinutes/.test(saveBody),
    "autoLockMinutes must fall back to the already-persisted value for a guest, ignoring whatever the caller's buffer holds"
  );
  assert.ok(
    /biometricUnlockEnabled\s*=\s*if\s*\(\s*guestActive\s*\)\s*current\.biometricUnlockEnabled\s*else\s*prefs\.biometricUnlockEnabled/.test(saveBody),
    "biometricUnlockEnabled must fall back to the already-persisted value for a guest, ignoring whatever the caller's buffer holds"
  );
});

test("theme and language are passed straight through, never conditioned on guestActive", () => {
  assert.ok(
    /themeMode\s*=\s*prefs\.themeMode\b/.test(saveBody) && !/themeMode\s*=\s*if\s*\(\s*guestActive/.test(saveBody),
    "themeMode must not be gated -- this wave's decision is that a guest may change it"
  );
  assert.ok(
    /language\s*=\s*prefs\.language\b/.test(saveBody) && !/language\s*=\s*if\s*\(\s*guestActive/.test(saveBody),
    "language must not be gated -- this wave's decision is that a guest may change it"
  );
});

test("PLANTED FAILURE: a save() that always writes prefs.autoLockMinutes unconditionally is caught", () => {
  const fake = `settingsStore.saveDevicePrefs(themeMode = prefs.themeMode, language = prefs.language, autoLockMinutes = prefs.autoLockMinutes, biometricUnlockEnabled = prefs.biometricUnlockEnabled)`;
  assert.ok(
    !/autoLockMinutes\s*=\s*if\s*\(\s*guestActive\s*\)/.test(fake),
    "sanity: the planted regression really has no guest guard on autoLockMinutes"
  );
});

// =============================================================================
// 2a. SurveyDrawScreen.kt -- satellite note is a real resource; other gates untouched
// =============================================================================

const surveySrc = src("ui/survey/SurveyDrawScreen.kt");

test("the satellite tile-budget note is a stringResource call, not a hardcoded English literal", () => {
  assert.ok(
    surveySrc.includes("stringResource(R.string.sat_extent_note, reachFt)"),
    "expected the note to be rendered from a translated resource"
  );
  assert.ok(
    !surveySrc.includes("Satellite imagery is complete up to about"),
    "the old hardcoded English literal must be gone, not merely duplicated alongside the resource"
  );
});

test("PLANTED FAILURE: a literal alongside the resource call would be caught", () => {
  const fake = `Text("Satellite imagery is complete up to about " + reachFt + " ft")`;
  assert.ok(fake.includes("Satellite imagery is complete up to about"), "sanity: the planted literal really matches the forbidden text");
});

test("untouched: the guest read-only gate, delete gating, and the uncalibrated-photo scale read are all still present", () => {
  assert.ok(surveySrc.includes("val editable = !session.isGuestDemo"), "the survey screen's own guest gate must be unchanged");
  assert.strictEqual(count(surveySrc, "session.canDelete"), 2, "expected both existing canDelete checks (the run-erase button and its confirm) untouched");
  assert.ok(surveySrc.includes("val pxPerFt = SurveyViewModel.drawingScale(job2)"), "the uncalibrated-photo scale read (null pxPerFt drives the tap-to-calibrate prompt) must be unchanged");
});

// =============================================================================
// 2b. strings_satellite.xml -- all three locales define sat_extent_note
// =============================================================================

const satLocales = {
  base: res("values/strings_satellite.xml"),
  es: res("values-es/strings_satellite.xml"),
  fr: res("values-fr/strings_satellite.xml"),
};

for (const [locale, xml] of Object.entries(satLocales)) {
  test(`strings_satellite.xml (${locale}) defines sat_extent_note with a %1$d placeholder`, () => {
    const strings = stringMap(xml);
    assert.ok("sat_extent_note" in strings, `sat_extent_note missing from ${locale}`);
    assert.ok(strings.sat_extent_note.includes("%1$d"), `sat_extent_note in ${locale} must carry the feet count as a real format arg, not a baked-in number`);
  });

  test(`strings_satellite.xml (${locale}) has no double-hyphen inside an XML comment`, () => {
    assertNoDoubleHyphenComments(xml, `strings_satellite.xml (${locale})`);
  });
}

test("sat_extent_note is present in all three locales (not just base) -- the lockstep this project's StringResourceSanityTest checks", () => {
  const names = Object.values(satLocales).map((xml) => "sat_extent_note" in stringMap(xml));
  assert.ok(names.every(Boolean), "sat_extent_note must exist in base, -es and -fr alike, or the build breaks on whichever locale is missing it");
});

// =============================================================================
// 2c. strings.xml -- pset_guest_security_locked in all three locales
// =============================================================================

const mainLocales = {
  base: res("values/strings.xml"),
  es: res("values-es/strings.xml"),
  fr: res("values-fr/strings.xml"),
};

for (const [locale, xml] of Object.entries(mainLocales)) {
  test(`strings.xml (${locale}) defines pset_guest_security_locked`, () => {
    const strings = stringMap(xml);
    assert.ok("pset_guest_security_locked" in strings, `pset_guest_security_locked missing from ${locale}`);
    assert.ok(strings.pset_guest_security_locked.trim().length > 0, `pset_guest_security_locked in ${locale} must not be empty`);
  });

  test(`strings.xml (${locale}) has no double-hyphen inside an XML comment near the new string`, () => {
    // Scoped to the region around pset_guest_security_locked rather than the
    // whole multi-thousand-line file, so a pre-existing, unrelated violation
    // elsewhere in the file (not this wave's to fix) can't hide this wave's
    // own mistake or fail this test for someone else's reason.
    const idx = xml.indexOf("pset_guest_security_locked");
    assert.ok(idx > 0, `pset_guest_security_locked not found in ${locale} to scope the comment check around`);
    const region = xml.slice(Math.max(0, idx - 1200), idx + 200);
    assertNoDoubleHyphenComments(region, `strings.xml (${locale}) near pset_guest_security_locked`);
  });
}
