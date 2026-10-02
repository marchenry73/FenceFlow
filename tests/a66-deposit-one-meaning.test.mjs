// tests/a66-deposit-one-meaning.test.mjs
//
// 2 Oct 2026. THE DEPOSIT MEANS ONE THING ON EVERY SURFACE.
//
// docs/MONEY_AUDIT_SURFACES.md measured eight ways the deposit disagreed with
// itself across the phone, the office, the customer's quote page, the contract
// PDF and the approval email. The owner reads those side by side -- the deposit
// has been wrong three different ways in one day and he noticed every time --
// so a disagreement between two defensible surfaces is a bug.
//
// What this file proves, for the same job, with his real numbers:
//
//   1. THE CAP IS ONE DECISION. The deposit a job may ask for is the stored
//      figure capped at the price, on all eight surfaces. It used to be capped
//      in five and raw in three, so a signed contract PDF could state a
//      deposit LARGER than the price on the same customer's page.
//   2. THE STORED COLUMN IS CUMULATIVE. "Set deposit" after a payment wrote
//      the INCREMENTAL figure (the rule net of money already in) into the
//      cumulative column, so every reader took the same payment off twice.
//   3. THE PHONE AND THE PAGE ASK FOR THE SAME AMOUNT after a part payment.
//      The phone asked for the whole balance; the page asked for the rest of
//      the deposit. On his job K -- a $3,000 deposit on a $4,654.47 total with
//      $500 in -- that was $4,154.47 against $2,500.00.
//   4. NO DEPOSIT MEANS SAY NOTHING, not "$0.00". Five of his jobs ask for no
//      deposit and the contract printed "A deposit of $0.00 is due before
//      materials are ordered" on every one of them.
//   5. THE OWNER'S LABEL MATCHES THE RULE: next $100 plus $100, in all three
//      languages, where it said "next $10".
//   6. "DEPOSIT RECEIVED" HAS ONE MEANING: nothing outstanding on the deposit.
//      It meant "any money in" on the phone and "the whole deposit" in the
//      office.
//   7. "MATERIALS STILL TO BE BOUGHT" HAS ONE BASIS, WITH THE SALES TAX ON IT.
//   8. A DEPOSIT TYPED WITH CENTS STORES THOSE CENTS, not float32 dust.
//
// How each side gets in here:
//   - the SERVER is imported and run for real (quote-deposit.ts: depositFigures,
//     suggestedDeposit, ruleDeposit, roundToCents);
//   - the OFFICE's own functions are lifted out of website/dashboard.html by
//     source and evaluated, so this compares the shipped page, not a paraphrase;
//   - the PHONE is hand-transcribed from the Kotlin, line for line, and the
//     Kotlin files are FINGERPRINTED: edit them and this test fails on purpose,
//     telling you to re-read the transcription before moving the pin. A copy
//     that goes stale in silence turns a guard into a green light (see
//     tests/downstream-deposit-balance.test.mjs, which does the same);
//   - the PDF and the two screens are checked by reading their source for the
//     decision they make, because there is no JVM here.
//
// Every claim has a POSITIVE CONTROL (it agrees for the right reason, not
// because both sides returned zero) and a CANARY: the OLD logic, written out,
// asserted to DISAGREE on the same input. A test that would pass whichever
// rule ran cannot hide in this file.
//
// READ-ONLY. Nothing here touches the live database, deploys anything, or
// writes outside this file.
//
// Run with: node --test tests/a66-deposit-one-meaning.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
// Line endings differ between a checkout and an edit, and a fingerprint that
// notices \r\n notices nothing useful.
const normalise = (s) => s.split("\r").join("");
/** A blank line: what separates one paragraph of the contract terms from the next. */
const DOUBLE_NEWLINE = "\n\n";
const fingerprint = (p) =>
  createHash("sha256").update(normalise(read(p))).digest("hex").slice(0, 16);

const {
  depositFigures,
  suggestedDeposit,
  ruleDeposit,
  roundToCents,
  DEPOSIT_ROUND_UP_TO,
  DEPOSIT_PLUS,
} = await import("../supabase/functions/_shared/quote-deposit.ts");

const JOB_MONEY = "app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt";
const PDF_EXPORTER = "app/src/main/java/com/fenceestimator/app/estimate/PdfExporter.kt";
const ESTIMATE_SCREEN = "app/src/main/java/com/fenceestimator/app/ui/estimate/EstimateScreen.kt";
const JOB_SCREEN = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt";
const JOB_VM = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailViewModel.kt";
const PROJECT_STATUS = "app/src/main/java/com/fenceestimator/app/ui/components/ProjectStatus.kt";

const jobMoneySrc = read(JOB_MONEY);
const dashboardSrc = read("website/dashboard.html");

// ---------------------------------------------------------------- the phone --
//
// JobMoney.kt, transcribed. Each line below is a direct read of the Kotlin.
// Where the Kotlin writes `coerceAtLeast(0.0)` this writes Math.max(0, ...);
// where it writes `Math.round(x * 100.0) / 100.0` this writes the same, which
// is what quote-deposit.ts's roundToCents does too (same IEEE multiply, same
// half-up) -- that equality is itself pinned by tests/a29.

const phone = {
  // fun netPaid(job) = (job.amountPaid - job.refundedAmount).coerceAtLeast(0.0)
  netPaid: (j) => Math.max(0, (j.amountPaid || 0) - (j.refundedAmount || 0)),
  // fun stillOwed(job, contractTotal) = (contractTotal - netPaid(job)).coerceAtLeast(0.0)
  stillOwed: (j, total) => Math.max(0, total - phone.netPaid(j)),
  // fun depositAsked(job, billableTotal):
  //   val requested = job.depositAmount.coerceAtLeast(0.0)
  //   return if (billableTotal > 0.0) minOf(requested, billableTotal) else requested
  depositAsked: (j, total) => {
    const requested = Math.max(0, j.depositAmount || 0);
    return total > 0 ? Math.min(requested, total) : requested;
  },
  // fun depositStillDue(job, billableTotal) =
  //   (depositAsked(job, billableTotal) - netPaid(job)).coerceAtLeast(0.0)
  depositStillDue: (j, total) =>
    roundToCents(Math.max(0, phone.depositAsked(j, total) - phone.netPaid(j))),
  // fun depositSettled(job, billableTotal) = depositStillDue(job, billableTotal) <= 0.005
  depositSettled: (j, total) => phone.depositStillDue(j, total) <= 0.005,
  // fun nextRequestAmount(job, contractTotal):
  //   val owed = stillOwed(job, contractTotal)
  //   if (owed <= 0.005) return 0.0
  //   val depositLeft = depositStillDue(job, contractTotal)
  //   if (depositLeft > 0.005) return minOf(depositLeft, owed)
  //   return owed
  nextRequestAmount: (j, total) => {
    const owed = phone.stillOwed(j, total);
    if (owed <= 0.005) return 0;
    const depositLeft = phone.depositStillDue(j, total);
    if (depositLeft > 0.005) return Math.min(depositLeft, owed);
    return owed;
  },
  // fun nextRequestLabel(job, contractTotal) =
  //   if (depositStillDue(job, contractTotal) > 0.005) "deposit" else "balance"
  nextRequestLabel: (j, total) =>
    phone.depositStillDue(j, total) > 0.005 ? "deposit" : "balance",
  // fun ruleDeposit(outstandingMaterials):
  //   if (!isFinite) 0; cents = Math.round(x * 100); if (cents <= 0) 0
  //   hundreds = (cents + stepCents - 1) / stepCents   (integer division)
  //   hundreds * 100 + 100
  ruleDeposit: (outstanding) => {
    if (!Number.isFinite(outstanding)) return 0;
    const cents = Math.round(outstanding * 100);
    if (cents <= 0) return 0;
    const stepCents = 100 * 100;
    const hundreds = Math.floor((cents + stepCents - 1) / stepCents);
    return hundreds * 100 + 100;
  },
  // fun depositSuggestion(job, materialsToBuy, billableTotal) -- the cumulative
  // figure to STORE, capped at the price.
  depositSuggestion: (j, materialsToBuy, total) => {
    const none = { amount: 0, capped: false };
    if (!Number.isFinite(materialsToBuy) || !Number.isFinite(total)) return none;
    if (materialsToBuy <= 0 || total <= 0) return none;
    const collected = phone.netPaid(j);
    const toCollect = phone.ruleDeposit(materialsToBuy - collected);
    if (toCollect <= 0) return none;
    const owed = roundToCents(phone.stillOwed(j, total));
    if (owed <= 0.005) return none;
    return toCollect <= owed + 0.005
      ? { amount: roundToCents(collected + toCollect), capped: false }
      : { amount: roundToCents(collected + owed), capped: true };
  },
  // fun materialsToBuy(totals, changeOrders) =
  //   roundToCents(materialsSubtotal + tax + Σ changeOrder.materialCost)
  materialsToBuy: (totals, orders) =>
    roundToCents(
      totals.materialsSubtotal + totals.tax + (orders || []).reduce((s, o) => s + o.materialCost, 0),
    ),
};

// PdfExporter.dropDepositClause, transcribed. The PDF is the only surface that
// has to REMOVE a sentence rather than change a figure.
const PLACEHOLDER = "{DEPOSIT}";
function dropOneDepositClause(terms) {
  const at = terms.indexOf(PLACEHOLDER);
  if (at < 0) return terms;
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = terms[i];
    if (c === "." || c === "!" || c === "?") { start = i + 1; break; }
    if (c === "\n" && i > 0 && terms[i - 1] === "\n") { start = i + 1; break; }
  }
  let end = terms.length;
  let cutAtSemicolon = false;
  for (let j = at + PLACEHOLDER.length; j < terms.length; j++) {
    const c = terms[j];
    if (c === ";") { end = j + 1; cutAtSemicolon = true; break; }
    if (c === "." || c === "!" || c === "?") { end = j + 1; break; }
  }
  const head = terms.slice(0, start).replace(/ +$/, "");
  const tail = terms.slice(end);
  const lead = (tail.match(/^[ \n]*/) || [""])[0];
  const body0 = tail.slice(lead.length);
  const body = cutAtSemicolon && body0.length
    ? body0[0].toUpperCase() + body0.slice(1)
    : body0;
  const separator = head === "" ? ""
    : head.endsWith("\n") ? ""
    : body === "" ? ""
    : lead.includes("\n\n") ? "\n\n"
    : " ";
  return head + separator + body;
}
function dropDepositClause(terms) {
  let out = terms;
  for (let i = 0; i < 8; i++) {
    const next = dropOneDepositClause(out);
    if (next === out) return out;
    out = next;
  }
  return out;
}

// --------------------------------------------------------------- the office --

const grabFn = (src, name) => {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "dashboard.html no longer has function " + name);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};
const office = (() => {
  const code = ["netPaid", "depositAskedOf"].map((n) => grabFn(dashboardSrc, n)).join("\n\n");
  return new Function(code + "\nreturn { netPaid, depositAskedOf };")();
})();
// The office reads snake_case rows straight out of PostgREST.
const row = (j) => ({
  deposit_amount: j.depositAmount || 0,
  amount_paid: j.amountPaid || 0,
  refunded_amount: j.refundedAmount || 0,
});

// ------------------------------------------------------------- the old logic --
//
// The CANARIES. Each is the behaviour measured in docs/MONEY_AUDIT_SURFACES.md
// before this change, written out so it can be asserted to disagree.
const old = {
  // PdfExporter.kt:465 / 579, EstimateScreen.kt:699 -- the raw stored figure.
  depositPrintedRaw: (j) => Math.max(0, j.depositAmount || 0),
  // JobMoney.nextRequestAmount before 2 Oct: the whole balance once any money
  // was in.
  nextRequestAmount: (j, total) => {
    const owed = phone.stillOwed(j, total);
    if (owed <= 0.005) return 0;
    if (phone.netPaid(j) <= 0.005 && (j.depositAmount || 0) > 0.005) {
      return Math.min(j.depositAmount, owed);
    }
    return owed;
  },
  // depositSuggestion before 2 Oct: the incremental figure, stored in the
  // cumulative column.
  depositSuggestion: (j, materials, total) => {
    const rule = phone.ruleDeposit(materials - phone.netPaid(j));
    if (rule <= 0) return { amount: 0, capped: false };
    const owed = roundToCents(phone.stillOwed(j, total));
    if (owed <= 0.005) return { amount: 0, capped: false };
    return rule <= owed + 0.005 ? { amount: rule, capped: false } : { amount: owed, capped: true };
  },
  // ProjectStatus / the office progress step before 2 Oct: any money at all.
  depositReceived: (j) => phone.netPaid(j) > 0,
  // JobDetailScreen's capped-label test before 2 Oct: the next-$10 rule.
  suggestionIsCapped: (suggested, materials, paid) =>
    suggested > 0 && suggested + 0.005 < Math.ceil((materials - paid) / 10) * 10,
  // The deposit field's float32 round trip.
  floatBacked: (typed) => Math.fround(typed),
};

// ============================================================ fingerprints ==

test("the transcription is of the Kotlin that is actually in the tree", () => {
  // Moved 2 Oct 2026 for this change. When one of these fires: re-read the
  // transcribed block above against the Kotlin, function by function, THEN
  // move the pin. Moving the pin first is how a guard stops guarding.
  const pins = {
    [JOB_MONEY]: "ef59d93ea2a44a3c",
    [PROJECT_STATUS]: "1ccd57a4590503be",
  };
  for (const [path, want] of Object.entries(pins)) {
    const got = fingerprint(path);
    assert.equal(
      got,
      want,
      `${path} changed (${got}). Re-read the transcription in this file against it, then move the pin.`,
    );
  }
});

// ================================================== 1. the cap, one decision ==

test("the deposit asked for is the same figure on the phone, the server and the office", () => {
  const cases = [
    { name: "ordinary job", depositAmount: 3000, amountPaid: 0, refundedAmount: 0, total: 4654.47 },
    { name: "part paid", depositAmount: 3000, amountPaid: 500, refundedAmount: 0, total: 4654.47 },
    { name: "deposit over the price (the $3,963 on a $3,620 job)", depositAmount: 3963, amountPaid: 0, refundedAmount: 0, total: 3620 },
    { name: "deposit a cent over the price", depositAmount: 200.01, amountPaid: 0, refundedAmount: 0, total: 200 },
    { name: "no deposit asked for", depositAmount: 0, amountPaid: 0, refundedAmount: 0, total: 5853.81 },
    { name: "not priced yet: nothing to cap against", depositAmount: 500, amountPaid: 0, refundedAmount: 0, total: 0 },
    { name: "a nonsense negative deposit", depositAmount: -50, amountPaid: 0, refundedAmount: 0, total: 1000 },
  ];
  let capsThatBit = 0;
  for (const c of cases) {
    const server = depositFigures({
      depositAmount: c.depositAmount,
      contractTotal: c.total,
      amountPaid: c.amountPaid,
      refundedAmount: c.refundedAmount,
    });
    const onPhone = phone.depositAsked(c, c.total);
    const inOffice = office.depositAskedOf(row(c), c.total);
    assert.equal(onPhone, server.asked, `${c.name}: phone vs server`);
    assert.equal(inOffice, server.asked, `${c.name}: office vs server`);
    if (onPhone + 0.005 < Math.max(0, c.depositAmount)) capsThatBit++;
  }
  // POSITIVE CONTROL: the cap actually bit on some of these, so the agreement
  // above is not three copies of "no cap needed".
  assert.equal(capsThatBit, 2, "the cap has to bite somewhere for this to mean anything");

  // CANARY: the three surfaces that printed the figure RAW disagree with the
  // capped decision on exactly the case that matters.
  const overCap = cases[2];
  assert.equal(phone.depositAsked(overCap, overCap.total), 3620);
  assert.equal(old.depositPrintedRaw(overCap), 3963);
  assert.notEqual(
    old.depositPrintedRaw(overCap),
    phone.depositAsked(overCap, overCap.total),
    "PLANTED: the old PDF and estimate card printed $3,963 under a $3,620 price",
  );
});

test("the PDF and the estimate card read the shared cap, not the stored column", () => {
  const pdf = read(PDF_EXPORTER);
  assert.match(
    pdf,
    /val depositAsked = JobMoney\.depositAsked\(job, billable\)/,
    "PdfExporter must take the deposit from the one shared decision",
  );
  // The deposit row, the purpose sentence and the {DEPOSIT} in the terms all
  // read it; nothing in the document prints job.depositAmount any more.
  assert.equal(
    (pdf.match(/job\.depositAmount/g) || []).length,
    0,
    "PdfExporter still prints the raw stored deposit somewhere",
  );
  assert.match(pdf, /\.replace\("\{DEPOSIT\}", currency\.format\(depositAsked\)\)/);

  const screen = read(ESTIMATE_SCREEN);
  assert.match(screen, /val depositAsked = JobMoney\.depositAsked\(job, billable\)/);
  assert.equal(
    (screen.match(/Money\.format\(job\.depositAmount\)/g) || []).length,
    0,
    "the estimate card still prints the raw stored deposit",
  );
});

// ============================ 2. the stored column is cumulative, not delta ==

test("Set deposit after a payment stores the cumulative figure, so the page asks for the rule's figure", () => {
  // The measured case: $2,449.10 of materials, $1,000 already in, $9,710 job.
  const job = { depositAmount: 0, amountPaid: 1000, refundedAmount: 0 };
  const materials = 2449.10;
  const total = 9710;

  const want = ruleDeposit(materials - 1000); // 1,449.10 -> 1,500 -> +100
  assert.equal(want, 1600, "the rule still needs 1,600 more for the materials");

  const server = suggestedDeposit({
    materialCost: materials,
    amountPaid: 1000,
    refundedAmount: 0,
    billableTotal: total,
  });
  const onPhone = phone.depositSuggestion(job, materials, total);
  assert.deepEqual(onPhone, server, "phone and server suggest the same stored figure");
  assert.equal(server.amount, 2600, "stored: the 1,000 already in plus the 1,600 still needed");

  // What every reader then asks for, through its own subtraction.
  const stored = { ...job, depositAmount: server.amount };
  const afterStore = depositFigures({
    depositAmount: stored.depositAmount,
    contractTotal: total,
    amountPaid: 1000,
    refundedAmount: 0,
  });
  assert.equal(afterStore.due, want, "the customer's page asks for exactly the rule's figure");
  assert.equal(phone.depositStillDue(stored, total), want, "so does the phone");
  assert.equal(
    office.depositAskedOf(row(stored), total) - office.netPaid(row(stored)),
    want,
    "so does the office",
  );

  // POSITIVE CONTROL: this case has money in it, which is the only case the
  // bug could ever show in -- with nothing paid the two figures are equal.
  assert.ok(phone.netPaid(stored) > 0);
  const fresh = { depositAmount: 0, amountPaid: 0, refundedAmount: 0 };
  assert.equal(
    phone.depositSuggestion(fresh, materials, total).amount,
    old.depositSuggestion(fresh, materials, total).amount,
    "with nothing paid, old and new agree -- which is why this hid for a month",
  );

  // CANARY: the old incremental write, read back through the same page.
  const wrong = { ...job, depositAmount: old.depositSuggestion(job, materials, total).amount };
  assert.equal(wrong.depositAmount, 1600, "the old code stored the incremental figure");
  const wrongDue = depositFigures({
    depositAmount: wrong.depositAmount,
    contractTotal: total,
    amountPaid: 1000,
    refundedAmount: 0,
  }).due;
  assert.equal(wrongDue, 600, "PLANTED: the page then asked for $600");
  assert.notEqual(wrongDue, want, "PLANTED: $1,000 short of the materials he is about to buy");
});

test("every shared vector: storing the suggestion asks for exactly the rule's figure", () => {
  // tests/a29-deposit-rule-vectors.json is run by the TypeScript (a29) and by
  // the Kotlin (JobMoneyDepositRuleTest) for `amount` and `capped`. This runs
  // the same rows one step further: store the suggested figure, then read what
  // the customer is asked for, on all three surfaces. The `due` column in the
  // vector file is that figure, worked out by hand from the rule.
  const vectors = JSON.parse(read("tests/a29-deposit-rule-vectors.json"));
  assert.ok(vectors.suggestedDeposit.length >= 12, "the vector file lost its rows");
  let withMoneyIn = 0;
  for (const v of vectors.suggestedDeposit) {
    assert.ok(typeof v.due === "number", `${v.name}: the vector has no due`);
    const got = suggestedDeposit(v);
    assert.deepEqual({ amount: got.amount, capped: got.capped }, { amount: v.amount, capped: v.capped }, v.name);
    const j = {
      depositAmount: got.amount,
      amountPaid: v.amountPaid || 0,
      refundedAmount: v.refundedAmount || 0,
    };
    const total = v.billableTotal || 0;
    const server = depositFigures({
      depositAmount: j.depositAmount,
      contractTotal: total,
      amountPaid: j.amountPaid,
      refundedAmount: j.refundedAmount,
    });
    assert.equal(server.due, v.due, `${v.name}: the page's figure`);
    assert.equal(phone.depositStillDue(j, total), v.due, `${v.name}: the phone's figure`);
    assert.equal(
      roundToCents(Math.max(0, office.depositAskedOf(row(j), total) - office.netPaid(row(j)))),
      v.due,
      `${v.name}: the office's figure`,
    );
    // And it is the rule's own figure whenever the cap did not bite.
    if (!got.capped && got.amount > 0) {
      assert.equal(v.due, ruleDeposit(v.materialCost - Math.max(0, (v.amountPaid || 0) - (v.refundedAmount || 0))));
    }
    if (phone.netPaid(j) > 0.005) withMoneyIn++;
  }
  // POSITIVE CONTROL: some rows have money already in, which is the only shape
  // the cumulative/incremental confusion could ever show in.
  assert.ok(withMoneyIn >= 3, "the vectors need part-paid rows to prove anything here");
});

test("the cap after a part payment leaves the whole balance due, to the cent", () => {
  // The float-clean vector: materials 5,000, $500.01 in, price 2,119.99.
  const input = { materialCost: 5000, amountPaid: 500.01, refundedAmount: 0, billableTotal: 2119.99 };
  const server = suggestedDeposit(input);
  assert.deepEqual(server, { amount: 2119.99, capped: true });
  const stored = { depositAmount: server.amount, amountPaid: 500.01, refundedAmount: 0 };
  const figures = depositFigures({
    depositAmount: stored.depositAmount,
    contractTotal: 2119.99,
    amountPaid: 500.01,
    refundedAmount: 0,
  });
  assert.equal(figures.due, 1619.98, "the rest of the price, with no float dust");
  assert.equal(figures.due, figures.balance, "a capped deposit asks for the whole balance");
  assert.equal(phone.depositStillDue(stored, 2119.99), 1619.98);
});

// ================================= 3. the phone and the page ask the same ====

test("after a part payment the phone asks for exactly what the customer's page asks for", () => {
  // His job K, measured: $3,000 deposit, $4,654.47 total.
  const K = (paid) => ({ depositAmount: 3000, amountPaid: paid, refundedAmount: 0 });
  const total = 4654.47;

  const cases = [
    { paid: 0, due: 3000, label: "deposit" },
    { paid: 500, due: 2500, label: "deposit" },
    { paid: 3000, due: 1654.47, label: "balance" },
    { paid: 4654.47, due: 0, label: "balance" },
  ];
  for (const c of cases) {
    const j = K(c.paid);
    const server = depositFigures({
      depositAmount: 3000, contractTotal: total, amountPaid: c.paid, refundedAmount: 0,
    });
    // The page asks for the rest of the deposit while there is one, then the
    // balance -- the same two figures, in the same order, as the phone.
    const pageAsks = server.due > 0.005 ? server.due : server.balance;
    assert.equal(
      roundToCents(phone.nextRequestAmount(j, total)),
      roundToCents(pageAsks),
      `K with $${c.paid} in: phone vs page`,
    );
    assert.equal(roundToCents(phone.nextRequestAmount(j, total)), c.due, `K with $${c.paid} in`);
    assert.equal(phone.nextRequestLabel(j, total), c.label);
  }

  // His job C, measured: $160 deposit, $200 total, $100 in.
  const C = { depositAmount: 160, amountPaid: 100, refundedAmount: 0 };
  const cServer = depositFigures({
    depositAmount: 160, contractTotal: 200, amountPaid: 100, refundedAmount: 0,
  });
  assert.equal(cServer.due, 60);
  assert.equal(phone.nextRequestAmount(C, 200), 60, "C: the rest of the deposit, not the balance");

  // POSITIVE CONTROL: the two figures really are different numbers on these
  // jobs, so the agreement is not "balance happens to equal due".
  assert.notEqual(phone.stillOwed(K(500), total), 2500);
  assert.notEqual(phone.stillOwed(C, 200), 60);

  // CANARY: the old rule, on the measured job, produces the number the owner
  // saw on his phone beside $2,500.00 on hers.
  assert.equal(roundToCents(old.nextRequestAmount(K(500), total)), 4154.47, "PLANTED: the old phone figure");
  assert.notEqual(
    roundToCents(old.nextRequestAmount(K(500), total)),
    2500,
    "PLANTED: the old phone rule disagrees with the page",
  );
  assert.equal(old.nextRequestAmount(C, 200), 100, "PLANTED: C's old phone figure against the page's 60");
});

test("the pay link and the request the phone makes cannot ask for more than the balance", () => {
  // Belt and braces: whatever the deposit says, nothing asks for more than is
  // owed on the price. A deposit above the price is the case that used to.
  for (const deposit of [0, 1, 160, 3000, 9999, 1e6]) {
    for (const paid of [0, 0.5, 500, 4654.47, 5000]) {
      const j = { depositAmount: deposit, amountPaid: paid, refundedAmount: 0 };
      const asked = phone.nextRequestAmount(j, 4654.47);
      assert.ok(
        asked <= phone.stillOwed(j, 4654.47) + 1e-9,
        `deposit ${deposit}, paid ${paid}: asked ${asked} above the balance`,
      );
      assert.ok(asked >= 0);
    }
  }
});

// ============================================ 4. no deposit means say nothing ==

test("with no deposit the contract says nothing about one, in all three languages", () => {
  const template = read("app/src/main/java/com/fenceestimator/app/data/ContractTemplate.kt");
  // The three shipped defaults, read out of the source rather than retyped.
  const blocks = [...template.matchAll(/"""([\s\S]*?)"""/g)].map((m) => m[1]);
  const withDeposit = blocks.filter((b) => b.includes("{DEPOSIT}"));
  // POSITIVE CONTROL: there are three of them, one per language, and they all
  // carry the placeholder -- otherwise this test proves nothing about any of
  // them.
  assert.equal(withDeposit.length, 3, "expected the English, Spanish and French defaults");

  for (const terms of withDeposit) {
    const stripped = dropDepositClause(terms);
    assert.ok(!stripped.includes("{DEPOSIT}"), "the placeholder survived");
    // The clause after the semicolon is still there, and still a sentence.
    const kept = ["the balance is due on completion", "el saldo vence al terminar", "le solde est dû à l'achèvement"];
    const keptOne = kept.find((k) => terms.toLowerCase().includes(k.toLowerCase()));
    assert.ok(keptOne, "the shipped terms no longer carry the balance clause this test knows");
    const capitalised = keptOne[0].toUpperCase() + keptOne.slice(1);
    assert.ok(
      stripped.includes(capitalised),
      `the balance clause should survive, capitalised: ${capitalised}`,
    );
    // Nothing is left dangling IN THE PARAGRAPH THAT WAS CUT: no orphaned
    // semicolon, no double space. Scoped to that paragraph on purpose -- the
    // French terms use French typography (" ;") elsewhere, and a check across
    // the whole document would read that as damage.
    const paragraph = stripped
      .split(DOUBLE_NEWLINE)
      .find((p) => p.includes("{TOTAL}"));
    assert.ok(paragraph, "the price-and-payment paragraph went missing");
    assert.ok(!/ ;|;;|  /.test(paragraph), "the cut left stray punctuation: " + paragraph);
    // And the rest of the terms are untouched.
    assert.ok(stripped.includes("PROPERTY LINES") || stripped.includes("LÍNEAS") || stripped.includes("LIMITES"));
  }

  // CANARY: the old substitution, on a job with no deposit.
  const english = withDeposit[0];
  const oldFilled = english.replace("{DEPOSIT}", "$0.00");
  assert.match(oldFilled, /A deposit of \$0\.00 is due before materials are/, "PLANTED: the old sentence");
  assert.ok(
    !dropDepositClause(english).includes("$0.00"),
    "PLANTED: and it cannot be produced any more",
  );
});

test("the PDF only strips the clause when no deposit is asked for", () => {
  const pdf = read(PDF_EXPORTER);
  assert.match(
    pdf,
    /val source = if \(depositAsked > 0\.0\) source0 else dropDepositClause\(source0\)/,
    "the strip has to be conditional, or a real deposit stops being stated",
  );
  // Owner-edited terms are arbitrary text, so the sentence surgery has to cope
  // with wording nobody shipped.
  const edited = "PAYMENT. Pay {DEPOSIT} up front please! The rest on the day.";
  assert.equal(
    dropDepositClause(edited),
    "PAYMENT. The rest on the day.",
    "an edited term with no semicolon loses the whole sentence",
  );
  const noPlaceholder = "PAYMENT. Cash on completion.";
  assert.equal(dropDepositClause(noPlaceholder), noPlaceholder, "terms without one are untouched");
});

// ========================================= 5. the owner's label and the rule ==

test("the owner's job screen states the rule the button applies, in all three languages", () => {
  const files = [
    ["app/src/main/res/values/strings.xml", /next \$100, plus \$100/],
    ["app/src/main/res/values-es/strings.xml", /siguientes \$100, más \$100/],
    ["app/src/main/res/values-fr/strings.xml", /100 \$ supérieurs, plus 100 \$/],
  ];
  for (const [path, wanted] of files) {
    const src = read(path);
    for (const key of ["jd_materials_come_to", "jd_materials_partly_paid"]) {
      const line = src.split("\n").find((l) => l.includes(`name="${key}"`));
      assert.ok(line, `${path} lost ${key}`);
      assert.match(line, wanted, `${path} ${key} must state the next-$100-plus-$100 rule`);
      // CANARY: the sentence that was a month out of date.
      assert.ok(
        !/next \$10[^0]|siguientes \$10[^0]|10 \$ supérieurs/.test(line),
        `${path} ${key} still says the next $10`,
      );
    }
  }
  // The rule those sentences describe, as the code has it.
  assert.equal(DEPOSIT_ROUND_UP_TO, 100);
  assert.equal(DEPOSIT_PLUS, 100);
  // His own measured case: $1,630 of materials, the button sets $1,800.
  assert.equal(ruleDeposit(1630), 1800);
  assert.equal(phone.ruleDeposit(1630), 1800);
  // CANARY: the next-$10 rule on the same materials.
  assert.equal(Math.ceil(1630 / 10) * 10, 1630);
  assert.notEqual(Math.ceil(1630 / 10) * 10, 1800, "PLANTED: the label's old rule gives a different figure");
});

test("the capped label comes from the suggestion itself, not from the old $10 rounding", () => {
  const screen = read(JOB_SCREEN);
  assert.match(screen, /val suggestionIsCapped = suggestion\.capped/);
  assert.ok(
    !/ceil\(\(materialCost - paidSoFar\) \/ 10\.0\)/.test(screen),
    "the screen still re-derives the cap with the next-$10 rule",
  );
  // CANARY: on the measured job the old test could never fire. His K: 2,828.48
  // of materials on a 4,654.47 job, nothing paid -- the cap does NOT bite, and
  // the old comparison agrees. Make it bite and the old test still says no.
  const small = { depositAmount: 0, amountPaid: 0, refundedAmount: 0 };
  const capped = phone.depositSuggestion(small, 120, 150);
  assert.deepEqual(capped, { amount: 150, capped: true }, "the cap bites on a $150 job");
  assert.equal(
    old.suggestionIsCapped(capped.amount, 120, 0),
    false,
    "PLANTED: the old next-$10 comparison called this uncapped, so the label never showed",
  );
  assert.notEqual(old.suggestionIsCapped(capped.amount, 120, 0), capped.capped);
});

// ============================================ 6. one meaning of "received" ====

test("deposit received means the same thing on the phone and in the office", () => {
  const cases = [
    { name: "nothing in, a deposit asked", depositAmount: 3000, amountPaid: 0, refundedAmount: 0, total: 4654.47, want: false },
    { name: "part paid", depositAmount: 3000, amountPaid: 500, refundedAmount: 0, total: 4654.47, want: false },
    { name: "a cent short", depositAmount: 3000, amountPaid: 2999.99, refundedAmount: 0, total: 4654.47, want: false },
    { name: "the whole deposit", depositAmount: 3000, amountPaid: 3000, refundedAmount: 0, total: 4654.47, want: true },
    { name: "paid in full", depositAmount: 3000, amountPaid: 4654.47, refundedAmount: 0, total: 4654.47, want: true },
    { name: "no deposit asked for", depositAmount: 0, amountPaid: 0, refundedAmount: 0, total: 5853.81, want: true },
    { name: "paid then fully refunded", depositAmount: 1000, amountPaid: 1000, refundedAmount: 1000, total: 5000, want: false },
    { name: "a deposit above the price, paid in full", depositAmount: 3963, amountPaid: 3620, refundedAmount: 0, total: 3620, want: true },
  ];
  // The office's own rule, from jobReadiness(): nothing asked, or all of it in.
  const officeSays = (c) => {
    const dep = office.depositAskedOf(row(c), c.total);
    const paid = office.netPaid(row(c));
    return dep <= 0.005 || paid >= dep - 0.005;
  };
  for (const c of cases) {
    assert.equal(phone.depositSettled(c, c.total), c.want, `${c.name}: phone`);
    assert.equal(officeSays(c), c.want, `${c.name}: office`);
  }
  // POSITIVE CONTROL: the table has both answers in it.
  assert.ok(cases.some((c) => c.want) && cases.some((c) => !c.want));

  // The office's two surfaces read it off the same arithmetic as the phone.
  assert.match(dashboardSrc, /ok: dep <= 0\.005 \|\| paid >= dep - 0\.005/, "jobReadiness");
  assert.match(
    dashboardSrc,
    /\['jobProgStep3', progDep <= 0\.005 \|\| netPaid\(openJob\) >= progDep - 0\.005\]/,
    "the office job progress step",
  );
  assert.match(read(PROJECT_STATUS), /JobMoney\.depositSettled\(job, billableTotal\)/, "the phone's stage");

  // CANARY: the old "any money in" rule, on the part-paid job he was looking at.
  const partPaid = cases[1];
  assert.equal(old.depositReceived(partPaid), true, "PLANTED: the old phone said received");
  assert.notEqual(
    old.depositReceived(partPaid),
    phone.depositSettled(partPaid, partPaid.total),
    "PLANTED: $500 of a $3,000 deposit ticked on the phone and read part-paid in the office",
  );

  // And the other reading is no longer called a deposit anywhere a person reads.
  for (const path of [
    "app/src/main/res/values/strings.xml",
    "app/src/main/res/values-es/strings.xml",
    "app/src/main/res/values-fr/strings.xml",
  ]) {
    const src = read(path);
    for (const key of ["enum_payment_deposit_paid", "enum_pipeline_deposit_paid"]) {
      const line = src.split("\n").find((l) => l.includes(`name="${key}"`));
      assert.ok(line, `${path} lost ${key}`);
      // The TEXT, not the whole line: the resource NAME contains "deposit" and
      // always will -- the column's value is DEPOSIT_PAID in the database and
      // renaming that is a migration, not a label.
      const text = (line.match(/>([^<]*)</) || ["", ""])[1];
      assert.ok(
        !/[Dd]eposit|[Dd]epósito|[Aa]nticipo|[Aa]compte|[Dd]épôt/.test(text),
        `${key} in ${path} still calls "any money in" a deposit: ${text}`,
      );
    }
  }
  assert.match(dashboardSrc, /jobOptDepositPaid:'Part paid'/);
  assert.match(dashboardSrc, /calStageDepositPaid:'Part paid'/);
});

// ====================================== 7. one basis for "materials to buy" ===

test("materials still to be bought is one basis, and it includes the sales tax", () => {
  // His K, measured: 2,828.48 of material lines, 7% on the taxable ones.
  const totals = { materialsSubtotal: 2828.48, tax: 197.99, taxableSubtotal: 2828.48 };
  const orders = [{ materialCost: 150 }];
  const basis = phone.materialsToBuy(totals, orders);
  assert.equal(basis, 3176.47, "lines + tax + change-order materials");

  // CANARY: the three bases that disagreed. The deposit the rule produces is a
  // different figure on each, so this is not a cosmetic difference.
  const linesOnly = totals.materialsSubtotal;                       // the estimate warning
  const linesAndOrders = totals.materialsSubtotal + 150;            // the Set deposit button
  assert.notEqual(linesOnly, basis);
  assert.notEqual(linesAndOrders, basis);
  assert.equal(ruleDeposit(linesOnly), 3000, "PLANTED: lines only");
  assert.equal(ruleDeposit(linesAndOrders), 3100, "PLANTED: lines and change orders, no tax");
  assert.equal(ruleDeposit(basis), 3300, "the one basis, tax included");
  // The tax he pays at the counter, which the old bases left him to front.
  assert.equal(roundToCents(basis - linesAndOrders), 197.99);

  // The phone takes it from the one place.
  assert.match(read(JOB_VM), /JobMoney\.materialsToBuy\(/, "the job screen's materials figure");
  assert.match(jobMoneySrc, /fun materialsToBuy\(totals: EstimateEngine\.Totals, changeOrders: List<ChangeOrder>\)/);
  // The server's input says the same thing, so a server-side suggestion later
  // cannot quietly use a different basis.
  assert.match(
    read("supabase/functions/_shared/quote-deposit.ts"),
    /THE\s+\*\s*SALES TAX ON THEM|SALES TAX ON THEM/,
    "quote-deposit.ts must document the same basis",
  );
});

// ================================================= 8. cents, not float dust ===

test("a deposit typed with cents is stored to the cent", () => {
  const typed = [1234.56, 2158.45, 8101.68, 0.01, 4654.47, 99999.99];
  for (const t of typed) {
    // The field is Float-backed, so this is what reaches the write.
    const throughFloat = old.floatBacked(t);
    // The write rounds to cents (EstimateEngine.roundToCents == roundToCents).
    assert.equal(roundToCents(throughFloat), t, `${t} must store as itself`);
  }
  // POSITIVE CONTROL + CANARY: the dust is real, and it used to be stored.
  const dusty = typed.filter((t) => old.floatBacked(t) !== t);
  assert.ok(dusty.length >= 3, "float32 has to actually move these for this to mean anything");
  assert.equal(old.floatBacked(1234.56), 1234.56005859375, "PLANTED: what was stored before");
  assert.notEqual(old.floatBacked(1234.56), 1234.56);
  // And a dusty deposit changed what the customer was asked for.
  assert.notEqual(
    depositFigures({ depositAmount: old.floatBacked(1234.56), contractTotal: 5000, amountPaid: 0, refundedAmount: 0 }).asked,
    1234.56,
    "PLANTED: the page's own figure carried the dust",
  );
  assert.match(
    read(JOB_SCREEN),
    /depositAmount = EstimateEngine\.roundToCents\(typed\.toDouble\(\)\)/,
    "the one write that stores a typed deposit has to round it",
  );
});

// ======================================== the whole thing, on one real job ====

test("every surface agrees on his job K, payment by payment", () => {
  // K as measured in docs/MONEY_AUDIT_SURFACES.md: total 4,654.47, deposit
  // 3,000.00, materials 2,828.48 (plus the tax on them).
  const total = 4654.47;
  const ladder = [0, 500, 1500, 3000, 4000, 4654.47];
  for (const paid of ladder) {
    const j = { depositAmount: 3000, amountPaid: paid, refundedAmount: 0 };
    const server = depositFigures({
      depositAmount: 3000, contractTotal: total, amountPaid: paid, refundedAmount: 0,
    });
    const officeAsked = office.depositAskedOf(row(j), total);
    const officeDue = Math.max(0, officeAsked - office.netPaid(row(j)));

    // The deposit asked: phone, server, office, PDF row, estimate card.
    assert.equal(phone.depositAsked(j, total), 3000);
    assert.equal(server.asked, 3000);
    assert.equal(officeAsked, 3000);
    // What is still due on it: three copies of one subtraction.
    assert.equal(roundToCents(phone.depositStillDue(j, total)), roundToCents(server.due));
    assert.equal(roundToCents(officeDue), roundToCents(server.due));
    // What the next request is for: phone == page.
    const pageAsks = server.due > 0.005 ? server.due : server.balance;
    assert.equal(roundToCents(phone.nextRequestAmount(j, total)), roundToCents(pageAsks));
    // Whether the deposit is in: phone == office.
    assert.equal(phone.depositSettled(j, total), officeDue <= 0.005);
  }
  // POSITIVE CONTROL: the ladder really moves the figures it is checking.
  const dues = ladder.map((paid) =>
    depositFigures({ depositAmount: 3000, contractTotal: total, amountPaid: paid, refundedAmount: 0 }).due,
  );
  assert.deepEqual(dues, [3000, 2500, 1500, 0, 0, 0]);
  // CANARY: the old phone rule disagrees with the page at three rungs of it.
  const disagreements = ladder.filter((paid) => {
    const j = { depositAmount: 3000, amountPaid: paid, refundedAmount: 0 };
    const server = depositFigures({
      depositAmount: 3000, contractTotal: total, amountPaid: paid, refundedAmount: 0,
    });
    const pageAsks = server.due > 0.005 ? server.due : server.balance;
    return roundToCents(old.nextRequestAmount(j, total)) !== roundToCents(pageAsks);
  });
  assert.deepEqual(disagreements, [500, 1500], "PLANTED: the old rule's disagreements with her page");
});
