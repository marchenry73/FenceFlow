/**
 * A THOUSANDTH OF A FOOT MUST NOT BUY A BAY -- the office engine's half.
 *
 * The same four arithmetic claims as
 * app/src/test/java/com/fenceestimator/app/estimate/CountToleranceTest.kt,
 * against the same numbers. Two engines, one rule, and this is the file that
 * says so for this one.
 *
 * WHY NOT LEAVE IT TO THE PARITY FIXTURES. They are recorded FROM the phone
 * engine and replayed here, so they prove the two agree. They cannot prove
 * either is right: a fixture written after a mistake pins the mistake. These
 * assert the behaviour itself -- an exact multiple stays N, a hair over stays
 * N, a real overhang still charges N+1, and a span smaller than the slack
 * keeps the answer it always had.
 *
 * Run: npx -y tsx supabase/functions/_shared/pricing/tolerance_test.ts
 */
import { suggestQuantities } from "./takeoff.ts";
import type { FenceRun } from "./types.ts";

let failures = 0;
let checks = 0;

function eq(got: unknown, want: unknown, what: string) {
  checks++;
  if (got === want) {
    console.log(`  ok    ${what}`);
  } else {
    failures++;
    console.log(`  FAIL  ${what}\n          got ${String(got)}, want ${String(want)}`);
  }
}

/** A vinyl run with a typed footage, which is the cleanest way to aim at a boundary. */
function run(feet: number, over: Partial<FenceRun> = {}): FenceRun {
  return {
    syncId: "00000000-0000-0000-0000-000000000001",
    label: "Side",
    fenceType: "VINYL",
    sortOrder: 0,
    pointsEncoded: "",
    gatesEncoded: "",
    closedLoop: false,
    isTeardown: false,
    colorOrFinish: "",
    panelWidthFt: 8,
    panelHeightFt: 6,
    aluminumStyle: "RACKABLE",
    woodStyle: "PRIVACY",
    woodRailCount: 2,
    picketWidthIn: 5.5,
    picketGapIn: 0.5,
    fabricHeightFt: 4,
    includeTopRail: true,
    includeTensionWire: false,
    includeBarbedWireArms: false,
    includePrivacySlats: false,
    splitRailCount: 2,
    postSpacingFt: 8,
    concreteBagsPerPost: 1,
    manualLinearFeet: feet,
    manualCornerCount: 0,
    suppressedRoles: new Set(),
    startJointId: "",
    endJointId: "",
    ...over,
  } as FenceRun;
}

function qty(r: FenceRun, role: string): number {
  return suggestQuantities(r, 0)
    .entries.filter((e) => e.role === role)
    .reduce((t, e) => t + e.quantity, 0);
}

const panels = (feet: number) => qty(run(feet), "PANEL");

console.log("\n1. An exact multiple is exactly that many panels -- the case that must NOT move:");
eq(panels(96), 12, "96 ft at 8 ft panels is 12 panels");
eq(panels(8), 1, "8 ft is 1 panel");
eq(panels(400), 50, "400 ft is 50 panels");

console.log("\n2. A hair over an exact multiple is still that many -- the bug this closes:");
eq(panels(96.000008), 12, "96.000008 ft is still 12 panels, not 13");
eq(panels(96.0008), 12, "96.0008 ft (twice the worst drift measured) is still 12");
eq(panels(96.001), 12, "96.001 ft, right at the tolerance, is still 12");

console.log("\n3. An overhang a tape could read still buys the next panel:");
eq(panels(96.01), 13, "96.01 ft (an eighth of an inch) buys the 13th panel");
eq(panels(96.1), 13, "96.1 ft buys the 13th panel");
eq(panels(97), 13, "97 ft buys the 13th panel");
eq(panels(100), 13, "100 ft buys the 13th panel");

console.log("\n4. A span smaller than the tolerance keeps its old answer:");
eq(panels(0.0005), 1, "0.0005 ft still buys 1 panel, not 0");
eq(panels(0.001), 1, "0.001 ft still buys 1 panel");
eq(panels(0), 0, "nothing drawn buys nothing");

console.log("\n5. The same rule for the posts, caps and concrete the bays decide:");
for (const role of ["LINE_POST", "CORNER_POST", "END_POST", "POST_CAP"]) {
  eq(qty(run(96.000008), role), qty(run(96), role), `${role} does not move on a hair over`);
}

console.log("\n6. Pickets, whose pitch is in INCHES so the slack has to be too:");
const wood = (feet: number) => run(feet, { fenceType: "WOOD", picketWidthIn: 5.5, picketGapIn: 0.5 });
eq(qty(wood(96), "WOOD_PICKET"), 192, "96 ft at a 6 in pitch is exactly 192 pickets");
eq(qty(wood(96.000008), "WOOD_PICKET"), 192, "a hair over is still 192 pickets");
eq(qty(wood(96.05), "WOOD_PICKET"), 193, "a real overhang still buys the 193rd picket");

console.log("\n7. CANARY -- the old behaviour is detectable:");
// If this suite could not tell the fixed engine from the broken one, every
// check above is decoration. Math.ceil with no slack is what shipped until
// today. Math.fround to match the float32 the engine works in.
const brokenPanels = Math.round(Math.ceil(Math.fround(Math.fround(96.000008) / 8)));
eq(brokenPanels, 13, "PLANTED: ceil with no slack gains a panel on 96.000008 ft (proves this can fail)");
eq(panels(96.000008), 12, "and the real engine disagrees with it, which is the point");

console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
