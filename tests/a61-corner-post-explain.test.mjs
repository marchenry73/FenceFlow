// THE "WHY DOES IT SAY 36 POSTS?" SHEET, after a join took one of them away.
//
// Run:   node tests/a61-corner-post-explain.test.mjs    (exit 0 = every check passed)
//
// =============================================================================
// WHAT THIS GUARDS, AND WHY IT IS GREEN TODAY
// =============================================================================
// tests/a61-corner-post-pricing.test.mjs proves the MONEY: two sides the owner
// has joined share one post, and its cap and its concrete come off with it.
// This file guards the one place that is NOT money and is still a number he
// reads: the post-workings sheet behind "why?" on the estimate screen.
//
// That sheet is an addition he can check with a pencil. It prints
//
//     Posts along the line      <standardEstimate>     (bold)
//     Of those, corners         <cornerPosts>
//     ... ends                  <endPosts>
//     ... line                  <linePosts>
//     Gate posts               +<gatePosts>
//     Total posts               <totalPosts>           (bold)
//
// and EstimateEngine.PostWorkings' own doc comment says, in as many words,
// that the shared post has to appear there "or standardEstimate above will not
// add up to totalPosts and the explanation becomes a formula the product does
// not use".
//
// The engine DOES carry the figure: PostCounts.postsSharedAtJoints is set from
// the join adjustment and explainPosts copies it onto PostWorkings. Nothing
// renders it. On a joined run the sheet therefore reads, for a 52 ft side with
// both ends joined, "along the line 10 ... corners 1, ends 0, line 8, total 9"
// -- 10 against 9, with no row saying where the post went.
//
// It CANNOT BE REACHED TODAY: SurveyViewModel.JOIN_STORAGE_READY is false, so
// the Attach tool is not offered, no run can carry a joint, and every
// adjustment is zero. So this is written as an IMPLICATION -- the sheet must
// print the figure BY THE TIME the tool is in front of him -- which passes
// now and goes red the day someone flips that flag without touching the sheet.
// An implication that passes trivially is worth nothing on its own, so the
// mutation that violates it is constructed here and asserted to violate it.
//
// Nothing in here reads the database, and nothing in here is about price.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");

let passed = 0;
let failed = 0;
function ok(id, label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok    ${id} ${label}`); }
  else { failed++; console.log(`  FAIL  ${id} ${label}${detail ? `\n          ${detail}` : ""}`); }
}

const ENGINE = "app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt";
const SHEET = "app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateScreen.kt";
const VM = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt";

const SRC = { engine: read(ENGINE), sheet: read(SHEET), vm: read(VM) };

/**
 * Kotlin line comments and KDoc blocks stripped out. A claim about what the
 * code DOES may never be satisfied by a sentence about what it does -- which
 * is how a check on price-job came to be satisfied by a comment mentioning the
 * column it was supposed to be reading.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}
const CODE = {
  engine: stripComments(SRC.engine),
  sheet: stripComments(SRC.sheet),
  vm: stripComments(SRC.vm),
};

console.log("\n1. THE FILES ARE THERE AND READABLE (a check on an empty string passes everything)");
ok("1a", `${ENGINE} read, and it is the post engine`,
  SRC.engine.length > 10000 && /fun\s+explainPosts/.test(CODE.engine), `${SRC.engine.length} bytes`);
ok("1b", `${SHEET} read, and it is the sheet that prints the workings`,
  SRC.sheet.length > 10000 && /posts_why_total/.test(CODE.sheet), `${SRC.sheet.length} bytes`);
ok("1c", `${VM} read, and it declares the gesture's gates`,
  SRC.vm.length > 10000 && /JOIN_STORAGE_READY/.test(CODE.vm), `${SRC.vm.length} bytes`);

console.log("\n2. THE ENGINE CARRIES THE FIGURE, so there is something for the sheet to print");
ok("2a", "PostCounts declares postsSharedAtJoints", /val\s+postsSharedAtJoints/.test(CODE.engine));
ok("2b", "it is SET from the join adjustment, not left at its default",
  /postsSharedAtJoints\s*=\s*-\s*joinAdjustment\.totalPostsDelta/.test(CODE.engine));
ok("2c", "and explainPosts copies it onto PostWorkings, which is what the sheet is handed",
  /postsSharedAtJoints\s*=\s*c\.postsSharedAtJoints/.test(CODE.engine));
ok("2d-canary", "canary: that probe can fail -- a name the engine does not use is not found",
  !/val\s+postsSharedAtWindows/.test(CODE.engine));

console.log("\n3. THE SHEET MUST PRINT IT BY THE TIME THE ATTACH TOOL IS OFFERED");
const readyMatch = /const val JOIN_STORAGE_READY = (true|false)/.exec(CODE.vm);
ok("3a-canary", "canary: JOIN_STORAGE_READY was found (a missing flag must not read as 'off')", readyMatch !== null);
const toolOffered = readyMatch !== null && readyMatch[1] === "true";
/** True when the sheet renders the shared-post figure at all. */
const sheetPrintsIt = (code) => /\bw\.postsSharedAtJoints\b/.test(code);
const printsIt = sheetPrintsIt(CODE.sheet);

console.log(`        JOIN_STORAGE_READY = ${toolOffered}; the sheet prints the figure = ${printsIt}`);
ok("3b", "the workings sheet accounts for the shared post whenever the Attach tool is offered",
  !toolOffered || printsIt,
  "The Attach tool is in front of him and the post-workings sheet does not print " +
  "postsSharedAtJoints. On any joined run the sheet's bold 'Posts along the line' no longer " +
  "equals corners + ends + line + gate, and nothing on it says why -- the addition he can " +
  "check with a pencil stops adding up. FIX: one row in EstimateScreen.kt's post-workings " +
  "dialog, between the 'along the line' total and the Total row, e.g. " +
  "`if (w.postsSharedAtJoints > 0) WorkingRow(stringResource(R.string.posts_why_shared), " +
  "\"-${w.postsSharedAtJoints}\")`, plus that string in res/values/strings.xml beside " +
  "posts_why_along_line. The figure is already on PostWorkings (check 2c); only the row is missing.");

// TEETH. 3b is an implication, and while the flag is false it passes whatever
// the sheet does. So the exact mutation it exists to refuse is built here and
// 3b's own expression is evaluated against it.
const rule = (offered, prints) => !offered || prints;
const MUTANT_VM = SRC.vm.replace(
  /const val JOIN_STORAGE_READY = false/,
  "const val JOIN_STORAGE_READY = true",
);
const mutantReady = /const val JOIN_STORAGE_READY = (true|false)/.exec(stripComments(MUTANT_VM));
const mutantOffered = mutantReady !== null && mutantReady[1] === "true";
ok("3c-teeth", "TEETH: the mutation really does flip the flag the rule reads",
  mutantOffered, `mutant flag reads ${mutantReady === null ? "NOT FOUND" : mutantReady[1]}`);
ok("3d-teeth", "TEETH: with the flag flipped, 3b's own expression is FALSE for a sheet that does not print it",
  rule(mutantOffered, false) === false);
ok("3e-teeth", "TEETH: and TRUE for one that does, so the rule is not simply always-false",
  rule(mutantOffered, true) === true);
ok("3f-canary", "canary: the probe is not satisfied by a COMMENT mentioning the figure",
  !sheetPrintsIt(stripComments("// w.postsSharedAtJoints goes here one day\n")));
ok("3g-canary", "canary: and it IS satisfied by a real read of it",
  sheetPrintsIt('WorkingRow(x, "-${w.postsSharedAtJoints}")'));

console.log("\n4. THE SHEET'S OWN ARITHMETIC, stated so the fix has a target");
ok("4a", "the sheet prints 'Posts along the line' from standardEstimate",
  /posts_why_along_line[\s\S]{0,160}w\.standardEstimate/.test(CODE.sheet));
ok("4b", "and 'Total posts' from totalPosts, which is the figure the join moves",
  /posts_why_total[\s\S]{0,160}w\.totalPosts/.test(CODE.sheet));
ok("4c", "and the rows in between are corners, ends, line and gate -- nothing else",
  /posts_why_corners/.test(CODE.sheet) && /posts_why_ends/.test(CODE.sheet)
  && /posts_why_line/.test(CODE.sheet) && /posts_why_gate_posts/.test(CODE.sheet));

console.log("\n" + "-".repeat(70));
console.log(`${passed} ok, ${failed} FAIL`);
if (!toolOffered && !printsIt) {
  console.log("NOTE: green because the Attach tool is still switched off (JOIN_STORAGE_READY = false).");
  console.log("      Flip that flag without adding the sheet row and check 3b goes red.");
}
process.exitCode = failed === 0 ? 0 : 1;
