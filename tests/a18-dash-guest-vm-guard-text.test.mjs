// DEFECTS (this wave), Android side -- covers three of the four owner-flagged
// defects that live in .kt files, not website/dashboard.html:
//
//   2. FenceRunListViewModel.addRun()/duplicateRun() used to refuse a guest
//      by returning with their `onCreated` callback never invoked at all --
//      no error, no navigation, no explanation for whatever was waiting on
//      it. Fixed to emit on a new `message` SharedFlow instead (see that
//      file's own KDoc for why `onCreated` itself could not honestly carry
//      the signal).
//   3. CrewJobViewModel.deleteTimeEntry() was dead code with no caller
//      anywhere in the app -- a delete function sitting in a crew-facing
//      view model, against this project's own "crew can never delete
//      anything" rule. Deleted outright.
//   4. GuestReadOnlyTest's own `the read-only promise the guest banner shows
//      still exists` test claimed, by name, to pin a "read-only" promise
//      while its body only ever checked that a string resource is non-blank
//      -- and Section 4's own comment says that string was deliberately
//      reworded to NOT claim read-only outright. Renamed to what it checks.
//
// Why this file exists, in Node, instead of only in GuestReadOnlyTest.kt
// itself: this task's hard rules forbid running `gradlew` (the working tree
// is shared with other agents mid-edit, and a Gradle invocation compiles the
// whole app). GuestReadOnlyTest.kt's own checks for #2 are pure TEXT
// operations over the .kt source -- matching braces, extracting a named
// function's body, asking whether a literal guard string opens it -- with
// nothing in their *implementation* that is actually Kotlin-specific. The
// helpers below are a faithful line-for-line port of GuestReadOnlyTest.kt's
// own matchingClose/functionBody/opensWith/block/count, run against the same
// real .kt source files, so the claims here can actually be executed and
// re-run (`node tests/a18-dash-guest-vm-guard-text.test.mjs`) without a JVM
// or Gradle. This is NOT a substitute for `gradlew test` actually compiling
// and running GuestReadOnlyTest.kt -- that still has to happen once a build
// is possible again -- it is a stand-in that proves the same text-level
// claims against the same source, with the same algorithm, in the meantime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP_ROOT = "app/src/main/java/com/fenceestimator/app";
const TEST_ROOT = "app/src/test/java/com/fenceestimator/app";
const src = (rel) => readFileSync(`${APP_ROOT}/${rel}`, "utf8");

// ---- ported from GuestReadOnlyTest.kt (matchingClose/functionBody/opensWith/block/count) ----

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
  const sig = new RegExp("(private |internal |protected )?(suspend )?fun\\s+" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\(");
  const m = sig.exec(text.slice(from));
  if (!m) throw new Error("the gate I was checking for is gone or was renamed: function " + name + " not found");
  const sigStart = from + m.index;
  const parenOpen = sigStart + m[0].length - 1;
  const parenClose = matchingClose(text, parenOpen, "(", ")");
  if (parenClose < 0) throw new Error("unbalanced parens in the signature of " + name);
  const braceOpen = text.indexOf("{", parenClose);
  if (braceOpen < 0) throw new Error("no body follows the signature of " + name);
  const braceClose = matchingClose(text, braceOpen, "{", "}");
  if (braceClose < 0) throw new Error("unbalanced braces in the body of " + name);
  return text.slice(sigStart, braceClose + 1);
}

function realBodyOpenBrace(body) {
  const sig = /fun\s+\w+\s*\(/;
  const m = sig.exec(body);
  if (!m) throw new Error("opensWith could not find a `fun name(` signature");
  const parenOpen = m.index + m[0].length - 1;
  const parenClose = matchingClose(body, parenOpen, "(", ")");
  if (parenClose < 0) throw new Error("opensWith could not match the parameter list's closing paren");
  const braceOpen = body.indexOf("{", parenClose);
  if (braceOpen < 0) throw new Error("opensWith could not find a body brace after the signature");
  return braceOpen;
}

function opensWith(body, guardExpr) {
  const open = realBodyOpenBrace(body);
  const rest = body.slice(open + 1).split("\n").map((l) => l.trim());
  const first = rest.find((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*"));
  if (first === undefined) return false;
  return first.startsWith(guardExpr);
}

function block(text, marker, what, from = 0) {
  const start = text.indexOf(marker, from);
  if (start < 0) throw new Error("the gate I was checking for is gone or was renamed: " + what + " (looked for: `" + marker + "`)");
  const open = start + marker.length - 1;
  if (text[open] !== "{") throw new Error("marker for " + what + " must end in the block's own `{`: `" + marker + "`");
  const close = matchingClose(text, open, "{", "}");
  if (close < 0) throw new Error("unbalanced braces after " + what);
  return text.slice(start, close + 1);
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

// =============================================================================
// DEFECT 2 -- FenceRunListViewModel: guard refuses AND tells the caller something
// =============================================================================

const guardMarker = "if (session.state.value.isGuestDemo) {";
const fenceRunListWriteFunnel = ["addRun", "duplicateRun"];

test("FenceRunListViewModel's addRun/duplicateRun refuse a guest and surface something instead of silently swallowing the callback", () => {
  const text = src("ui/runs/FenceRunListViewModel.kt");
  assert.ok(text.includes("session: SessionManager"));
  for (const name of fenceRunListWriteFunnel) {
    const body = functionBody(text, name);
    assert.ok(opensWith(body, guardMarker), `${name} must open with the block-style guest guard`);
    const guardBlock = block(body, guardMarker, name);
    assert.ok(guardBlock.includes("return"), `${name}'s guard must still refuse (return)`);
    assert.ok(
      guardBlock.includes("_message.tryEmit("),
      `${name}'s guard must surface something on refusal -- this is the fix for the silent-callback defect`
    );
  }
});

test("PLANTED FAILURE: the pre-fix single-line guard shape surfaces nothing on refusal", () => {
  // Reconstructs exactly what FenceRunListViewModel.kt carried before this
  // wave: `if (session.state.value.isGuestDemo) return` with nothing else.
  const preFixAddRun = `fun addRun(\n        onCreated: (Long) -> Unit\n    ) {\n        if (session.state.value.isGuestDemo) return\n        viewModelScope.launch { onCreated(1L) }\n    }`;
  assert.ok(opensWith(preFixAddRun, "if (session.state.value.isGuestDemo) return"), "sanity: the pre-fix shape really does open with the bare guard");
  assert.ok(!opensWith(preFixAddRun, guardMarker), "sanity: the pre-fix shape has no block-style guard at all");
  assert.ok(!preFixAddRun.includes("_message.tryEmit("), "the bug: the pre-fix shape surfaces nothing on refusal");
});

test("DEFECT 3: CrewJobViewModel has no delete-time-entry function left, and nothing in the app calls one on it", () => {
  const vmText = src("ui/crew/CrewJobViewModel.kt");
  assert.ok(
    !/fun\s+deleteTimeEntry\s*\(/.test(vmText),
    "CrewJobViewModel must not define a delete-time-entry function -- crew can never delete anything, and this one had no caller"
  );
  const screenText = src("ui/crew/CrewJobScreen.kt");
  assert.ok(
    !screenText.includes("deleteTimeEntry"),
    "CrewJobScreen (the only screen built on this view model) must not reference deleteTimeEntry either"
  );
  // Repository.deleteTimeEntry (the DATA-layer function, a different thing --
  // still legitimately used by TimeApprovalViewModel.discardBlocked for a
  // permanently-blocked sync row) must be untouched by this deletion.
  const repoText = readFileSync(`${APP_ROOT}/data/Repository.kt`, "utf8");
  assert.ok(repoText.includes("suspend fun deleteTimeEntry(entry: TimeEntry)"), "sanity: Repository.deleteTimeEntry itself must still exist");
});

// =============================================================================
// DEFECT 4 -- the renamed test in GuestReadOnlyTest.kt
// =============================================================================

test("DEFECT 4: GuestReadOnlyTest no longer has a test named for a read-only promise its body does not check", () => {
  const testText = readFileSync(`${TEST_ROOT}/guest/GuestReadOnlyTest.kt`, "utf8");
  assert.ok(
    !testText.includes("`the read-only promise the guest banner shows still exists`"),
    "the old, overstating name must be gone"
  );
  assert.ok(
    testText.includes("`the guest banner's explain string exists and is not blank`"),
    "the renamed test must describe exactly what its body checks"
  );
  // The renamed test's body is unchanged -- still only existence + non-blank
  // -- so the rename is honest (a narrower name for the same check), not a
  // cover for also narrowing the check itself.
  const nameIdx = testText.indexOf("fun `the guest banner's explain string exists and is not blank`");
  assert.ok(nameIdx >= 0);
  const braceIdx = testText.indexOf("{", nameIdx);
  const bodyText = block(testText, "{", "renamed test body", braceIdx);
  assert.ok(bodyText.includes("isNotBlank()"), "sanity: the renamed test still only asserts non-blank, nothing about read-only wording");
});
