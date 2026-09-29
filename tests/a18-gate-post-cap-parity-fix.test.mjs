// A18 -- fixes item 4 of this wave: a LINE_TO_WALL gate billed one fewer
// POST_CAP than the posts the SAME takeoff put in the ground.
//
// computePostCounts() (supabase/functions/_shared/pricing/takeoff.ts, ported
// from app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt)
// hardcoded `gatePosts = gateCount * 2`, unconditional on mounting. But
// gateAreaEntries() for GateMounting.LINE_TO_WALL adds a THIRD END_POST (the
// gate's own two, plus the one where the rest of the run terminates at the
// wall, because that mounting ends the fence line twice) -- and POST_CAP is
// priced off gatePosts, not off the entries gateAreaEntries actually builds.
// So a LINE_TO_WALL gate stood one more physical post than it billed a cap
// for. WALL and LINE both already took exactly two -- this shortfall is
// specific to LINE_TO_WALL, not a general off-by-one every gate carries.
//
// The bug was pinned, not hidden: tests/a4-engine-parity.test.mjs's own
// FINDING 2 named it "reproduced, not fixed", and
// fixtures/pricing/gate-line-to-wall-mount.json's `note` still says so (that
// prose is stale now, not a code bug -- nobody has rewritten it since the
// fix landed). a4-engine-parity.test.mjs's FINDING 2 has ALREADY been
// rewritten from BUG to FIXED in this same wave; this file no longer needs
// to say what someone else must still do to it.
//
// This file's numbers do NOT come from the committed fixtures' own
// `expected` field, on either side of the fix. A fixture's `expected` is
// only ever as current as the last parity-gate regeneration (the fixtures
// were regenerated once, mid-wave, to carry the FIXED numbers -- but still
// under the STALE, un-bumped engine.version, which is the exact "version
// stamp is lying" bug this wave's version bump exists to close), so reading
// it as "the buggy answer" or "the fixed answer" depends entirely on WHEN
// this file happens to run relative to that regeneration -- this file ran
// green once, against the pre-regeneration (buggy) fixtures, then would have
// gone red against the very same assertions the moment the fixtures were
// regenerated, despite the code never moving. Pre-fix and post-fix numbers
// are frozen below as plain constants instead (PRE_FIX, derived by hand from
// the same arithmetic the header above describes and cross-checked against
// the fixtures as they were actually committed at HEAD), so this file's
// verdict depends only on the ENGINE, never on which side of a fixture
// regeneration it happens to run.
//
// Fixed in BOTH engines in the same change (parity): this file's own import
// of the real, already-fixed supabase/functions/_shared/pricing/index.ts
// proves the TypeScript side; the Kotlin side (EstimateEngine.kt) carries
// the identical formula and is pinned by
// app/src/test/java/com/fenceestimator/app/estimate/ZeroPriceGuardTest.kt,
// which this sandbox cannot run (house rule: gradlew is for the parity gate,
// not a track making a source change) -- its numbers were hand-derived from
// the identical arithmetic and cross-checked against the live numbers this
// file prints.
//
// Run: npx tsx tests/a18-gate-post-cap-parity-fix.test.mjs

import { readFileSync, mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { priceJob as fixedPriceJob, PRICING_ENGINE_VERSION } from "../supabase/functions/_shared/pricing/index.ts";

let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/pricing/${name}.json`, import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

// A committed fixture's `input.engine_version` is stamped with whatever
// PRICING_ENGINE_VERSION was live the day it was generated -- exactly the
// version-inlining trap this whole wave exists to close (see
// tests/a17-photo-uncalibrated-pricing.test.mjs, which hit it first, and
// tests/a4-engine-parity.test.mjs, which carries the identical helper).
// priceJob() refuses an input whose engine_version disagrees with the
// engine it is called on, so every fixture input below is re-stamped with
// the CALLING engine's own current version before it is priced -- the
// fixed, real engine's for `fixedPriceJob`, the scratch reverted copy's own
// (inherited from the same, already-bumped index.ts it was copied from) for
// `revertedPriceJob`.
const withVersion = (input, version) => ({ ...clone(input), engine_version: version });

const capQty = (out) => out.runs[0].entries.find((e) => e.role === "POST_CAP").quantity;
const endPostQty = (out) => out.runs[0].entries.filter((e) => e.role === "END_POST").reduce((s, e) => s + e.quantity, 0);
// A WALL gate builds a BLANK_POST as well as an END_POST for its hinge side
// (EstimateEngine.kt's "Blank posts (wall-hung gates)" line) -- a blank post
// IS a post, the same as an end or a corner post is, so it belongs in this
// count on exactly the same footing. An earlier version of this file left
// BLANK_POST out and patched the resulting one-post gap back in with a
// "WALL gates are a pre-existing, out-of-scope quirk" fudge factor, on the
// premise that a wall-hung gate overbills a cap. That premise was wrong:
// WALL correctly builds one blank post and one end post and correctly bills
// two caps for them. Counting BLANK_POST here removes the gap AND the fudge
// that used to paper over it -- physicalPosts matches the billed POST_CAP
// quantity exactly, for every mounting, with nothing added back in by name.
const blankPostQty = (out) => out.runs[0].entries.filter((e) => e.role === "BLANK_POST").reduce((s, e) => s + e.quantity, 0);
const physicalPosts = (out) => out.runs[0].posts.line + out.runs[0].posts.corner + endPostQty(out) + blankPostQty(out);

const AFFECTED = ["gate-line-to-wall-mount", "gate-malformed-entries", "multi-gate-whole-bags"];
const UNAFFECTED = ["gate-wall-mount", "gate-line-mount"];

// Frozen by hand from the fixtures exactly as committed at HEAD (f4ffff9),
// before the mid-wave regeneration this file's own header explains -- the
// bug this whole file exists to prove fixed. `posts` and `cap` are read
// straight off each fixture's committed `expected`; `materials` and `grand`
// off its committed `expected.totals`. Cross-checked against the pre-fix
// numbers this file printed the first time it ran green, which are the same
// numbers tests/a4-engine-parity.test.mjs's own (now-rewritten) FINDING 2
// used to pin as "BUG".
const PRE_FIX = {
  "gate-line-to-wall-mount": { posts: { line: 14, corner: 0, end: 2, gate: 2, terminal: 4, total: 18 }, cap: 18, materials: 1535.9799999999998, grand: 2430 },
  "gate-malformed-entries": { posts: { line: 13, corner: 0, end: 2, gate: 4, terminal: 6, total: 19 }, cap: 19, materials: 1833.45, grand: 2800 },
  "multi-gate-whole-bags": { posts: { line: 11, corner: 0, end: 2, gate: 6, terminal: 8, total: 19 }, cap: 19, materials: 2054.8099999999995, grand: 3070 },
  "gate-wall-mount": { posts: { line: 14, corner: 0, end: 2, gate: 2, terminal: 4, total: 18 }, cap: 18, materials: 1489.2099999999998, grand: 2380 },
  "gate-line-mount": { posts: { line: 14, corner: 0, end: 2, gate: 2, terminal: 4, total: 18 }, cap: 18, materials: 1514.6699999999998, grand: 2400 },
};

// The CORRECTED numbers: every AFFECTED case bills exactly one more $0.74
// cap than PRE_FIX, matching the one extra physical post LINE_TO_WALL always
// stood without a cap for it; every UNAFFECTED case is byte-identical to
// PRE_FIX, because this fix touches LINE_TO_WALL alone.
const FIXED = {
  "gate-line-to-wall-mount": { posts: { line: 14, corner: 0, end: 2, gate: 3, terminal: 5, total: 19 }, cap: 19, materials: 1536.7199999999998, grand: 2430 },
  "gate-malformed-entries": { posts: { line: 13, corner: 0, end: 2, gate: 5, terminal: 7, total: 20 }, cap: 20, materials: 1834.19, grand: 2800 },
  "multi-gate-whole-bags": { posts: { line: 11, corner: 0, end: 2, gate: 7, terminal: 9, total: 20 }, cap: 20, materials: 2055.5499999999997, grand: 3080 },
  "gate-wall-mount": PRE_FIX["gate-wall-mount"],
  "gate-line-mount": PRE_FIX["gate-line-mount"],
};

// ===========================================================================
// 1. Prove teeth: revert this change's one rule in a scratch copy of the
//    pricing engine and confirm it reproduces the FROZEN pre-fix numbers
//    exactly for every case, affected and unaffected alike -- i.e. PRE_FIX
//    above really does encode the known bug, not something else invented
//    for this file. Nothing in the working tree is touched; the copy is
//    discarded afterward.
// ===========================================================================
console.log("\n1. RED -- reverting the fix in a scratch copy reproduces the frozen pre-fix numbers exactly:");

let revertedPriceJob;
let REVERTED_VERSION;
let scratchRoot;
{
  scratchRoot = mkdtempSync(join(tmpdir(), "a18-postcap-scratch-"));
  const realPricingDir = fileURLToPath(new URL("../supabase/functions/_shared/pricing/", import.meta.url));
  const scratchPricingDir = join(scratchRoot, "pricing");
  cpSync(realPricingDir, scratchPricingDir, { recursive: true });

  const takeoffPath = join(scratchPricingDir, "takeoff.ts");
  const takeoffSrc = readFileSync(takeoffPath, "utf8");
  const needle = 'const gatePosts = gates.reduce((sum, g) => sum + (g.mounting === "LINE_TO_WALL" ? 3 : 2), 0);';
  const reverted = takeoffSrc.replace(needle, "const gatePosts = gateCount * 2; // REVERTED for this test only");

  ok("found the exact rule to revert (if this fails, the scratch check below is not exercising the fix)",
    reverted !== takeoffSrc);
  writeFileSync(takeoffPath, reverted);

  const scratchIndex = await import(pathToFileURL(join(scratchPricingDir, "index.ts")).href);
  revertedPriceJob = scratchIndex.priceJob;
  // Inherited from the same (already version-bumped) index.ts this scratch
  // copy was made from -- not necessarily PRICING_ENGINE_VERSION's own
  // value if a future bump ever lands between the copy and this read, but
  // always the value THIS scratch copy's priceJob() actually demands.
  REVERTED_VERSION = scratchIndex.PRICING_ENGINE_VERSION;

  for (const name of [...AFFECTED, ...UNAFFECTED]) {
    const out = revertedPriceJob(withVersion(fixture(name).input, REVERTED_VERSION));
    const pre = PRE_FIX[name];
    ok(`RED ${name}: reverted engine reproduces the frozen pre-fix posts exactly`,
      JSON.stringify(out.runs[0].posts) === JSON.stringify(pre.posts),
      `reverted=${JSON.stringify(out.runs[0].posts)} preFix=${JSON.stringify(pre.posts)}`);
    ok(`RED ${name}: reverted engine bills the frozen pre-fix POST_CAP quantity`,
      capQty(out) === pre.cap, `reverted=${capQty(out)} preFix=${pre.cap}`);
    ok(`RED ${name}: reverted engine matches the frozen pre-fix materials_subtotal`,
      out.totals.materials_subtotal === pre.materials,
      `reverted=${out.totals.materials_subtotal} preFix=${pre.materials}`);
  }
}

// ===========================================================================
// 2. GREEN -- the real, fixed engine matches the CORRECTED numbers exactly:
//    one more post cap than PRE_FIX for each of the three affected cases,
//    and that cap count matches the physical posts the SAME takeoff
//    actually builds (line + corner + every END_POST + every BLANK_POST)
//    exactly, with nothing added back in by name -- closing the gap
//    tests/a4-engine-parity.test.mjs's FINDING 2 documents as fixed.
// ===========================================================================
console.log("\n2. GREEN -- the real (fixed) engine matches the corrected numbers, exactly matching physical posts:");

for (const name of AFFECTED) {
  const out = fixedPriceJob(withVersion(fixture(name).input, PRICING_ENGINE_VERSION));
  const pre = PRE_FIX[name];
  const fixed = FIXED[name];

  ok(`GREEN ${name}: posts match the corrected prediction exactly`,
    JSON.stringify(out.runs[0].posts) === JSON.stringify(fixed.posts),
    `actual=${JSON.stringify(out.runs[0].posts)} predicted=${JSON.stringify(fixed.posts)}`);
  ok(`GREEN ${name}: POST_CAP is exactly one more than the pre-fix quantity (${pre.cap} -> ${fixed.cap})`,
    capQty(out) === fixed.cap && capQty(out) === pre.cap + 1,
    `actual=${capQty(out)} predicted=${fixed.cap} preFix=${pre.cap}`);
  ok(`GREEN ${name}: fixed POST_CAP matches physical posts exactly (line + corner + every ` +
     `END_POST + every BLANK_POST) -- no fudge factor needed for any mounting`,
    capQty(out) === physicalPosts(out),
    `capQty=${capQty(out)} physicalPosts=${physicalPosts(out)}`);
  ok(`GREEN ${name}: materials_subtotal matches the corrected prediction, moved by exactly one ` +
     `cap's price ($0.74) off the pre-fix figure`,
    out.totals.materials_subtotal === fixed.materials &&
    Math.abs(fixed.materials - pre.materials - 0.74) < 0.001,
    `actual=${out.totals.materials_subtotal} predicted=${fixed.materials} preFix=${pre.materials}`);
  ok(`GREEN ${name}: grand_total matches the corrected prediction`,
    out.totals.grand_total === fixed.grand,
    `actual=${out.totals.grand_total} predicted=${fixed.grand}`);
}

// grand_total deltas differ per case only in whether the extra 74 cents
// crosses that case's own $10 rounding ceiling, not in the underlying fact:
// exactly one extra $0.74 cap on every affected case. Pinned by name, not
// "some cases", so a future change that moves a DIFFERENT case across its
// boundary is caught rather than shrugged off.
ok("multi-gate-whole-bags: the one case where the extra 74 cents crosses a $10 rounding boundary",
  PRE_FIX["multi-gate-whole-bags"].grand === 3070 && FIXED["multi-gate-whole-bags"].grand === 3080);
ok("gate-line-to-wall-mount: grand_total unchanged -- 74 cents does not cross this one's $10 ceiling",
  PRE_FIX["gate-line-to-wall-mount"].grand === 2430 && FIXED["gate-line-to-wall-mount"].grand === 2430);
ok("gate-malformed-entries: grand_total unchanged -- 74 cents does not cross this one's $10 ceiling either",
  PRE_FIX["gate-malformed-entries"].grand === 2800 && FIXED["gate-malformed-entries"].grand === 2800);

// ===========================================================================
// 3. CANARY -- WALL and LINE mountings are untouched, in both the reverted
//    scratch engine and the real fixed one: this defect, and this fix, are
//    specific to LINE_TO_WALL. physicalPosts (with BLANK_POST counted) now
//    matches billed POST_CAP exactly here too, with no fudge -- a WALL gate
//    was never actually a quirk this fix had to work around.
// ===========================================================================
console.log("\n3. CANARY -- WALL and LINE fixtures are identical before and after, in both engines:");

for (const name of UNAFFECTED) {
  const pre = PRE_FIX[name];
  const fixedOut = fixedPriceJob(withVersion(fixture(name).input, PRICING_ENGINE_VERSION));
  const revertedOut = revertedPriceJob(withVersion(fixture(name).input, REVERTED_VERSION));

  ok(`CANARY ${name}: fixed engine matches the frozen pre-fix numbers exactly (posts, cap, materials, grand total)`,
    JSON.stringify(fixedOut.runs[0].posts) === JSON.stringify(pre.posts) &&
    capQty(fixedOut) === pre.cap && fixedOut.totals.materials_subtotal === pre.materials &&
    fixedOut.totals.grand_total === pre.grand,
    `posts=${JSON.stringify(fixedOut.runs[0].posts)} cap=${capQty(fixedOut)} ` +
    `materials=${fixedOut.totals.materials_subtotal} grand=${fixedOut.totals.grand_total}`);
  ok(`CANARY ${name}: reverted-scratch engine agrees with the fixed engine byte-for-byte ` +
     `(this bug never touched WALL/LINE, so reverting the LINE_TO_WALL-only rule changes nothing here)`,
    JSON.stringify(revertedOut) === JSON.stringify(fixedOut));
  ok(`CANARY ${name}: physical posts (line + corner + every END_POST + every BLANK_POST) match ` +
     `billed POST_CAP exactly -- no fudge factor, including for the WALL mounting's blank post`,
    capQty(fixedOut) === physicalPosts(fixedOut),
    `capQty=${capQty(fixedOut)} physicalPosts=${physicalPosts(fixedOut)}`);
}

rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
