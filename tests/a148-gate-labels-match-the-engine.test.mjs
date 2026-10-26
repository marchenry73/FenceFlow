/* THE PICKER SAID "NO CONCRETE" AND THE QUOTE CHARGED A BAG.
 *
 * "Fix the concrete on the wall gates too."
 *
 * The concrete on wall gates was right, and had been since 2026-10-05: a WALL
 * gate bolts its hinge side through the wall and sets nothing in the ground, so
 * the engine bills the latch post's bag only -- one bag, for the one post that
 * is actually in a hole. ConcreteBagsTest pins that.
 *
 * The LABEL was wrong. "Blank post + end post, 4 hole plugs, no concrete" is
 * what the gate picker said while the quote billed a bag, so a correct quote
 * read as a broken one. Two of the four details misstated it: "(2 bags)" where
 * the engine bills 2.5, and "no concrete" where it bills 1.
 *
 * A label that contradicts the money is worse than no label. This file makes
 * the two agree by construction: it reads the bag arithmetic out of the ENGINE
 * and the numbers out of the STRINGS, in every language, and fails when they
 * differ. Change the engine's constants and these tests fail until the picker
 * is told.
 *
 *   node --test tests/a148-gate-labels-match-the-engine.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8").split("\r\n").join("\n");

const ENGINE = "app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt";
const LOCALES = ["values", "values-es", "values-fr"];

/** Which string describes which mounting. */
const DETAIL_OF = {
  LINE: "misc_gate_mount_line_detail",
  LINE_TO_WALL: "misc_gate_mount_line_to_wall_detail",
  LATCHES_TO_WALL: "misc_gate_mount_latches_to_wall_detail",
  WALL: "misc_gate_mount_wall_detail",
};

const engineSrc = read(ENGINE);

/** The engine's own constants, read rather than copied. */
function constants() {
  const grab = (name) => {
    const m = engineSrc.match(new RegExp(`const val ${name}\\s*=\\s*([0-9.]+)`));
    assert.ok(m, `${name} is gone from the engine`);
    return Number(m[1]);
  };
  return { GATE_HINGE_BAGS: grab("GATE_HINGE_BAGS"), GATE_LATCH_BAGS: grab("GATE_LATCH_BAGS") };
}

/** The body of one `GateMounting.X -> { ... }` branch, by brace matching. */
function branch(mounting) {
  const head = `GateMounting.${mounting} -> {`;
  const start = engineSrc.indexOf(head);
  assert.ok(start > 0, `the ${mounting} branch is gone`);
  let depth = 0;
  for (let i = start + head.length - 1; i < engineSrc.length; i++) {
    if (engineSrc[i] === "{") depth++;
    else if (engineSrc[i] === "}") {
      depth--;
      if (!depth) return engineSrc.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces in the ${mounting} branch`);
}

/** How many bags that branch adds for the gate itself. */
function bagsFor(mounting) {
  const body = branch(mounting).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const m = body.match(/MaterialRole\.CONCRETE_BAG,\s*([^)]+)\)/);
  assert.ok(m, `the ${mounting} branch no longer adds concrete; this test must be rewritten, not deleted`);
  const expr = m[1].replace(/\s+/g, " ").trim();
  const c = constants();
  // Only the two named constants and + may appear. Anything else and this
  // check would be quietly evaluating something it does not understand.
  const terms = expr.split("+").map((t) => t.trim());
  for (const t of terms) {
    assert.ok(Object.hasOwn(c, t), `${mounting} adds concrete as "${expr}", which this test cannot read`);
  }
  return terms.reduce((sum, t) => sum + c[t], 0);
}

/** The bag figure a label states, in any of the three languages. */
function bagsStatedIn(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:bags?|bolsas?|sacs?)\b/i);
  return m ? Number(m[1].replace(",", ".")) : null;
}

const NO_CONCRETE = /no concrete|sin concreto|sans béton|rien dans le sol|set in nothing|sin nada en el suelo/i;

test("the engine's gate concrete is still readable, and still differs by mounting", () => {
  const c = constants();
  assert.ok(c.GATE_HINGE_BAGS > c.GATE_LATCH_BAGS,
    "the hinge post no longer takes more concrete than the latch post; the labels say it does");
  const all = Object.keys(DETAIL_OF).map((m) => [m, bagsFor(m)]);
  // If every mounting billed the same, these labels would carry no information
  // and this whole file would be checking nothing.
  assert.ok(new Set(all.map(([, b]) => b)).size > 1,
    "every mounting bills the same concrete: " + JSON.stringify(all));
  // The one the owner asked about, named explicitly so a change is deliberate.
  assert.equal(bagsFor("WALL"), c.GATE_LATCH_BAGS,
    "a wall gate bolts its hinge to the wall and sets nothing there -- it should bill the latch post only");
});

test("every label states the bags the engine actually bills, in every language", () => {
  for (const [mounting, key] of Object.entries(DETAIL_OF)) {
    const expected = bagsFor(mounting);
    for (const loc of LOCALES) {
      const src = read(`app/src/main/res/${loc}/strings.xml`);
      const m = src.match(new RegExp(`<string name="${key}">([\\s\\S]*?)</string>`));
      assert.ok(m, `${key} missing from ${loc}`);
      const text = m[1];
      const stated = bagsStatedIn(text);
      assert.notEqual(stated, null,
        `${loc}/${key} names no number of bags, so it cannot be checked against the engine: "${text}"`);
      assert.equal(stated, expected,
        `${loc}/${key} says ${stated} bags; the engine bills ${expected} for ${mounting}`);
    }
  }
});

test("no label claims nothing is set in concrete while concrete is billed", () => {
  // The exact sentence that sent the owner looking for a bug in a correct
  // quote. A wall gate DOES set nothing on the hinge side -- the label may say
  // so about the hinge -- but it must not read as "no concrete at all" with no
  // figure beside it.
  for (const [mounting, key] of Object.entries(DETAIL_OF)) {
    const bags = bagsFor(mounting);
    if (bags <= 0) continue;
    for (const loc of LOCALES) {
      const src = read(`app/src/main/res/${loc}/strings.xml`);
      const text = src.match(new RegExp(`<string name="${key}">([\\s\\S]*?)</string>`))[1];
      if (!NO_CONCRETE.test(text)) continue;
      assert.notEqual(
        bagsStatedIn(text), null,
        `${loc}/${key} says nothing is set in concrete and gives no figure, while ${mounting} bills ${bags} bags`,
      );
    }
  }
});

test("the two wall options say WHICH SIDE the fence is on", () => {
  // "I also want to be able to connect gate to fence, on either side."
  // Both arrangements already existed; they were named after what they touch,
  // not after where the fence is, so the choice he wanted to make was not the
  // choice the list offered. The difference is money: the hinge post carries
  // the gate and takes more concrete than the latch post.
  const en = read("app/src/main/res/values/strings.xml");
  const title = (k) => en.match(new RegExp(`<string name="${k}">([\\s\\S]*?)</string>`))[1];
  assert.match(title("misc_gate_mount_latches_to_wall"), /hinge side/i,
    "the hinge-side option does not say the fence is on the hinge side");
  assert.match(title("misc_gate_mount_wall"), /latch side/i,
    "the wall option does not say the fence is on the latch side");
});

test("POSITIVE CONTROL: the reader really reads the engine, and really can fail", () => {
  const c = constants();
  assert.equal(c.GATE_HINGE_BAGS, 1.5, "GATE_HINGE_BAGS moved; the labels need rewriting with it");
  assert.equal(c.GATE_LATCH_BAGS, 1.0, "GATE_LATCH_BAGS moved; the labels need rewriting with it");
  assert.equal(bagsFor("LINE"), 2.5);
  assert.equal(bagsFor("LINE_TO_WALL"), 3.5);
  assert.equal(bagsFor("LATCHES_TO_WALL"), 1.5);
  assert.equal(bagsFor("WALL"), 1.0);
  // And the label reader is not simply returning whatever it is given.
  assert.equal(bagsStatedIn("Blank post + end post, 4 hole plugs, no concrete"), null);
  assert.equal(bagsStatedIn("... 4 hole plugs, 1 bag"), 1);
  assert.equal(bagsStatedIn("... 2,5 bolsas"), 2.5);
});
