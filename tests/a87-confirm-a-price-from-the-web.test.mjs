// a87 -- a price can be confirmed from the web, by the PHONE's rule.
//
// a25 carried this as its last honest todo: "there is no way to confirm a price
// on the web; only the phone's Confirm box (source_doc = Confirmed) does."
// catalogItemPayload never named source_doc, so saving a row in the office left
// the flag exactly as it was.
//
// It became the blocking half of another change the same night. The office's
// send gate was corrected to flag imported-unverified rows as the phone already
// did (tests/a86), so the office now REFUSES to send a quote priced off one --
// and until this, the only way to clear that was to pick up the phone. A
// stricter refusal whose remedy lives on another device is half a fix.
//
// WHAT THIS FILE IS FOR. The bug a86 fixed was these two halves disagreeing
// about this exact column, and the office's comment had claimed they agreed.
// So this does not test the office's rule on its own terms: it reads
// CatalogScreen.currentEdits out of the Kotlin, reads catalogItemPayload out of
// the page, and runs BOTH over every branch. The branches are the phone's:
//
//   startedUnverified  the row was flagged when the dialog OPENED, so ticking
//                      the box is the only thing that clears it -- editing a
//                      name must not quietly confirm a price;
//   keepsSource        a row carrying a real source (an invoice reference)
//                      keeps it while its price is unchanged, because that
//                      reference is the only record of where the price came
//                      from and "Confirmed" would destroy it;
//   price changed      no longer matches that reference, so it is stamped;
//   blank source       nothing to protect, so it is stamped;
//   unticking          does NOT un-confirm. The phone has no way back to
//                      unverified and the office must not invent one.
//
//     node --test tests/a87-confirm-a-price-from-the-web.test.mjs   (no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const KT_SEED = read("app/src/main/java/com/fenceestimator/app/data/SeedData.kt");
const KT_CAT = read("app/src/main/java/com/fenceestimator/app/ui/catalog/CatalogScreen.kt");
const DASH = read("website/dashboard.html");

const ktConst = (name) => {
  const m = new RegExp('const val ' + name + '\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(KT_SEED);
  assert.ok(m, `could not read ${name} from SeedData.kt`);
  return m[1];
};
const EM = ktConst("LABEL_DASH");
const CONFIRMED = ktConst("CONFIRMED");
const SEEDED = ktConst("SEEDED");
const IMPORTED_UNVERIFIED = ktConst("IMPORTED_UNVERIFIED");

test("0. the labels read, and the office carries the same CONFIRMED", () => {
  assert.equal(CONFIRMED, "Confirmed", "SeedData.CONFIRMED moved");
  assert.ok(SEEDED.includes(EM), "control: the seeded label was read whole");
  const m = /row\.source_doc = "([^"]*)";/.exec(DASH);
  assert.ok(m, "catalogItemPayload does not stamp a source_doc literal");
  assert.equal(m[1], CONFIRMED,
    "the office stamps a different word than the phone -- the two halves would disagree about which rows are checked, which is the bug a86 fixed");
  // INLINE, NOT A TOP-LEVEL CONST, and that is a requirement rather than taste.
  // The harnesses that exercise catalogItemPayload load the page's FUNCTIONS
  // into a scope of their own and not its consts, so a const here throws
  // "CONFIRMED_SOURCE_DOC is not defined" the moment a25 runs -- which it did.
  // The identical trap, with a labels const inside isSeededUnverifiedPrice, had
  // turned five files red an hour earlier the same night.
  const branch = /if\(form\.price_confirmed !== undefined\)\{[\s\S]*?\n  \}/.exec(DASH);
  assert.ok(branch, "catalogItemPayload has no price_confirmed branch");
  const branchCode = branch[0].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
  const free = (branchCode.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) || []);
  assert.deepEqual(free, [],
    `catalogItemPayload's source_doc branch references outer-scope name(s) ${free.join(", ")} -- every harness that calls it in isolation will throw`);
});

// ====================================================== the phone's rule, read
test("1. the phone's rule is still the four-branch one this file ports", () => {
  const i = KT_CAT.indexOf("fun currentEdits()");
  assert.ok(i > 0, "currentEdits not found in CatalogScreen.kt");
  const body = KT_CAT.slice(i, i + 1600);
  assert.match(body, /val keepsSource = !startedUnverified && item\.sourceDoc\.isNotBlank\(\) && price == item\.unitPrice/,
    "the phone's keepsSource rule changed -- the office must change with it");
  assert.match(body, /sourceDoc = if \(priceConfirmed && !keepsSource\) com\.fenceestimator\.app\.data\.CONFIRMED else item\.sourceDoc/,
    "the phone's stamp rule changed");
  assert.match(KT_CAT, /val startedUnverified = com\.fenceestimator\.app\.data\.isPlaceholderPrice\(item\.sourceDoc\)/,
    "the phone no longer decides the switch's initial state from isPlaceholderPrice");
  assert.match(KT_CAT, /var priceConfirmed by remember \{ mutableStateOf\(!startedUnverified\) \}/,
    "the switch no longer starts OFF for a flagged row, so editing a name could confirm a price");
});

/** The phone's rule, ported from that body. */
function phoneSourceDoc({ was, ticked, price, oldPrice }) {
  const startedUnverified = officeFlagged(was);
  const priceConfirmed = ticked === undefined ? !startedUnverified : ticked;
  const keepsSource = !startedUnverified && String(was).trim() !== "" && price === oldPrice;
  return priceConfirmed && !keepsSource ? CONFIRMED : was;
}

// ===================================================== the office's rule, run
/** isSeededUnverifiedPrice, out of the page. Self-contained by design (a86). */
const officeFlagged = (() => {
  const m = /function isSeededUnverifiedPrice\(sourceDoc\)\{([\s\S]*?)\n\}/.exec(DASH);
  assert.ok(m, "isSeededUnverifiedPrice not found");
  return new Function("sourceDoc", m[1]);
})();

/** catalogItemPayload's source_doc decision, out of the page. */
const officeSourceDoc = (() => {
  // THE GUARD IS PART OF THE RULE, so it is captured with the block rather
  // than stripped off it. Capturing only the inside and running that
  // unconditionally made "no box offered" look like it wrote the flag back --
  // a failure in this extraction, not in the page.
  const m = /(if\(form\.price_confirmed !== undefined\)\{[\s\S]*?\n  \})/.exec(DASH);
  assert.ok(m, "catalogItemPayload has no price_confirmed branch");
  assert.match(m[1], /^if\(form\.price_confirmed !== undefined\)\{/, "the guard was not captured");
  const body =
    "const row = {};" + m[1] +
    "\nreturn Object.prototype.hasOwnProperty.call(row,'source_doc') ? row.source_doc : undefined;";
  const fn = new Function("form", "existing", "isSeededUnverifiedPrice", "CONFIRMED_SOURCE_DOC", body);
  return ({ was, ticked, price, oldPrice }) =>
    fn({ price_confirmed: ticked, unit_price: price },
       was === null ? null : { source_doc: was, unit_price: oldPrice },
       officeFlagged, CONFIRMED);
})();

// ================================================= branch by branch, together
const CASES = [
  // label, stored source_doc, box ticked, new price, old price
  ["flagged row, box ticked -> stamped", SEEDED, true, 50, 50],
  ["flagged row, box left alone -> flag kept", SEEDED, false, 50, 50],
  ["flagged row, name edited only, box alone -> flag kept", SEEDED, false, 50, 50],
  ["imported-unverified row, ticked -> stamped", IMPORTED_UNVERIFIED, true, 50, 50],
  ["real source, price unchanged -> reference kept", "FloriFence Invoice 36499", true, 50, 50],
  ["real source, price changed -> stamped", "FloriFence Invoice 36499", true, 61.5, 50],
  ["blank source -> stamped", "", true, 50, 50],
  ["already confirmed, ticked -> stays confirmed", CONFIRMED, true, 50, 50],
];

test("2. the office and the phone agree on every branch", () => {
  for (const [label, was, ticked, price, oldPrice] of CASES) {
    const office = officeSourceDoc({ was, ticked, price, oldPrice });
    const phone = phoneSourceDoc({ was, ticked, price, oldPrice });
    assert.equal(office, phone,
      `${label}: office=${JSON.stringify(office)} phone=${JSON.stringify(phone)}`);
  }
});

test("3. the branches do what they are for -- spelled out, not just 'they agree'", () => {
  const s = (was, ticked, price = 50, oldPrice = 50) =>
    officeSourceDoc({ was, ticked, price, oldPrice });
  assert.equal(s(SEEDED, true), CONFIRMED, "ticking the box on a flagged row must clear the flag");
  assert.equal(s(SEEDED, false), SEEDED, "NOT ticking it must leave the flag -- editing a name must not confirm a price");
  assert.equal(s(IMPORTED_UNVERIFIED, true), CONFIRMED, "an imported row can be confirmed too");
  assert.equal(s("FloriFence Invoice 36499", true), "FloriFence Invoice 36499",
    "a real invoice reference must survive a save that did not change the price -- it is the only record of where the price came from");
  assert.equal(s("FloriFence Invoice 36499", true, 61.5, 50), CONFIRMED,
    "a CHANGED price no longer matches that reference, so it must be stamped");
  assert.equal(s("", true), CONFIRMED, "a blank source has nothing to protect");
  // And the box being absent entirely leaves the column off the payload, which
  // is what every caller before this change relied on.
  assert.equal(officeSourceDoc({ was: SEEDED, ticked: undefined, price: 50, oldPrice: 50 }), undefined,
    "with no box offered, source_doc must not be written at all");
});

test("4. CANARY: three plausible wrong rules each disagree with the phone", () => {
  const wrong = {
    "stamps whenever saved (ignores the box)": ({ was }) => CONFIRMED,
    "stamps over a real invoice reference": ({ was, ticked }) => (ticked ? CONFIRMED : was),
    "lets unticking un-confirm": ({ was, ticked }) => (ticked ? CONFIRMED : ""),
  };
  for (const [name, rule] of Object.entries(wrong)) {
    const disagrees = CASES.some(([, was, ticked, price, oldPrice]) =>
      rule({ was, ticked, price, oldPrice }) !== phoneSourceDoc({ was, ticked, price, oldPrice }));
    assert.ok(disagrees,
      `canary: "${name}" agrees with the phone on every case, so check 2 cannot tell a right rule from a wrong one`);
  }
});

test("5. the box is offered only where it can do something, and is wired", () => {
  // A box that cannot change anything teaches people to ignore boxes. The
  // phone's switch starts ON for a verified row and there is no way back to
  // unverified, so the office shows it only for a row that is flagged now.
  assert.match(DASH, /id="ci_confirmed_wrap"[^>]*style="display:none/,
    "the confirm box is not hidden by default");
  assert.match(DASH, /const flagged = !!existing && isSeededUnverifiedPrice\(existing\.source_doc\);/,
    "the dialog no longer decides visibility from the row's current flag");
  assert.match(DASH, /\$\('ci_confirmed'\)\.checked = false;/,
    "the box is not reset to unticked on open, so a previous row's tick could carry over");
  // Read by the save, or the box is decoration.
  assert.match(DASH, /price_confirmed: \$\('ci_confirmed_wrap'\)\.style\.display === 'none' \? undefined : \$\('ci_confirmed'\)\.checked/,
    "saveCatItemDialog does not read the box");
  // And the hint tells the owner what it is for, including the consequence.
  assert.match(DASH, /ciConfirmedHint:/, "there is no hint explaining the box");
});
