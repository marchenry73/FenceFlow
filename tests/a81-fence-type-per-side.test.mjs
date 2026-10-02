/**
 * WHAT KIND OF FENCE IS ON EACH SIDE, AND EVERYTHING CONNECTED TO IT.
 *
 * His words: "after I create the drawing I need a spot to set what kind of
 * fence is on each side, use the default, but I also want to set what type of
 * fence it is on each side." And: "Also for everything that's connected to it
 * for it to work too."
 *
 * WHAT WAS ALREADY TRUE, confirmed rather than taken on trust (section 0):
 * every run already carries its own `fence_type`, both pricing engines narrow
 * the catalog by it, and RunEditScreen has had a per-run dropdown all along.
 * The capability was there; he could not find it, because it lived on a screen
 * two navigations away from the one he is on when he finishes drawing.
 *
 * WHAT WAS NOT TRUE, and is the reason this file exists:
 *
 *  1. **A type change did not re-price.** The only re-pricing watcher in the
 *     app is `SurveyViewModel.watchDrawingForRepricing`, on the DRAWING screen.
 *     The picker was on RunEditScreen, whose view model wrote the row and
 *     stopped. So a side switched from Vinyl to Wood kept its vinyl panels,
 *     vinyl posts and vinyl caps priced on it, with every surface in the app
 *     already reading "Wood" off the row. Section 4.
 *  2. **A new side's type was a hardcoded constant**, in two places, neither of
 *     which looked at the job. Section 1.
 *  3. **Height did not carry between the two columns that hold it.**
 *     `panelHeightFt` and `fabricHeightFt` are one physical fact under two
 *     names. A 6 ft side switched to chain link priced 4 ft fabric -- and the
 *     fabric row is CHOSEN by that number, so it buys the wrong roll. Measured
 *     below on his real catalog: $125.00 on 100 ft, and the wrong material.
 *     Section 3.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT
 * ------------------------------------
 * Nothing here compiles or runs Kotlin. No Gradle in this wave, so the Kotlin
 * added alongside this file is UNVERIFIED BY COMPILATION and says so. Three
 * kinds of check, kept apart, the same shape tests/a80 uses:
 *
 *  1. STATIC, against the real source text, each paired with a mutation of that
 *     text that must make the same check fail.
 *  2. A TRANSCRIPTION of the deciding logic -- RunTypeChange.defaultTypeFor,
 *     .apply, .specProblem, and EstimateEngine's suggestQuantities /
 *     computePostCounts / buildLineItems -- exercised on fixtures. That is a
 *     model of the Kotlin, not the Kotlin itself; the static checks pin the
 *     lines the model encodes so the two cannot drift silently where it decides
 *     money.
 *  3. PRICES MEASURED ON HIS REAL CATALOG. The 47 rows below were read out of
 *     the live database READ-ONLY on 2 Oct 2026 (positive control: 120 active
 *     rows; canary: a role name that must match nothing matched nothing on
 *     every type). Nothing was written, deployed or applied.
 *
 * THE CANARIES AT THE BOTTOM MUST FAIL. Three of them: a defaultTypeFor that
 * ignores the job's sides, a buildLineItems that ignores `run.fenceType`, and
 * an apply() that drops the height carry. If any of them passes, this file is
 * decoration.
 */
import { readFileSync } from "node:fs";
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
  ok(id, what, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
}
let pendingCount = 0;
/**
 * A check EXPECTED to fail right now because the edit it pins lives in a file
 * another wave owns this run. Printed as PEND, counted separately, and still
 * makes the run exit non-zero: the feature is not finished until the anchored
 * edit lands, and a green suite would say otherwise.
 */
function pending(id, what, cond, why) {
  if (cond) {
    passed++;
    console.log(`  ok    ${id} ${what} (anchor applied)`);
  } else {
    pendingCount++;
    console.log(`  PEND  ${id} ${what} -- ${why}`);
  }
}
const money = (n) => Math.round(n * 100) / 100;

const ENGINE = "app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt";
const REFRESHER = "app/src/main/java/com/fenceestimator/app/estimate/TakeoffRefresher.kt";
const TYPECHANGE = "app/src/main/java/com/fenceestimator/app/ui/runs/RunTypeChange.kt";
const PICKER = "app/src/main/java/com/fenceestimator/app/ui/runs/FenceTypePicker.kt";
const CARD = "app/src/main/java/com/fenceestimator/app/ui/runs/SideTypesCard.kt";
const SIDEVM = "app/src/main/java/com/fenceestimator/app/ui/runs/SideTypesViewModel.kt";
const RUNEDIT = "app/src/main/java/com/fenceestimator/app/ui/runs/RunEditScreen.kt";
const RUNEDITVM = "app/src/main/java/com/fenceestimator/app/ui/runs/RunEditViewModel.kt";
const SURVEYVM = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt";
const SURVEYSCREEN = "app/src/main/java/com/fenceestimator/app/ui/survey/SurveyDrawScreen.kt";
const JOBDETAIL = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt";
const ENTITIES = "app/src/main/java/com/fenceestimator/app/data/Entities.kt";
const LINEITEMS_TS = "supabase/functions/_shared/pricing/line-items.ts";
const TAKEOFF_TS = "supabase/functions/_shared/pricing/takeoff.ts";
const CREWPLAN = "app/src/main/java/com/fenceestimator/app/ui/crew/CrewFencePlanScreen.kt";
const PLANVIEW = "app/src/main/java/com/fenceestimator/app/ui/components/FencePlanView.kt";
const PDF = "app/src/main/java/com/fenceestimator/app/estimate/PdfExporter.kt";
const QUOTEVIEW = "supabase/functions/quote-view/index.ts";
const REPORTSVM = "app/src/main/java/com/fenceestimator/app/ui/reports/ReportsViewModel.kt";
const RUNLISTVM = "app/src/main/java/com/fenceestimator/app/ui/runs/FenceRunListViewModel.kt";

/* ===================================================================== *
 * 0. WHAT WAS ALREADY TRUE. Verified, not trusted.
 * ===================================================================== */
console.log("\n0. The capability that already existed");

const entities = read(ENTITIES);
ok("0a", "fence_runs carries its own fenceType, defaulting to VINYL",
  /val fenceType: FenceType = FenceType\.VINYL/.test(entities));

const engine = read(ENGINE);
const NARROW_KT = /\.filter \{ it\.isActive && \(it\.fenceType == run\.fenceType \|\| it\.fenceType == FenceType\.UNIVERSAL\) \}/;
ok("0b", "PHONE engine narrows the catalog by the RUN's own fence type",
  NARROW_KT.test(engine));
ok("0b-canary", "PLANTED: that check fails once the type narrowing is removed",
  !NARROW_KT.test(engine.replace(NARROW_KT, ".filter { it.isActive }")));

const lineItemsTs = read(LINEITEMS_TS);
const NARROW_TS = /item\.fenceType === run\.fenceType \|\| item\.fenceType === "UNIVERSAL"/;
ok("0c", "OFFICE engine narrows the catalog the same way (line-items.ts)",
  NARROW_TS.test(lineItemsTs));
ok("0c-canary", "PLANTED: that check fails once the server narrowing is removed",
  !NARROW_TS.test(lineItemsTs.replace(NARROW_TS, "item.isActive")));

ok("0d", "the quantity branch is per-run-type on the phone",
  /when \(run\.fenceType\) \{/.test(engine));
ok("0e", "the quantity branch is per-run-type on the server",
  /switch \(run\.fenceType\)/.test(read(TAKEOFF_TS)));

// The vinyl-only gate hardware the brief names. STIFFENER and BRACE are
// gated by a set; HANDLE is asked for unconditionally.
ok("0f", "STIFFENER is gated by a type set, not asked for every type",
  /STIFFENED_GATE_TYPES\.contains|in STIFFENED_GATE_TYPES/.test(engine));
ok("0g", "BRACE is gated by a type set too",
  /in BRACED_GATE_TYPES/.test(engine));
ok("0h", "HANDLE is asked for on every type (no set guards it)",
  /entries \+= QtyEntry\(MaterialRole\.HANDLE, 1\.0\)/.test(engine));

/* ===================================================================== *
 * HIS REAL CATALOG. Read-only, live, 2 Oct 2026.
 * Positive control on the read: 120 active rows, VINYL PANEL = 8 rows.
 * Canary on the read: role 'ZZZ_CANARY_ROLE' matched 0 rows on every type.
 * ===================================================================== */
const CATALOG = [
  { t: "UNIVERSAL", role: "CONCRETE_BAG", s: "65d1dc5a-2526-4bd5-9926-918be64d4639", p: 4.75, cov: null, h: null, c: "" },
  { t: "VINYL", role: "CORNER_POST", s: "99713633-5e3a-4d13-9a42-690be16aabb2", p: 16.56, cov: null, h: 6, c: "White" },
  { t: "VINYL", role: "END_POST", s: "94fe58bc-479d-40c2-8cec-2ad53c80da34", p: 16.56, cov: null, h: 6, c: "White" },
  { t: "VINYL", role: "END_POST", s: "b6e6870b-53c1-42a8-8754-07fab2202c51", p: 16.56, cov: null, h: 6, c: "White" },
  { t: "VINYL", role: "END_POST", s: "cf8f1234-6cf0-45c3-add2-c9f8a8a800c7", p: 16.75, cov: null, h: 4, c: "White" },
  { t: "VINYL", role: "END_POST", s: "56da04ec-0446-4a19-892c-2af833007cf6", p: 19, cov: null, h: 6, c: "White" },
  { t: "VINYL", role: "LINE_POST", s: "6567cd59-b3c4-4e83-9539-579e9523cbc2", p: 13.18, cov: null, h: 4, c: "White" },
  { t: "VINYL", role: "LINE_POST", s: "0853425e-f790-46c8-86ba-d06f154cf9ad", p: 16.56, cov: null, h: 6, c: "White" },
  { t: "VINYL", role: "LINE_POST", s: "2313d5c3-1b48-4efc-8f8d-3d4eb856b9e4", p: 16.56, cov: null, h: 6, c: "White" },
  { t: "VINYL", role: "LINE_POST", s: "bbea42c9-5eaf-41fa-bd68-b617f3eca901", p: 16.75, cov: null, h: 4, c: "White" },
  { t: "VINYL", role: "LINE_POST", s: "65a04614-1cb3-4e11-8dbd-9728a3926b3f", p: 17.25, cov: null, h: 6, c: "Tan" },
  { t: "VINYL", role: "LINE_POST", s: "7af87da6-77a5-4529-848f-0c2346932b14", p: 17.25, cov: null, h: 6, c: "Gray" },
  { t: "VINYL", role: "LINE_POST", s: "1e4c2d19-d734-4737-91ca-e81d52bd1a2b", p: 18.99929, cov: null, h: 6, c: "White" },
  { t: "VINYL", role: "PANEL", s: "46e45804-f6f8-44c1-9189-50a1c3f87d03", p: 54.15, cov: 6, h: 6, c: "White" },
  { t: "VINYL", role: "PANEL", s: "1d647c45-1f70-4994-9cac-2b2ceadffd99", p: 54.5, cov: 6, h: 6, c: "Gray" },
  { t: "VINYL", role: "PANEL", s: "8d9ac579-26bd-43b6-af1d-fa03b1578c83", p: 54.5, cov: 6, h: 6, c: "Tan" },
  { t: "VINYL", role: "PANEL", s: "032d7cdd-ca61-40a8-9e89-a1f579f81cc9", p: 54.99875, cov: 6, h: 6, c: "White" },
  { t: "VINYL", role: "PANEL", s: "264fd613-5e56-40e6-bff5-4a53d6efff83", p: 61.74, cov: 6, h: 4, c: "White" },
  { t: "VINYL", role: "PANEL", s: "4c238144-1b7f-4c25-9f77-60aa6f72db64", p: 71.4, cov: 8, h: 6, c: "White" },
  { t: "VINYL", role: "PANEL", s: "e0541b48-9290-45e2-91a8-42e5e35161cc", p: 71.5, cov: 6, h: 4, c: "White" },
  { t: "VINYL", role: "PANEL", s: "832aba35-eda2-489a-b768-60da094b2d4a", p: 73.9, cov: 8, h: 6, c: "Tan" },
  { t: "VINYL", role: "POST_CAP", s: "24f97300-7490-494b-9288-41b426d5c08e", p: 0.78, cov: null, h: null, c: "White" },
  { t: "VINYL", role: "POST_CAP", s: "e9bb9af8-dff7-455a-81e0-c6f6eadde39b", p: 1.65, cov: null, h: null, c: "White" },
  { t: "WOOD", role: "CORNER_POST", s: "a6eb2d2f-d084-4268-af9a-2d402303c62a", p: 9.5, cov: null, h: null, c: "" },
  { t: "WOOD", role: "END_POST", s: "79e14f82-96da-4e8c-82e0-67f8213e2275", p: 9.5, cov: null, h: null, c: "" },
  { t: "WOOD", role: "LINE_POST", s: "43cca8b2-e647-437d-94d6-75eca1bc90ab", p: 9.5, cov: null, h: null, c: "" },
  { t: "WOOD", role: "POST_CAP", s: "68387c67-2796-472d-b49e-1070fb7919aa", p: 2.25, cov: null, h: null, c: "" },
  { t: "WOOD", role: "WOOD_PICKET", s: "3a94ea18-0c07-4052-a92c-f8c1a8ef9b05", p: 3.25, cov: null, h: null, c: "" },
  { t: "WOOD", role: "WOOD_RAIL", s: "5fc1c947-e8ff-41ad-8ade-b2bf6ad70e15", p: 6.5, cov: null, h: null, c: "" },
  { t: "CHAIN_LINK", role: "CHAIN_FABRIC", s: "dbbf6561-d5d0-4128-b2b7-c1f8d826d082", p: 3.1, cov: 4, h: null, c: "" },
  { t: "CHAIN_LINK", role: "CHAIN_FABRIC", s: "1d88cbe2-1852-4c05-bd7e-73a45375c727", p: 4.35, cov: 6, h: null, c: "" },
  { t: "CHAIN_LINK", role: "CHAIN_FABRIC", s: "6f034605-e85e-411d-a176-8a6bdd083381", p: 5.6, cov: 8, h: null, c: "" },
  { t: "CHAIN_LINK", role: "CORNER_POST", s: "5fe85f90-e7d4-4304-81ce-880193286d68", p: 19.75, cov: null, h: null, c: "" },
  { t: "CHAIN_LINK", role: "END_POST", s: "043eb7eb-b1b3-4963-bcf0-e9aa075a6e44", p: 19.75, cov: null, h: null, c: "" },
  { t: "CHAIN_LINK", role: "LINE_POST", s: "6732a9e5-5fdc-48b4-ade1-dc9fa498fbd4", p: 11.5, cov: null, h: null, c: "" },
  { t: "CHAIN_LINK", role: "POST_CAP", s: "0f5c775f-17c5-4c35-bfb7-fa21e2c2e630", p: 1.1, cov: null, h: null, c: "" },
  { t: "CHAIN_LINK", role: "RAIL_END", s: "04da9043-5217-4a75-8ca1-52e328e05e4e", p: 1.6, cov: null, h: null, c: "" },
  { t: "CHAIN_LINK", role: "TENSION_BAND", s: "26e8460b-b1d1-414b-9619-f074281a50f8", p: 1.05, cov: null, h: null, c: "" },
  { t: "CHAIN_LINK", role: "BRACE_BAND", s: "409aebdb-8362-4e0c-a511-3541a2c82d05", p: 1.35, cov: null, h: null, c: "" },
  { t: "CHAIN_LINK", role: "TOP_RAIL", s: "38b6e5da-a3c5-4644-bbef-a24a4b13d92b", p: 2.1, cov: null, h: null, c: "" },
];

/* ===================================================================== *
 * THE TRANSCRIPTION. EstimateEngine, the parts a type change moves.
 * ===================================================================== */
const PANEL_TYPES = new Set(["VINYL", "ALUMINUM", "ORNAMENTAL_IRON"]);
const PICKET_TYPES = new Set(["WOOD", "COMPOSITE"]);
const HEIGHT_FILTERED_ROLES = new Set([
  "PANEL", "GATE_PANEL", "LINE_POST", "END_POST", "CORNER_POST", "GATE_POST", "BLANK_POST",
]);
const WASTE_ROLES = new Set([
  "PANEL", "WOOD_PICKET", "WOOD_RAIL", "CHAIN_FABRIC", "TOP_RAIL", "TENSION_WIRE",
  "PRIVACY_SLAT", "CONCRETE_BAG", "TRIM",
]);

/** FenceRunListViewModel.defaultSpacingFor. */
function spacingFor(type, panelWidthFt, fallback) {
  if (PANEL_TYPES.has(type)) return panelWidthFt;
  if (PICKET_TYPES.has(type)) return 8;
  if (type === "CHAIN_LINK") return 10;
  if (type === "SPLIT_RAIL") return 8;
  return fallback;
}

/** EstimateEngine.computePostCounts, with no joints (joinAdjustment == null). */
function postCounts({ corners, ends, gates, postSpacingFt, netFt }) {
  const gateCount = gates.length;
  const gatePosts = gates.reduce((n, g) => n + (g.mounting === "LINE_TO_WALL" ? 3 : 2), 0);
  const bays = postSpacingFt > 0 ? Math.round(Math.ceil(netFt / postSpacingFt)) : 0;
  const standard = bays === 0
    ? 0
    : ends === 0
      ? Math.max(bays - gateCount, 0)
      : Math.max(bays + 1 - gateCount, 0);
  const linePosts = Math.max(standard - corners - ends, 0);
  return {
    linePosts, cornerPosts: corners, endPosts: ends, gatePosts,
    terminalPosts: corners + ends + gatePosts,
    totalPosts: linePosts + corners + ends + gatePosts,
  };
}

/** EstimateEngine.suggestQuantities, the entry list only (no gates in these fixtures). */
function suggestEntries(run, netFt) {
  const pc = postCounts({
    corners: run.corners, ends: run.ends, gates: run.gates || [],
    postSpacingFt: run.postSpacingFt, netFt,
  });
  let entries = [];
  if (PANEL_TYPES.has(run.fenceType)) {
    const panelCount = run.panelWidthFt > 0 ? Math.round(Math.ceil(netFt / run.panelWidthFt)) : 0;
    entries = [
      { role: "PANEL", q: panelCount, prefer: run.panelWidthFt, covers: netFt },
      { role: "LINE_POST", q: pc.linePosts },
      { role: "CORNER_POST", q: pc.cornerPosts },
      { role: "END_POST", q: pc.endPosts },
      { role: "POST_CAP", q: pc.totalPosts },
    ];
  } else if (PICKET_TYPES.has(run.fenceType)) {
    const bays = run.postSpacingFt > 0 ? Math.round(Math.ceil(netFt / run.postSpacingFt)) : 0;
    const pitch = Math.max(run.picketWidthIn + run.picketGapIn, 0.5);
    entries = [
      { role: "WOOD_PICKET", q: Math.round(Math.ceil((netFt * 12) / pitch)) },
      { role: "WOOD_RAIL", q: bays * run.woodRailCount },
      { role: "LINE_POST", q: pc.linePosts },
      { role: "CORNER_POST", q: pc.cornerPosts },
      { role: "END_POST", q: pc.endPosts },
      { role: "POST_CAP", q: pc.totalPosts },
    ];
  } else if (run.fenceType === "CHAIN_LINK") {
    const bands = Math.max(Math.round(Math.ceil(run.fabricHeightFt)), 1);
    entries = [
      { role: "CHAIN_FABRIC", q: netFt, prefer: run.fabricHeightFt },
      { role: "LINE_POST", q: pc.linePosts },
      { role: "CORNER_POST", q: pc.cornerPosts },
      { role: "END_POST", q: pc.endPosts },
      { role: "POST_CAP", q: pc.totalPosts },
      { role: "TENSION_BAND", q: pc.terminalPosts * bands },
      { role: "BRACE_BAND", q: pc.terminalPosts },
    ];
    if (run.includeTopRail !== false) {
      entries.push({ role: "TOP_RAIL", q: netFt });
      entries.push({ role: "RAIL_END", q: pc.terminalPosts });
    }
  }
  // Concrete: non-gate posts, then wholeBags rounds the sum up once.
  const nonGate = Math.max(pc.totalPosts - pc.gatePosts, 0);
  entries.push({ role: "CONCRETE_BAG", q: nonGate * run.concreteBagsPerPost });
  return { entries, pc };
}

/** EstimateEngine.applyWaste + wholeBags. */
function finishEntries(entries, wastePercent) {
  let out = entries;
  if (wastePercent > 0) {
    const f = 1 + wastePercent / 100;
    out = out.map((e) => {
      if (!WASTE_ROLES.has(e.role)) return e;
      if (e.role === "CONCRETE_BAG") return { ...e, q: e.q * f };
      return { ...e, q: Math.ceil(e.q * f) };
    });
  }
  const bagTotal = out.filter((e) => e.role === "CONCRETE_BAG").reduce((n, e) => n + e.q, 0);
  if (bagTotal > 0) {
    out = out.filter((e) => e.role !== "CONCRETE_BAG")
      .concat([{ role: "CONCRETE_BAG", q: Math.ceil(bagTotal) }]);
  }
  return out.filter((e) => e.q > 0);
}

/**
 * EstimateEngine.buildLineItems. `narrowByType` is the switch the canary
 * flips: with it off, the catalog is NOT narrowed to the run's own type, which
 * is the version of the engine this file has to be able to catch.
 */
function buildLineItems(run, entries, catalog, { narrowByType = true } = {}) {
  const base = catalog.filter((i) =>
    narrowByType ? (i.t === run.fenceType || i.t === "UNIVERSAL") : true);
  const items = [];
  const unmatched = [];
  for (const entry of entries) {
    let candidates = base.filter((i) => i.role === entry.role);
    if (candidates.length === 0) { unmatched.push(entry.role); continue; }
    if (run.colorOrFinish) {
      const m = candidates.filter((i) => i.c.toLowerCase() === run.colorOrFinish.toLowerCase());
      if (m.length) candidates = m;
    }
    if (HEIGHT_FILTERED_ROLES.has(entry.role)) {
      const cur = candidates;
      candidates = cur.filter((c) =>
        c.h === run.panelHeightFt ||
        !cur.some((d) => d.cov === c.cov && d.h === run.panelHeightFt));
    }
    let chosen;
    if (entry.prefer != null) {
      const priced = candidates.filter((i) => i.p > 0);
      const pool = priced.length ? priced : candidates;
      chosen = pool.slice().sort((a, b) =>
        Math.abs((a.cov ?? entry.prefer) - entry.prefer) - Math.abs((b.cov ?? entry.prefer) - entry.prefer)
        || a.p - b.p || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))[0];
    } else {
      chosen = candidates.slice().sort((a, b) =>
        (a.p <= 0) - (b.p <= 0) || a.p - b.p || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))[0];
    }
    if (!chosen) { unmatched.push(entry.role); continue; }
    let q = entry.q;
    if (entry.role === "PANEL" && entry.prefer != null && entry.covers != null) {
      const actual = chosen.cov ?? entry.prefer;
      if (actual > 0 && Math.abs(actual - entry.prefer) > 0.01) {
        q = Math.ceil(entry.covers / actual);
      }
    }
    items.push({ role: entry.role, sku: chosen.s, unit: chosen.p, q, line: money(q * chosen.p) });
  }
  return { items, unmatched, total: money(items.reduce((n, i) => n + i.line, 0)) };
}

function priceSide(run, netFt, opts = {}) {
  const { entries } = suggestEntries(run, netFt);
  return buildLineItems(run, finishEntries(entries, run.wastePercent || 0), CATALOG, opts);
}

/* ===================================================================== *
 * THE TRANSCRIPTION. RunTypeChange.
 * ===================================================================== */
const isUsable = (v) => Number.isFinite(v) && v > 0;

/** RunTypeChange.defaultTypeFor. `ignoreSiblings` is canary 1. */
function defaultTypeFor(siblings, { ignoreSiblings = false } = {}) {
  if (ignoreSiblings) return "VINYL";
  const eligible = siblings.filter((r) => !r.isTeardown);
  if (eligible.length === 0) return "VINYL";
  const last = eligible.slice().sort((a, b) =>
    a.sortOrder - b.sortOrder || a.id - b.id).at(-1);
  return last.fenceType;
}

/** RunTypeChange.apply. `dropHeightCarry` is canary 3. */
function applyType(run, newType, { dropHeightCarry = false } = {}) {
  if (run.fenceType === newType) return run;
  const next = {
    ...run,
    fenceType: newType,
    postSpacingFt: spacingFor(newType, run.panelWidthFt, run.postSpacingFt),
  };
  if (dropHeightCarry) return next;
  if (newType === "CHAIN_LINK" && isUsable(run.panelHeightFt)) {
    next.fabricHeightFt = run.panelHeightFt;
  } else if (run.fenceType === "CHAIN_LINK" && isUsable(run.fabricHeightFt)) {
    next.panelHeightFt = run.fabricHeightFt;
  }
  return next;
}

/** RunTypeChange.specProblem. */
function specProblem(run) {
  if (!isUsable(run.postSpacingFt)) return "POST_SPACING";
  if (PANEL_TYPES.has(run.fenceType)) {
    if (!isUsable(run.panelWidthFt)) return "PANEL_WIDTH";
    if (!isUsable(run.panelHeightFt)) return "PANEL_HEIGHT";
    return null;
  }
  if (PICKET_TYPES.has(run.fenceType)) {
    if (!isUsable(run.picketWidthIn + run.picketGapIn)) return "PICKET_PITCH";
    if (run.woodRailCount <= 0) return "RAIL_COUNT";
    return null;
  }
  if (run.fenceType === "CHAIN_LINK") {
    return isUsable(run.fabricHeightFt) ? null : "FABRIC_HEIGHT";
  }
  if (run.fenceType === "SPLIT_RAIL") {
    return run.splitRailCount > 0 ? null : "RAIL_COUNT";
  }
  return null;
}

/** A side as the entity defaults it, 100 ft long, open, no corners. */
const side = (over = {}) => ({
  id: 1, sortOrder: 0, isTeardown: false, label: "",
  fenceType: "VINYL", colorOrFinish: "",
  panelWidthFt: 6, panelHeightFt: 6, postSpacingFt: 6, concreteBagsPerPost: 1,
  woodRailCount: 3, picketWidthIn: 5.5, picketGapIn: 0,
  fabricHeightFt: 4, includeTopRail: true, splitRailCount: 2,
  corners: 0, ends: 2, gates: [], wastePercent: 0,
  ...over,
});

/* ===================================================================== *
 * 1. A NEW SIDE INHERITS THE TYPE THE JOB IS ALREADY USING.
 * ===================================================================== */
console.log("\n1. The default a new side gets");

const typechange = read(TYPECHANGE);
// Comments stripped FIRST. The prose explaining why this file is pure
// mentions Repository and Context, and a check that reads the explanation
// instead of the code is the "grep the region, not the body" mistake that
// called correct code broken three times in one day on this project.
const typechangeCode = typechange
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
ok("1a", "defaultTypeFor exists and is pure (no Repository, no Context in the CODE)",
  /fun defaultTypeFor\(siblings: List<FenceRun>\): FenceType/.test(typechangeCode) &&
  !/\bRepository\b|\bContext\b/.test(typechangeCode));
ok("1a-canary", "PLANTED: the purity check fails once a Repository is taken",
  /\bRepository\b/.test(typechangeCode + "\nclass X(private val r: Repository)"));

eq("1b", "no sides yet falls back to VINYL, the entity default",
  defaultTypeFor([]), "VINYL");
eq("1c", "one wood side on the job: the next side is wood",
  defaultTypeFor([side({ fenceType: "WOOD", sortOrder: 0 })]), "WOOD");
eq("1d", "last side wins by sortOrder, not list order",
  defaultTypeFor([
    side({ id: 2, fenceType: "CHAIN_LINK", sortOrder: 2 }),
    side({ id: 1, fenceType: "WOOD", sortOrder: 0 }),
  ]), "CHAIN_LINK");
eq("1e", "a sortOrder tie is broken by id, the same way the run picker does",
  defaultTypeFor([
    side({ id: 7, fenceType: "WOOD", sortOrder: 1 }),
    side({ id: 9, fenceType: "ALUMINUM", sortOrder: 1 }),
  ]), "ALUMINUM");
// The one that is easy to get wrong, and costs him money when it is.
eq("1f", "a TEARDOWN side is ignored: pulling a wood fence out does not make the new side wood",
  defaultTypeFor([
    side({ id: 1, fenceType: "WOOD", sortOrder: 0, isTeardown: true }),
    side({ id: 2, fenceType: "VINYL", sortOrder: 1 }),
  ]), "VINYL");
eq("1g", "a job whose ONLY side is a teardown still falls back to VINYL, not to the old fence",
  defaultTypeFor([side({ fenceType: "WOOD", isTeardown: true })]), "VINYL");

// Where it is actually wired in. The job screen's dialog (allowed to edit),
// and the drawing screen's quick-add (an anchored edit for the orchestrator).
const jobDetail = read(JOBDETAIL);
ok("1h", "the Add dialog opens on the inherited type, not a hardcoded VINYL",
  /initialType = com\.fenceestimator\.app\.ui\.runs\.RunTypeChange\.defaultTypeFor\(existingRuns\)/.test(jobDetail) &&
  /var type by remember \{ mutableStateOf\(initialType\) \}/.test(jobDetail));
ok("1h-canary", "PLANTED: that check fails if the dialog goes back to a constant",
  !/var type by remember \{ mutableStateOf\(initialType\) \}/.test(
    jobDetail.replace("mutableStateOf(initialType)", "mutableStateOf(FenceType.VINYL)")));

// SurveyViewModel is owned by another wave this run; the edit is reported as
// an anchor, so this check is EXPECTED TO FAIL until the orchestrator applies
// it. Reported, not hidden.
const surveyVm = read(SURVEYVM);
const QUICKADD_INHERITS = /fenceType = RunTypeChange\.defaultTypeFor\(siblings\)/;
pending("1i", "the drawing screen's quick-add inherits the type too",
  QUICKADD_INHERITS.test(surveyVm),
  "SurveyViewModel.kt is owned by another wave this run, so this edit is handed to " +
  "the orchestrator as an anchor. Until it lands, a side added from the drawing " +
  "screen's + menu is still VINYL whatever the job already is.");

/* ===================================================================== *
 * 2. SETTING A SIDE'S TYPE CHANGES WHICH ROWS ARE PICKED, AND THE PRICE.
 *    Measured on his real catalog.
 * ===================================================================== */
console.log("\n2. A type change moves the money");

const vinylSide = side();
const vinyl = priceSide(vinylSide, 100);
const woodSide = applyType(vinylSide, "WOOD");
const wood = priceSide(woodSide, 100);

eq("2a", "the wood side's post spacing followed the type (6 ft -> 8 ft)",
  woodSide.postSpacingFt, 8);
eq("2b", "VINYL picks panels, line/end posts, caps and concrete",
  vinyl.items.map((i) => i.role).sort(),
  ["CONCRETE_BAG", "END_POST", "LINE_POST", "PANEL", "POST_CAP"]);
eq("2c", "WOOD picks pickets and rails instead of panels -- different ROWS, not a relabel",
  wood.items.map((i) => i.role).sort(),
  ["CONCRETE_BAG", "END_POST", "LINE_POST", "POST_CAP", "WOOD_PICKET", "WOOD_RAIL"]);
ok("2d", "not one catalog row is shared between the two (except the UNIVERSAL concrete bag)",
  vinyl.items.filter((i) => i.role !== "CONCRETE_BAG")
    .every((i) => !wood.items.some((w) => w.sku === i.sku)));

eq("2e", "VINYL 100 ft prices $1318.17 on his catalog", vinyl.total, 1318.17);
eq("2f", "WOOD 100 ft prices $1196.25 on his catalog", wood.total, 1196.25);
eq("2g", "so switching that one side costs $121.92 less in material",
  money(vinyl.total - wood.total), 121.92);
ok("2h", "and the price genuinely MOVED -- a picker that only changed a label is the fake feature",
  vinyl.total !== wood.total);

// The engine's height filter is what makes the vinyl pick right in the first
// place: the 4 ft rows must not win a 6 ft run.
eq("2i", "the vinyl line post chosen is a 6 ft row, not the cheaper 4 ft one",
  vinyl.items.find((i) => i.role === "LINE_POST").unit, 16.56);

/* ===================================================================== *
 * 3. HEIGHT CARRIES ACROSS. THE SUBTLE ONE.
 * ===================================================================== */
console.log("\n3. Spec fields on a type switch");

ok("3a", "apply() carries panelHeightFt into fabricHeightFt going to chain link",
  /newType == FenceType\.CHAIN_LINK && isUsable\(run\.panelHeightFt\)/.test(typechange));
ok("3b", "and back out again leaving chain link",
  /run\.fenceType == FenceType\.CHAIN_LINK && isUsable\(run\.fabricHeightFt\)/.test(typechange));

const sixFoot = side({ panelHeightFt: 6, fabricHeightFt: 4 });
const toChain = applyType(sixFoot, "CHAIN_LINK");
eq("3c", "a 6 ft side switched to chain link is 6 ft of fabric, not the 4 ft default",
  toChain.fabricHeightFt, 6);

const chainRight = priceSide(toChain, 100);
const chainWrong = priceSide(applyType(sixFoot, "CHAIN_LINK", { dropHeightCarry: true }), 100);
eq("3d", "with the carry, the 6 ft roll at $4.35/ft is chosen",
  chainRight.items.find((i) => i.role === "CHAIN_FABRIC").unit, 4.35);
eq("3e", "without it, the 4 ft roll at $3.10/ft is chosen -- the WRONG MATERIAL on a 6 ft fence",
  chainWrong.items.find((i) => i.role === "CHAIN_FABRIC").unit, 3.1);
eq("3f", "which is a $125.00 undercharge on 100 ft of fabric alone",
  money(chainRight.items.find((i) => i.role === "CHAIN_FABRIC").line -
    chainWrong.items.find((i) => i.role === "CHAIN_FABRIC").line), 125);

// Nothing is cleared. Switching back must not lose what he typed.
const typedWide = side({ panelWidthFt: 8, postSpacingFt: 8 });
const roundTrip = applyType(applyType(typedWide, "WOOD"), "VINYL");
eq("3g", "a round trip through WOOD keeps the 8 ft panel width he typed",
  roundTrip.panelWidthFt, 8);
eq("3h", "and restores vinyl's spacing-follows-panel rule on the way back",
  roundTrip.postSpacingFt, 8);
ok("3i", "apply() clears nothing: no field is set to 0 anywhere in it",
  !/= 0f\b|= 0\b/.test(typechange.split("fun apply(")[1].split("fun isUsable")[0]));

// An empty required spec must READ as not set, never PRICE as zero.
eq("3j", "a vinyl side with panelWidthFt 0 is reported as not set, not priced",
  specProblem(side({ panelWidthFt: 0 })), "PANEL_WIDTH");
eq("3k", "a chain-link side with fabricHeightFt 0 is reported as not set",
  specProblem(side({ fenceType: "CHAIN_LINK", postSpacingFt: 10, fabricHeightFt: 0 })), "FABRIC_HEIGHT");
eq("3l", "a wood side with a zero picket pitch is reported, not billed at 24 pickets a foot",
  specProblem(side({ fenceType: "WOOD", postSpacingFt: 8, picketWidthIn: 0, picketGapIn: 0 })), "PICKET_PITCH");
eq("3m", "post spacing 0 is refused for every type before anything else",
  specProblem(side({ postSpacingFt: 0 })), "POST_SPACING");
eq("3n", "a NaN is refused the same way a zero is",
  specProblem(side({ panelWidthFt: Number.NaN })), "PANEL_WIDTH");
eq("3o", "a properly spec'd side reports no problem", specProblem(side()), null);
// And the thing the refusal is FOR: without it, the engine bills nothing and
// says nothing.
const zeroWidth = priceSide(side({ panelWidthFt: 0, postSpacingFt: 6 }), 100);
ok("3p", "a zero panel width silently drops the PANEL line entirely -- which is why the refusal is raised at the field",
  !zeroWidth.items.some((i) => i.role === "PANEL"));

/* ===================================================================== *
 * 4. A MIXED JOB PRICES EACH SIDE FROM ITS OWN TYPE.
 * ===================================================================== */
console.log("\n4. A mixed job, and the re-price that was missing");

const jobSides = [
  side({ id: 1, sortOrder: 0, fenceType: "VINYL" }),
  side({ id: 2, sortOrder: 1, fenceType: "WOOD", postSpacingFt: 8 }),
  side({ id: 3, sortOrder: 2, fenceType: "CHAIN_LINK", postSpacingFt: 10, fabricHeightFt: 6 }),
];
const perSide = jobSides.map((r) => priceSide(r, 100));
// Hand-checked, chain link side: 100 ft at 10 ft spacing with 6 ft fabric and
// 2 ends gives 10 bays, 11 posts (9 line + 2 end), 2 terminal posts. So
// fabric 100 x 4.35 = 435.00, line posts 9 x 11.50 = 103.50, end posts
// 2 x 19.75 = 39.50, caps 11 x 1.10 = 12.10, tension bands 12 x 1.05 = 12.60,
// brace bands 2 x 1.35 = 2.70, top rail 100 x 2.10 = 210.00, rail ends
// 2 x 1.60 = 3.20, concrete 11 x 4.75 = 52.25. Total 870.85.
eq("4a", "three sides at 100 ft each price three different totals from their own types",
  perSide.map((p) => p.total), [1318.17, 1196.25, 870.85]);
ok("4b", "no two sides share a PANEL-equivalent row",
  new Set(perSide.map((p) => p.items[0].sku)).size === 3);
eq("4c", "the job's material total is the sum of the sides, not one type applied to all three",
  money(perSide.reduce((n, p) => n + p.total, 0)), 3385.27);
// The counter-case: one type applied to the whole job.
const asIfAllVinyl = money(jobSides.map((r) => priceSide({ ...r, fenceType: "VINYL", postSpacingFt: 6 }, 100).total)
  .reduce((n, t) => n + t, 0));
eq("4d", "quoting all three as vinyl would OVERCHARGE by $569.24 -- the error a per-JOB type would make",
  money(asIfAllVinyl - 3385.27), 569.24);

// The re-price itself.
const refresher = read(REFRESHER);
ok("4e", "there is a re-price entry point for a type change",
  /suspend fun refreshAfterTypeChange\(/.test(refresher));
ok("4f", "it refuses a side nobody has priced yet rather than inventing an estimate",
  /if \(priced\.isEmpty\(\)\) return TypeChangeResult\.NOT_PRICED/.test(refresher));
ok("4g", "it CLEARS rather than leaving the old type's lines when the new type prices nothing",
  /CLEARED_NOTHING_PRICED/.test(refresher) &&
  /replaceAutoGeneratedLineItemsForRun\(run\.id, emptyList\(\)\)[\s\S]{0,80}CLEARED_NOTHING_PRICED/.test(refresher));
ok("4h", "pricingSignature still includes fenceType (it subtracts only identity, clock, label, order, template)",
  /fun pricingSignature\(run: FenceRun\): String =[\s\S]{0,400}buildTemplateSyncId = null/.test(refresher) &&
  !/fenceType\s*=\s*FenceType/.test(refresher.split("fun pricingSignature(")[1].split("/**")[0]));

const runEditVm = read(RUNEDITVM);
ok("4i", "the run editor's picker now re-prices (it used to write the row and stop)",
  /fun setFenceType\(/.test(runEditVm) &&
  /TakeoffRefresher\.refreshAfterTypeChange\(/.test(runEditVm));
const runEdit = read(RUNEDIT);
ok("4j", "and the screen routes the dropdown through it, not through the generic update()",
  /FenceTypeDropdown\(currentRun\.fenceType, editable\) \{ newType ->\s*viewModel\.setFenceType\(newType\)/.test(runEdit));
ok("4j-canary", "PLANTED: that check fails if the screen goes back to writing the row directly",
  !/viewModel\.setFenceType\(newType\)/.test(
    runEdit.replace("viewModel.setFenceType(newType)", "viewModel.update { r -> r.copy(fenceType = newType) }")));

const sideVm = read(SIDEVM);
ok("4k", "the drawing screen's card re-prices through the SAME two steps",
  /RunTypeChange\.apply\(fresh, newType\)/.test(sideVm) &&
  /TakeoffRefresher\.refreshAfterTypeChange\(/.test(sideVm));
ok("4l", "and refuses a guest before the repository is ever reached",
  /isGuestDemo[\s\S]{0,200}return[\s\S]{0,400}repository\.getFenceRun/.test(sideVm));

/* ===================================================================== *
 * 5. ONE PICKER, AND THE TYPE ON EVERY SURFACE COMES FROM THE RUN.
 * ===================================================================== */
console.log("\n5. One picker; every surface reads the run");

const picker = read(PICKER);
ok("5a", "the picker is now shared, not private to one screen",
  /^fun FenceTypeDropdown\(/m.test(picker));
ok("5b", "RunEditScreen no longer defines a second one",
  !/private fun FenceTypeDropdown\(/.test(runEdit));
ok("5c", "UNIVERSAL is still filtered out of the offered list (it prices nothing)",
  /filter \{ it != FenceType\.UNIVERSAL \}/.test(picker));
ok("5d", "the card uses that picker rather than a third",
  /FenceTypeDropdown\(/.test(read(CARD)) && !/ExposedDropdownMenuBox/.test(read(CARD)));

// Each surface, read live off the run. A copy is what would go stale.
ok("5e", "crew plan spec row reads run.fenceType",
  /SpecRow\(stringResource\(R\.string\.crew_plan_spec_type\), run\.fenceType\.label\(\)\)/.test(read(CREWPLAN)));
ok("5f", "the drawing screen's run picker reads run.fenceType into its label",
  /\$\{run\.fenceType\.label\(\)\}/.test(read(SURVEYSCREEN)));
ok("5g", "the PDF contract/estimate heading reads run.fenceType",
  /run\.fenceType\.label/.test(read(PDF)));
ok("5h", "quote-view selects fence_type per run and returns it per run",
  /select\("label, fence_type/.test(read(QUOTEVIEW)) && /type: r\.fence_type/.test(read(QUOTEVIEW)));
ok("5i", "the reports chart groups by each run's own type",
  /val key = run\.fenceType\.name/.test(read(REPORTSVM)));
ok("5j", "the job screen's fence-run list reads run.fenceType",
  /run\.fenceType\.label\(\)/.test(jobDetail));
ok("5k", "defaultSpacingFor is still the ONE spacing table, and RunTypeChange defers to it",
  /fun defaultSpacingFor\(/.test(read(RUNLISTVM)) &&
  /FenceRunListViewModel\.defaultSpacingFor\(type, panelWidthFt, fallback\)/.test(typechange));

// The two surfaces that do NOT follow, named here so they are not mistaken
// for clean. Both are asserted as the CURRENT state, so the day either is
// fixed this check fails and says so.
ok("5l", "KNOWN GAP (asserted): the plan LEGEND has no fence-type entry at all",
  !/fenceType/.test(read(PLANVIEW)),
  "if this now fails, the legend learned the type -- update the report");
ok("5m", "KNOWN GAP (asserted): the HOA letter still takes the FIRST run's type for the whole job",
  /fenceType = firstRun\?\.fenceType/.test(jobDetail),
  "if this now fails, the HOA letter was fixed -- update the report");

/* ===================================================================== *
 * 6. RE-APPROVAL. Against the LIVE function body, not the repo .sql.
 * ===================================================================== */
console.log("\n6. Re-approval on a type change");

/**
 * Transcribed from the LIVE body of public.reapp_row_takeoff, read out of
 * pg_proc on 2 Oct 2026 (read-only; positive control: the body contains
 * "points_encoded"; canary: it does not contain "zzz_canary_never_present").
 *
 * THE REPO FILE AND THE LIVE FUNCTION DISAGREE, which is exactly why the live
 * one was read. supabase_reapproval_on_drawing_change.sql defines
 * reapp_row_takeoff as a three-line passthrough with no fence_type in it at
 * all. The LIVE one is 2093 characters and DOES mention fence_type -- but only
 * inside a tail that four clauses gate off.
 */
function liveFingerprint(run) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sj = uuid.test(run.startJoint || "") ? run.startJoint : "";
  const ej = uuid.test(run.endJoint || "") ? run.endJoint : "";
  // The geometry half (reapp_run_takeoff) reads points, gates, closedLoop,
  // manual feet/corners and isTeardown. It does NOT read fence_type.
  const fp = `b=${run.builtFt.toFixed(1)}|t=${run.tearFt.toFixed(1)}` +
    `|c=${run.corners}|e=${run.ends}|g=${run.gateCount}` +
    `|gf=${run.gateFt.toFixed(1)}|gm=${run.mounts || ""}`;
  const empty = fp === "b=0.0|t=0.0|c=0|e=0|g=0|gf=0.0|gm=";
  if ((sj === "" && ej === "") || run.isTeardown || run.closedLoop || empty) return fp;
  return fp + `|sj=${sj}|ej=${ej}|jf=${run.fenceType || ""}` +
    `|jph=${(run.panelHeightFt || 0).toFixed(2)}` +
    `|jfh=${(run.fabricHeightFt || 0).toFixed(2)}|jso=${run.sortOrder || 0}`;
}

const approved = {
  builtFt: 100, tearFt: 0, corners: 0, ends: 2, gateCount: 0, gateFt: 0, mounts: "",
  isTeardown: false, closedLoop: false, startJoint: "", endJoint: "",
  fenceType: "VINYL", panelHeightFt: 6, fabricHeightFt: 0, sortOrder: 0,
};
const J = "11111111-2222-4333-8444-555555555555";

// THE FINDING. Stated as a test so it cannot be quietly forgotten.
ok("6a", "FINDING: on an UNJOINTED side, a VINYL -> WOOD change does NOT move the live fingerprint",
  liveFingerprint(approved) === liveFingerprint({ ...approved, fenceType: "WOOD" }),
  "if this now FAILS, the live function learned fence_type unconditionally -- good, update the report");
ok("6b", "on a JOINTED, open, non-teardown side it DOES move -- but only incidentally",
  liveFingerprint({ ...approved, startJoint: J }) !==
  liveFingerprint({ ...approved, startJoint: J, fenceType: "WOOD" }));
ok("6c", "the joint tail is also what carries panel height, so a height change moves it there too",
  liveFingerprint({ ...approved, startJoint: J }) !==
  liveFingerprint({ ...approved, startJoint: J, panelHeightFt: 4 }));
ok("6d", "POSITIVE CONTROL: a footage change moves the fingerprint on every side, jointed or not",
  liveFingerprint(approved) !== liveFingerprint({ ...approved, builtFt: 120 }) &&
  liveFingerprint({ ...approved, startJoint: J }) !==
  liveFingerprint({ ...approved, startJoint: J, builtFt: 120 }));
ok("6e", "CANARY: an identical row must produce an identical fingerprint",
  liveFingerprint(approved) === liveFingerprint({ ...approved }));
// And what the rule document says is in scope, so the gap is measured against
// the written rule rather than against an opinion.
const RULE = read("docs/REAPPROVAL_RULE.md");
ok("6f", "the written rule's fingerprint table lists footage, corners, ends and gates",
  /built linear feet/.test(RULE) && /corner count/.test(RULE) && /gate mountings/.test(RULE));
ok("6g", "and does NOT list the fence type -- so the gap is in the RULE, not only the code",
  !/fence type|fence_type/i.test(RULE.split("## What counts")[1].split("## What happens")[0]));

/* ===================================================================== *
 * 7. THE CANARIES. ALL THREE MUST FAIL.
 * ===================================================================== */
console.log("\n7. Canaries -- every one of these MUST fail");

let canariesFailed = 0;
function canary(id, what, cond) {
  // cond is the assertion a BROKEN version would have to satisfy. It must be
  // false.
  if (!cond) {
    canariesFailed++;
    console.log(`  ok    ${id} FAILED AS REQUIRED: ${what}`);
  } else {
    failed++;
    failedIds.push(id);
    console.log(`  FAIL  ${id} CANARY PASSED, so this file proves nothing: ${what}`);
  }
}

// 1. A default that ignores the job's own sides.
canary("7a", "a defaultTypeFor that ignores the job's sides still inherits WOOD",
  defaultTypeFor([side({ fenceType: "WOOD" })], { ignoreSiblings: true }) === "WOOD");

// 2. An engine that does not narrow the catalog by the run's type.
const woodNoNarrow = priceSide(woodSide, 100, { narrowByType: false });
canary("7b", "an engine with no type narrowing still prices a wood side at the wood total",
  woodNoNarrow.total === 1196.25);
canary("7c", "and still keeps vinyl rows out of a wood side's materials",
  !woodNoNarrow.items.some((i) => CATALOG.find((r) => r.s === i.sku)?.t === "VINYL"));

// 3. An apply() that drops the height carry.
canary("7d", "an apply() with no height carry still gives a 6 ft side 6 ft of fabric",
  applyType(sixFoot, "CHAIN_LINK", { dropHeightCarry: true }).fabricHeightFt === 6);

console.log(`\n${canariesFailed}/4 canaries failed as required.`);
console.log(`\n${passed} passed, ${failed} failed, ${pendingCount} pending anchored edit(s)`);
if (failedIds.length) console.log(`failed: ${failedIds.join(", ")}`);
if (pendingCount) {
  console.log("PENDING: an edit to a file another wave owns has not been applied yet. " +
    "This run is NOT green until it is.");
}
process.exit(failed > 0 || pendingCount > 0 ? 1 : 0);
