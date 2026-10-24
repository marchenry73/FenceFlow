// a94-viewmodel-init-order -- an init block may not start a coroutine that reads a field declared below it.
//
// WHY THIS EXISTS. Commit 83a7097 put restoreDrawingHistory() and persistDrawingHistory() in SurveyViewModel's init
// block at line 344. Both read _undo and _redo, declared at 490 and 493. Kotlin runs property initialisers and init
// blocks in the order they are written, so from that init block both backing fields were still null.
//
// That alone would have been harmless if the launch were posted for later. It was not: viewModelScope is
// SupervisorJob() + Dispatchers.Main.immediate, and HandlerContext.isDispatchNeeded returns false when it is already
// on the main thread, so launch ran its body INLINE inside the constructor and combine(_undo, _redo) dereferenced two
// nulls. The NPE went to the default uncaught handler and killed the process, so the drawing screen could not be
// opened at all by a real user. A guest escaped it (persistDrawingHistory returns early for the demo) and so did the
// crew plan (repriceOnDrawingChange = false), which is exactly why it was invisible.
//
// Nothing caught it. 1428 unit tests were green: no test constructs SurveyViewModel, because doing so needs Android.
// This file does not need Android -- it reads the source and checks the ORDER, which is the whole bug.
//
// WHAT IS PROVEN. For every init block in each view model below: every private backing field (_name) reachable from
// the functions that init calls, to two levels, is declared ABOVE that init block.
//
// WHAT IS NOT PROVEN. That the coroutine actually runs inline -- that is a property of Dispatchers.Main.immediate, not
// of this source. And a field read through an interface or a lambda stored elsewhere is not followed. This checks the
// direct, common shape, which is the one that shipped.
//
//   node --test tests/a94-viewmodel-init-order.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const KT = "app/src/main/java/com/fenceestimator/app/";

// Every view model whose init block starts coroutines. Add to this list rather than writing a new file.
const FILES = [
  KT + "ui/survey/SurveyViewModel.kt",
];

const readRaw = (p) => readFileSync(p, "utf8");

/**
 * Blank out comments, keeping every newline so line numbers still line up.
 *
 * Needed because a KDoc that NAMES a field is not a read of it. The comment
 * above the second init block explains the bug and writes [_undo] and [_redo]
 * in prose; without this, the checker reported the explanation as the thing it
 * was explaining. Strings are blanked for the same reason.
 */
function stripComments(text) {
  let out = "";
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (text[i] === '"') {
      // Skip a string literal (including the triple-quoted form).
      const triple = text.slice(i, i + 3) === '"""';
      const close = triple ? '"""' : '"';
      let j = i + close.length;
      while (j < text.length) {
        if (!triple && text[j] === "\\") { j += 2; continue; }
        if (text.slice(j, j + close.length) === close) break;
        j++;
      }
      const stop = Math.min(text.length, j + close.length);
      out += blank(text.slice(i, stop));
      i = stop;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

const read = (p) => stripComments(readRaw(p));

/** Index of the character after the block opened by the `{` at or after `from`. */
function matchBrace(text, from) {
  const open = text.indexOf("{", from);
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

/** `private val _name = ...` -> line number it is declared on. */
function backingFields(text) {
  const out = new Map();
  const re = /^[ \t]*(?:private |internal |protected )?val (_\w+)\s*[:=]/gm;
  let m;
  while ((m = re.exec(text))) out.set(m[1], lineOf(text, m.index));
  return out;
}

/** Every `init { ... }` block: its line and its body text. */
function initBlocks(text) {
  const out = [];
  const re = /^[ \t]*init\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    const end = matchBrace(text, m.index);
    out.push({ line: lineOf(text, m.index), body: text.slice(m.index, end + 1) });
  }
  return out;
}

/** Body of `private fun name(...)` as text, or null. */
function functionBody(text, name) {
  const re = new RegExp("^[ \\t]*(?:private |internal |protected )?(?:suspend )?fun " + name + "\\s*\\(", "m");
  const m = re.exec(text);
  if (!m) return null;
  const end = matchBrace(text, m.index);
  return end < 0 ? null : text.slice(m.index, end + 1);
}

/**
 * Unqualified calls only: `foo()`, never `something.foo()`.
 *
 * A dotted call is a method on another object, and following it into a
 * same-named function in THIS file invents a path that does not exist. The
 * fields that matter are reached by calling this view model's own functions.
 */
const callsIn = (body) => [...body.matchAll(/(^|[^.\w])([a-z]\w*)\s*\(/g)].map((m) => m[2]);

/**
 * Fields an init block can reach, to two levels of calls. Two is enough for the shape that shipped
 * (init -> persistDrawingHistory -> _undo) with one level of slack, and keeps the walk honest rather
 * than chasing the whole file.
 */
function reachableFields(text, init, fields) {
  const seen = new Set();
  const found = new Map();
  let frontier = [init.body];

  for (let depth = 0; depth < 2 && frontier.length; depth++) {
    const next = [];
    for (const body of frontier) {
      for (const f of body.matchAll(/\b(_\w+)\b/g)) {
        if (fields.has(f[1]) && !found.has(f[1])) found.set(f[1], depth);
      }
      for (const name of callsIn(body)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const b = functionBody(text, name);
        if (b) next.push(b);
      }
    }
    frontier = next;
  }
  return found;
}

/** Every violation: a field read from an init block but declared after it. */
function violations(text) {
  const fields = backingFields(text);
  const out = [];
  for (const init of initBlocks(text)) {
    for (const [name] of reachableFields(text, init, fields)) {
      const declared = fields.get(name);
      if (declared > init.line) {
        out.push(`init at line ${init.line} reaches ${name}, declared at line ${declared}`);
      }
    }
  }
  return out;
}

test("no init block reads a backing field declared below it", () => {
  for (const file of FILES) {
    assert.deepEqual(violations(read(file)), [], file);
  }
});

test("the check can fail: the shipped bug is detected when put back", () => {
  const text = read(FILES[0]);

  // Put the two history calls back in the FIRST init block, which is what 83a7097 did and what
  // crashed the screen. Anchored on the comment that replaced them, so this sabotage cannot
  // silently stop applying.
  const anchor = "        if (repriceOnDrawingChange) {\n            watchDrawingForRepricing()\n        }";
  assert.equal(
    text.split(anchor).length, 2,
    "sabotage anchor must appear exactly once -- the first init block's body changed shape"
  );
  const broken = text.replace(
    anchor,
    "        if (repriceOnDrawingChange) {\n            watchDrawingForRepricing()\n" +
    "            restoreDrawingHistory()\n            persistDrawingHistory()\n        }"
  );

  const found = violations(broken);
  assert.ok(found.length > 0, "sabotaged source must report a violation, got none");
  assert.ok(
    found.some((v) => /_timeline/.test(v)),
    "the violation must name _timeline, got: " + JSON.stringify(found)
  );
});

test("the parser actually finds the things it claims to", () => {
  const text = read(FILES[0]);

  // A parser that finds nothing would pass the first test for the wrong reason.
  const fields = backingFields(text);
  assert.ok(fields.has("_timeline"), "_timeline not found by the field parser");
  // ONE field now, not two: the per-run undo and redo stacks became one timeline.

  const inits = initBlocks(text);
  assert.ok(inits.length >= 2, "expected at least two init blocks, found " + inits.length);

  // And the second init must genuinely sit below the two declarations it reads.
  const second = inits[inits.length - 1];
  assert.ok(second.line > fields.get("_timeline"), "the history init block is no longer below _timeline");
  // (the redo stack is gone; _timeline above covers both halves)
  assert.ok(
    /restoreDrawingHistory\(\)/.test(second.body) && /persistDrawingHistory\(\)/.test(second.body),
    "the history init block no longer starts the history"
  );
});
