// a73 -- THE REST OF THE CUSTOMER EMAIL SET (pure: no network, no database, NOTHING SENT).
//
// Section 3 of supabase/functions/_shared/email-templates.ts, and its browser
// twin website/js/lib/job-emails.mjs, build the four emails nothing in this
// product speaks for today:
//
//   reapproval_needed  the drawing changed, so the approval was withdrawn
//   payment_received   a receipt, and what is still owed
//   scheduled          you are on the schedule for <date>
//   work_finished      the fence is in
//
// Run with:
//
//   node --test tests/a73-email-template-set.test.mjs
//
// NOTHING HERE SENDS ANYTHING. There is no fetch, no mail provider, no
// Supabase client and no address belonging to a real person anywhere in this
// file. Both modules are pure -- facts in, words out -- which is the whole
// reason they are separate from the senders.
//
// WHAT THIS FILE IS FOR, in order of how much it would cost to get wrong:
//
//   1. NOTHING OPTIONAL IS EVER PRINTED EMPTY. Rendered with every optional
//      fact absent, no template may produce an empty label, a double space, a
//      dangling "call us at", "Hi ,", a stray bullet or a leftover
//      placeholder. He said it about payment methods and it holds for every
//      field: "I only want to present what is there."
//   2. NO INVENTED NUMBER OR TERM. No warranty length, no lead time, no
//      cancellation window, no fee, no percentage, no time of day -- checked
//      two ways: a banned-wording scan over EVERY sentence either module can
//      print, and a sentinel scan proving every digit in a finished email came
//      from a fact the caller passed in.
//   3. NO FIGURE ANOTHER SURFACE OWNS. The balance is depositFigures()'s
//      figure under the quote page's own label, proved against both the page
//      and the approval email; the builders are fed poisoned extra fields
//      (total, deposit, contractTotal, amountPaid, materials) and must produce
//      byte-identical output; and the two templates declared money-free must
//      print no figure even when a caller passes one.
//   4. THREE LANGUAGES, COMPARED BY KEY, NOT BY WORD.
//   5. THE SERVER'S COPY AND THE BROWSER'S COPY CANNOT DRIFT -- compared on
//      rendered output, character for character, not by searching for a
//      phrase.
//
// EVERY CHECK HERE HAS A CANARY. A checker that cannot fail reports zero
// failures for a case it never looked at, so each scanner below is first run
// against a planted bad input and asserted to FIND it. The canaries are marked
// CANARY and each says what it plants.
//
// WHAT THE CANARY RUN ACTUALLY CAUGHT, 2026-10-02. Two faults were planted in
// website/js/lib/job-emails.mjs -- an invented warranty length and lead time
// ("warranted for one year ... we return within 3 business days") in the
// English words, and a balance label printed with nothing after it when the
// caller passes no balance. The first run caught the warranty in two tests and
// MISSED the empty label entirely, because every cleanliness check was
// rendering the SERVER copy only. That is why the render-reading checks loop
// over COPIES rather than over SRV: the second run caught both faults in five
// tests, and the file is green with the faults reverted. The digit scan and the
// money-free scan still read the server copy alone on purpose -- the parity
// test compares the two copies byte for byte across every template, language
// and job shape, which is a stronger statement than scanning each separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as SRV from "../supabase/functions/_shared/email-templates.ts";
import * as WEB from "../website/js/lib/job-emails.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Characters that must never reach a sent email, built by code point: a literal
 *  U+2028 inside a regex literal is a syntax error, and an editor that decodes a
 *  backslash-u escape into the character it stands for turns a working test file
 *  into one that cannot load. email-templates.ts avoids them for the same reason. */
const U = (c) => String.fromCharCode(c);
const NL = U(10);
const INVISIBLE_CHARS = new RegExp(`[${U(0)}${U(0x2028)}${U(0x2029)}${U(0x200b)}]`);

const LANGS = ["en", "es", "fr"];
const TEMPLATES = SRV.JOB_EMAIL_TEMPLATES;
/**
 * The two copies, rendered side by side by every check that reads a finished
 * email. The first canary run of this file proved why this is a list and not
 * just SRV: an empty label planted in the browser copy alone passed every
 * cleanliness check, because nothing was rendering the browser copy.
 */
const COPIES = [["server", SRV], ["browser", WEB]];

// --------------------------------------------------------------------------
// Fixtures. Every name, address and link here is obviously fake; no real
// customer, company or mailbox appears in this file.
// --------------------------------------------------------------------------

/** Figures chosen so each is unmistakable in a finished email and cannot arise by coincidence. */
const AMOUNT = 1234.56;
const BALANCE = 7890.12;
/** Dates carry NO DIGITS, so any digit left in a rendered email must be a figure. */
const DATE_SCHEDULED = "Schedulember the Nth";
const DATE_CHANGED = "Changember the Nth";
const DATE_PAID = "Paidember the Nth";
const DATE_AS_OF = "Asofember the Nth";

const FULL = Object.freeze({
  companyName: "Test Fence Co",
  companyPhone: "KL five-eleven hundred",
  customerName: "Pat Buyer",
  address: "One Test Street, Testville",
  quoteUrl: "https://quote.example.test/quote.html?t=tttttt",
  changedOn: DATE_CHANGED,
  runLabel: "back yard",
  paymentTaken: true,
  amount: AMOUNT,
  paidOn: DATE_PAID,
  scheduledOn: DATE_SCHEDULED,
  balance: BALANCE,
  asOf: DATE_AS_OF,
});

/** Only what [jobEmailRefusal] insists on for this template; every optional fact absent. */
function minimalFacts(template) {
  const f = { companyName: "Test Fence Co" };
  if (template === "reapproval_needed") f.quoteUrl = "https://quote.example.test/q";
  if (template === "payment_received") f.amount = AMOUNT;
  if (template === "scheduled") f.scheduledOn = DATE_SCHEDULED;
  return f;
}

/** The shapes a real job comes in. Each is FULL with pieces taken away. */
const SHAPES = [
  ["everything filled in", FULL],
  ["no phone", { ...FULL, companyPhone: "" }],
  ["no customer name", { ...FULL, customerName: "" }],
  ["no address", { ...FULL, address: "" }],
  ["no link", { ...FULL, quoteUrl: "" }],
  ["no dates", { ...FULL, changedOn: "", paidOn: "", asOf: "", scheduledOn: DATE_SCHEDULED }],
  ["nothing paid yet", { ...FULL, paymentTaken: false, balance: 0 }],
  ["no run named", { ...FULL, runLabel: "" }],
  ["balance absent", { ...FULL, balance: null, asOf: "" }],
  ["only what is required", null], // filled per template below
];

// --------------------------------------------------------------------------
// The scanners. Each is a pure function from text to a list of complaints, so
// a canary can prove it complains.
// --------------------------------------------------------------------------

/**
 * Anything that reads as a gap somebody forgot to fill in.
 *
 * Deliberately NOT a check for a space before every punctuation mark: French
 * typography puts one before a colon, a question mark and a semicolon, and the
 * approval email already writes "Reste a payer : " that way on purpose. What a
 * dropped fact actually leaves behind is a space before a COMMA or a FULL STOP
 * ("Hi ,", "and tell ."), and that is what is checked.
 */
function cleanlinessProblems(text) {
  const bad = [];
  const lines = String(text).split(NL);
  if (/ {2,}/.test(text)) bad.push("two or more spaces in a row");
  if (new RegExp(NL + "{3,}").test(text)) bad.push("three or more newlines in a row");
  if (new RegExp("[ \\t]+(?:" + NL + "|$)").test(text)) bad.push("trailing whitespace on a line");
  if (/\(\s*\)/.test(text)) bad.push("empty brackets");
  if (/[{}]|%s|%1\$s/.test(text)) bad.push("a placeholder was left in");
  if (/\b(?:undefined|null|NaN|Infinity)\b/.test(text)) bad.push("a JavaScript value reached the words");
  if (/\$NaN|\$(?=\s|$)/.test(text)) bad.push("a dollar sign with no figure after it");
  for (const [i, line] of lines.entries()) {
    const where = `line ${i + 1}: ${JSON.stringify(line)}`;
    // A label or a heading with nothing after it. A heading that ends in a
    // colon is legitimate only when a bullet follows it on the next line.
    if (/\S\s?:$/.test(line)) {
      const next = (lines[i + 1] ?? "").trimStart();
      if (!next.startsWith("-")) bad.push(`label with nothing after it, ${where}`);
    }
    if (/^-\s*$/.test(line)) bad.push(`empty bullet, ${where}`);
    if (/\s[,.]/.test(line)) bad.push(`space before a comma or a full stop, ${where}`);
    if (/,,|\.\.|[,;]\s*\./.test(line)) bad.push(`doubled punctuation, ${where}`);
    if (/^(?:Hi|Hello|Hola|Bonjour)\s*,\s*,/.test(line)) bad.push(`greeting with no name, ${where}`);
    if (/-\s*\./.test(line)) bad.push(`dash with nothing after it, ${where}`);
  }
  return bad;
}

/**
 * Wordings only he can supply, and that therefore must never appear in a
 * template. A warranty length, a lead time, a cancellation window, a fee, a
 * percentage or a time of day written into an email becomes a term of his
 * contract, in writing, in the customer's inbox.
 */
const BANNED = [
  // warranty
  /\bwarrant/i, /\bguarantee/i, /garant[íi]a/i, /\bgaranti/i,
  // lead time / duration / time of day
  /business day/i, /working day/i, /d[íi]as h[áa]biles/i, /jours ouvrables/i,
  /\bweeks?\b/i, /\bsemanas?\b/i, /\bsemaines?\b/i,
  /\bam\b|\bpm\b/i, /o.clock/i,
  /\bbusiness hours\b/i,
  // cancellation window
  /cancel/i, /cancelaci/i, /annul/i,
  // fees and rates
  /\bfee\b/i, /\bfees\b/i, /restocking/i, /late payment/i, /\brecargo\b/i, /\bfrais\b/i,
  /\bpercent\b/i, /per cent/i, /\bpor ciento\b/i, /pour cent/i, /%/,
  // a figure written into a sentence
  /\$\s?\d/, /\d+\s?(?:days?|d[íi]as?|jours?|months?|meses?|mois)\b/i,
  // any digit at all: every figure in these emails arrives as a fact
  /[0-9]/,
];

/** Every sentence either module can print, with every argument a digit-free sentinel. */
function everySentence(words) {
  const SENTINEL = "SENTINELPIECE";
  const out = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(words[lang])) {
      if (typeof value === "string") out.push([lang, key, value]);
      else if (typeof value === "function") {
        // Called at every arity it can take, so a branch that only fires when
        // an argument is blank is read too.
        const n = value.length;
        const fills = [Array(n).fill(SENTINEL), Array(n).fill(""), Array(n).fill(SENTINEL).fill("", 1)];
        for (const args of fills) out.push([lang, key, String(value(...args))]);
      }
    }
  }
  return out;
}

function bannedWordingProblems(sentences) {
  const bad = [];
  for (const [lang, key, text] of sentences) {
    for (const rx of BANNED) {
      if (rx.test(text)) bad.push(`${lang}.${key} matches ${rx}: ${JSON.stringify(text)}`);
    }
  }
  return bad;
}

/** Which currency-shaped tokens a rendered email contains. */
const currencyTokens = (text) => String(text).match(/\$[\d,]+(?:\.\d{2})?/g) ?? [];

// ==========================================================================
// 0. The scanners have teeth.  CANARY SECTION -- every one of these plants a
//    fault and asserts the scanner finds it. If this block ever passes
//    silently with the scanners broken, everything below it is worthless.
// ==========================================================================

test("CANARY: cleanlinessProblems finds every kind of gap it claims to", () => {
  const planted = [
    ["two spaces", "Hello,\n\nYour fence  is finished."],
    ["empty label", "Hello,\n\nLeft to pay:\n\nTest Fence Co"],
    ["dangling clause", "Hello,\n\nQuestions? Just reply, or call Test Fence Co at ."],
    ["greeting with no name", "Hi ,\n\nYour fence is finished."],
    ["leftover placeholder", "Hello,\n\nYour fence at {address} is finished."],
    ["JavaScript value", "Hello,\n\nWe have received your payment of undefined."],
    ["empty bullet", "Before we start, please:\n-\n- Move anything of yours."],
    ["dollar with no figure", "Hello,\n\nLeft to pay: $ "],
  ];
  for (const [what, text] of planted) {
    const found = cleanlinessProblems(text);
    assert.ok(found.length > 0, `cleanlinessProblems did NOT catch the planted ${what}: ${JSON.stringify(text)}`);
  }
  // And a positive control: clean text must come back clean, or the scanner
  // is simply complaining about everything and proves nothing.
  assert.deepEqual(
    cleanlinessProblems("Hello,\n\nYour fence is finished.\n\nTest Fence Co"),
    [],
    "cleanlinessProblems complained about text that is actually clean",
  );
});

test("CANARY: bannedWordingProblems finds an invented term and an invented figure", () => {
  const planted = {
    en: {
      warranty: "Workmanship is warranted for one year from completion.",
      lead: "We will start within 3 business days.",
      cancelWindow: "You may cancel within 72 hours.",
      fee: "A 5% restocking fee applies.",
      time: "The crew arrives at 8am.",
    },
    es: { warranty: "La mano de obra tiene garantía de un año." },
    fr: { warranty: "La main-d'oeuvre est garantie un an." },
  };
  const found = bannedWordingProblems(everySentence(planted));
  for (const key of ["warranty", "lead", "cancelWindow", "fee", "time"]) {
    assert.ok(found.some((f) => f.includes(`en.${key}`)), `the banned-wording scan missed en.${key}`);
  }
  assert.ok(found.some((f) => f.startsWith("es.")), "the banned-wording scan missed the Spanish warranty");
  assert.ok(found.some((f) => f.startsWith("fr.")), "the banned-wording scan missed the French warranty");
  // Positive control: the sentence shapes these templates really use must pass.
  assert.deepEqual(
    bannedWordingProblems(everySentence({
      en: { ok: "Your fence is finished.", f: (a) => `Left to pay: ${a}` },
      es: { ok: "Su cerca está terminada." },
      fr: { ok: "Votre clôture est terminée." },
    })),
    [],
    "the banned-wording scan complained about sentences that are fine",
  );
});

test("CANARY: the server copy and the browser copy are compared on output, and a change is caught", () => {
  const a = SRV.buildJobEmail("work_finished", FULL, "en");
  const tampered = { ...a, text: a.text.replace("finished", "complete") };
  assert.notEqual(tampered.text, a.text, "the tamper did nothing, so this canary proves nothing");
  assert.throws(
    () => assert.equal(tampered.text, a.text),
    "comparing two different bodies did NOT fail -- the parity check below cannot detect drift",
  );
});

test("CANARY: comparing the language tables BY KEY catches a missing key", () => {
  const keysOf = (o) => Object.keys(o).sort();
  const planted = { en: { a: "x", b: "y" }, es: { a: "x" }, fr: { a: "x", b: "y" } };
  assert.notDeepEqual(keysOf(planted.es), keysOf(planted.en), "the by-key comparison cannot see a missing key");
});

// ==========================================================================
// 1. Nothing optional is ever printed empty.
// ==========================================================================

test("every template, in every language, is clean with NOTHING optional filled in", () => {
  for (const template of TEMPLATES) {
    for (const lang of LANGS) {
      for (const [which, M] of COPIES) {
        const built = M.buildJobEmail(template, minimalFacts(template), lang);
        assert.deepEqual(
          cleanlinessProblems(built.text), [],
          `${which} copy, ${template}/${lang} body, with every optional fact absent`,
        );
        assert.deepEqual(
          cleanlinessProblems(built.subject), [],
          `${which} copy, ${template}/${lang} subject, with every optional fact absent`,
        );
        assert.ok(built.subject.length > 0, `${which} copy, ${template}/${lang} produced no subject`);
        assert.ok(built.text.trim().length > 0, `${which} copy, ${template}/${lang} produced no body`);
      }
    }
  }
});

test("every template, in every language, is clean in every shape a real job comes in", () => {
  for (const template of TEMPLATES) {
    for (const lang of LANGS) {
      for (const [what, shape] of SHAPES) {
        const facts = shape ?? minimalFacts(template);
        for (const [which, M] of COPIES) {
          const built = M.buildJobEmail(template, facts, lang);
          assert.deepEqual(
            cleanlinessProblems(`${built.subject}\n${built.text}`), [],
            `${which} copy, ${template}/${lang}, ${what}`,
          );
        }
      }
    }
  }
});

test("a blank business name never leaves a dangling line", () => {
  // jobEmailRefusal() already refuses this send; the builder must not be the
  // thing that produces "Payment received - " either.
  for (const template of TEMPLATES) {
    for (const lang of LANGS) {
      for (const [which, M] of COPIES) {
        const built = M.buildJobEmail(template, { ...minimalFacts(template), companyName: "" }, lang);
        assert.deepEqual(
          cleanlinessProblems(`${built.subject}\n${built.text}`), [],
          `${which} copy, ${template}/${lang}`,
        );
      }
    }
  }
});

// ==========================================================================
// 2. No invented number, no invented term.
// ==========================================================================

test("no sentence either module can print carries a figure or a term only he can supply", () => {
  assert.deepEqual(
    bannedWordingProblems(everySentence(SRV.JOB_EMAIL_WORDS)), [],
    "the server copy writes something only the owner can decide",
  );
  assert.deepEqual(
    bannedWordingProblems(everySentence(WEB.JOB_EMAIL_WORDS)), [],
    "the browser copy writes something only the owner can decide",
  );
});

test("every digit in a finished email came from a fact the caller passed in", () => {
  // The dates in FULL contain no digits on purpose, so after the two figures
  // are removed nothing numeric may be left anywhere.
  const sentinels = [
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(AMOUNT),
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(BALANCE),
  ];
  // Control: the sentinels really are present where they should be, or
  // stripping them proves nothing.
  const receipt = SRV.buildJobEmail("payment_received", FULL, "en");
  assert.ok(receipt.text.includes(sentinels[0]), "the receipt did not state the payment at all");
  assert.ok(receipt.text.includes(sentinels[1]), "the receipt did not state the balance at all");

  for (const template of TEMPLATES) {
    for (const lang of LANGS) {
      const built = SRV.buildJobEmail(template, FULL, lang);
      let left = `${built.subject}\n${built.text}`;
      for (const s of sentinels) left = left.split(s).join("");
      const digits = left.match(/[0-9]+/g);
      assert.equal(
        digits, null,
        `${template}/${lang} printed a number that came from nowhere: ${JSON.stringify(digits)}`,
      );
    }
  }
});

test("the only figures the set can print are the payment and the balance", () => {
  for (const template of TEMPLATES) {
    for (const lang of LANGS) {
      const built = SRV.buildJobEmail(template, FULL, lang);
      const tokens = currencyTokens(`${built.subject}\n${built.text}`);
      for (const t of tokens) {
        assert.ok(
          t === "$1,234.56" || t === "$7,890.12",
          `${template}/${lang} printed a figure that is neither the payment nor the balance: ${t}`,
        );
      }
    }
  }
});

test("the two money-free templates print no figure even when a caller passes one", () => {
  for (const template of TEMPLATES) {
    const carries = SRV.JOB_EMAIL_CARRIES_MONEY[template];
    for (const lang of LANGS) {
      const built = SRV.buildJobEmail(template, FULL, lang);
      const tokens = currencyTokens(`${built.subject}\n${built.text}`);
      if (carries) {
        assert.ok(tokens.length > 0, `${template}/${lang} is declared to carry money and printed none`);
      } else {
        assert.deepEqual(
          tokens, [],
          `${template}/${lang} is declared money-free -- a crew member may send it -- and it printed ${tokens.join(", ")}`,
        );
      }
    }
  }
});

// ==========================================================================
// 3. No figure another surface owns.
// ==========================================================================

test("the builders read nothing but their own whitelist", () => {
  // Fed fields named for everything the rest of the app knows about this job.
  // If any of them reached a sentence, the output would change.
  const POISON = {
    total: 99999.99,
    deposit: 88888.88,
    contractTotal: 77777.77,
    acceptedTotal: 66666.66,
    amountPaid: 55555.55,
    refundedAmount: 44444.44,
    materials: 33333.33,
    roundedMaterials: 22222.22,
    extra: 11111.11,
    schedulingFee: 100,
    taxRatePercent: 7.5,
    warrantyPeriod: "one year",
    leadTimeDays: 10,
    cancellationHours: 72,
  };
  for (const template of TEMPLATES) {
    for (const lang of LANGS) {
      const clean = SRV.buildJobEmail(template, FULL, lang);
      const poisoned = SRV.buildJobEmail(template, { ...FULL, ...POISON }, lang);
      assert.equal(poisoned.subject, clean.subject, `${template}/${lang} subject changed when poisoned`);
      assert.equal(poisoned.text, clean.text, `${template}/${lang} body changed when poisoned`);
    }
  }
});

test("the balance is printed under the SAME label the quote page uses for it", () => {
  // One number, one wording. She reads the email and the page side by side.
  const page = read("website/quote.html");
  const approval = read("supabase/functions/quote-approval-email/email.ts");
  const expected = { en: "Left to pay", es: "Queda por pagar", fr: "Reste à payer" };
  for (const lang of LANGS) {
    const label = SRV.JOB_EMAIL_WORDS[lang].balance;
    assert.equal(label, expected[lang], `the ${lang} balance label is not what this test was written against`);
    assert.ok(
      page.includes(`balanceDue: '${label}'`),
      `website/quote.html no longer labels depositFigures().balance "${label}" in ${lang}. ` +
      "Either the page was renamed and section 3 of email-templates.ts must follow, " +
      "or the email is now giving one number two names.",
    );
    assert.ok(
      approval.includes(`balance: "${label}"`),
      `quote-approval-email/email.ts no longer labels the balance "${label}" in ${lang}. ` +
      "Two emails about the same job would then use two wordings for one figure.",
    );
    assert.equal(WEB.JOB_EMAIL_WORDS[lang].balance, label, `the browser copy's ${lang} balance label drifted`);
  }
});

test("the balance line and the sentence that dates it are both there or neither", () => {
  for (const template of ["payment_received", "work_finished"]) {
    for (const lang of LANGS) {
      const label = SRV.JOB_EMAIL_WORDS[lang].balance;
      const withBoth = SRV.buildJobEmail(template, FULL, lang).text;
      assert.ok(withBoth.includes(label), `${template}/${lang} dropped the balance it was given`);
      assert.ok(withBoth.includes(DATE_AS_OF), `${template}/${lang} stated a balance with no date on it`);

      const noBalance = SRV.buildJobEmail(template, { ...FULL, balance: 0 }, lang).text;
      assert.ok(!noBalance.includes(label), `${template}/${lang} printed a zero balance instead of omitting it`);
      assert.ok(!noBalance.includes(DATE_AS_OF), `${template}/${lang} dated figures it did not print`);

      const noDate = SRV.buildJobEmail(template, { ...FULL, asOf: "" }, lang).text;
      assert.ok(noDate.includes(label), `${template}/${lang} dropped the balance because it had no date`);
      assert.deepEqual(cleanlinessProblems(noDate), [], `${template}/${lang} with a balance and no date`);
    }
  }
});

// ==========================================================================
// 4. Three languages, compared by key.
// ==========================================================================

test("every template exists in all three languages, compared by key", () => {
  const keysOf = (o) => Object.keys(o).sort();
  const base = keysOf(SRV.JOB_EMAIL_WORDS.en);
  assert.ok(base.length > 10, "the English table is suspiciously small; this test is reading the wrong thing");
  for (const lang of LANGS) {
    assert.deepEqual(keysOf(SRV.JOB_EMAIL_WORDS[lang]), base, `the ${lang} table does not have the same keys as English`);
    assert.deepEqual(keysOf(WEB.JOB_EMAIL_WORDS[lang]), base, `the browser copy's ${lang} table has different keys`);
    for (const key of base) {
      assert.equal(
        typeof SRV.JOB_EMAIL_WORDS[lang][key], typeof SRV.JOB_EMAIL_WORDS.en[key],
        `${lang}.${key} is a ${typeof SRV.JOB_EMAIL_WORDS[lang][key]} where English has a ${typeof SRV.JOB_EMAIL_WORDS.en[key]}`,
      );
      if (typeof SRV.JOB_EMAIL_WORDS.en[key] === "function") {
        assert.equal(
          SRV.JOB_EMAIL_WORDS[lang][key].length, SRV.JOB_EMAIL_WORDS.en[key].length,
          `${lang}.${key} takes a different number of facts than English does`,
        );
      }
    }
  }
});

test("no sentence is left in English inside the Spanish or French table", () => {
  for (const lang of ["es", "fr"]) {
    for (const key of Object.keys(SRV.JOB_EMAIL_WORDS.en)) {
      const en = SRV.JOB_EMAIL_WORDS.en[key];
      const other = SRV.JOB_EMAIL_WORDS[lang][key];
      if (typeof en !== "string" || key === "sep") continue;
      assert.notEqual(other, en, `${lang}.${key} is still the English sentence`);
    }
  }
});

test("every refusal has a sentence in all three languages", () => {
  const codes = ["no_address", "bad_address", "no_link", "no_company_name", "no_amount", "no_date"];
  for (const lang of LANGS) {
    for (const code of codes) {
      const srv = SRV.JOB_EMAIL_REFUSAL_REASON[lang][code];
      assert.ok(srv && srv.length > 20, `${lang}.${code} has no usable sentence on the server`);
      assert.deepEqual(cleanlinessProblems(srv), [], `${lang}.${code} is not a clean sentence`);
      assert.equal(WEB.JOB_EMAIL_REFUSAL_REASON[lang][code], srv, `the browser copy's ${lang}.${code} drifted from the server's`);
    }
  }
});

// ==========================================================================
// 5. A template with nowhere to go is refused BEFORE any words are built.
// ==========================================================================

test("full facts are accepted, and each missing requirement is refused by name", () => {
  const good = { ...FULL, recipient: "someone@example.test" };
  for (const template of TEMPLATES) {
    // Positive control first: if this ever stops being null, every refusal
    // below would pass for the wrong reason.
    assert.equal(SRV.jobEmailRefusal(template, good), null, `${template} refused a job that has everything`);
    assert.equal(WEB.jobEmailRefusal(template, good), null, `${template} refused a complete job in the browser copy`);

    assert.equal(SRV.jobEmailRefusal(template, { ...good, recipient: "" }), "no_address");
    assert.equal(SRV.jobEmailRefusal(template, { ...good, recipient: "not an address" }), "bad_address");
    assert.equal(SRV.jobEmailRefusal(template, { ...good, recipient: "a@b.test, c@d.test" }), "bad_address");
    assert.equal(SRV.jobEmailRefusal(template, { ...good, companyName: "" }), "no_company_name");
  }
  assert.equal(SRV.jobEmailRefusal("reapproval_needed", { ...good, quoteUrl: "" }), "no_link");
  assert.equal(SRV.jobEmailRefusal("reapproval_needed", { ...good, quoteUrl: "http://quote.example.test/q" }), "no_link");
  assert.equal(SRV.jobEmailRefusal("payment_received", { ...good, amount: 0 }), "no_amount");
  assert.equal(SRV.jobEmailRefusal("payment_received", { ...good, amount: null }), "no_amount");
  assert.equal(SRV.jobEmailRefusal("scheduled", { ...good, scheduledOn: "" }), "no_date");
  // And the ones that do NOT need those facts are not refused for lacking them.
  assert.equal(SRV.jobEmailRefusal("work_finished", { ...good, quoteUrl: "", amount: 0, scheduledOn: "" }), null);
  assert.equal(SRV.jobEmailRefusal("scheduled", { ...good, quoteUrl: "", amount: 0 }), null);
});

// ==========================================================================
// 6. The server's copy and the browser's copy cannot drift.
// ==========================================================================

test("the server copy and the browser copy render the same email, character for character", () => {
  assert.deepEqual([...WEB.JOB_EMAIL_TEMPLATES], [...TEMPLATES], "the two copies do not even agree on the list");
  assert.deepEqual(WEB.JOB_EMAIL_CARRIES_MONEY, SRV.JOB_EMAIL_CARRIES_MONEY, "the two copies disagree on which templates carry money");
  let compared = 0;
  for (const template of TEMPLATES) {
    for (const lang of LANGS) {
      for (const [what, shape] of SHAPES) {
        const facts = shape ?? minimalFacts(template);
        const a = SRV.buildJobEmail(template, facts, lang);
        const b = WEB.buildJobEmail(template, facts, lang);
        assert.equal(b.subject, a.subject, `${template}/${lang}, ${what}: subjects differ`);
        assert.equal(b.text, a.text, `${template}/${lang}, ${what}: bodies differ`);
        compared++;
      }
    }
  }
  // A loop that compared nothing passes. Say how much it actually read.
  assert.equal(compared, TEMPLATES.length * LANGS.length * SHAPES.length);
  assert.ok(compared >= 100, `only ${compared} renderings were compared`);
});

test("the shared primitives behave the same in both copies", () => {
  const cases = ["", " a  b ", "a​b", "x".repeat(300), "https://a.test/x", "http://a.test/x", "javascript:alert(1)"];
  for (const c of cases) {
    assert.equal(WEB.oneLine(c, 40), SRV.oneLine(c, 40), `oneLine drifted on ${JSON.stringify(c)}`);
    assert.equal(WEB.safeUrl(c), SRV.safeUrl(c), `safeUrl drifted on ${JSON.stringify(c)}`);
  }
  for (const c of ["es", "fr", "en", "de", "", null, "ES-mx"]) {
    assert.equal(WEB.pickLang(c), SRV.pickLang(c), `pickLang drifted on ${JSON.stringify(c)}`);
  }
  assert.equal(WEB.pickLang(null, "fr-CA,fr;q=0.9,en;q=0.8"), "fr");
  assert.equal(SRV.pickLang(null, "fr-CA,fr;q=0.9,en;q=0.8"), "fr");
});

// ==========================================================================
// 7. One template, one moment.
// ==========================================================================

test("no two templates produce the same subject, so he is never choosing between two right answers", () => {
  for (const lang of LANGS) {
    const subjects = TEMPLATES.map((t) => SRV.buildJobEmail(t, FULL, lang).subject);
    assert.equal(new Set(subjects).size, subjects.length, `two templates share a subject in ${lang}: ${subjects.join(" | ")}`);
  }
});

test("nothing anybody typed can become markup, a header or an invisible character", () => {
  // These modules build PLAIN TEXT and nothing else. What the customer typed,
  // what he typed and what a run is labelled all travel as text; the HTML twin
  // is made later, by composeBody(), which escapes. So there are two things to
  // prove here: the builders add no markup OF THEIR OWN, and a hostile string
  // survives as literal text rather than becoming structure.
  const nasty = {
    ...FULL,
    customerName: "<script>alert(1)</script>",
    address: "1 Test St\r\nBcc: someone@example.test",
    companyName: `Co${U(0x2028)}${U(0x200b)}Name`,
    companyPhone: "555\n0100",
    runLabel: `back${U(0)}yard`,
  };
  for (const template of TEMPLATES) {
    for (const lang of LANGS) {
      const clean = SRV.buildJobEmail(template, FULL, lang);
      assert.ok(!/[<>]/.test(clean.text), `${template}/${lang} built markup out of clean facts`);
      assert.ok(!/&[a-z]+;|&#/i.test(clean.text), `${template}/${lang} built an HTML entity`);

      const built = SRV.buildJobEmail(template, nasty, lang);
      assert.ok(!/\r/.test(built.text), `${template}/${lang} carried a carriage return into the body`);
      assert.ok(!/[\r\n]/.test(built.subject), `${template}/${lang} carried a newline into the subject`);
      assert.ok(!INVISIBLE_CHARS.test(built.text), `${template}/${lang} carried an invisible character`);
      assert.ok(!INVISIBLE_CHARS.test(built.subject), `${template}/${lang} carried an invisible character into the subject`);
      // A newline typed into an address or a phone number must not become a new
      // line of the email, which is how a typed "Bcc:" would come to look like
      // a header.
      assert.ok(
        !built.text.split("\n").some((l) => /^Bcc:/i.test(l.trim())),
        `${template}/${lang} let a typed header become its own line`,
      );
      assert.ok(!/^Bcc:/mi.test(built.subject), `${template}/${lang} let a header through the subject`);
      // Control: the hostile name really did reach the body, as text. Without
      // this, the checks above could be passing on an email that dropped it.
      assert.ok(
        built.text.includes("<script>alert(1)</script>"),
        `${template}/${lang} dropped the typed name, so this test proved nothing`,
      );
    }
  }
});
