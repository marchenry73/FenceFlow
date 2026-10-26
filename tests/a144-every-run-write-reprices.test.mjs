/* A NUMBER YOU CHANGE MUST MOVE THE PRICE, OR SAY IT DID NOT.
 *
 * "here it shows that it's supposed to have seven line post but on the details
 * it shows that it has five each so that is an issue"
 *
 * Both numbers come from the same engine. They disagreed because one is
 * computed LIVE from the run every time the screen draws, and the other is
 * stored line items rewritten only when something asks for a regenerate --
 * and typing a length or a corner count asked for nothing. The readout moved,
 * the materials did not, and the quote billed 9 post caps and 9 bags of
 * concrete against 7 posts' worth of posts.
 *
 * THIS SHAPE HAS NOW BEEN WRITTEN DOWN THREE TIMES IN THIS PROJECT and fixed
 * at one call site each time:
 *   - RunEditViewModel.update carries the paragraph about a side edited on the
 *     side screen keeping the previous spec's price.
 *   - EstimateViewModel.setWastePercent opens with the owner's own words:
 *     "When I click waste allowances, it should auto update without having to
 *     click suggest quantities again."
 *   - setManualFeet, here, which is the one he hit.
 *
 * The cause is architectural: the ONLY automatic re-pricing in the app is
 * SurveyViewModel.watchDrawingForRepricing, and that watcher lives on the
 * drawing screen's view model, so it exists only while that one screen is
 * open. Every other screen that writes a fence run has to remember to
 * re-price, and remembering is what keeps failing.
 *
 * So this file makes forgetting FAIL rather than ship: every call that writes
 * a fence run must re-price inside the same function, or be named in EXEMPT
 * with a reason. A new write added anywhere is refused by default.
 *
 *   node --test tests/a144-every-run-write-reprices.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "app/src/main/java/com/fenceestimator/app");
const read = (p) => readFileSync(p, "utf8").split("\r\n").join("\n");

/** Comments stripped: a rule named only in prose must not satisfy a check. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Anything that actually rebuilds a run's priced lines. */
const REPRICES =
  /regenerateSuggested\s*\(|regenerateAll\s*\(|TakeoffRefresher\.refreshRun\s*\(|TakeoffRefresher\.refreshAfterTypeChange\s*\(/;

/**
 * Writes that deliberately do not re-price, each with the reason it is right.
 *
 * Keyed by "<path>#<function>". Every entry is checked to still exist and to
 * still contain a write -- a stale exemption is a hole that passes quietly,
 * which is the failure mode this whole file exists to stop.
 */
const EXEMPT = {
  "data/Repository.kt#deleteFenceRun":
    "The data layer freeing a joint id off a surviving run. Its public callers " +
    "(RunEditViewModel.delete, the drawing screen) re-price every remaining run " +
    "straight afterwards, which is where the decision belongs: the repository " +
    "has no session and so cannot answer mayReprice.",
  "ui/estimate/EstimateViewModel.kt#deleteLineItem":
    "Records the deleted role against the run so Suggest never rebuilds it. " +
    "Re-pricing here would fight the delete that just happened.",
  "ui/jobs/JobDetailViewModel.kt#restoreRunDrawing":
    "APPROVAL-SENSITIVE AND NOT MINE TO DECIDE. Putting a drawing back changes " +
    "the footage, so re-pricing it would move the contract total of a job the " +
    "customer has already approved. Whether a restore may do that is an owner " +
    "decision with a reapproval fingerprint behind it (docs/JOINING_RUNS.md), " +
    "not a thing to change while fixing a readout. Raised with the owner; this " +
    "entry is the record that it is known and unresolved, not that it is right.",
};

/** Every SurveyViewModel write is covered by one watcher; asserted below. */
const WATCHED_FILE = "ui/survey/SurveyViewModel.kt";

function kotlinFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...kotlinFiles(p));
    else if (name.endsWith(".kt")) out.push(p);
  }
  return out;
}

const FUN = /\n[ \t]*(?:internal |private |public |protected |override |suspend )*fun\s+([A-Za-z_][\w]*)/g;

/** The function a character offset falls inside, and that function's body. */
function enclosing(src, at) {
  FUN.lastIndex = 0;
  let name = null;
  let start = 0;
  let end = src.length;
  let m;
  const starts = [];
  while ((m = FUN.exec(src)) !== null) starts.push({ i: m.index, name: m[1] });
  for (let k = 0; k < starts.length; k++) {
    if (starts[k].i <= at) {
      name = starts[k].name;
      start = starts[k].i;
      end = k + 1 < starts.length ? starts[k + 1].i : src.length;
    } else break;
  }
  return { name, body: src.slice(start, end) };
}

/** Every place in the app that writes a fence run, outside the cloud pull. */
function writeSites() {
  const sites = [];
  for (const file of kotlinFiles(APP)) {
    const rel = relative(APP, file).split("\\").join("/");
    const src = code(read(file));
    const re = /updateFenceRun\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      // The repository's own declarations, and the cloud-pull twin that must
      // never re-price (a pull writing prices would fight the other phone).
      if (/fun\s+$/.test(before)) continue;
      if (/FromCloud\s*\($/.test(src.slice(m.index - 20, m.index + 1))) continue;
      const { name, body } = enclosing(src, m.index);
      sites.push({ rel, fn: name, body });
    }
  }
  return sites;
}

test("every write of a fence run re-prices, or is exempt with a reason", () => {
  const sites = writeSites();
  assert.ok(sites.length >= 8, `only ${sites.length} write sites found -- the scan has stopped working`);

  const offenders = [];
  for (const { rel, fn, body } of sites) {
    if (rel === WATCHED_FILE) continue;
    if (REPRICES.test(body)) continue;
    const key = `${rel}#${fn}`;
    if (Object.hasOwn(EXEMPT, key)) continue;
    offenders.push(key);
  }
  assert.deepEqual(
    offenders,
    [],
    "these write a fence run and never re-price it, so the readout and the priced lines " +
      "will disagree on that run: " + offenders.join(", "),
  );
});

test("the drawing screen's blanket exemption is earned by a watcher that still exists", () => {
  // SurveyViewModel is exempt as a FILE because one watcher covers every write
  // in it. That is only true while the watcher is there and still keyed on the
  // pricing signature -- if it is ever narrowed or removed, this exemption
  // becomes a silent hole across the busiest writer in the app.
  const src = code(read(join(APP, WATCHED_FILE)));
  assert.match(src, /private fun watchDrawingForRepricing\(\)/, "the watcher is gone");
  assert.match(
    src,
    /observeFenceRuns\(jobId\)[\s\S]{0,200}TakeoffRefresher\.pricingSignature/,
    "the watcher no longer compares every run by pricing signature",
  );
  assert.match(src, /watchDrawingForRepricing\(\)/g, "the watcher is never started");
});

test("no exemption has gone stale", () => {
  // A guard pinned to a name rots: the function gets renamed or its write
  // removed, the entry stops matching anything, and it reads as "covered".
  const sites = writeSites();
  const present = new Set(sites.map((s) => `${s.rel}#${s.fn}`));
  const stale = Object.keys(EXEMPT).filter((k) => !present.has(k));
  assert.deepEqual(stale, [], "exempted but no longer a write site: " + stale.join(", "));
});

test("the reported bug itself: typing a length or a corner count re-prices", () => {
  const src = code(read(join(APP, "ui/estimate/EstimateViewModel.kt")));
  const { body } = enclosing(src, src.indexOf("fun setManualFeet"));
  assert.match(body, REPRICES, "setManualFeet writes the row and stops -- the bug is back");
  // And it WAITS for the write, because regenerateInternal reads the run out of
  // a StateFlow that has not caught up. Re-pricing immediately prices the
  // previous number, which looks like it works.
  assert.match(
    body,
    /withTimeoutOrNull\s*\(\s*WASTE_SETTLE_MS\s*\)/,
    "setManualFeet re-prices without waiting for the write, so it prices the previous number",
  );
});

test("POSITIVE CONTROL: the scan finds real sites and the checker can fail", () => {
  const sites = writeSites();
  // It really found the known-good one, with its re-price.
  const good = sites.find((s) => s.rel === "ui/runs/SideTypesViewModel.kt" && s.fn === "setType");
  assert.ok(good, "the scan no longer finds SideTypesViewModel.setType");
  assert.match(good.body, REPRICES, "setType stopped re-pricing, or the marker list is wrong");
  // And it really would catch one that does not.
  const fake = "\n    fun writesAndForgets() {\n        repository.updateFenceRun(run)\n    }\n";
  const { name, body } = enclosing(fake, fake.indexOf("updateFenceRun"));
  assert.equal(name, "writesAndForgets");
  assert.doesNotMatch(body, REPRICES, "the marker list matches a function that does not re-price");
});
