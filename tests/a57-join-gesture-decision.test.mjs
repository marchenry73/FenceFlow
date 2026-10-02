/**
 * ATTACHING ONE SIDE TO ANOTHER: the gesture.
 *
 * What he said: "for the grid, I'm not able to attach the fence to the other
 * ones." What governs it, in his words: "it would not be a corner post if I
 * drew it on the other side until I connect it to that one." So a post becomes
 * a corner because HE joined two ends, never because two points happen to land
 * on the same spot -- and that is the first thing this file holds.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 * ------------------------------------
 * Nothing here compiles or runs Kotlin (a release build is queued and these
 * waves must not touch Gradle). Two different kinds of check, kept apart on
 * purpose:
 *
 *  1. STATIC, against the real source text. The claims that are about the
 *     code's shape -- the gesture reads no coordinate to decide membership,
 *     the tool is not offered while an attachment cannot be saved, nothing
 *     writes anywhere, the retired run_joins API is untouched, every string is
 *     in all three locales. Each one is paired with a mutation of the real
 *     text that must make it fail, because a check that has never been seen to
 *     fail has only been run, not tested.
 *
 *  2. A TRANSCRIPTION of the gesture's decisions and arithmetic
 *     (RunJoinGesture.decide, liveJointOf, endNear, effectBetween and the
 *     RunJoinArithmetic.adjust they rest on), exercised on fixtures. That
 *     proves the SPEC the figures shown to him come from -- one post, one cap,
 *     two end posts becoming one corner post -- and it is a model of the
 *     Kotlin, not the Kotlin itself. tests/a33-join-arithmetic-posts.test.mjs
 *     holds `adjust` to the COMPILED Kotlin's own output line for line; the
 *     structural checks in section 1 here pin the specific lines of the new
 *     gesture layer that this model encodes, so the two cannot drift silently
 *     at the points that decide money.
 *
 * NOT CLAIMED ANYWHERE IN THIS FILE: that an attachment can be made on a
 * phone. It cannot. There is nowhere to keep one (FenceRun has no joint field
 * and no cloud column exists), the tool is therefore not offered, and section 2
 * is the set of checks that keeps that honest in both directions -- it fails if
 * the tool is offered while the storage is missing, AND it fails if the storage
 * lands and the flag is left false.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
const failedIds = [];
function ok(id, what, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok    ${id} ${what}`);
  } else {
    failed++;
    failedIds.push(id);
    console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`);
  }
}
function eq(id, what, got, want) {
  ok(id, what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}

const GEOM = "app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt";
const VM = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt";
const SCREEN = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt";
const ENTITIES = "app/src/main/java/com/fenceestimator/app/data/Entities.kt";

const geomSrc = read(GEOM);
const vmSrc = read(VM);
const screenSrc = read(SCREEN);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** `<signature>` through its matching close brace, or null. */
function bodyOf(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return null;
  const open = src.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

// =============================================================================
console.log("\n1. A JOIN IS SOMETHING HE SAYS, NEVER SOMETHING THE APP NOTICES");
// =============================================================================
{
  const code = stripComments(geomSrc);
  const object = bodyOf(code, "object RunJoinGesture");

  ok("1a", "FenceGeometry.kt defines the gesture layer: RunJoinGesture with decide, endNear, liveJointOf, markers and both effect functions",
    object !== null &&
      ["fun decide(", "fun endNear(", "fun liveJointOf(", "fun markers(", "fun effectOfAttaching(", "fun effectOfDetaching(", "fun attachableEnds(", "fun withJointAt("]
        .every((s) => object.includes(s)));
  ok("1a-types", "and the types the screen and the view model read: JoinEnd, JoinRefusal, JoinDecision, JoinCandidateRun, JointMarker, JoinEffect",
    ["data class JoinEnd(", "enum class JoinRefusal", "data class JoinDecision(", "data class JoinCandidateRun(", "data class JointMarker(", "data class JoinEffect("]
      .every((s) => code.includes(s)));

  // The canary for the scan below: the object DOES read coordinates somewhere
  // (endNear measures a tap, markers measure a drift), so a scan that reports
  // "no coordinates" in the deciding functions is reporting something real.
  ok("1b-canary", "scanner canary: RunJoinGesture was found and some of it DOES read coordinates, so the scans below can see one",
    object !== null && /\.x\b/.test(object) && /sqrt\(/.test(object));

  if (object !== null) {
    const coordinate = /\.(x|y)\b|sqrt\(|hypot|atan2|abs\(/;
    const decide = bodyOf(object, "fun decide(");
    const live = bodyOf(object, "fun liveJointOf(");
    const runsAt = bodyOf(object, "fun runsAtJoint(");
    ok("1c", "TEETH: decide() reads NO coordinate, so two ends can never be attached because they are near each other",
      decide !== null && !coordinate.test(decide),
      `found ${decide && (coordinate.exec(decide) || [])[0]} in decide()`);
    ok("1d", "TEETH: liveJointOf() and runsAtJoint() read NO coordinate either, so whether a post is shared is answered by the ids alone",
      live !== null && runsAt !== null && !coordinate.test(live) && !coordinate.test(runsAt));

    // planJoin's refusals, re-homed in planJoin's order (docs/JOINING_RUNS.md 11.1).
    const order = ["JoinRefusal.NOT_FOUND", "JoinRefusal.SAME_RUN", "JoinRefusal.CLOSED_LOOP", "JoinRefusal.TYPED_FOOTAGE", "JoinRefusal.TEARDOWN_MISMATCH", "JoinRefusal.ALREADY_ATTACHED", "JoinRefusal.AT_ANOTHER_POINT"];
    const positions = order.map((r) => (decide === null ? -1 : decide.indexOf(r)));
    ok("1e", "decide() refuses in planJoin's own order: missing run, same run, closed loop, typed footage, teardown mismatch, already attached, at another point",
      positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
      `positions ${JSON.stringify(positions)}`);

    ok("1f", "a joint id is live only when at least TWO different runs hold it, so a half-synced attachment reads as a free end and bills today's price",
      live !== null && /runsAtJoint\(runs, id\)\.size >= 2/.test(live));

    const markers = bodyOf(object, "fun markers(");
    ok("1g", "the plan's shared-post markers come from the ARITHMETIC's own posts, so the drawing cannot show a post the estimate is not counting",
      markers !== null && /RunJoinArithmetic\.adjust\(/.test(markers) && /adjustment\.posts/.test(markers));

    const between = bodyOf(object, "private fun effectBetween(");
    ok("1h", "the materials figures are the arithmetic run twice and subtracted, and null when the two answers agree",
      between !== null &&
        (between.match(/RunJoinArithmetic\.adjust\(/g) || []).length === 2 &&
        /if \(saved == 0\) return null/.test(between));
    ok("1h-sign", "and a detach is the same figures with the sign flipped, never a second arithmetic",
      between !== null && /saved \* sign/.test(between) && (bodyOf(object, "fun effectOfDetaching(") || "").includes("-1"));
  }

  // The gesture is not wired to the snap or the drag: the only caller is the tap.
  const vmCode = stripComments(vmSrc);
  const snapForDraw = bodyOf(vmCode, "fun snapForDraw(");
  const snapForMove = bodyOf(vmCode, "fun snapForMove(");
  const movePoint = bodyOf(vmCode, "fun movePoint(");
  const addPoint = bodyOf(vmCode, "fun addDrawPoint(");
  const joinish = /RunJoinGesture|_joinPick|_joinOffer|writeJointIds/;
  ok("1i", "TEETH: snapForDraw, snapForMove, addDrawPoint and movePoint mention nothing of the attach gesture -- placing or dragging a point can neither make nor break an attachment",
    [snapForDraw, snapForMove, movePoint, addPoint].every((b) => b !== null && !joinish.test(b)));
  const screenCode = stripComments(screenSrc);
  ok("1j", "the screen reaches the gesture only through viewModel.tapJoinEnd, and only from the Attach tool",
    /SurveyMode\.JOIN -> \{[\s\S]{0,400}?viewModel\.tapJoinEnd\(/.test(screenCode) &&
      (screenCode.match(/viewModel\.tapJoinEnd\(/g) || []).length === 1);
}

// =============================================================================
console.log("\n2. NOTHING IS STORED YET, AND NOTHING PRETENDS OTHERWISE");
// =============================================================================
/** Whether a text of Entities.kt gives FenceRun a joint field. */
function entityHasJointField(text) {
  return /\bval\s+(startJoint|endJoint)\s*:/.test(text);
}
/** Whether a text of SurveyViewModel.kt says an attachment can be kept. */
function storageFlag(text) {
  const m = /const val JOIN_STORAGE_READY\s*=\s*(true|false)/.exec(text);
  return m === null ? null : m[1] === "true";
}
function pricingFlag(text) {
  const m = /const val JOIN_PRICING_READY\s*=\s*(true|false)/.exec(text);
  return m === null ? null : m[1] === "true";
}

{
  const entitiesSrc = read(ENTITIES);
  const stored = entityHasJointField(entitiesSrc);
  const flag = storageFlag(vmSrc);
  ok("2a", "JOIN_STORAGE_READY says an attachment can be kept EXACTLY while FenceRun has a joint field to keep it in",
    flag !== null && flag === stored,
    stored
      ? "FenceRun now carries a joint field but the Attach tool is still switched off: wire the Repository write and the sync, then flip JOIN_STORAGE_READY."
      : "JOIN_STORAGE_READY is true while FenceRun has no joint field. An attachment would be lost the moment the app closed, and would never reach the office.");
  ok("2a-canary", "canary: the probe really is reading Entities.kt and FenceRun",
    /data class FenceRun\(/.test(entitiesSrc) && /val pointsEncoded: String/.test(entitiesSrc));
  // RETIRED AND REPLACED 2026-10-02, when storage landed and both gates went
  // true in one build.
  //
  // This used to read `entityHasJointField(entitiesSrc) === false` -- it proved
  // the probe had teeth by showing it said "no joint field" about the real
  // entity and "yes" about a doctored one. That was the correct shape while
  // FenceRun carried no joint field. It now carries two, so the old assertion
  // asserts the opposite of the truth and could only ever fail.
  //
  // Deleting it would have been the wrong cure. A probe with no teeth check is
  // a probe nobody can trust, and a red gate after a deliberate flip is exactly
  // when someone is tempted to delete rather than re-aim. So the teeth are
  // re-aimed: strip the fields out and the probe must say so.
  ok("2b-teeth", "TEETH: the probe notices if the joint fields are taken OFF the entity",
    entityHasJointField(entitiesSrc) === true &&
      entityHasJointField(
        entitiesSrc.replace(/val startJoint: String[^\n]*\n/, "").replace(/val endJoint: String[^\n]*\n/, "")
      ) === false,
    "the probe cannot tell an entity with joint fields from one without, so 2a is guarding nothing");

  const screenCode = stripComments(screenSrc);
  ok("2c", "the Attach tool is ABSENT from the mode switcher while an attachment cannot be kept, rather than present and refusing",
    /if \(SurveyViewModel\.JOIN_STORAGE_READY\) \{[\s\S]{0,200}?add\(SurveyMode\.JOIN to R\.string\.mode_attach\)/.test(screenCode),
    "SurveyMode.JOIN is offered without the JOIN_STORAGE_READY gate");

  const vmCode = stripComments(vmSrc);
  const write = bodyOf(vmCode, "private suspend fun writeJointIds(");
  const reads = bodyOf(vmCode, "private fun jointIdsOf(");

  // RETIRED AND REPLACED 2026-10-02. 2d asserted writeJointIds wrote NOTHING
  // ("no repository, no database, no file -- it answers false") and 2e that
  // jointIdsOf returned `"" to ""` for every run. Both were true, and were the
  // right guard, for exactly as long as there was nowhere to keep an
  // attachment: they stopped the Attach tool shipping as a control that looked
  // like it worked.
  //
  // Storage landed (SchemaV50, both columns on fence_runs, the sync carrying
  // them in both directions), so both now assert the opposite of the truth.
  // THE DETAIL MOVED, it was not dropped: tests/a59-join-storage-roundtrip.test.mjs
  // owns it in nine checks -- the entity fields, the migration chain, the
  // Postgres half being additive, the sync in BOTH directions, un-joining
  // travelling as '' rather than being absent, validate-on-read erring toward
  // MORE posts, the two gates pinned to each other, and ONE write path with the
  // retired run_joins table untouched. What stays here is only what this file is
  // about: that the seam exists and is the one the gesture calls.
  ok("2d", "writeJointIds IS the write seam, and it reaches the repository rather than inventing its own store",
    write !== null && /repository\./.test(write) && !/runJoinDao|File\(|prefs/.test(write),
    "writeJointIds either no longer writes, or writes somewhere other than the repository -- " +
    "run_joins and a file are both designs that lost; see docs/JOINING_RUNS.md 11.1");
  ok("2d-teeth", "TEETH: the same probe would catch the store being swapped for the retired table",
    write !== null && /runJoinDao/.test(write.replace("repository.", "runJoinDao.")));
  ok("2e", "jointIdsOf reads the stored joint rather than answering two free ends for every run",
    reads !== null && /startJoint|endJoint/.test(reads) && !/^\s*return "" to ""\s*$/m.test(reads),
    "jointIdsOf still returns a hardcoded pair of free ends, so an attachment could be " +
    "written and never read back -- which is the shape of a tool that silently does nothing");
  ok("2e-teeth", "TEETH: that probe would catch it reverting to a hardcoded free pair",
    reads !== null && !/startJoint|endJoint/.test('    return "" to ""'));

  const confirm = bodyOf(vmCode, "fun confirmJoinOffer(");
  ok("2f", "a confirmation that could not be kept reports NO_STORAGE: the attachment is refused, never accepted and quietly lost",
    confirm !== null && /JoinRefusal\.NO_STORAGE/.test(confirm) && /if \(!kept\)/.test(confirm));
  ok("2f-wording", "and the message for it says nothing was attached and why",
    /attach_refused_no_storage/.test(screenCode) &&
      /Nothing was attached/.test(read("app/src/main/res/values/strings.xml")));

  // No third home: the join section holds what a gesture is in the middle of
  // and nothing else.
  //
  // WIDENED on 2 Oct 2026, from three names to five, for the draw-time offer
  // (tests/a80-snap-to-connect.test.mjs). The rule this check exists to hold is
  // unchanged and is NOT the number: it is that no in-memory collection stands
  // in for the stored joint. The two additions are a single pending question
  // (_snapJoinOffer: "these two sides meet -- one post?", which writes nothing
  // and is re-derived from the database before it can be taken) and one number
  // attached to one refusal (_joinTooFarFeet, the gap a TOO_FAR_APART names).
  // The scan is also widened to catch _snapJoin*, which the old `_join\w+`
  // pattern would have missed entirely -- so this is a stricter check than the
  // one it replaces, not a looser one.
  const flows = [...vmSrc.matchAll(/private val (_(?:join|snapJoin)\w+)\s*=\s*Mutable(StateFlow|SharedFlow)/g)].map((m) => m[1]);
  eq("2g", "the view model holds exactly five pieces of join state -- the lifted end, the confirmation, the refusal, that refusal's one number, and the standing draw-time offer -- and no in-memory list of attachments standing in for storage",
    flows.sort(), ["_joinOffer", "_joinPick", "_joinRefused", "_joinTooFarFeet", "_snapJoinOffer"]);
  ok("2g-teeth", "TEETH: none of that state is a COLLECTION of attachments -- a list, set or map standing in for the stored joint",
    flows.every((name) => {
      const decl = vmSrc.slice(vmSrc.indexOf(`private val ${name}`), vmSrc.indexOf(`private val ${name}`) + 180);
      return !/Mutable(StateFlow|SharedFlow)<\s*(List|Set|Map|MutableList|MutableSet|MutableMap)</.test(decl);
    }));
  ok("2g-teeth2", "and that probe can see one: a planted list-of-attachments declaration is caught",
    /Mutable(StateFlow|SharedFlow)<\s*(List|Set|Map)</.test('private val _joinStore = MutableStateFlow<List<JoinEnd>>(emptyList())'));

  // The price half, and its own honesty check: the same predicate a33's 7h uses.
  const engineFiles = [
    "app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt",
    "app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt",
    "supabase/functions/_shared/pricing/takeoff.ts",
    "supabase/functions/_shared/pricing/index.ts",
  ];
  const reachedBy = engineFiles.filter((f) => existsSync(join(ROOT, f)) &&
    /RunJoinArithmetic|JoinableRun|JoinAdjustment|RunPostAdjustment/.test(stripComments(read(f))));
  const pricing = pricingFlag(vmSrc);
  ok("2h", "JOIN_PRICING_READY says the estimate reads attachments EXACTLY while an engine references the join arithmetic",
    pricing !== null && pricing === (reachedBy.length > 0),
    reachedBy.length > 0
      ? `${reachedBy.join(", ")} now read the join arithmetic, so the confirmation must stop saying the price does not change.`
      : "JOIN_PRICING_READY is true but no engine reads the join arithmetic: the dialog would imply the price had moved when it had not.");
  ok("2h-canary", "canary: that probe can see a reference, proved against the file that defines the arithmetic",
    /RunJoinArithmetic/.test(stripComments(geomSrc)));
  ok("2i", "while the estimate does not read attachments, the confirmation says the materials and the price do not change today",
    /if \(!SurveyViewModel\.JOIN_PRICING_READY\) \{[\s\S]{0,200}?R\.string\.attach_price_later/.test(screenCode));
  ok("2j", "and it never claims a saving it cannot deliver: a null effect gets its own wording",
    /if \(effect == null\) \{[\s\S]{0,200}?R\.string\.attach_no_material/.test(screenCode));
}

// =============================================================================
console.log("\n3. THE APPROVED QUOTE IS NOT RE-CUT SILENTLY");
// =============================================================================
{
  const vmCode = stripComments(vmSrc);
  const screenCode = stripComments(screenSrc);
  const risk = bodyOf(vmCode, "private fun approvalAtRisk(");
  ok("3a", "the approval question is the SAME predicate the drawing screen's edit warning uses, not a second copy of the rule",
    risk !== null && /shouldWarnBeforeEditingDrawing\(/.test(risk) &&
      /quoteApprovedAt, current\.reapprovalRequiredAt/.test(risk));
  ok("3b", "every offer carries the answer, so the words appear before the attachment and not after it",
    (vmCode.match(/approvalAtRisk = approvalAtRisk\(\)/g) || []).length === 2 &&
      /if \(offer\.approvalAtRisk\) \{[\s\S]{0,200}?R\.string\.attach_approved_warning/.test(screenCode));
  ok("3c", "and it is said in the warning colour, with the withdrawal and the customer named",
    /attach_approved_warning[\s\S]{0,120}?color = warning/.test(screenCode) &&
      /withdraws that approval, and the customer is asked to approve the new price/.test(read("app/src/main/res/values/strings.xml")));
  // The reason the tool waits for the fingerprint fix at all. The gate's own
  // documentation has to name it, because whoever flips that flag is the last
  // person who can check it.
  const gateAt = vmSrc.indexOf("const val JOIN_STORAGE_READY");
  const gateDoc = gateAt < 0 ? "" : vmSrc.slice(Math.max(0, gateAt - 2500), gateAt);
  ok("3d-canary", "canary: the gate and the text above it were found", gateAt > 0 && gateDoc.length > 500);
  ok("3d", "the gate names BOTH conditions on it: somewhere to store an attachment, and the re-approval fingerprint that has to see one first",
    /supabase_a56_join_reapproval_fingerprint\.sql/.test(gateDoc) && /writeJointIds/.test(gateDoc),
    "the JOIN_STORAGE_READY documentation no longer names the fingerprint file or the write seam");
  ok("3d-teeth", "TEETH: that probe reads the gate's own documentation, not the whole file",
    !/supabase_a56_join_reapproval_fingerprint\.sql/.test(gateDoc.replace(/supabase_a56_join_reapproval_fingerprint\.sql/g, "x")));
}

// =============================================================================
console.log("\n4. THE RETIRED LOCAL TABLE IS NOT TOUCHED");
// =============================================================================
{
  // The same regex tests/a33-join-model-storage.test.mjs uses for its reach
  // check. run_joins is the design that lost (docs/JOINING_RUNS.md 11.1) and a
  // SchemaV50 DROP TABLE is already owed on it: an attachment written there
  // would be deleted by the next upgrade.
  const API = /\b(RunJoin|RunJoinDao|runJoinDao|RunEnd|JoinResult|JoinPlan|planJoin|joinRunEnds|unjoinRunEnd|getRunJoins|observeRunJoins|run_joins|SchemaV48)\b/;
  const mine = { [GEOM]: geomSrc, [VM]: vmSrc, [SCREEN]: screenSrc };
  const offenders = Object.entries(mine).filter(([, text]) => API.test(stripComments(text))).map(([rel]) => rel);
  eq("4a", "none of the three files this wave owns uses the retired run_joins API, so nothing it writes can be dropped by the migration that retires it",
    offenders, []);
  ok("4b-teeth", "TEETH: the same probe catches a call planted in one of them",
    API.test(stripComments(vmSrc + "\nval x = repository.joinRunEnds(a, b)\n")));
  ok("4c", "the names the gesture does use are its own, and cannot be confused with that API",
    /object RunJoinGesture/.test(geomSrc) && !API.test("RunJoinGesture JoinRefusal JoinDecision JoinEnd JoinOffer"));
}

// =============================================================================
console.log("\n5. EVERY WORD IS IN ALL THREE LOCALES");
// =============================================================================
/** name -> text, for one values directory. */
/**
 * Every string a locale declares, across ALL of its string files.
 *
 * Read only values/strings.xml until 2026-10-02, when the join-offer strings
 * landed in their own file. Android merges every <resources> in a values folder,
 * so strings.xml was never the whole table -- this app now also ships
 * strings_join_offer.xml, strings_email.xml, strings_pullsheet.xml,
 * strings_number_guards.xml and strings_side_types.xml, and more will come,
 * because a separate file is how two people edit strings at once without losing
 * each other's work.
 *
 * Reading one file made this report five strings missing that the app resolves
 * perfectly well. The guarantee underneath is unchanged and still the point: a
 * key present in one locale and absent in another is a crash in that language.
 */
function resourceStrings(dir) {
  const base = new URL(`../app/src/main/res/${dir}/`, import.meta.url);
  const out = {};
  for (const file of readdirSync(base).filter((f) => /^strings.*\.xml$/.test(f)).sort()) {
    const text = readFileSync(new URL(file, base), 'utf8');
    for (const m of text.matchAll(/<string name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) out[m[1]] = m[2];
  }
  return out;
}
/** The format arguments one string takes, as a set, the way StringResourceSanityTest reads them. */
function formatArgs(body) {
  const args = new Set();
  const positional = /%\d+\$[sdf]/g;
  for (const m of body.matchAll(positional)) args.add(m[0]);
  for (const m of body.replace(/%%/g, "").replace(positional, "").matchAll(/%[sdf]/g)) args.add(m[0]);
  return [...args].sort();
}
{
  const en = resourceStrings("values");
  const es = resourceStrings("values-es");
  const fr = resourceStrings("values-fr");
  // Every resource the two screens of this wave name, not a hand-written list:
  // a key referenced in Kotlin and missing from the XML is the failure that
  // breaks mergeReleaseResources and takes the whole build with it.
  const referenced = [...new Set([...stripComments(screenSrc).matchAll(/R\.string\.(attach_\w+|mode_attach)/g)].map((m) => m[1]))].sort();
  ok("5a-canary", "canary: the scan found the wave's own string references, so the checks below are not vacuous",
    referenced.length >= 20, `found ${referenced.length}: ${referenced.join(", ")}`);
  const missingEn = referenced.filter((k) => !(k in en));
  const missingEs = referenced.filter((k) => !(k in es));
  const missingFr = referenced.filter((k) => !(k in fr));
  eq("5b", "every attach string the screen names exists in values/strings.xml", missingEn, []);
  eq("5c", "and in values-es", missingEs, []);
  eq("5d", "and in values-fr -- a resource in one locale and not another is the build failure this project has had twice", missingFr, []);
  ok("5e-teeth", "TEETH: the same probe names a key dropped from a locale",
    referenced.filter((k) => !(k in Object.fromEntries(Object.entries(fr).filter(([n]) => n !== referenced[0])))).length === 1);

  const argMismatch = referenced.filter((k) =>
    JSON.stringify(formatArgs(en[k] ?? "")) !== JSON.stringify(formatArgs(es[k] ?? "")) ||
    JSON.stringify(formatArgs(en[k] ?? "")) !== JSON.stringify(formatArgs(fr[k] ?? "")));
  eq("5f", "and every locale takes the same format arguments, so no translation throws at format time on a customer's phone", argMismatch, []);
  ok("5f-canary", "canary: formatArgs really reads a placeholder, and tells a faithful translation from a broken one",
    JSON.stringify(formatArgs("%1$s and %2$s")) === JSON.stringify(["%1$s", "%2$s"]) &&
      JSON.stringify(formatArgs("%1$s et %2$s")) === JSON.stringify(formatArgs("%2$s et %1$s")) &&
      JSON.stringify(formatArgs("%1$s seul")) !== JSON.stringify(formatArgs("%1$s and %2$s")));

  // The two arguments the code actually passes, against what the string wants.
  eq("5g", "attach_body_two is handed two run names, and asks for two", formatArgs(en.attach_body_two), ["%1$s", "%2$s"]);
  eq("5h", "the one-post and many-post wordings ask for nothing and one number respectively",
    [formatArgs(en.attach_effect_one), formatArgs(en.attach_effect_many)], [[], ["%1$d"]]);
  eq("5i", "the French cancel wording is the project's own, not a guess: the attach dialog reuses action_cancel",
    /R\.string\.action_cancel/.test(stripComments(screenSrc)), true);

  // The comment form that has killed this build before.
  for (const dir of ["values", "values-es", "values-fr"]) {
    const text = read(`app/src/main/res/${dir}/strings.xml`);
    const comments = [...text.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
    ok(`5j-${dir}`, `${dir}/strings.xml has no double hyphen inside an XML comment, the form that killed mergeReleaseResources`,
      comments.every((c) => !c.includes("--")), `${comments.filter((c) => c.includes("--")).length} offending comment(s)`);
  }
  ok("5j-canary", "canary: that comment scan can see a double hyphen",
    [...'<!-- a -- b -->'.matchAll(/<!--([\s\S]*?)-->/g)].some((m) => m[1].includes("--")));
}

// =============================================================================
console.log("\n6. THE DECISIONS AND THE NUMBERS (transcription of the gesture layer)");
// =============================================================================
// A model of RunJoinGesture and of the RunJoinArithmetic.adjust it rests on,
// transcribed from the Kotlin. Section 1 pins the lines of the Kotlin this
// model encodes; a33 pins `adjust` itself against the compiled output.
const CORNER_ANGLE_THRESHOLD_DEGREES = 15;

/** FenceGeometryEngine.analyze, reduced to what the join layer reads. */
function analyze(points, pxPerFt, closedLoop) {
  if (points.length < 2 || pxPerFt <= 0) return { vertices: [], endCount: 0 };
  return { vertices: points.slice(), endCount: closedLoop ? 0 : 2 };
}
function toJoinable(run, pxPerFt) {
  return {
    id: run.runId,
    geometry: run.typedFootage ? analyze([], pxPerFt, false) : analyze(run.points, pxPerFt, run.closedLoop),
    heightFt: run.heightFt ?? 6,
    sortOrder: run.sortOrder ?? 0,
    isTeardown: !!run.isTeardown,
    startJointId: run.startJointId ?? "",
    endJointId: run.endJointId ?? "",
  };
}
const isLive = (r) => !r.isTeardown && r.geometry.endCount >= 2;
function endAndNeighbour(member) {
  const v = member.run.geometry.vertices;
  if (v.length < 2) return null;
  return member.atEnd ? [v[v.length - 1], v[v.length - 2]] : [v[0], v[1]];
}
function turnDegrees(first, second) {
  const a = endAndNeighbour(first);
  const b = endAndNeighbour(second);
  if (a === null || b === null) return null;
  const [aEnd, aNext] = a;
  const [bEnd, bNext] = b;
  if (aEnd.x === aNext.x && aEnd.y === aNext.y) return null;
  if (bEnd.x === bNext.x && bEnd.y === bNext.y) return null;
  const angleIn = Math.atan2(aEnd.y - aNext.y, aEnd.x - aNext.x);
  const angleOut = Math.atan2(bNext.y - bEnd.y, bNext.x - bEnd.x);
  let turn = angleOut - angleIn;
  while (turn > Math.PI) turn -= 2 * Math.PI;
  while (turn < -Math.PI) turn += 2 * Math.PI;
  return (Math.abs(turn) * 180) / Math.PI;
}
function outranks(a, b) {
  if (a.heightFt !== b.heightFt) return a.heightFt > b.heightFt;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder;
  return a.id < b.id;
}
/** RunJoinArithmetic.adjust. */
function adjust(joinables) {
  const byJoint = new Map();
  for (const run of joinables) {
    if (run.startJointId !== "") {
      if (!byJoint.has(run.startJointId)) byJoint.set(run.startJointId, []);
      byJoint.get(run.startJointId).push({ run, atEnd: false });
    }
    if (run.endJointId !== "") {
      if (!byJoint.has(run.endJointId)) byJoint.set(run.endJointId, []);
      byJoint.get(run.endJointId).push({ run, atEnd: true });
    }
  }
  if (byJoint.size === 0) return { perRun: {}, posts: [], ignored: [], postsSaved: 0 };
  const deltas = new Map();
  const bump = (id, line, corner, end) => {
    if (!deltas.has(id)) deltas.set(id, [0, 0, 0]);
    const cell = deltas.get(id);
    cell[0] += line;
    cell[1] += corner;
    cell[2] += end;
  };
  const posts = [];
  const ignored = [];
  for (const jointId of [...byJoint.keys()].sort()) {
    const live = byJoint.get(jointId).filter((m) => isLive(m.run));
    if (live.length < 2) { ignored.push({ jointId, reason: "FEWER_THAN_TWO_LIVE_RUNS" }); continue; }
    let twice = false;
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) if (live[i].run.id === live[j].run.id) twice = true;
    if (twice) { ignored.push({ jointId, reason: "SAME_RUN_TWICE" }); continue; }
    let owner = live[0];
    for (let i = 1; i < live.length; i++) if (outranks(live[i].run, owner.run)) owner = live[i];
    let kind;
    if (live.length >= 3) kind = "CORNER";
    else {
      const firstIsZero = live[0].run.id < live[1].run.id;
      const turn = turnDegrees(firstIsZero ? live[0] : live[1], firstIsZero ? live[1] : live[0]);
      kind = turn === null || turn >= CORNER_ANGLE_THRESHOLD_DEGREES ? "CORNER" : "LINE";
    }
    for (const m of live) {
      if (m === owner) {
        if (kind === "CORNER") bump(m.run.id, 0, 1, -1);
        else bump(m.run.id, 1, 0, -1);
      } else bump(m.run.id, 0, 0, -1);
    }
    posts.push({ jointId, kind, ownerRunId: owner.run.id, memberRunIds: live.map((m) => m.run.id).sort(), degree: live.length });
  }
  const perRun = {};
  let postsSaved = 0;
  for (const id of [...deltas.keys()].sort()) {
    const [line, corner, end] = deltas.get(id);
    if (line === 0 && corner === 0 && end === 0) continue;
    perRun[id] = { line, corner, end };
    postsSaved -= line + corner + end;
  }
  return { perRun, posts, ignored, postsSaved };
}
const forRun = (a, id) => a.perRun[id] ?? { line: 0, corner: 0, end: 0 };

/** RunJoinGesture, the parts that decide. */
const G = {
  runOf: (runs, end) => runs.find((r) => r.runId === end.runId) ?? null,
  pointAt(run, atEnd) {
    if (run.points.length < 2) return null;
    return atEnd ? run.points[run.points.length - 1] : run.points[0];
  },
  attachable: (run) => run.points.length >= 2 && !run.closedLoop && !run.typedFootage,
  jointIdAt: (run, atEnd) => (atEnd ? run.endJointId ?? "" : run.startJointId ?? ""),
  attachableEnds(runs) {
    const out = [];
    for (const run of runs) {
      if (!G.attachable(run)) continue;
      for (const atEnd of [false, true]) {
        const point = G.pointAt(run, atEnd);
        if (point === null) continue;
        out.push([{ runId: run.runId, atEnd }, point]);
      }
    }
    return out;
  },
  endNear(runs, at, radius) {
    if (radius <= 0) return null;
    let best = null;
    let bestDistance = radius;
    for (const [end, point] of G.attachableEnds(runs)) {
      const d = Math.sqrt((point.x - at.x) ** 2 + (point.y - at.y) ** 2);
      if (d > bestDistance) continue;
      if (best === null || d < bestDistance) { best = end; bestDistance = d; }
    }
    return best;
  },
  runsAtJoint(runs, jointId) {
    if (jointId === "") return [];
    const ids = [];
    for (const run of runs) {
      if ((run.startJointId ?? "") === jointId || (run.endJointId ?? "") === jointId) {
        if (!ids.includes(run.runId)) ids.push(run.runId);
      }
    }
    return ids.sort();
  },
  endsAtJoint(runs, jointId) {
    if (jointId === "") return [];
    const out = [];
    for (const run of [...runs].sort((a, b) => (a.runId < b.runId ? -1 : 1))) {
      if ((run.startJointId ?? "") === jointId) out.push({ runId: run.runId, atEnd: false });
      if ((run.endJointId ?? "") === jointId) out.push({ runId: run.runId, atEnd: true });
    }
    return out;
  },
  liveJointOf(runs, end) {
    const run = G.runOf(runs, end);
    if (run === null) return "";
    const id = G.jointIdAt(run, end.atEnd);
    if (id === "") return "";
    return G.runsAtJoint(runs, id).length >= 2 ? id : "";
  },
  decide(runs, a, b, newJointId) {
    const runA = G.runOf(runs, a);
    const runB = G.runOf(runs, b);
    if (runA === null || runB === null) return { refusal: "NOT_FOUND" };
    if (runA.runId === runB.runId) return { refusal: "SAME_RUN" };
    if (runA.closedLoop || runB.closedLoop) return { refusal: "CLOSED_LOOP" };
    if (runA.typedFootage || runB.typedFootage) return { refusal: "TYPED_FOOTAGE" };
    if (!!runA.isTeardown !== !!runB.isTeardown) return { refusal: "TEARDOWN_MISMATCH" };
    const jointA = G.liveJointOf(runs, a);
    const jointB = G.liveJointOf(runs, b);
    if (jointA !== "" && jointA === jointB) return { refusal: "ALREADY_ATTACHED" };
    if (jointA !== "" && jointB !== "") return { refusal: "AT_ANOTHER_POINT" };
    const ends = [a, b];
    if (jointA !== "") {
      return G.jointIdAt(runB, !b.atEnd) === jointA ? { refusal: "SAME_RUN" } : { refusal: null, jointId: jointA, ends };
    }
    if (jointB !== "") {
      return G.jointIdAt(runA, !a.atEnd) === jointB ? { refusal: "SAME_RUN" } : { refusal: null, jointId: jointB, ends };
    }
    if (newJointId === "") return { refusal: "NOT_FOUND" };
    return { refusal: null, jointId: newJointId, ends };
  },
  withJointAt: (runs, end, jointId) => runs.map((r) => (r.runId !== end.runId ? r
    : end.atEnd ? { ...r, endJointId: jointId } : { ...r, startJointId: jointId })),
  withDecisionApplied(runs, decision) {
    if (decision.refusal !== null) return runs;
    let out = runs;
    for (const end of decision.ends) out = G.withJointAt(out, end, decision.jointId);
    return out;
  },
  widestGapPx(points) {
    let widest = 0;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const d = Math.sqrt((points[i].x - points[j].x) ** 2 + (points[i].y - points[j].y) ** 2);
        if (d > widest) widest = d;
      }
    }
    return widest;
  },
  effectBetween(before, after, jointId, ends, pxPerFt, sign) {
    const was = adjust(before.map((r) => toJoinable(r, pxPerFt)));
    const now = adjust(after.map((r) => toJoinable(r, pxPerFt)));
    const post = now.posts.find((p) => p.jointId === jointId);
    if (post === undefined) return null;
    const saved = now.postsSaved - was.postsSaved;
    if (saved === 0) return null;
    let endPosts = 0;
    let cornerPosts = 0;
    let linePosts = 0;
    for (const runId of post.memberRunIds) {
      endPosts += forRun(was, runId).end - forRun(now, runId).end;
      cornerPosts += forRun(now, runId).corner - forRun(was, runId).corner;
      linePosts += forRun(now, runId).line - forRun(was, runId).line;
    }
    const points = ends.map((e) => {
      const r = G.runOf(after, e);
      return r === null ? null : G.pointAt(r, e.atEnd);
    }).filter((p) => p !== null);
    return {
      postsSaved: saved * sign,
      postCapsSaved: saved * sign,
      endPostsRemoved: endPosts * sign,
      cornerPostsAdded: cornerPosts * sign,
      linePostsAdded: linePosts * sign,
      kind: post.kind,
      ownerRunId: post.ownerRunId,
      memberCount: post.degree,
      gapFeet: pxPerFt > 0 ? G.widestGapPx(points) / pxPerFt : 0,
    };
  },
  effectOfAttaching(runs, decision, pxPerFt) {
    if (decision.refusal !== null) return null;
    return G.effectBetween(runs, G.withDecisionApplied(runs, decision), decision.jointId, decision.ends, pxPerFt, 1);
  },
  effectOfDetaching(runs, end, pxPerFt) {
    const jointId = G.liveJointOf(runs, end);
    if (jointId === "") return null;
    const ends = G.endsAtJoint(runs, jointId);
    return G.effectBetween(G.withJointAt(runs, end, ""), runs, jointId, ends, pxPerFt, -1);
  },
};

const PX = 20;
const P = (x, y) => ({ x, y });
/** A drawn, open, 6 ft run. */
function R(runId, points, extra = {}) {
  return { runId, points, closedLoop: false, typedFootage: false, isTeardown: false, heightFt: 6, sortOrder: 0, startJointId: "", endJointId: "", ...extra };
}
// A: west to east along y=0. B: north from A's east end (a square corner).
// C: carries on east from A's east end (straight through).
const A = R("a", [P(0, 0), P(600, 0)]);
const B = R("b", [P(600, 0), P(600, -340)], { sortOrder: 1 });
const C = R("c", [P(600, 0), P(1000, 0)], { sortOrder: 2 });

{
  // 6a-6c. The headline numbers: one post, one cap, two end posts into one corner.
  const runs = [A, B];
  const aEnd = { runId: "a", atEnd: true };
  const bStart = { runId: "b", atEnd: false };
  const decision = G.decide(runs, aEnd, bStart, "J1");
  ok("6a", "two sides drawn separately and attached end to end: the attachment is allowed and takes a new post id",
    decision.refusal === null && decision.jointId === "J1");
  const effect = G.effectOfAttaching(runs, decision, PX);
  eq("6b", "and the figures he is shown are one post, one post cap, two end posts gone and one corner post in their place",
    effect && [effect.postsSaved, effect.postCapsSaved, effect.endPostsRemoved, effect.cornerPostsAdded, effect.linePostsAdded, effect.kind, effect.memberCount],
    [1, 1, 2, 1, 0, "CORNER", 2]);
  const straight = G.effectOfAttaching([A, C], G.decide([A, C], aEnd, { runId: "c", atEnd: false }, "J1"), PX);
  eq("6c", "a side that carries straight on gets a LINE post instead, exactly as a bend inside one run would",
    straight && [straight.postsSaved, straight.kind, straight.linePostsAdded, straight.cornerPostsAdded], [1, "LINE", 1, 0]);

  // 6d. The T: a third end onto a post that already exists, in one write.
  const joined = G.withDecisionApplied(runs, decision).concat([C]);
  const third = G.decide(joined, { runId: "c", atEnd: false }, aEnd, "J2");
  ok("6d", "a third side reaching the same post joins THAT post rather than making a second one",
    third.refusal === null && third.jointId === "J1");
  const tee = G.effectOfAttaching(joined, third, PX);
  eq("6e", "and a T is one more post saved, three ends meeting, always a corner post however the legs fall",
    tee && [tee.postsSaved, tee.endPostsRemoved, tee.memberCount, tee.kind], [1, 1, 3, "CORNER"]);

  // 6f. Detaching puts it back, and it is the undo.
  const detach = G.effectOfDetaching(G.withDecisionApplied(runs, decision), bStart, PX);
  eq("6f", "detaching one end puts the post, its cap and its concrete back on the order",
    detach && [detach.postsSaved, detach.postCapsSaved, detach.memberCount], [-1, -1, 2]);

  // 6g. Who is billed.
  const taller = G.effectOfAttaching([A, { ...B, heightFt: 8 }], decision, PX);
  eq("6g", "the shared post is billed on the TALLER side, because that is the post that has to be built",
    taller && taller.ownerRunId, "b");
  const equal = G.effectOfAttaching([{ ...A, sortOrder: 5 }, { ...B, sortOrder: 1 }], decision, PX);
  eq("6h", "equal heights go to the lower sort order, so the answer never depends on list order",
    equal && equal.ownerRunId, "b");

  // 6i. The gap is measured in feet at the drawing's own scale, never pixels.
  const apart = [A, R("b", [P(630, 0), P(630, -340)], { sortOrder: 1 })];
  const gap = G.effectOfAttaching(apart, G.decide(apart, aEnd, bStart, "J1"), PX);
  ok("6i", "two ends 30 px apart on a 20 px/ft drawing are reported as 1.5 ft apart, not 30 of anything",
    gap !== null && Math.abs(gap.gapFeet - 1.5) < 1e-6, `got ${gap && gap.gapFeet}`);
  ok("6i-scale", "and the same pixels on a coarser drawing read as more feet, which is why the warning is never in pixels",
    Math.abs(G.effectOfAttaching(apart, G.decide(apart, aEnd, bStart, "J1"), 4).gapFeet - 7.5) < 1e-6);

  // 6j-6o. The refusals, each on its own fixture.
  const refusalOf = (runs2, x, y) => G.decide(runs2, x, y, "J9").refusal;
  eq("6j", "both ends of one side cannot be attached to each other: that is what a closed perimeter is for",
    refusalOf(runs, { runId: "a", atEnd: false }, aEnd), "SAME_RUN");
  eq("6k", "a closed perimeter has no free end to give",
    refusalOf([A, { ...B, closedLoop: true }], aEnd, bStart), "CLOSED_LOOP");
  eq("6l", "a side quoted from typed footage has no drawn end to attach -- refused on the way in, while an attachment already on one is still honoured by the price",
    refusalOf([A, { ...B, typedFootage: true }], aEnd, bStart), "TYPED_FOOTAGE");
  eq("6m", "the old fence coming out is not attached to the new one going in",
    refusalOf([A, { ...B, isTeardown: true }], aEnd, bStart), "TEARDOWN_MISMATCH");
  eq("6n", "two ends already at one post are not attached twice",
    refusalOf(G.withDecisionApplied(runs, decision), aEnd, bStart), "ALREADY_ATTACHED");
  const twoPosts = G.withJointAt(G.withJointAt([A, B, C], aEnd, "J1"), { runId: "c", atEnd: true }, "J1");
  const bothBusy = G.withJointAt(G.withJointAt(twoPosts, bStart, "J2"), { runId: "c", atEnd: false }, "J2");
  eq("6o", "two ends that each already meet another side, at two different posts, are not quietly merged into one",
    refusalOf(bothBusy, aEnd, bStart), "AT_ANOTHER_POINT");

  // 6p. Two teardown runs: allowed, and honest about changing no material.
  const tearDowns = [{ ...A, isTeardown: true }, { ...B, isTeardown: true }];
  const tearDecision = G.decide(tearDowns, aEnd, bStart, "J1");
  ok("6p", "two tear-out sides may be attached to each other",
    tearDecision.refusal === null);
  eq("6q", "but it changes no material, and the confirmation is given null rather than a confident zero",
    G.effectOfAttaching(tearDowns, tearDecision, PX), null);

  // 6r. The half-synced attachment: an id on one end only is a free end.
  const lonely = G.withJointAt([A, B], aEnd, "J1");
  eq("6r", "an id left on ONE end -- its partner deleted, or not synced down yet -- reads as a free end, so the bill is a post too many and never a post too few",
    G.liveJointOf(lonely, aEnd), "");
  eq("6s", "and nothing is drawn as a shared post for it: the arithmetic ignores it",
    adjust(lonely.map((r) => toJoinable(r, PX))).posts.length, 0);
  ok("6t", "so that end is still attachable, rather than stuck",
    G.decide(lonely, aEnd, bStart, "J2").refusal === null);

  // 6u-6w. The tap.
  const ends = G.attachableEnds([A, B, { ...C, closedLoop: true }, { ...R("d", [P(0, 0)]) }, { ...R("e", [], { typedFootage: true }) }]);
  eq("6u", "a tap can reach two ends per drawn open side, and none at all on a closed perimeter, a typed side or a side of one point",
    ends.map(([e]) => `${e.runId}${e.atEnd ? "/end" : "/start"}`), ["a/start", "a/end", "b/start", "b/end"]);
  eq("6v", "a tap lands on the nearest end within reach",
    G.endNear([A, B], P(596, 6), 40), { runId: "a", atEnd: true });
  eq("6w", "and on nothing at all beyond it, so tapping open ground puts down what was lifted",
    G.endNear([A, B], P(300, 300), 40), null);
  eq("6w-teardown", "a tear-out side's ends ARE tappable: refusing them would refuse the thing rather than the mistake",
    G.attachableEnds([{ ...A, isTeardown: true }]).length, 2);
}

// =============================================================================
console.log("\n7. TEETH ON SECTION 6: every claim above fails when the rule is broken");
// =============================================================================
{
  const runs = [A, B];
  const aEnd = { runId: "a", atEnd: true };
  const bStart = { runId: "b", atEnd: false };
  const decision = G.decide(runs, aEnd, bStart, "J1");

  // A joint id that nobody else holds must not become a post: that is the
  // whole "two or more ends" rule.
  const broken = { ...G, liveJointOf: (rs, e) => G.jointIdAt(G.runOf(rs, e), e.atEnd) };
  const lonely = G.withJointAt(runs, aEnd, "J1");
  ok("7a", "TEETH: dropping the two-ends rule makes a lone id read as attached, and the fixture notices",
    G.liveJointOf(lonely, aEnd) === "" && broken.liveJointOf(lonely, aEnd) === "J1");

  // Inferring from coordinates: A's end and B's start are on the SAME point in
  // every fixture above, and nothing in the model attaches them.
  ok("7b", "TEETH: A's end and B's start sit on one identical point in these fixtures, and the arithmetic still counts two end posts there -- proof that nothing here infers an attachment from position",
    A.points[1].x === B.points[0].x && A.points[1].y === B.points[0].y &&
      adjust(runs.map((r) => toJoinable(r, PX))).posts.length === 0 &&
      adjust(runs.map((r) => toJoinable(r, PX))).postsSaved === 0);

  // The corner threshold.
  const nearlyStraight = [A, R("b", [P(600, 0), P(1000, 100)], { sortOrder: 1 })];
  const sharp = [A, R("b", [P(600, 0), P(1000, 120)], { sortOrder: 1 })];
  const turnOf = (rs) => G.effectOfAttaching(rs, G.decide(rs, aEnd, bStart, "J1"), PX).kind;
  ok("7c", "TEETH: the line/corner line is the engine's own 15 degrees -- 14.0 degrees is a line post, 16.7 a corner",
    turnOf(nearlyStraight) === "LINE" && turnOf(sharp) === "CORNER",
    `${turnOf(nearlyStraight)} / ${turnOf(sharp)}`);

  // The sign of a detach.
  const attached = G.withDecisionApplied(runs, decision);
  ok("7d", "TEETH: attaching and detaching the same pair are equal and opposite, so one wording cannot be used for the other direction",
    G.effectOfAttaching(runs, decision, PX).postsSaved === 1 &&
      G.effectOfDetaching(attached, bStart, PX).postsSaved === -1);

  // Gate posts and footage are untouched by an attachment: a post has no length.
  const before = adjust(runs.map((r) => toJoinable(r, PX)));
  const after = adjust(attached.map((r) => toJoinable(r, PX)));
  ok("7e", "TEETH: an attachment moves post counts and nothing else -- the ends it removes and the post it adds are the only deltas",
    before.postsSaved === 0 && after.postsSaved === 1 &&
      Object.values(after.perRun).reduce((t, d) => t + d.line + d.corner + d.end, 0) === -1);

  // A teardown member never owns or gives up a post, even with the lowest sort order.
  const mixed = [{ ...A, isTeardown: true, sortOrder: -5 }, B, C];
  const withJoint = G.withJointAt(G.withJointAt(G.withJointAt(mixed, aEnd, "J1"), bStart, "J1"), { runId: "c", atEnd: false }, "J1");
  const tally = adjust(withJoint.map((r) => toJoinable(r, PX)));
  ok("7f", "TEETH: a tear-out side at the same post neither owns it nor gives up an end post, even with the lowest sort order",
    tally.posts.length === 1 && tally.posts[0].ownerRunId !== "a" && forRun(tally, "a").end === 0);
}

// -----------------------------------------------------------------------------
console.log("\n----------------------------------------------------------------------");
console.log(`${passed} ok, ${failed} FAIL`);
if (failed > 0) {
  console.log(`FAILED: ${failedIds.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("The attach gesture is explicit, stores nothing, says so, and its numbers are the arithmetic's own.");
}
