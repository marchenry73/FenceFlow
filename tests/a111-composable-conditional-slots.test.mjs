// A111 -- a composable that uses slots must never hang off `?.` or `?:`.
//
// Run with:  node --test tests/a111-composable-conditional-slots.test.mjs
//
// WHAT THIS IS ABOUT. The only live crash in the product for five months was
// one line of JobsListScreen.kt:
//
//     val crewAttentionItems = crewAttentionViewModel?.items?.collectAsState()?.value.orEmpty()
//
// collectAsState() is a composable and it uses slots (produceState -> remember
// + LaunchedEffect). A safe-call chain is NOT a conditional the Compose
// compiler wraps in a group, so that call simply happened or did not, with
// nothing enclosing the slots it took. session.role resolves a moment after
// this screen first composes, isCrewRole flips, and every slot after that
// point shifts. The next remembered composable lambda then read a slot
// belonging to something else and the app died:
//
//     java.lang.ClassCastException: r4.j cannot be cast to c0.a
//     kotlin.coroutines.EmptyCoroutineContext cannot be cast to
//     androidx.compose.runtime.internal.ComposableLambdaImpl
//
// Fatal, on the jobs list, seven reports across 1.519, 1.532, 1.577 and 1.687.
//
// WHY ONLY SLOT-USING COMPOSABLES. `x ?: stringResource(R.string.foo)` appears
// twenty-odd times in this app and is fine: stringResource reads composition
// locals and takes no slots, so calling it or not changes nothing about the
// slot table. The property that matters is whether the call CONSUMES SLOTS, not
// whether it is composable -- so the list below is deliberately a list of
// slot-users, and widening it to "anything composable" would go red on
// correct code.
//
// Source checks: Kotlin is not compiled here. Each is paired with a canary that
// sabotages a copy and asserts the check would have gone red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../app/src/main/java/com/fenceestimator/app", import.meta.url));
const SCREEN = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobsListScreen.kt";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

/** Source with comments blanked, string literals left alone. */
function stripComments(src) {
  let out = "";
  let i = 0;
  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        if (src[i] === "\n") { i++; break; }
        i++;
      }
      continue;
    }
    if (two === "//") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } }
    else if (two === "/*") {
      while (i < src.length && src.slice(i, i + 2) !== "*/") { out += blank(src[i]); i++; }
      out += "  "; i += 2;
    } else { out += c; i++; }
  }
  return out;
}

function kotlinFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) found.push(...kotlinFiles(p));
    else if (entry.endsWith(".kt")) found.push(p);
  }
  return found;
}

// Composables that take slots. Adding one here is how this guard grows; a
// composable that takes no slots (stringResource, painterResource, a
// CompositionLocal read) does NOT belong in it.
const SLOT_USERS = [
  "collectAsState",
  "collectAsStateWithLifecycle",
  "remember",
  "rememberSaveable",
  "rememberCoroutineScope",
  "rememberLazyListState",
  "rememberScrollState",
  "rememberUpdatedState",
  "produceState",
  "viewModel",
  "LaunchedEffect",
  "DisposableEffect",
  "rememberComposableLambda",
];
const NAMES = SLOT_USERS.join("|");
// `?.collectAsState(` and `?: remember {` -- a slot-user reached through a
// null-conditional. `remember` also matches rememberSaveable and friends,
// which is intended: this is a prefix list, not an exact-name list.
const CHAINED = new RegExp("\\?\\.\\s*(?:" + NAMES + ")[A-Za-z]*\\s*[(<{]", "g");
const ELVIS = new RegExp("\\?:\\s*(?:" + NAMES + ")[A-Za-z]*\\s*[(<{]", "g");

function offenders(sources) {
  const bad = [];
  for (const [path, src] of sources) {
    const clean = stripComments(src);
    for (const re of [CHAINED, ELVIS]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(clean)) !== null) {
        const line = clean.slice(0, m.index).split("\n").length;
        bad.push(`${path}:${line}  ${m[0].trim()}`);
      }
    }
  }
  return bad;
}

const FILES = kotlinFiles(ROOT);

test("the app's Kotlin was found at all", () => {
  // An empty file list would make every check below pass by finding nothing.
  // 215 at the time of writing. The floor only has to catch a scan that is
  // rooted somewhere wrong or returning nothing.
  assert.ok(FILES.length > 150, `only ${FILES.length} .kt files found under ${ROOT}`);
  assert.ok(FILES.some((f) => f.endsWith("JobsListScreen.kt")), "JobsListScreen.kt not among them");
});

test("no slot-using composable hangs off ?. or ?: anywhere in the app", () => {
  const sources = FILES.map((f) => [f.slice(ROOT.length + 1).replaceAll("\\", "/"), readFileSync(f, "utf8")]);
  const bad = offenders(sources);
  assert.deepEqual(bad, [], "a composable that takes slots is being called conditionally:\n  " + bad.join("\n  "));
});

test("CANARY: the check goes red on the line that actually crashed", () => {
  const bad = offenders([[SCREEN, "val x = vm?.items?.collectAsState()?.value.orEmpty()\n"]]);
  assert.equal(bad.length, 1, "the real crash line was not flagged, so this check has no teeth");
});

test("CANARY: and on the elvis form", () => {
  const bad = offenders([[SCREEN, "val s = saved ?: rememberSaveable { 0 }\n"]]);
  assert.equal(bad.length, 1, "the ?: form was not flagged");
});

test("CANARY: a slot-free composable after ?: is left alone", () => {
  // stringResource takes no slots. Twenty-odd correct lines in this app look
  // like this, and a guard that reddened them would be deleted within a day.
  const bad = offenders([[SCREEN, 'Text(name ?: stringResource(R.string.jd_unassigned))\n']]);
  assert.deepEqual(bad, [], "a slot-free composable was wrongly flagged");
});

test("the crash site is still written as an if, not a chain", () => {
  const src = stripComments(read(SCREEN));
  const i = src.indexOf("val crewAttentionItems");
  assert.ok(i !== -1, "crewAttentionItems is gone -- this guard is pinned to a name that moved");
  // Bounded by the next statement, so this reads the assignment and not half
  // the screen.
  const region = src.slice(i, src.indexOf("val keptJobIds", i));
  assert.match(region, /if \(crewAttentionViewModel != null\)/,
    "the crew items are no longer read inside an if; a conditional composable there is the five-month crash");
  assert.doesNotMatch(region, /\?\./, "a safe-call crept back into the crash site");
});
