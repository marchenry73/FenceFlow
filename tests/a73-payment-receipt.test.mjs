// A73 -- THE RECEIPT. What the customer gets when money lands.
//
// "After customer pays, they should receive a receipt on their email and it
//  should look like a company made it."
// "...it should also send an email when the person make a payment even if it
//  was a test one"
//
// WHAT THIS GUARDS, in the order a regression would hurt somebody:
//
//   1. A TEST RECEIPT IS UNMISTAKABLY A TEST. Every one of his Stripe rows is
//      livemode false today, so the test path is the only one he has used --
//      and a receipt that reads as real, for money nobody paid, is a false
//      record of a payment. Marked in the SUBJECT (so it is clear before it is
//      opened) and in the FIRST LINE of the body, in all three languages.
//
//   2. THE AMOUNT IS IN IT. A receipt with no figure is not a receipt. This is
//      the deliberate opposite of the quote-send email, which is forbidden
//      from naming one (tests/a72-quote-email.test.mjs) because the price is
//      still moving while that letter sits in her inbox. Here the payment has
//      happened and the figure is the point.
//
//   3. A BALANCE IS NAMED ONLY WHEN THE CALLER VOUCHED FOR IT. null prints no
//      balance line at all -- a figure that went stale between the payment and
//      the send would read as a discount she can hold the company to.
//
//   4. NOTHING A STRANGER TYPED BECOMES A LINK. lead-intake runs with
//      verify_jwt = false and writes customer_name and address straight onto a
//      job from the public website form.
//
//   5. A RECEIPT WITH NOWHERE TO GO, OR NOTHING TO SAY, IS REFUSED with a
//      sentence -- and a refund (a negative amount) is refused rather than
//      printed as a payment, because it is a different letter.
//
//   6. All three languages carry every sentence, and they are actually
//      different text.
//
// NOTHING IS SENT. No network, no key, no address: every assertion is against
// the template function.
//
// Run: node --test tests/a73-payment-receipt.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(
  pathToFileURL(path.join(ROOT, "supabase/functions/_shared/payment-receipt.ts")).href
);

const {
  buildReceiptEmail, receiptRefusal, REFUSAL_REASON, RECEIPT_WORDS, methodWord, money, LANGS,
} = mod;

const LANGLIST = ["en", "es", "fr"];

// Real columns, invented values. No real customer's name or address.
const FACTS = {
  companyName: "Example Fence LLC",
  companyPhone: "(813) 555-0100",
  customerName: "Customer 1",
  address: "1200 Example Row",
  amount: 2480.5,
  method: "CARD",
  paidAt: "2026-10-23T03:25:00.000Z",
  timeZone: "America/New_York",
  stillOwed: 9919.5,
};

test("POSITIVE CONTROL: a real receipt is produced in all three languages", () => {
  for (const lang of LANGLIST) {
    const r = buildReceiptEmail(FACTS, lang);
    assert.ok(r.subject.length > 10, `${lang}: subject too short`);
    assert.ok(r.subject.includes(FACTS.companyName), `${lang}: the company is not named in the subject`);
    assert.ok(r.text.length > 200, `${lang}: body is ${r.text.length} chars -- too short to be a receipt`);
    // The control that makes "no TEST marking" below mean something.
    assert.ok(!/TEST|PRUEBA/.test(r.subject), `${lang}: a live receipt is marked as a test`);
  }
});

test("the amount paid is in the receipt, in every language", () => {
  for (const lang of LANGLIST) {
    const r = buildReceiptEmail(FACTS, lang);
    assert.ok(r.text.includes(money(FACTS.amount)), `${lang}: the amount is missing from the body`);
  }
  // CANARY: a receipt built with no amount must not pass the check above, or
  // the check is measuring nothing.
  const blank = buildReceiptEmail({ ...FACTS, amount: 0 }, "en");
  assert.ok(!blank.text.includes(money(FACTS.amount)),
    "THE CANARY FAILED: a zero-amount receipt still contained the test amount");
});

test("the date is the payment's own, in the company's time zone", () => {
  // 03:25 UTC on 23 Oct is still the EVENING OF THE 22nd in Florida. A
  // receipt dated tomorrow for a payment made tonight is the bug here.
  const r = buildReceiptEmail(FACTS, "en");
  assert.ok(r.text.includes("October 22, 2026"),
    "the date was not put in the company's time zone: " + r.text);
  // CONTROL: a DIFFERENT zone gives a different date, so the assertion above
  // is about the zone and not about the formatter.
  //
  // Not "no zone" as the control: with none, Intl uses the MACHINE's zone,
  // which on the machine this was written on is the same Eastern zone -- so
  // the control passed for the wrong reason and said nothing.
  const tokyo = buildReceiptEmail({ ...FACTS, timeZone: "Asia/Tokyo" }, "en");
  assert.ok(tokyo.text.includes("October 23, 2026"), "the control did not differ: " + tokyo.text);
});

test("an unparseable date prints no date line rather than Invalid Date", () => {
  for (const bad of ["", "not a date", null, undefined]) {
    const r = buildReceiptEmail({ ...FACTS, paidAt: bad }, "en");
    assert.ok(!/Invalid Date|NaN/.test(r.text), `"${bad}" leaked through: ` + r.text);
    assert.ok(!r.text.includes("Date:"), `"${bad}" printed an empty date line`);
  }
});

// ===========================================================================
// 1. A test receipt is unmistakably a test.
// ===========================================================================

test("a TEST receipt says so in the subject AND the first line, in every language", () => {
  for (const lang of LANGLIST) {
    const r = buildReceiptEmail({ ...FACTS, test: true }, lang);
    assert.match(r.subject, /\[(TEST|PRUEBA)\]/, `${lang}: the subject does not mark it as a test`);
    // The FIRST line, not somewhere further down: this is read on a phone.
    const first = r.text.split("\n")[0];
    assert.equal(first, RECEIPT_WORDS[lang].testNote, `${lang}: the test note is not the first line`);
    // And it says plainly that nothing moved.
    assert.ok(first.length > 80, `${lang}: the test note is too short to explain itself`);
  }
});

test("a live receipt carries no test marking anywhere", () => {
  for (const lang of LANGLIST) {
    const r = buildReceiptEmail(FACTS, lang);
    const whole = (r.subject + "\n" + r.text).toLowerCase();
    for (const word of ["test", "prueba", "[test]"]) {
      assert.ok(!whole.includes(word), `${lang}: a live receipt mentions "${word}"`);
    }
  }
});

// ===========================================================================
// 3. The balance.
// ===========================================================================

test("no balance line at all when the caller did not vouch for one", () => {
  for (const unknown of [null, undefined, NaN, "1200"]) {
    const r = buildReceiptEmail({ ...FACTS, stillOwed: unknown }, "en");
    assert.ok(!r.text.includes(RECEIPT_WORDS.en.stillOwed(money(9919.5))),
      `stillOwed=${String(unknown)} printed a balance`);
    assert.ok(!r.text.includes(RECEIPT_WORDS.en.settled),
      `stillOwed=${String(unknown)} claimed the job is settled`);
  }
  // CONTROL: a real figure DOES print, so the absences above are about the
  // figure being unknown and not about the line never existing.
  const known = buildReceiptEmail(FACTS, "en");
  assert.ok(known.text.includes(money(FACTS.stillOwed)), "a known balance was not printed");
});

test("a balance of zero says the job is settled, not 'still to pay $0.00'", () => {
  for (const lang of LANGLIST) {
    const r = buildReceiptEmail({ ...FACTS, stillOwed: 0 }, lang);
    assert.ok(r.text.includes(RECEIPT_WORDS[lang].settled), `${lang}: did not say the job is settled`);
    assert.ok(!r.text.includes(money(0)), `${lang}: printed $0.00 at a customer`);
  }
});

// ===========================================================================
// 4. Stranger-typed text.
// ===========================================================================

test("a link in a stranger-typed name or address never reaches the letter", () => {
  // customer_name and address come off the public lead form (lead-intake,
  // verify_jwt = false), so both are stranger-typed.
  const nasty = "Pay here https://evil.example.invalid/x or www.evil.example.invalid";
  for (const field of ["customerName", "address"]) {
    const r = buildReceiptEmail({ ...FACTS, [field]: nasty }, "en");
    assert.ok(!r.text.includes("https://"), `${field}: a URL reached the body`);
    assert.ok(!r.text.includes("www."), `${field}: a bare www link reached the body`);
  }
  // CONTROL: the harmless words around the link survive, so the cleaner is
  // removing links rather than dropping the whole field.
  const r = buildReceiptEmail({ ...FACTS, customerName: nasty }, "en");
  assert.ok(r.text.includes("Pay here"), "the cleaner dropped everything: " + r.text);
});

test("newlines and control characters cannot break the letter apart", () => {
  const r = buildReceiptEmail(
    { ...FACTS, customerName: "A\nB\r\nSubject: injected\u0000" }, "en"
  );
  const hello = r.text.split("\n")[0];
  assert.ok(hello.startsWith("Hi "), "the greeting is not the first line: " + hello);
  assert.ok(!r.text.includes("Subject: injected") || hello.includes("Subject: injected"),
    "injected text landed on its own line");
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(r.text), "a control character survived");
});

// ===========================================================================
// 5. Refusals.
// ===========================================================================

test("a receipt with nowhere to go is refused, and says why", () => {
  const base = { amount: 100, companyName: "Example Fence LLC" };
  assert.equal(receiptRefusal({ ...base, recipient: "" }), "no_address");
  assert.equal(receiptRefusal({ ...base, recipient: "   " }), "no_address");
  assert.equal(receiptRefusal({ ...base, recipient: "not-an-address" }), "bad_address");
  assert.equal(receiptRefusal({ ...base, recipient: "a@b" }), "bad_address");
  assert.equal(receiptRefusal({ ...base, recipient: "her@example.invalid" }), null);
});

test("a zero or negative payment is refused, not printed as a receipt", () => {
  const base = { recipient: "her@example.invalid", companyName: "Example Fence LLC" };
  assert.equal(receiptRefusal({ ...base, amount: 0 }), "no_amount");
  assert.equal(receiptRefusal({ ...base, amount: -250 }), "no_amount",
    "a refund was accepted as a payment receipt");
  assert.equal(receiptRefusal({ ...base, amount: "nonsense" }), "no_amount");
  assert.equal(receiptRefusal({ ...base, amount: 0.004 }), "no_amount");
  assert.equal(receiptRefusal({ ...base, amount: 100 }), null);
});

test("a company with no name is refused -- the receipt must not arrive from nobody", () => {
  assert.equal(
    receiptRefusal({ recipient: "her@example.invalid", amount: 100, companyName: "" }),
    "no_company_name"
  );
});

test("every refusal has a sentence in every language", () => {
  const codes = ["no_address", "bad_address", "no_amount", "no_company_name"];
  for (const lang of LANGLIST) {
    for (const code of codes) {
      const s = REFUSAL_REASON[lang][code];
      assert.equal(typeof s, "string", `${lang}.${code} is missing`);
      assert.ok(s.trim().length > 20, `${lang}.${code} is too short to help`);
    }
  }
  // And they are genuinely translated, compared by key.
  for (const code of codes) {
    const seen = new Set(LANGLIST.map((l) => REFUSAL_REASON[l][code]));
    assert.equal(seen.size, 3, `two languages share the same sentence for ${code}`);
  }
});

// ===========================================================================
// 6. Three languages, and the method word.
// ===========================================================================

test("every sentence exists in all three languages, and they differ", () => {
  assert.deepEqual([...LANGS], LANGLIST);
  const keys = Object.keys(RECEIPT_WORDS.en);
  for (const lang of LANGLIST) {
    assert.deepEqual(Object.keys(RECEIPT_WORDS[lang]).sort(), [...keys].sort(),
      `${lang} does not carry the same sentences as English`);
  }
  // Rendered, so a function that ignores its arguments is caught too.
  const render = (w) => [
    w.subject("C"), w.subjectTest("C"), w.testNote, w.hello("N"), w.received("$1.00", "C"),
    w.on("D"), w.by("M"), w.forJob("A"), w.stillOwed("$2.00"), w.settled, w.keep,
    w.questions("C", "P"),
  ];
  const en = render(RECEIPT_WORDS.en);
  for (const lang of ["es", "fr"]) {
    const other = render(RECEIPT_WORDS[lang]);
    for (let i = 0; i < en.length; i++) {
      assert.notEqual(other[i], en[i], `${lang} sentence ${i} is identical to English`);
    }
  }
});

test("the payment method is named in her language, and an unknown one prints nothing", () => {
  assert.equal(methodWord("CARD", "en"), "card");
  assert.equal(methodWord("card", "en"), "card");
  assert.equal(methodWord("CASH", "es"), "efectivo");
  assert.equal(methodWord("BANK_TRANSFER", "fr"), "virement bancaire");
  // Proper nouns stay as they are.
  assert.equal(methodWord("ZELLE", "fr"), "Zelle");
  // An enum this table does not know must not be printed at a customer.
  for (const unknown of ["OTHER", "CRYPTO", "", null, undefined, 42, "<script>"]) {
    assert.equal(methodWord(unknown, "en"), "", `"${String(unknown)}" leaked a raw value`);
  }
  // And the letter then simply has no "Paid by" line.
  const r = buildReceiptEmail({ ...FACTS, method: "CRYPTO" }, "en");
  assert.ok(!r.text.includes("Paid by"), "an unknown method printed an empty line: " + r.text);
  // CONTROL: a known one does print it.
  assert.ok(buildReceiptEmail(FACTS, "en").text.includes("Paid by: card"));
});

test("the phone is optional and its clause drops cleanly", () => {
  for (const lang of LANGLIST) {
    const r = buildReceiptEmail({ ...FACTS, companyPhone: "" }, lang);
    assert.ok(r.text.includes(RECEIPT_WORDS[lang].questions(FACTS.companyName, "")),
      `${lang}: the no-phone sentence is not the one that was used`);
    // No dangling punctuation where the clause was -- checked on the
    // questions line only. Run over the whole letter this matched "Hi
    // Customer 1," , which ends in a comma on purpose.
    const asks = r.text.split("\n").filter((l) => l.includes("?")).join(" ");
    assert.ok(!/,\s*[.?]/.test(asks), `${lang}: a clause left punctuation behind: ${asks}`);
  }
});

test("a bare job -- nothing but a company, an amount and a date -- still reads as a letter", () => {
  const bare = {
    companyName: "Example Fence LLC",
    amount: 500,
    paidAt: FACTS.paidAt,
  };
  for (const lang of LANGLIST) {
    const r = buildReceiptEmail(bare, lang);
    assert.ok(r.text.includes(money(500)), `${lang}: no amount`);
    assert.ok(!r.text.includes("undefined") && !r.text.includes("null"),
      `${lang}: a missing field printed itself: ` + r.text);
    // No empty fact lines.
    assert.ok(!/^(Paid by|Work at|Date):\s*$/m.test(r.text), `${lang}: an empty fact line`);
    // No run of three newlines: every dropped clause took its blank line with it.
    assert.ok(!r.text.includes("\n\n\n"), `${lang}: a dropped line left a gap`);
  }
});
