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
// UPDATED 2 Oct 2026. Freezing an ABSOLUTE DOLLAR figure turned out to tie this
// file to the whole engine rather than to its own one rule: four later
// deliberate, version-bumped changes to money landed on these same five
// fixtures (the starting-catalog tax fix, the removal of the $10 round-up, a
// wall gate's blank post becoming priced, and gate posts being billed as gate
// posts) and each one made this file red without the LINE_TO_WALL rule having
// moved at all. The constants are brought up to date, every move written out
// with its cause and its arithmetic at the table itself -- and the teeth are
// moved onto the DIFFERENCE between the reverted engine and the real one,
// which is what this file is actually about and is immune to the next
// unrelated price change: one $0.74 cap, plus its 7% tax, on each affected
// case, and byte-for-byte nothing else.
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

const roleQty = (out, role) =>
  out.runs[0].entries.filter((e) => e.role === role).reduce((s, e) => s + e.quantity, 0);
const capQty = (out) => out.runs[0].entries.find((e) => e.role === "POST_CAP").quantity;
const endPostQty = (out) => roleQty(out, "END_POST");
// EVERY post role the takeoff can emit. A WALL gate builds a BLANK_POST as
// well as an END_POST for its hinge side (EstimateEngine.kt's "Blank posts
// (wall-hung gates)" line) -- a blank post IS a post, the same as an end or a
// corner post is, so it belongs in this count on exactly the same footing. An
// earlier version of this file left BLANK_POST out and patched the resulting
// one-post gap back in with a "WALL gates are a pre-existing, out-of-scope
// quirk" fudge factor, on the premise that a wall-hung gate overbills a cap.
// That premise was wrong: WALL correctly builds one blank post and one end
// post and correctly bills two caps for them.
//
// RE-AIMED, 2 Oct 2026: GATE_POST was added to this list for the same reason
// BLANK_POST is in it. GATE POSTS ARE NOW BILLED AS GATE POSTS (engine
// 2026.10.4, the owner's own correction): the two posts standing at a gate
// opening used to be emitted as END_POST and are now emitted as GATE_POST.
// The posts did not move -- the ROLE on the entry did -- so a list naming
// only three of the five post roles now undercounts by exactly the ones it
// forgot, and read as "the engine bills more caps than it stands posts",
// which was never true. Nothing is added back in by name; physicalPosts
// matches the billed POST_CAP quantity exactly, for every mounting.
const POST_ROLES = ["LINE_POST", "CORNER_POST", "END_POST", "GATE_POST", "BLANK_POST"];
const physicalPosts = (out) => POST_ROLES.reduce((s, r) => s + roleQty(out, r), 0);
// Money, in whole cents. materials_subtotal is a chain of float additions, so
// the SAME dollars can arrive as 1514.6699999999996 or 1514.6699999999998
// depending only on the ORDER the entries were summed in -- and that order
// changed when GATE_POST stopped being lumped in with END_POST (2026.10.4).
// Comparing in cents keeps every tooth (a one-cent move still fails) without
// pinning 2e-13 of float dust that is not money.
const cents = (x) => Math.round(x * 100);

const AFFECTED = ["gate-line-to-wall-mount", "gate-malformed-entries", "multi-gate-whole-bags"];
const UNAFFECTED = ["gate-wall-mount", "gate-line-mount"];

// `posts` and `cap` are the POST-COUNT shape of the bug and are the thing this
// file exists to pin. They are unchanged from the day this file was written:
// reverting the one rule still produces exactly these, and the fix still adds
// exactly one cap on each AFFECTED case.
//
// `materials` and `grand` ARE NOT the figures this file froze in September, and
// every one that moved is listed below with what moved it. None of these moves
// is this file's subject; all are deliberate, version-bumped changes to money
// that happen to land on the same fixtures.
//
//  (i)   THE STARTING-CATALOG TAX FIX (commit 87639fc). The seeded PANEL and
//        GATE_PANEL rows shipped taxable = false; panels are taxable in
//        Florida. These fixtures' catalogs ARE the seed, so each one's taxable
//        base jumped to the whole of materials and its tax with it. Materials
//        itself did not move. Tax is 7% on every fixture here.
//  (ii)  THE $10 ROUND-UP WAS REMOVED (engine 2026.10.1, the owner's decision
//        of 1 Oct 2026). grand_total was ceil(preMarkup / 10) * 10 and is now
//        roundToCents(preMarkup). Markup and discount are 0 on all five.
//  (iii) A BLANK_POST WITH NO BLANK_POST ROW IS NOW PRICED OFF THE COMPANY'S
//        GATE_POST ROWS (engine 2026.10.5 -- "a wall gate charges for the post
//        it bolts through"). These catalogs hold no BLANK_POST row, so the
//        blank post of a WALL gate used to price at $0.00 and now prices at
//        $16.56, the END_POST/GATE_POST price in this catalog. It touches
//        exactly the two fixtures with a WALL gate on them: gate-wall-mount
//        and multi-gate-whole-bags. Both move UP, by one post each.
//  (iv)  GATE POSTS ARE BILLED AS GATE POSTS (engine 2026.10.4). Same price,
//        same quantity, a different entry -- so only the ORDER the float
//        additions happen in moved, which is why gate-line-mount's materials
//        read ...96 instead of ...98 at the same 1514.67. Compared in cents
//        (see `cents` above), not as a float.
//
// Every derivation below is preMarkup = materials + tax + labour + gate charge
// (teardown, change orders, markup and discount are all 0 on these five).
const PRE_FIX = {
  // REVERTED-ENGINE figures: what the engine produces TODAY with only the one
  // gatePosts rule put back. posts/cap unchanged from the September freeze.
  "gate-line-to-wall-mount": {
    posts: { line: 14, corner: 0, end: 2, gate: 2, terminal: 4, total: 18 }, cap: 18,
    // materials unchanged at 1535.98. grand 2430 -> 2491.50 by (i) and (ii):
    //   old: ceil((1535.98 + 38.0509 + 768 + 80) / 10) * 10 = ceil(2422.03/10)*10 = 2430
    //   new: roundToCents(1535.98 + 107.5186 + 768 + 80)    = roundToCents(2491.4986) = 2491.50
    materials: 1535.9799999999998, grand: 2491.5,
  },
  "gate-malformed-entries": {
    posts: { line: 13, corner: 0, end: 2, gate: 4, terminal: 6, total: 19 }, cap: 19,
    // materials unchanged at 1833.45. grand 2800 -> 2869.79 by (i) and (ii):
    //   new: roundToCents(1833.45 + 128.3415 + 728 + 180) = roundToCents(2869.7915) = 2869.79
    materials: 1833.45, grand: 2869.79,
  },
  "multi-gate-whole-bags": {
    posts: { line: 11, corner: 0, end: 2, gate: 6, terminal: 8, total: 19 }, cap: 19,
    // materials 2054.81 -> 2071.37 by (iii): +16.56, the one blank post of this
    // fixture's WALL gate, previously priced at $0.00.
    // grand 3070 -> 3172.37 by (i), (ii) and (iii):
    //   new: roundToCents(2071.37 + 144.9959 + 696 + 260) = roundToCents(3172.3659) = 3172.37
    materials: 2071.37, grand: 3172.37,
  },
  "gate-wall-mount": {
    posts: { line: 14, corner: 0, end: 2, gate: 2, terminal: 4, total: 18 }, cap: 18,
    // materials 1489.21 -> 1505.77 by (iii): +16.56, this fixture's one blank post.
    // grand 2380 -> 2459.17 by (i), (ii) and (iii):
    //   new: roundToCents(1505.77 + 105.4039 + 768 + 80) = roundToCents(2459.1739) = 2459.17
    materials: 1505.7699999999998, grand: 2459.17,
  },
  "gate-line-mount": {
    posts: { line: 14, corner: 0, end: 2, gate: 2, terminal: 4, total: 18 }, cap: 18,
    // materials unchanged at $1,514.67 to the cent; the float tail moved ...98 -> ...96 by (iv).
    // grand 2400 -> 2468.70 by (i) and (ii):
    //   new: roundToCents(1514.67 + 106.0269 + 768 + 80) = roundToCents(2468.6969) = 2468.70
    materials: 1514.67, grand: 2468.7,
  },
};

// The CORRECTED numbers: every AFFECTED case bills exactly one more $0.74
// cap than PRE_FIX, matching the one extra physical post LINE_TO_WALL always
// stood without a cap for it; every UNAFFECTED case is byte-identical to
// PRE_FIX, because this fix touches LINE_TO_WALL alone.
//
// Each `grand` is its PRE_FIX twin plus 0.79: one $0.74 cap plus its 7% tax,
// 0.74 * 1.07 = 0.7918, rounded to the cent. Before the round-up was removed
// (ii) that 79 cents disappeared into the $10 ceiling on two of the three
// cases and crossed it on the third; now it lands on all three alike, which is
// a plainer statement of the same fix.
const FIXED = {
  // 2491.50 + 0.79 = 2492.29
  "gate-line-to-wall-mount": { posts: { line: 14, corner: 0, end: 2, gate: 3, terminal: 5, total: 19 }, cap: 19, materials: 1536.7199999999998, grand: 2492.29 },
  // 2869.79 + 0.79 = 2870.58
  "gate-malformed-entries": { posts: { line: 13, corner: 0, end: 2, gate: 5, terminal: 7, total: 20 }, cap: 20, materials: 1834.19, grand: 2870.58 },
  // materials 2055.55 -> 2072.11 by (iii) as above; 3172.37 + 0.79 = 3173.16
  "multi-gate-whole-bags": { posts: { line: 11, corner: 0, end: 2, gate: 7, terminal: 9, total: 20 }, cap: 20, materials: 2072.1099999999997, grand: 3173.16 },
  "gate-wall-mount": PRE_FIX["gate-wall-mount"],
  "gate-line-mount": PRE_FIX["gate-line-mount"],
};

// One extra $0.74 cap, and its 7% tax, is the WHOLE of what this fix does to
// money -- stated once, in cents, and then asserted per case below so no case
// can quietly drift onto a different delta.
const CAP_PRICE_CENTS = 74;
const CAP_WITH_TAX_CENTS = 79; // round(74 * 1.07) = round(79.18) = 79

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
      cents(out.totals.materials_subtotal) === cents(pre.materials),
      `reverted=${out.totals.materials_subtotal} preFix=${pre.materials}`);
    ok(`RED ${name}: reverted engine matches the frozen pre-fix grand_total`,
      cents(out.totals.grand_total) === cents(pre.grand),
      `reverted=${out.totals.grand_total} preFix=${pre.grand}`);
    // The reverted engine is the bug, stated as a fact about posts rather than
    // about dollars: it bills FEWER caps than the posts it stands. On the
    // UNAFFECTED mountings it is already matched, which is why reverting the
    // LINE_TO_WALL-only rule leaves them alone.
    const short = physicalPosts(out) - capQty(out);
    ok(`RED ${name}: the reverted engine's shortfall is ${short} cap${short === 1 ? "" : "s"} ` +
       `-- ${AFFECTED.includes(name) ? "one post with no cap on it, which IS the bug" : "none, this mounting never had the bug"}`,
      short === (AFFECTED.includes(name) ? 1 : 0),
      `physicalPosts=${physicalPosts(out)} capQty=${capQty(out)}`);
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
  const rev = revertedPriceJob(withVersion(fixture(name).input, REVERTED_VERSION));
  const pre = PRE_FIX[name];
  const fixed = FIXED[name];

  ok(`GREEN ${name}: posts match the corrected prediction exactly`,
    JSON.stringify(out.runs[0].posts) === JSON.stringify(fixed.posts),
    `actual=${JSON.stringify(out.runs[0].posts)} predicted=${JSON.stringify(fixed.posts)}`);
  ok(`GREEN ${name}: POST_CAP is exactly one more than the pre-fix quantity (${pre.cap} -> ${fixed.cap})`,
    capQty(out) === fixed.cap && capQty(out) === pre.cap + 1,
    `actual=${capQty(out)} predicted=${fixed.cap} preFix=${pre.cap}`);
  ok(`GREEN ${name}: fixed POST_CAP matches physical posts exactly (every LINE, CORNER, END, ` +
     `GATE and BLANK post the takeoff emitted) -- no fudge factor needed for any mounting`,
    capQty(out) === physicalPosts(out),
    `capQty=${capQty(out)} physicalPosts=${physicalPosts(out)}`);
  ok(`GREEN ${name}: materials_subtotal matches the corrected prediction, moved by exactly one ` +
     `cap's price ($0.74) off the pre-fix figure`,
    cents(out.totals.materials_subtotal) === cents(fixed.materials) &&
    cents(fixed.materials) - cents(pre.materials) === CAP_PRICE_CENTS,
    `actual=${out.totals.materials_subtotal} predicted=${fixed.materials} preFix=${pre.materials}`);
  ok(`GREEN ${name}: grand_total matches the corrected prediction`,
    cents(out.totals.grand_total) === cents(fixed.grand),
    `actual=${out.totals.grand_total} predicted=${fixed.grand}`);

  // RE-AIMED, and this is where the real teeth now are. The three checks that
  // used to sit below this loop compared the file's own PRE_FIX and FIXED
  // constants to literals -- `PRE_FIX[x].grand === 3070 && FIXED[x].grand ===
  // 3080` -- which is a tautology over two numbers typed into this same file
  // and could not fail on any engine. They existed to record WHICH cases had
  // the extra 74 cents swallowed by the $10 ceiling, and there is no ceiling
  // any more (deliberate change (ii), engine 2026.10.1), so the question they
  // asked no longer has an answer.
  //
  // What replaces them asks the same thing of the LIVE engines instead: revert
  // the one rule, and the difference the fix makes is exactly one $0.74 cap
  // plus its 7% tax, on every affected case, with nothing else moving. Stated
  // per case by name, so a future change that moves one case and not the
  // others still fails here.
  ok(`GREEN ${name}: reverting the one rule removes exactly one cap, $0.74 of materials and ` +
     `$0.79 of billed money (0.74 x 1.07 tax) -- that delta IS the fix, and nothing else moved`,
    capQty(out) - capQty(rev) === 1 &&
    cents(out.totals.materials_subtotal) - cents(rev.totals.materials_subtotal) === CAP_PRICE_CENTS &&
    cents(out.totals.grand_total) - cents(rev.totals.grand_total) === CAP_WITH_TAX_CENTS &&
    JSON.stringify(out.runs[0].entries.filter((e) => e.role !== "POST_CAP")) ===
      JSON.stringify(rev.runs[0].entries.filter((e) => e.role !== "POST_CAP")),
    `cap ${capQty(rev)}->${capQty(out)} materials ${rev.totals.materials_subtotal}->` +
    `${out.totals.materials_subtotal} grand ${rev.totals.grand_total}->${out.totals.grand_total}`);
}

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
    capQty(fixedOut) === pre.cap && cents(fixedOut.totals.materials_subtotal) === cents(pre.materials) &&
    cents(fixedOut.totals.grand_total) === cents(pre.grand),
    `posts=${JSON.stringify(fixedOut.runs[0].posts)} cap=${capQty(fixedOut)} ` +
    `materials=${fixedOut.totals.materials_subtotal} grand=${fixedOut.totals.grand_total}`);
  ok(`CANARY ${name}: reverted-scratch engine agrees with the fixed engine byte-for-byte ` +
     `(this bug never touched WALL/LINE, so reverting the LINE_TO_WALL-only rule changes nothing here)`,
    JSON.stringify(revertedOut) === JSON.stringify(fixedOut));
  ok(`CANARY ${name}: physical posts (every LINE, CORNER, END, GATE and BLANK post the takeoff ` +
     `emitted) match billed POST_CAP exactly -- no fudge factor, including for the WALL ` +
     `mounting's blank post`,
    capQty(fixedOut) === physicalPosts(fixedOut),
    `capQty=${capQty(fixedOut)} physicalPosts=${physicalPosts(fixedOut)}`);
}

rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\n${pass} of ${pass + fail} checks passed`);
if (fail) process.exit(1);
