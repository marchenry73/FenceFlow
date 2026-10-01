// A guest demo must give back the phone's theme and language.
//
// WHAT THIS IS. A visitor may change the theme and language while trying the product, and both are
// stored on the handset (SettingsStore, the "business_settings" DataStore), not in the sample company
// the demo wipe deletes -- so they used to stay changed after the demo ended. SettingsStore now keeps
// the phone's original pair in the same write that starts the countdown and gives it back in the same
// write that ends it.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. It is plain text analysis of the real Kotlin source, run with
// `node --test tests/a25-prefs-guest-demo-restore.test.mjs` -- no JVM, no Gradle. It proves WIRING:
// which functions write which keys, that the three ways a demo ends all reach the give-back, that the
// guards of the wipe are still where they were, and that no new caller can start or end a demo, or
// write the countdown, around them. It does NOT execute the give-back. The behaviour itself -- change
// during a demo, end it each way, the originals are back; no copy means nothing is written -- is
// app/src/test/java/com/fenceestimator/app/guest/GuestPrefsRestoreTest.kt, which runs the real bodies of
// SettingsStore's functions on a plain MutablePreferences.
//
// Every check below is a function of source text, so each is run twice: on the real source, where it
// must pass (a check that always throws would otherwise look like a check with teeth), and on a copy
// with the one regression it exists to catch planted in it, where it must throw.
//
// Comments are removed before anything is looked for. A sentence that talks ABOUT a call is not the call
// -- this repo has been told a correct function was broken, and a broken one correct, by a search that
// read comments and labels as code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const APP = "app/src/main/java/com/fenceestimator/app";
const read = (rel) => readFileSync(`${APP}/${rel}`, "utf8");

// ----------------------------------------------------------------------------------------------
// Kotlin source scrubbing: comments -> spaces (newlines kept), so every index means the same thing in
// the raw text, the comment-free `code`, and the `skeleton` (which additionally blanks string contents,
// so a brace inside "{customerName}" is not counted as a block).
// ----------------------------------------------------------------------------------------------
const scrubbed = new Map();
function scrub(text) {
  // The tree scan runs once per check and once per planted failure; the same 500 files each time.
  if (!scrubbed.has(text)) scrubbed.set(text, scrubOnce(text));
  return scrubbed.get(text);
}

function scrubOnce(text) {
  let code = "";
  let skel = "";
  const put = (c, s) => { code += c; skel += s; };
  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") { put(" ", " "); i++; }
    } else if (c === "/" && d === "*") {
      let depth = 0;
      while (i < n) {
        if (text[i] === "/" && text[i + 1] === "*") { depth++; put("  ", "  "); i += 2; }
        else if (text[i] === "*" && text[i + 1] === "/") { depth--; put("  ", "  "); i += 2; if (depth === 0) break; }
        else { put(blank(text[i]), blank(text[i])); i++; }
      }
    } else if (text.startsWith('"""', i)) {
      put('"""', '"""'); i += 3;
      while (i < n && !text.startsWith('"""', i)) { put(text[i], blank(text[i])); i++; }
      if (i < n) { put('"""', '"""'); i += 3; }
    } else if (c === '"') {
      put('"', '"'); i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) { put(text[i] + text[i + 1], "  "); i += 2; }
        else { put(text[i], blank(text[i])); i++; }
      }
      if (i < n) { put('"', '"'); i++; }
    } else if (c === "'") {
      // a Kotlin char literal: 'x' or '\n' -- consumed whole so a quoted brace is not a brace
      let j = i + 1;
      if (text[j] === "\\") j += 2; else j += 1;
      if (text[j] === "'") { put(text.slice(i, j + 1), " ".repeat(j + 1 - i)); i = j + 1; }
      else { put(c, c); i++; }
    } else {
      put(c, c); i++;
    }
  }
  return { code, skel };
}

function matching(skel, open, openCh, closeCh) {
  let depth = 0;
  for (let i = open; i < skel.length; i++) {
    if (skel[i] === openCh) depth++;
    else if (skel[i] === closeCh) { depth--; if (depth === 0) return i; }
  }
  throw new Error(`unbalanced ${openCh}${closeCh} from index ${open}`);
}

/** The body of the one function whose header matches `header` (a string), header included. */
function fun(src, header) {
  const { code, skel } = scrub(src);
  const at = skel.indexOf(header);
  if (at < 0) throw new Error(`function is gone or was renamed: ${header}`);
  if (skel.indexOf(header, at + 1) >= 0) throw new Error(`function header is not unique: ${header}`);
  const paren = skel.indexOf("(", at + header.length - 1);
  const parenClose = matching(skel, paren, "(", ")");
  const brace = skel.indexOf("{", parenClose);
  if (brace < 0) throw new Error(`no block body follows ${header}`);
  const end = matching(skel, brace, "{", "}");
  return { code: code.slice(at, end + 1), skel: skel.slice(at, end + 1), bodyCode: code.slice(brace + 1, end), bodySkel: skel.slice(brace + 1, end) };
}

/** The `{ ... }` block that follows the first occurrence of `head` inside a function. */
function block(f, head) {
  const at = f.skel.indexOf(head);
  if (at < 0) throw new Error(`block head not found: ${head}`);
  const brace = f.skel.indexOf("{", at);
  const end = matching(f.skel, brace, "{", "}");
  return { start: at, open: brace, end, code: f.code.slice(brace, end + 1) };
}

const squash = (s) => s.replace(/\s+/g, " ").trim();
const count = (text, re) => (text.match(re) ?? []).length;
const inOrder = (text, ...needles) => {
  let last = -1;
  for (const nd of needles) {
    const at = text.indexOf(nd, last + 1);
    if (at < 0) throw new Error(`missing, or out of order: ${nd}`);
    last = at;
  }
};

// ----------------------------------------------------------------------------------------------
// The checks. Each takes source text and throws if the wiring is not what the fix needs.
// ----------------------------------------------------------------------------------------------

/** startGuestSession / endGuestSession / clearAll are each ONE dataStore edit running the tested body. */
function checkStoreEntryPoints(store) {
  const rows = [
    ["suspend fun startGuestSession(", "beginDemoPrefs(it, startedAtMillis)"],
    ["suspend fun endGuestSession(", "endDemoPrefs(it)"],
    ["suspend fun clearAll(", "clearAllPrefs(it)"],
  ];
  for (const [header, callee] of rows) {
    const f = fun(store, header);
    assert.ok(squash(f.bodyCode).includes(callee), `${header} no longer runs ${callee}`);
    assert.equal(count(f.bodyCode, /dataStore\s*\.\s*edit/g), 1,
      `${header} must be a single dataStore edit -- two edits are two writes, and a kill between them strands the copy`);
    assert.ok(!f.bodyCode.includes("GUEST_SESSION_STARTED_AT"),
      `${header} writes the countdown itself instead of through the tested body`);
  }
}

/** The countdown key has exactly two writers, and each of them handles the copy. The copy marker has one. */
function checkFlagWriters(store) {
  const { code } = scrub(store);
  const flagWrites = count(code, /\[\s*Keys\.GUEST_SESSION_STARTED_AT\s*\]\s*=(?!=)/g);
  assert.equal(flagWrites, 2, `the countdown key is written ${flagWrites} times; it must be exactly beginDemoPrefs and endDemoPrefs`);
  const begin = fun(store, "internal fun beginDemoPrefs(");
  const end = fun(store, "internal fun endDemoPrefs(");
  assert.equal(count(begin.bodyCode, /\[\s*Keys\.GUEST_SESSION_STARTED_AT\s*\]\s*=(?!=)/g), 1, "beginDemoPrefs must write the countdown");
  assert.equal(count(end.bodyCode, /\[\s*Keys\.GUEST_SESSION_STARTED_AT\s*\]\s*=(?!=)/g), 1, "endDemoPrefs must write the countdown");
  assert.equal(count(code, /\[\s*Keys\.DEMO_PREV_TAKEN\s*\]\s*=(?!=)/g), 1, "the copy marker must be written in exactly one place: beginDemoPrefs");
  assert.equal(count(begin.bodyCode, /\[\s*Keys\.DEMO_PREV_TAKEN\s*\]\s*=(?!=)/g), 1);
}

/** The copy is taken only on the way from no demo to a demo, and only when the demo really starts. */
function checkBegin(store) {
  const f = fun(store, "internal fun beginDemoPrefs(");
  assert.ok(squash(f.bodyCode).includes("val running = (prefs[Keys.GUEST_SESSION_STARTED_AT] ?: 0L) != 0L"),
    "beginDemoPrefs no longer reads whether a demo is already running");
  const guard = block(f, "if (!running && startedAtMillis != 0L)");
  assert.ok(guard.code.includes("DEMO_PREV_TAKEN"), "the copy marker is written outside the not-already-running guard");
  assert.ok(guard.code.includes("Keys.THEME_MODE, Keys.DEMO_PREV_THEME"), "the theme copy is written outside the guard, or from the wrong key");
  assert.ok(guard.code.includes("Keys.LANGUAGE, Keys.DEMO_PREV_LANGUAGE"), "the language copy is written outside the guard, or from the wrong key");
  const after = f.code.slice(f.code.indexOf("{", guard.open) + guard.end - guard.open + 1);
  assert.ok(after.includes("GUEST_SESSION_STARTED_AT"), "the countdown must be written after the guarded copy, in the same function");
}

/** Giving back: spent in the same edit, and a no-op with no copy. */
function checkEnd(store) {
  const end = fun(store, "internal fun endDemoPrefs(");
  inOrder(end.bodyCode, "giveBackDemoPrefs(prefs)", "Keys.GUEST_SESSION_STARTED_AT");
  const give = fun(store, "private fun giveBackDemoPrefs(");
  assert.ok(squash(give.bodyCode).startsWith("if (prefs[Keys.DEMO_PREV_TAKEN] != true) return"),
    "giveBackDemoPrefs must return first when there is no copy -- with none, theme and language must not be written");
  for (const k of ["DEMO_PREV_TAKEN", "DEMO_PREV_THEME", "DEMO_PREV_LANGUAGE"]) {
    assert.ok(give.bodyCode.includes(`prefs.remove(Keys.${k})`), `the copy is not spent: ${k} is never removed`);
  }
  inOrder(give.bodyCode, "Keys.DEMO_PREV_THEME, Keys.THEME_MODE", "Keys.DEMO_PREV_LANGUAGE, Keys.LANGUAGE", "prefs.remove(Keys.DEMO_PREV_TAKEN)");
}

/** The account-change wipe reads the copy before it clears, and puts it back only if there was one. */
function checkClearAll(store) {
  const f = fun(store, "internal fun clearAllPrefs(");
  inOrder(f.bodyCode, "prefs[Keys.DEMO_PREV_TAKEN] == true", "prefs[Keys.DEMO_PREV_THEME]", "prefs[Keys.DEMO_PREV_LANGUAGE]", "prefs.clear()");
  const restore = block(f, "if (hadCopy)");
  assert.ok(restore.start > f.skel.indexOf("prefs.clear()"), "the give-back must come after the clear, or the clear deletes it");
  assert.ok(restore.code.includes("Keys.THEME_MODE") && restore.code.includes("Keys.LANGUAGE"));
  assert.ok(squash(f.bodyCode).includes("lastEmail?.let { prefs[Keys.LAST_SIGN_IN_EMAIL] = it }"), "the remembered sign-in address no longer survives the wipe");
}

/** A whole-profile save cannot write the countdown or the copy, and a cloud save cannot write the four device choices. */
function checkWriteProfile(store) {
  const f = fun(store, "internal fun writeProfile(");
  assert.ok(!f.bodyCode.includes("GUEST_SESSION_STARTED_AT"), "writeProfile writes the countdown from a profile that may be a moment old");
  assert.ok(!f.bodyCode.includes("DEMO_PREV"), "writeProfile touches the demo's copy");
  const gate = block(f, "if (!fromCloud)");
  for (const k of ["THEME_MODE", "LANGUAGE", "AUTO_LOCK_MINUTES", "BIOMETRIC_UNLOCK"]) {
    const inside = gate.code.includes(`Keys.${k}]`);
    const everywhere = count(f.bodyCode, new RegExp(`Keys\\.${k}\\]\\s*=`, "g"));
    assert.ok(inside, `${k} is not written inside the not-from-cloud block`);
    assert.equal(everywhere, 1, `${k} is written outside the not-from-cloud block as well`);
  }
  const save = fun(store, "suspend fun save(");
  assert.ok(squash(save.bodyCode).includes("writeProfile(it, toWrite, fromCloud = !stamp)"),
    "save no longer passes stamp = false through as 'came from the cloud'");
}

/** GuestWipe: the guards are where they were, every way in reaches clearDemo, and clearDemo keeps its order. */
function checkWipe(wipe) {
  const due = fun(wipe, "suspend fun wipeIfDue(");
  assert.ok(squash(due.bodyCode).startsWith("if (session.state.value.signedIn) return false"),
    "the signed-in guard is no longer the FIRST statement of wipeIfDue");
  inOrder(due.bodyCode, "session.state.value.signedIn", "settingsStore.profile.first()", "GuestSession.isActive(profile)", "GuestSession.isExpired(profile)", "clearDemo(");

  const onSignIn = fun(wipe, "suspend fun wipeOnSignIn(");
  inOrder(onSignIn.bodyCode, "settingsStore.profile.first()", "GuestSession.isActive(profile)", "clearDemo(");
  assert.ok(!onSignIn.bodyCode.includes("signedIn"), "wipeOnSignIn checks signed-in; being signed in is the reason it runs");
  assert.ok(!onSignIn.bodyCode.includes("isExpired"), "wipeOnSignIn waits for the clock; a real sign-in ends the demo whenever it happens");

  const clear = fun(wipe, "private suspend fun clearDemo(");
  inOrder(clear.bodyCode, "repository.deleteJobLocallyOnly(", "settingsStore.endGuestSession()", "dataOwnership.onGuestDemoEnded()");
  // Once each. A second call placed before the rows would satisfy the ordering above by accident.
  assert.equal(count(clear.bodyCode, /settingsStore\s*\.\s*endGuestSession\s*\(/g), 1, "clearDemo must end the countdown exactly once");
  assert.equal(count(clear.bodyCode, /repository\s*\.\s*deleteJobLocallyOnly\s*\(/g), 1, "clearDemo must delete the rows in exactly one place");
  assert.equal(count(clear.bodyCode, /dataOwnership\s*\.\s*onGuestDemoEnded\s*\(/g), 1, "clearDemo must release the demo stamp exactly once");
  assert.ok(!scrub(wipe).code.includes("clearAll("), "GuestWipe calls clearAll; ending a demo must not wipe the phone's settings");
}

// ---- the whole tree -----------------------------------------------------------------------------
function walk(dir, out = {}) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".kt")) out[p.replaceAll("\\", "/")] = readFileSync(p, "utf8");
  }
  return out;
}
const codeOf = (tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, scrub(v).code]));
const filesMatching = (tree, re) => Object.entries(tree).filter(([, c]) => re.test(c)).map(([k]) => basename(k)).sort();

/**
 * Every way a demo can start, end, or have its countdown written, and every writer of the two choices,
 * named -- so a NEW one fails here instead of quietly going around the copy.
 */
function checkCallers(tree) {
  const code = codeOf(tree);
  assert.deepEqual(filesMatching(code, /\.\s*endGuestSession\s*\(/), ["GuestWipe.kt"],
    "something other than the wipe now ends a demo -- it would not go through the ordered clearDemo");
  assert.deepEqual(filesMatching(code, /\.\s*startGuestSession\s*\(/), ["MainActivity.kt"],
    "something other than the welcome screen now starts a demo");
  assert.deepEqual(filesMatching(code, /\bsettingsStore\??\.\s*clearAll\s*\(\s*\)/), ["DataOwnership.kt"],
    "another caller now wipes every setting; it must be one that reaches clearAllPrefs deliberately");
  // The raw key strings (not comments): who can touch the countdown and the two choices at all.
  assert.deepEqual(filesMatching(code, /"guest_session_started_at"/), ["SettingsStore.kt"]);
  assert.deepEqual(filesMatching(code, /"theme_mode"/), ["SettingsStore.kt"]);
  assert.deepEqual(filesMatching(code, /"language"/), ["SettingsStore.kt"]);
  assert.deepEqual(filesMatching(code, /"business_settings"/), ["SettingsStore.kt"],
    "another class opens the same DataStore file and could write around SettingsStore");
  // Whole-profile saves: the cloud pull says stamp = false, which is what stops it writing the four device choices.
  const saves = Object.entries(code).flatMap(([k, c]) =>
    [...c.matchAll(/\b(?:settingsStore|store)\s*\.\s*save\s*\(([^;\n]*)\)/g)].map((m) => [basename(k), m[1]]));
  const summary = saves.map(([f, a]) => `${f}:${/stamp\s*=\s*false/.test(a) ? "cloud" : "person"}`).sort();
  assert.deepEqual(summary, ["SettingsSync.kt:cloud", "SettingsSync.kt:cloud", "SettingsViewModel.kt:person"],
    `the callers of SettingsStore.save changed: ${summary.join(", ")}. A write that came from the cloud must say stamp = false`);
}

/** Restoring the language recomposes the UI in place; nothing restarts the Activity. */
function checkLanguageRecomposes(main, locale, tree) {
  const m = scrub(main).code;
  assert.ok(count(m, /WithAppLanguage\(\s*profile\.language\s*\)/g) >= 2, "MainActivity no longer drives WithAppLanguage from profile.language");
  assert.ok(/val profile by app\.settingsStore\.profile\.collectAsState\(/.test(m), "MainActivity no longer reads the language from the settings flow");
  const l = scrub(locale).code;
  assert.ok(/remember\(\s*context\s*,\s*language\s*,\s*configuration\s*\)/.test(l), "the localized context is no longer keyed on the language");
  // The one recreate() in the app is MainActivity.onRestart, for the "finishing an update" screen only.
  // Nothing on the settings or guest path restarts the Activity or sets an application locale.
  const restarts = filesMatching(codeOf(tree), /\brecreate\s*\(|setApplicationLocales\s*\(/);
  assert.deepEqual(restarts, ["MainActivity.kt"],
    "something other than MainActivity's update-settling restart recreates the Activity or sets an application locale: " + restarts.join(", "));
  assert.equal(count(m, /\brecreate\s*\(/g), 1, "MainActivity recreates the Activity in more than the one place it used to");
  assert.equal(count(m, /setApplicationLocales\s*\(/g), 0);
  const restart = fun(main, "override fun onRestart(");
  inOrder(restart.bodyCode, "if (settling", "recreate()");
}

function checkKeyNamesInSync(store, kotlinTest) {
  for (const name of ["guest_demo_prev_taken", "guest_demo_prev_theme_mode", "guest_demo_prev_language"]) {
    assert.ok(store.includes(`"${name}"`), `SettingsStore no longer declares ${name}`);
    assert.ok(kotlinTest.includes(`"${name}"`), `GuestPrefsRestoreTest spells a different key than SettingsStore for ${name}`);
  }
}

// ----------------------------------------------------------------------------------------------
// The real sources.
// ----------------------------------------------------------------------------------------------
const store = read("data/SettingsStore.kt");
const wipe = read("guest/GuestWipe.kt");
const main = read("MainActivity.kt");
const locale = read("ui/components/AppLocale.kt");
const tree = walk("app/src/main/java");
const kotlinTest = readFileSync("app/src/test/java/com/fenceestimator/app/guest/GuestPrefsRestoreTest.kt", "utf8");

/** Replace `from` with `to` in `text`, insisting `from` occurs exactly once, so a planted failure is the one intended. */
function plant(text, from, to) {
  const i = text.indexOf(from);
  assert.ok(i >= 0, `planted-failure anchor not found (the source moved; update the plant): ${from.slice(0, 60)}`);
  assert.equal(text.indexOf(from, i + 1), -1, `planted-failure anchor is not unique: ${from.slice(0, 60)}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

const cases = [
  {
    name: "the three store entry points are each one edit running the tested body",
    real: () => checkStoreEntryPoints(store),
    planted: [
      ["endGuestSession goes back to writing only the flag", () => checkStoreEntryPoints(plant(store, "context.dataStore.edit { endDemoPrefs(it) }", "context.dataStore.edit { it[Keys.GUEST_SESSION_STARTED_AT] = 0L }"))],
      ["startGuestSession stops taking the copy", () => checkStoreEntryPoints(plant(store, "context.dataStore.edit { beginDemoPrefs(it, startedAtMillis) }", "context.dataStore.edit { it[Keys.GUEST_SESSION_STARTED_AT] = startedAtMillis }"))],
      ["clearAll goes back to clearing without the give-back", () => checkStoreEntryPoints(plant(store, "context.dataStore.edit { clearAllPrefs(it) }", "context.dataStore.edit { it.clear() }"))],
      ["endGuestSession becomes two edits", () => checkStoreEntryPoints(plant(store, "context.dataStore.edit { endDemoPrefs(it) }", "context.dataStore.edit { endDemoPrefs(it) }\n        context.dataStore.edit { }"))],
    ],
  },
  {
    name: "the countdown has exactly two writers and the copy marker one",
    real: () => checkFlagWriters(store),
    planted: [
      ["a third place writes the countdown", () => checkFlagWriters(plant(store, "prefs[Keys.SQUARE_LOCATION] = profile.squareLocationId", "prefs[Keys.SQUARE_LOCATION] = profile.squareLocationId\n            prefs[Keys.GUEST_SESSION_STARTED_AT] = profile.guestSessionStartedAt"))],
    ],
  },
  {
    name: "the copy is taken only on the way from no demo to a demo",
    real: () => checkBegin(store),
    planted: [
      ["begin copies again while a demo is running", () => checkBegin(plant(store, "if (!running && startedAtMillis != 0L) {", "if (startedAtMillis != 0L) {"))],
      ["begin copies on a zero start", () => checkBegin(plant(store, "if (!running && startedAtMillis != 0L) {", "if (!running) {"))],
      ["begin copies the language over the theme copy", () => checkBegin(plant(store, "copyOrForget(prefs, Keys.THEME_MODE, Keys.DEMO_PREV_THEME)", "copyOrForget(prefs, Keys.LANGUAGE, Keys.DEMO_PREV_THEME)"))],
    ],
  },
  {
    name: "giving back is spent in the same edit and does nothing without a copy",
    real: () => checkEnd(store),
    planted: [
      ["give-back loses its no-copy guard", () => checkEnd(plant(store, "            if (prefs[Keys.DEMO_PREV_TAKEN] != true) return\n", ""))],
      ["the copy is not spent", () => checkEnd(plant(store, "            prefs.remove(Keys.DEMO_PREV_TAKEN)\n", ""))],
      ["end clears the countdown before giving back", () => checkEnd(plant(store, "            giveBackDemoPrefs(prefs)\n            prefs[Keys.GUEST_SESSION_STARTED_AT] = 0L", "            prefs[Keys.GUEST_SESSION_STARTED_AT] = 0L\n            giveBackDemoPrefs(prefs)"))],
    ],
  },
  {
    name: "the account-change wipe reads the copy before clearing and gives back only if there was one",
    real: () => checkClearAll(store),
    planted: [
      ["the copy is read after the clear", () => checkClearAll(plant(store, "            val hadCopy = prefs[Keys.DEMO_PREV_TAKEN] == true\n", "").replace("            prefs.clear()\n", "            prefs.clear()\n            val hadCopy = prefs[Keys.DEMO_PREV_TAKEN] == true\n"))],
      ["the wipe gives back unconditionally", () => checkClearAll(plant(store, "if (hadCopy) {", "if (true) {"))],
      ["the wipe forgets the remembered address", () => checkClearAll(plant(store, "            lastEmail?.let { prefs[Keys.LAST_SIGN_IN_EMAIL] = it }\n            if (hadCopy)", "            if (hadCopy)"))],
    ],
  },
  {
    name: "a whole-profile save cannot write the countdown, and a cloud save cannot write the four device choices",
    real: () => checkWriteProfile(store),
    planted: [
      ["save writes the countdown again", () => checkWriteProfile(plant(store, "prefs[Keys.SQUARE_LOCATION] = profile.squareLocationId", "prefs[Keys.SQUARE_LOCATION] = profile.squareLocationId\n            prefs[Keys.GUEST_SESSION_STARTED_AT] = profile.guestSessionStartedAt"))],
      ["a cloud save writes the four", () => checkWriteProfile(plant(store, "if (!fromCloud) {", "if (true) {"))],
      ["theme is written outside the gate too", () => checkWriteProfile(plant(store, "prefs[Keys.SQUARE_LOCATION] = profile.squareLocationId", "prefs[Keys.SQUARE_LOCATION] = profile.squareLocationId\n            prefs[Keys.THEME_MODE] = profile.themeMode.name"))],
      ["save stops passing stamp as 'from the cloud'", () => checkWriteProfile(plant(store, "fromCloud = !stamp", "fromCloud = false"))],
    ],
  },
  {
    name: "GuestWipe keeps its guards, its order, and reaches the give-back from both entry points",
    real: () => checkWipe(wipe),
    planted: [
      ["the signed-in guard is no longer first in wipeIfDue", () => checkWipe(plant(wipe, "        if (session.state.value.signedIn) return false\n", "").replace("        val profile = settingsStore.profile.first()\n        if (!GuestSession.isActive(profile)) return false\n        if (!GuestSession.isExpired(profile)) return false", "        val profile = settingsStore.profile.first()\n        if (session.state.value.signedIn) return false\n        if (!GuestSession.isActive(profile)) return false\n        if (!GuestSession.isExpired(profile)) return false"))],
      ["wipeOnSignIn starts waiting for the clock", () => checkWipe(plant(wipe, "        if (!GuestSession.isActive(profile)) return false\n\n        clearDemo(repository, settingsStore, dataOwnership)\n        return true\n    }\n\n    /**\n     * The rows,", "        if (!GuestSession.isActive(profile)) return false\n        if (!GuestSession.isExpired(profile)) return false\n\n        clearDemo(repository, settingsStore, dataOwnership)\n        return true\n    }\n\n    /**\n     * The rows,"))],
      ["clearDemo ends the countdown before the rows", () => checkWipe(plant(wipe, "        val guestJobs = repository.getAllJobs().filter(GuestMarker::isGuestSeeded)\n        guestJobs.forEach { job -> repository.deleteJobLocallyOnly(job) }\n", "        settingsStore.endGuestSession()\n        val guestJobs = repository.getAllJobs().filter(GuestMarker::isGuestSeeded)\n        guestJobs.forEach { job -> repository.deleteJobLocallyOnly(job) }\n"))],
      ["clearDemo stops ending through endGuestSession", () => checkWipe(plant(wipe, "        settingsStore.endGuestSession()\n", "        settingsStore.startGuestSession(0L)\n"))],
      ["GuestWipe starts wiping every setting", () => checkWipe(plant(wipe, "        settingsStore.endGuestSession()\n", "        settingsStore.endGuestSession()\n        settingsStore.clearAll()\n"))],
    ],
  },
  {
    name: "nothing else starts or ends a demo, wipes the settings, or opens the settings file",
    real: () => checkCallers(tree),
    planted: [
      ["a view model ends a demo", () => checkCallers({ ...tree, "app/src/main/java/x/Some.kt": "fun f() { settingsStore.endGuestSession() }" })],
      ["a screen starts a demo", () => checkCallers({ ...tree, "app/src/main/java/x/Some.kt": "fun f() { app.settingsStore.startGuestSession(1L) }" })],
      ["a second wiper of every setting", () => checkCallers({ ...tree, "app/src/main/java/x/Some.kt": "fun f() { settingsStore.clearAll() }" })],
      ["a second file writes the theme key", () => checkCallers({ ...tree, "app/src/main/java/x/Some.kt": 'val k = stringPreferencesKey("theme_mode")' })],
      ["a second cloud-sourced save that forgets stamp = false", () => checkCallers({ ...tree, "app/src/main/java/x/Some.kt": "fun f() { store.save(profile) }" })],
    ],
  },
  {
    name: "restoring the language recomposes in place; nothing restarts the Activity",
    real: () => checkLanguageRecomposes(main, locale, tree),
    planted: [
      ["the language leaves the localized context's key", () => checkLanguageRecomposes(main, plant(locale, "remember(context, language, configuration)", "remember(context, configuration)"), tree)],
      ["a language change starts recreating the Activity", () => checkLanguageRecomposes(main, locale, { ...tree, "app/src/main/java/x/Some.kt": "fun f(a: Activity) { a.recreate() }" })],
      ["MainActivity recreates in a second place", () => checkLanguageRecomposes(plant(main, "            settling = false\n            recreate()", "            settling = false\n            recreate()\n            recreate()"), locale, tree)],
    ],
  },
  {
    name: "the key names in SettingsStore and in the Kotlin test agree",
    real: () => checkKeyNamesInSync(store, kotlinTest),
    planted: [
      ["SettingsStore renames a copy key", () => checkKeyNamesInSync(plant(store, '"guest_demo_prev_theme_mode"', '"guest_demo_previous_theme"'), kotlinTest)],
    ],
  },
];

for (const c of cases) {
  test(`${c.name} -- real source passes`, () => c.real());
  for (const [what, run] of c.planted) {
    test(`${c.name} -- PLANTED FAILURE is caught: ${what}`, () => assert.throws(run, undefined, `the check accepted: ${what}`));
  }
}

// ----------------------------------------------------------------------------------------------
// Claims made in prose elsewhere in the tree, read back against the source so they cannot go stale.
// ----------------------------------------------------------------------------------------------
test("the scrubber itself: a call inside a comment or a string is not a call, and a brace inside a string is not a block", () => {
  const src = 'fun a() { /* x.endGuestSession() */ val s = "{ x.endGuestSession() }" // y.endGuestSession()\n }';
  const { code, skel } = scrub(src);
  assert.equal(count(code, /endGuestSession/g), 1, "only the one inside the string literal survives in `code`");
  assert.equal(count(skel, /endGuestSession/g), 0, "the skeleton blanks string contents too");
  assert.equal(fun(src, "fun a(").bodyCode.trim().startsWith("/*") , false, "the comment is gone from the body");
  assert.equal(skel.length, src.length, "indices must mean the same thing in every view");
});

test("the tree scan really saw the tree", () => {
  const files = Object.keys(tree);
  assert.ok(files.length > 100, `expected the whole app source, saw ${files.length} files`);
  for (const must of ["MainActivity.kt", "DataOwnership.kt", "SettingsSync.kt", "SettingsViewModel.kt", "PersonalSettingsViewModel.kt"]) {
    assert.ok(files.some((f) => f.endsWith("/" + must)), `the scan did not see ${must}`);
  }
});
