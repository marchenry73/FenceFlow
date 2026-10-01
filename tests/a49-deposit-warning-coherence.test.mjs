// tests/a49-deposit-warning-coherence.test.mjs
//
// 1 Oct 2026. "I have 3000 as deposit and it's still telling me that it does
// not cover the estimated material cost, would be buying it with my own money
// when the cost is 2828.48, I already have enough."
//
// He was right, and the sentence convicted itself: $3,000 is more than
// $2,828.48. EstimateEngine's affordability check had drifted into testing one
// number and printing another. The CONDITION asked whether money COLLECTED
// covered the materials -- nothing had been collected on his job, so
// 0.00 < 2828.48 fired -- and the MESSAGE then printed the stored DEPOSIT. Two
// halves of one warning, talking about different money.
//
// WHY THIS FILE IS A SOURCE CHECK AND NOT A BEHAVIOUR CHECK. The behaviour is
// pinned where it belongs, in Kotlin, by
// app/src/test/java/com/fenceestimator/app/estimate/DepositWarningCoherenceTest.kt
// -- his numbers, the zero-deposit case, part paid, paid in full, and a grid
// sweep asserting every fired message is arithmetic about its own figures.
// Those run under Gradle. This file runs under node today, on a machine where
// Gradle must not be started, and it guards the one thing a source check can
// guard better than a behaviour check can: that the figure the condition tests
// and the figure each message prints are THE SAME EXPRESSION, not two
// expressions somebody has to remember to keep in step. That is the defect
// class. A behaviour test catches the instance; this catches the shape.
//
// It also checks what a missing or mis-arited string resource would do, in all
// three languages, because a format string with a %3$s the code never supplies
// is a crash on the screen the warning appears on.
//
// Every guard has a PLANTED FAILURE beside it -- the real shipped defect, or a
// one-line mutation of the current source -- fed to the same checker, which
// must reject it. A checker that passes whatever it is shown cannot hide here.
//
// Run with: node --test tests/a49-deposit-warning-coherence.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const ENGINE = "app/src/main/java/com/fenceestimator/app/estimate/EstimateEngine.kt";
const KOTLIN_TEST =
  "app/src/test/java/com/fenceestimator/app/estimate/DepositWarningCoherenceTest.kt";
const STRINGS = [
  "app/src/main/res/values/strings.xml",
  "app/src/main/res/values-es/strings.xml",
  "app/src/main/res/values-fr/strings.xml",
];

// ------------------------------------------------------------- harness ----

/**
 * Source with comments removed, so a guard reads the CODE and not the history
 * written beside it. (Three checks in one day have read a comment and called
 * correct code broken.)
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");

/** The text inside the parentheses that start at `open`, respecting nesting. */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced parentheses");
}

/** Split on commas that are not inside parentheses. */
function topLevelArgs(inner) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "(") depth++;
    else if (inner[i] === ")") depth--;
    else if (inner[i] === "," && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((s) => s.trim().replace(/\s+/g, ""));
}

/**
 * Pull the affordability block out of a whole-file (or fragment) source and
 * report what the condition tests against what each message prints.
 *
 * Returns { condVar, shortfallVar, messages: { res: [argExpressions] } }.
 * Throws when the block cannot be found at all, which is itself a failure: a
 * guard that silently finds nothing reports zero problems.
 */
function readAffordabilityBlock(src) {
  const code = stripComments(src);

  // The region, bounded by two anchors that are code, not prose: where the
  // collected figure is taken, and the next warning after this block.
  const from = code.indexOf("JobMoney.netPaid(job)");
  assert.ok(from >= 0, "could not find where collected money is read");
  const toMarker = code.indexOf("R.string.warn_still_to_collect", from);
  const region = code.slice(from, toMarker > 0 ? toMarker : code.length);

  const cond = region.match(
    /materialsSubtotal\s*>\s*0\.0\s*&&\s*([A-Za-z_][A-Za-z0-9_.]*)\s*<\s*totals\.materialsSubtotal/
  );
  assert.ok(cond, "could not find the 'can I cover the materials' condition");
  const condVar = cond[1];

  const shortfall = region.match(
    /val\s+shortfall\s*=\s*totals\.materialsSubtotal\s*-\s*([A-Za-z_][A-Za-z0-9_.]*)/
  );

  const messages = {};
  const resRe = /R\.string\.(warn_fronting_material|warn_deposit_short)/g;
  let m;
  while ((m = resRe.exec(region)) !== null) {
    const listOfAt = region.indexOf("listOf(", m.index);
    assert.ok(listOfAt > 0, `${m[1]} carries no argument list`);
    messages[m[1]] = topLevelArgs(balanced(region, listOfAt + "listOf".length));
  }

  return { condVar, shortfallVar: shortfall ? shortfall[1] : null, messages };
}

/**
 * The rule. Throws with the figures named when a message prints money the
 * condition did not test.
 */
function assertCoherent(block) {
  const { condVar, shortfallVar, messages } = block;
  const expected = `money(${condVar})`;

  for (const [res, args] of Object.entries(messages)) {
    assert.equal(
      args[0],
      expected,
      `${res} prints ${args[0]} as the money available, but the condition tested ` +
        `${condVar}. Those are different numbers, which is how a $3,000 deposit ` +
        `came to be printed into a sentence saying it did not cover $2,828.48.`
    );
    assert.equal(
      args[1],
      "money(totals.materialsSubtotal)",
      `${res} must print the material cost the condition compared against, not ${args[1]}`
    );
  }

  const fronting = messages.warn_fronting_material;
  assert.ok(fronting, "warn_fronting_material must still be reachable");
  assert.equal(fronting.length, 3, "warn_fronting_material takes three figures");
  assert.equal(
    fronting[2],
    "money(shortfall)",
    "the third figure must be the shortfall, not a separately computed number"
  );
  assert.equal(
    shortfallVar,
    condVar,
    `the shortfall is computed from ${shortfallVar} but the condition tested ` +
      `${condVar}; a shortfall against a different figure is not the gap being warned about`
  );

  const short = messages.warn_deposit_short;
  assert.ok(short, "warn_deposit_short must still be reachable -- it is the zero-deposit case");
  assert.equal(short.length, 2, "warn_deposit_short takes two figures");
}

// ---------------------------------------------- 1. the shipped defect ----
//
// The exact code that shipped, kept here so the checker is proved against the
// real thing and not against a mutation I invented.

const SHIPPED_DEFECT = `
        val collected = JobMoney.netPaid(job)
        val billable = JobMoney.billableTotal(job, totals.grandTotal, changeOrders)
        val owed = JobMoney.stillOwed(job, billable)

        if (totals.materialsSubtotal > 0.0 && collected < totals.materialsSubtotal) {
            val shortfall = totals.materialsSubtotal - collected
            warnings += if (collected > 0.005) {
                EstimateWarning(
                    R.string.warn_fronting_material,
                    listOf(money(collected), money(totals.materialsSubtotal), money(shortfall))
                )
            } else {
                EstimateWarning(
                    R.string.warn_deposit_short,
                    listOf(money(job.depositAmount), money(totals.materialsSubtotal))
                )
            }
        }
        if (collected > 0.005 && owed > 0.005) {
            warnings += EstimateWarning(R.string.warn_still_to_collect, listOf(money(owed)))
        }
`;

test("PLANTED FAILURE: the checker rejects the code that actually shipped", () => {
  const block = readAffordabilityBlock(SHIPPED_DEFECT);
  // The checker must see the two halves disagreeing.
  assert.equal(block.condVar, "collected");
  assert.equal(block.messages.warn_deposit_short[0], "money(job.depositAmount)");
  assert.throws(
    () => assertCoherent(block),
    /prints money\(job\.depositAmount\) as the money available, but the condition tested collected/,
    "the checker passed the defect it exists to catch"
  );
});

test("PLANTED FAILURE: the checker rejects a shortfall taken from another figure", () => {
  const mutated = SHIPPED_DEFECT.replace(
    "listOf(money(job.depositAmount), money(totals.materialsSubtotal))",
    "listOf(money(collected), money(totals.materialsSubtotal))"
  ).replace(
    "val shortfall = totals.materialsSubtotal - collected",
    "val shortfall = totals.materialsSubtotal - job.depositAmount"
  );
  assert.throws(
    () => assertCoherent(readAffordabilityBlock(mutated)),
    /shortfall is computed from job\.depositAmount but the condition tested collected/
  );
});

test("PLANTED FAILURE: the checker notices a message losing its material figure", () => {
  const mutated = SHIPPED_DEFECT.replace(
    "listOf(money(job.depositAmount), money(totals.materialsSubtotal))",
    "listOf(money(collected), money(totals.grandTotal))"
  );
  assert.throws(
    () => assertCoherent(readAffordabilityBlock(mutated)),
    /must print the material cost the condition compared against/
  );
});

// -------------------------------------------- 2. the current source -----

test("the condition and both messages use one figure", () => {
  const block = readAffordabilityBlock(read(ENGINE));
  assertCoherent(block);
  // Named, so a rename that quietly reintroduces two figures is visible in the
  // diff of this file rather than only in its pass/fail.
  assert.equal(block.condVar, "inHand");
  assert.equal(block.shortfallVar, "inHand");
});

test("the one figure is collected money once any has arrived, else the deposit", () => {
  const code = stripComments(read(ENGINE));
  // Nothing in, so the question turns on the deposit being asked for; money in,
  // so it turns on the money. Both halves spelled out here because getting
  // either backwards is a wrong answer about his own money.
  assert.match(code, /val\s+anyMoneyIn\s*=\s*collected\s*>\s*0\.005/);
  assert.match(
    code,
    /val\s+inHand\s*=\s*if\s*\(anyMoneyIn\)\s*collected\s+else\s+job\.depositAmount\.coerceAtLeast\(0\.0\)/
  );
  // And the branch picks the message by the same test, so the figure and the
  // wording cannot describe different situations.
  assert.match(code, /warnings\s*\+=\s*if\s*\(anyMoneyIn\)\s*\{/);
});

test("covering the materials to the cent is covering them", () => {
  // Without the tolerance, a deposit equal to the materials warns -- and float
  // dust on a 2828.48 subtotal decides it.
  const { condVar } = readAffordabilityBlock(read(ENGINE));
  const code = stripComments(read(ENGINE));
  assert.match(
    code,
    new RegExp(`${condVar}\\s*<\\s*totals\\.materialsSubtotal\\s*-\\s*0\\.005`),
    "the shortfall test needs a cent of tolerance or an exactly-funded job warns"
  );
});

// ------------------------------------ 3. the strings in three languages --

test("both warnings exist in all three languages with the arity the code supplies", () => {
  const arity = { warn_deposit_short: 2, warn_fronting_material: 3 };
  for (const path of STRINGS) {
    const xml = read(path);
    for (const [name, n] of Object.entries(arity)) {
      const m = xml.match(new RegExp(`<string name="${name}">([\\s\\S]*?)</string>`));
      assert.ok(m, `${path} is missing ${name} -- a missing string resource breaks the build`);
      const used = new Set((m[1].match(/%(\d)\$s/g) || []).map((s) => s[1]));
      assert.deepEqual(
        [...used].sort(),
        Array.from({ length: n }, (_, i) => String(i + 1)),
        `${path}: ${name} must use exactly %1..%${n} -- a placeholder the code does not ` +
          `supply throws when the warning is rendered`
      );
    }
  }
});

test("PLANTED FAILURE: the arity guard catches a placeholder the code never supplies", () => {
  const arity = 2;
  const broken = `<string name="warn_deposit_short">Deposit ($%1$s) of ($%2$s), short $%3$s.</string>`;
  const m = broken.match(/<string name="warn_deposit_short">([\s\S]*?)<\/string>/);
  const used = new Set((m[1].match(/%(\d)\$s/g) || []).map((s) => s[1]));
  assert.throws(() =>
    assert.deepEqual(
      [...used].sort(),
      Array.from({ length: arity }, (_, i) => String(i + 1))
    )
  );
});

// --------------------------- 4. the behaviour test keeps his numbers ----
//
// The numeric cases run under Gradle, not here, so the one thing this file can
// do for them is refuse to let them quietly disappear. A deleted case is how a
// fixed bug comes back.

test("the Kotlin behaviour test still carries the reported numbers", () => {
  const kt = read(KOTLIN_TEST);
  for (const needed of [
    "2828.48", // his material cost
    "3000.0", // his deposit: must produce no warning
    "2328.48", // the shortfall when only 500 has landed
    "warn_deposit_short",
    "warn_fronting_material",
  ]) {
    assert.ok(kt.includes(needed), `the behaviour test no longer mentions ${needed}`);
  }
  // The zero-deposit case is the one the warning exists for and the one his
  // earlier report hit. It must not be traded away for the new one.
  assert.match(kt, /deposit = 0\.0, materials = 2828\.48/);
  // And the sweep that catches the defect class, not just this instance.
  assert.match(kt, /no warning ever prints a figure its condition did not test/);
});
