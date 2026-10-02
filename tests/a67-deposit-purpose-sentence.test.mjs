// a67 -- WHAT THE DEPOSIT IS FOR, told to the customer on every surface she sees.
//
//   node --test tests/a67-deposit-purpose-sentence.test.mjs
//
// WHY THIS EXISTS. The owner asked for it in his own words on 1 Oct 2026:
//
//   "Also let the customer the deposit is to put you on the schedule and to
//    get the materials, the rest is for labor"
//
// docs/MONEY_AUDIT_SURFACES.md section 3.8 found that sentence existed NOWHERE
// -- not on the quote page, not in the copy she downloads, not on the contract,
// not in the approval email -- and that the approval email's wording guard
// would have REJECTED it in all three languages if somebody had written it.
//
// THE LINE THIS FILE GUARDS, and it is a line, not a ban:
//
//   the PURPOSE is his to tell      -- what the money buys
//   the ARITHMETIC is not          -- what the figure was worked out FROM
//
// He keeps the rule behind the deposit (the materials up to the next hundred,
// then another hundred) to himself, and said of the extra hundred "don't tell
// the customer that I want that in the app". A customer who reads "it pays for
// the materials" cannot derive the hundred. A customer who reads "it is the
// cost of the materials, rounded up" can. So this file holds, on all four
// surfaces and in all three languages:
//
//   1. the sentence is THERE when a deposit is being asked for;
//   2. it is ABSENT when it is not -- five of his jobs ask for nothing, and a
//      sentence explaining a deposit nobody is asking for is noise;
//   3. it carries no arithmetic: no figure, no percentage, no second amount,
//      no rounding, and no basis for the deposit;
//   4. it passes the approval email's own wording guard -- the REAL one, lifted
//      out of tests/a55-approval-email-builder.test.mjs rather than copied, so
//      the two cannot drift apart;
//   5. it reserves a PLACE in the queue, not a DATE. He schedules jobs himself
//      and the weather moves them (FIELD_FEEDBACK_2026-10-01.md C21);
//   6. the four surfaces say the SAME thing. He reads them side by side, and
//      the deposit has already been wrong three different ways in one day.
//
// HOW IT CHECKS, and why not by grepping for the words. A test that looks for
// a visible sentence passes in English and silently stops meaning anything the
// day somebody rewords the Spanish. So every assertion here goes through the
// STRING RESOURCE or the code that produces it:
//
//   email     the real buildApprovalEmail(), compared against ALL_WORDS[lang]
//   page      the real rows-building block, sliced out of website/quote.html
//             and executed, compared against the page's own L[lang] table
//   download  the real buildQuoteDocument(), fed the markup the page just made
//   contract  PdfLabels.depositPurpose and its draw site, read out of the
//             Kotlin source (Kotlin cannot run here -- gradlew is off limits)
//
// Every "it is there" check has a POSITIVE CONTROL beside it proving the
// fixture reached the deposit block at all, and every surface has a CANARY:
// the same assertion re-run against the surface with the new line taken back
// out, which must fail. The old email guard is reconstructed at the bottom and
// must reject the sentence, which is what made this a piece of work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALL_WORDS, buildApprovalEmail, LANGS } from "../supabase/functions/quote-approval-email/email.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* An apostrophe is a typographic choice, not a different sentence. The web and
   the email use U+2019 (the page's other French strings do); PdfExporter's
   labels have used a straight quote since they were written ("Main-d'œuvre /
   Installation"), and matching the file it lives in is worth more than matching
   the other three. Normalised here so surface 5 compares MEANING. */
const norm = (s) => String(s).replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

// ===================================================================== 1 =====
// The real email guard, lifted out of a55 rather than copied.
// ============================================================================

const A55 = read("tests/a55-approval-email-builder.test.mjs");
const guardSource = (() => {
  const start = A55.indexOf("const WORDING = [");
  assert.ok(start > 0, "a55 no longer declares WORDING -- this extraction needs rewriting, not deleting");
  const fnStart = A55.indexOf("const wordingProblems = (s) => {", start);
  assert.ok(fnStart > start, "a55 no longer declares wordingProblems as an arrow function body");
  const end = A55.indexOf("\n};", fnStart);
  assert.ok(end > fnStart, "could not find the end of wordingProblems");
  return A55.slice(start, end + 3);
})();
const { wordingProblems } = new Function(guardSource + "\nreturn { wordingProblems };")();

test("the guard lifted out of a55 is the real one: it still catches every way the rule could leak", () => {
  assert.equal(typeof wordingProblems, "function");
  assert.ok(guardSource.length > 400, `only ${guardSource.length} characters of guard were lifted`);
  // POSITIVE CONTROL. If the slice above ever grabs the wrong text, these fail
  // rather than quietly passing everything.
  const mustCatch = [
    "Deposit includes $100 for scheduling and transport",
    "Rounded up to the next hundred",
    "plus an extra $100",
    "Based on the cost of materials",
    "Your deposit is the cost of the materials for your fence.",
    "Comprend 250 $ pour le planning.",
    "El depósito se calcula sobre los materiales.",
    "Basé sur le coût des matériaux.",
    "Recargo por traslado",
    "Frais de planification",
  ];
  for (const s of mustCatch) assert.ok(wordingProblems(s).length > 0, `the lifted guard did not catch: ${s}`);
  // And it is not a guard that rejects everything: an ordinary sentence passes.
  assert.deepEqual(wordingProblems("Thank you for approving your fence quote."), []);
});

// ===================================================================== 2 =====
// What a purpose sentence may and may not say, whatever language it is in.
// ============================================================================

/** Arithmetic of any kind: a figure, an operator, a rounding, a derivation. */
const ARITHMETIC = [
  /\d/,
  /[+×÷=%]/,
  /\bhundreds?\b|\bcien(to)?s?\b|\bcentaines?\b/i,
  /round(ed|ing|s)?\b|redonde|arrondi/i,
  /\bplus\b|\bm[aá]s\b|\bde plus\b/i,
  /\bcost(s|ed|ing)?\b|\bbased\s+on\b|\bcalculat|\bsubtotal\b|costo|coste|basad|\bcalcul|co[uû]t/i,
  /\btotal\b|\bpercent|\bpor ciento\b|\bpourcent/i,
];
const arithmeticProblems = (s) => ARITHMETIC.filter((re) => re.test(s)).map(String);

/** A promise of a DATE, which is not his to make and not what he asked for. */
const DATE_PROMISE = [
  /\bguarantee|\bguaranteed\b|\bpromise[ds]?\b/i,
  /garanti|\bpromet|\bprometemos\b/i,
  /\bdate\b|\bdays?\b|\bweeks?\b|\bmonths?\b/i,
  /\bfecha\b|\bd[ií]as?\b|\bsemanas?\b|\bmes(es)?\b/i,
  /\bjours?\b|\bsemaines?\b|\bmois\b/i,
];
const datePromiseProblems = (s) => DATE_PROMISE.filter((re) => re.test(s)).map(String);

/** A purpose word has to be in there, or the sentence says nothing he asked for. */
const SAYS_SCHEDULE = /schedul|agend|program|calendar|planning|planifi/i;
const SAYS_MATERIALS = /materials?|materiales|mat[eé]riaux|mat[eé]riel/i;
const SAYS_LABOUR = /labou?r|mano de obra|main-d.?œuvre|main-d.?oeuvre/i;

/** Every check a purpose sentence must pass, in any language. */
function purposeProblems(s) {
  const out = [];
  if (!s || !String(s).trim()) return ["empty"];
  out.push(...wordingProblems(s).map((x) => `guard: ${x}`));
  out.push(...arithmeticProblems(s).map((x) => `arithmetic: ${x}`));
  out.push(...datePromiseProblems(s).map((x) => `date promise: ${x}`));
  if (!SAYS_SCHEDULE.test(s)) out.push("does not say it puts her on the schedule");
  if (!SAYS_MATERIALS.test(s)) out.push("does not say it pays for the materials");
  if (!SAYS_LABOUR.test(s)) out.push("does not say the rest is labour");
  return out;
}

test("PLANTED: the purpose checks fail on every wrong way to write this sentence", () => {
  const wrong = {
    "gives the arithmetic": "Your deposit is the materials rounded up to the next $100, plus $100.",
    "gives a figure": "Your deposit of $1,800.00 reserves your place on the schedule and pays for the materials; the rest is labor.",
    "gives the basis": "Your deposit is based on the cost of the materials; the rest covers the labor.",
    "gives a percentage": "Your deposit is 30% for the schedule and the materials, the rest is labor.",
    "promises a date": "Your deposit guarantees your start date, pays for the materials and the rest covers the labor.",
    "promises a week": "Your deposit puts you on the schedule within two weeks, pays for the materials, the rest is labor.",
    "says nothing about the schedule": "Your deposit pays for the materials. The rest covers the labor.",
    "says nothing about the materials": "Your deposit reserves your place on the schedule. The rest covers the labor.",
    "says nothing about the labour": "Your deposit reserves your place on the schedule and pays for the materials.",
    "empty": "",
  };
  for (const [why, s] of Object.entries(wrong)) {
    assert.ok(purposeProblems(s).length > 0, `not caught (${why}): ${s}`);
  }
});

// ===================================================================== 3 =====
// SURFACE A -- the approval email. The real builder.
// ============================================================================

const EMAIL_FACTS = {
  companyName: "Test Fence Co",
  companyPhone: "555-0199",
  customerName: "Pat Buyer",
  address: "1 Test Street, Testville",
  approvedBy: "Pat Buyer",
  approvedAt: "2026-10-01T18:00:00.000Z",
  timeZone: "America/New_York",
  pxPerFoot: 20,
  runs: [{ teardown: false, label: "", type: "Vinyl", finish: "White", points: "0:0,2800:0", gates: "4:SINGLE", heightFt: 6 }],
  total: 9710,
  deposit: 1800,
  depositDue: 1800,
  payments: { cashApp: "$TestOnly", zelle: "test@example.test", wire: "", cash: false },
  cardOnline: true,
  quoteUrl: "https://example.test/quote.html?t=00000000-0000-4000-8000-000000000001",
};
const emailText = (over = {}, lang = "en") => buildApprovalEmail({ ...structuredClone(EMAIL_FACTS), ...over }, lang).text;
const figuresIn = (s) => [...s.matchAll(/\$(\d{1,3}(?:,\d{3})*(?:\.\d\d)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));

test("email: the purpose sentence is in the table in all three languages, and passes every check", () => {
  assert.deepEqual([...LANGS].sort(), ["en", "es", "fr"]);
  const seen = new Set();
  for (const lang of LANGS) {
    const s = ALL_WORDS[lang].depositPurpose;
    assert.equal(typeof s, "string", `${lang} has no depositPurpose`);
    assert.deepEqual(purposeProblems(s), [], `${lang}: ${s}`);
    assert.ok(!seen.has(norm(s)), `${lang} repeats another language's sentence -- one of them was never translated`);
    seen.add(norm(s));
  }
});

test("email: a deposit is asked for -- the sentence is in the email, once, in the reader's language", () => {
  for (const lang of LANGS) {
    const text = emailText({}, lang);
    const sentence = ALL_WORDS[lang].depositPurpose;
    // POSITIVE CONTROL: this fixture really does reach the deposit block.
    assert.ok(text.includes(ALL_WORDS[lang].deposit), `${lang}: the fixture did not print a deposit at all`);
    assert.ok(text.includes("$1,800.00"), `${lang}: the deposit figure is missing`);
    assert.ok(text.includes(sentence), `${lang} email is missing its own depositPurpose string`);
    assert.equal(text.split(sentence).length - 1, 1, `${lang}: the sentence appears more than once`);
    // It added no figure to the email: still only the total and the deposit.
    assert.deepEqual([...new Set(figuresIn(text))].sort((a, b) => a - b), [1800, 9710], lang);
    assert.deepEqual(wordingProblems(text), [], `${lang}: the finished email trips the guard`);
    // And it is NOT in any other language's email.
    for (const other of LANGS) {
      if (other === lang) continue;
      assert.ok(!text.includes(ALL_WORDS[other].depositPurpose), `${lang} email carries the ${other} sentence`);
    }
  }
});

test("email: no deposit asked for -- the sentence is absent, in all three languages", () => {
  for (const lang of LANGS) {
    const text = emailText({ deposit: 0, depositDue: 0 }, lang);
    // POSITIVE CONTROL: the email is still a real email, with the total in it.
    assert.ok(text.includes("$9,710.00"), `${lang}: the zero-deposit email lost its total`);
    assert.ok(!text.includes(ALL_WORDS[lang].depositPurpose), `${lang}: explains a deposit nobody is asking for`);
    assert.ok(!text.includes(ALL_WORDS[lang].deposit), `${lang}: names a deposit it is not asking for`);
    assert.deepEqual(figuresIn(text), [9710], lang);
  }
  // A deposit of half a cent is no deposit: the same gate the figure uses.
  assert.ok(!emailText({ deposit: 0.004, depositDue: 0.004 }, "en").includes(ALL_WORDS.en.depositPurpose));
  // CONTROL on that boundary: a deposit above it DOES bring the sentence.
  assert.ok(emailText({ deposit: 0.01, depositDue: 0.01 }, "en").includes(ALL_WORDS.en.depositPurpose));
});

test("email: a part-paid deposit still carries the sentence, and still adds no figure of its own", () => {
  for (const lang of LANGS) {
    const text = emailText({ depositDue: 550 }, lang);
    assert.ok(text.includes(ALL_WORDS[lang].depositPurpose), lang);
    assert.deepEqual([...new Set(figuresIn(text))].sort((a, b) => a - b), [550, 1250, 1800, 9710], lang);
    assert.deepEqual(wordingProblems(text), [], lang);
  }
});

test("CANARY: the email checks fail against an email with the sentence taken back out", () => {
  for (const lang of LANGS) {
    const old = emailText({}, lang).replace(ALL_WORDS[lang].depositPurpose, "").replace(/\n{3,}/g, "\n\n");
    assert.ok(!old.includes(ALL_WORDS[lang].depositPurpose), `${lang}: the canary did not remove the sentence`);
    // The positive control still passes on it, so the canary is about the
    // sentence and not about a broken fixture.
    assert.ok(old.includes(ALL_WORDS[lang].deposit), `${lang}: canary lost the deposit row too`);
  }
});

// ===================================================================== 4 =====
// SURFACE B -- the quote page. The real rows-building block, executed.
// ============================================================================

const PAGE = read("website/quote.html");

/** The page's L table, read as data the way a47 reads it. */
const pageTable = (src) => {
  const start = src.indexOf("const L = {");
  const end = src.indexOf("\n};", start);
  assert.ok(start > 0 && end > start, "could not find the page's translation table");
  return new Function(`return (${src.slice(start + "const L = ".length, end + 2)})`)();
};
const L = pageTable(PAGE);

const grabFn = (src, name) => {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start > 0, "not found: " + name);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};
const grabConstLine = (src, name) => {
  const start = src.indexOf("const " + name + "=");
  assert.ok(start > 0, "not found: " + name);
  const end = src.indexOf("\n", start);
  return src.slice(start, end < 0 ? src.length : end);
};

/* The page's own totals rows, run as the page runs them.
   Sliced from `const rows=[];` to the sink it writes into, with ONLY the sink
   swapped for a return. Nothing is reimplemented: a bug in this block is a bug
   in this test. The same slice is taken again below with the purpose row
   removed, which is the canary. */
const ROWS_START = "const rows=[];";
const ROWS_SINK = "$('totals').innerHTML=rows.join('');";
function totalsMarkupFrom(src) {
  const a = src.indexOf(ROWS_START);
  const b = src.indexOf(ROWS_SINK, a);
  assert.ok(a > 0 && b > a, "could not find the totals rows block in website/quote.html");
  const region = src.slice(a, b);
  const built = new Function(
    pageTableDecl(src) + "\nlet LANG='en';\n"
    + grabFn(src, "tr") + "\n" + grabConstLine(src, "money") + "\n" + grabConstLine(src, "esc") + "\n"
    + "function totalsMarkup(q, lang){ LANG=lang||'en';\n" + region + "\nreturn rows.join(''); }\n"
    + "return totalsMarkup;"
  )();
  return built;
}
function pageTableDecl(src) {
  const start = src.indexOf("const L = {");
  const end = src.indexOf("\n};", start);
  return src.slice(start, end + 3);
}
const totalsMarkup = totalsMarkupFrom(PAGE);

const JOB = { total: 9710, deposit: 1800, depositDue: 1800, balanceDue: 7910 };
const NO_DEPOSIT = { total: 9710, deposit: 0, depositDue: 0, balanceDue: 9710 };

test("page: the purpose sentence is in the page's own L table in all three languages, and passes every check", () => {
  assert.deepEqual(Object.keys(L).sort(), ["en", "es", "fr"], "the page's translation table changed shape");
  const seen = new Set();
  for (const lang of Object.keys(L)) {
    const s = L[lang].depositPurpose;
    assert.equal(typeof s, "string", `${lang} has no depositPurpose on the page`);
    assert.deepEqual(purposeProblems(s), [], `${lang}: ${s}`);
    assert.ok(!seen.has(norm(s)), `${lang} repeats another language's sentence`);
    seen.add(norm(s));
  }
});

test("page: a deposit is asked for -- the sentence is rendered, as a note and not as a money row", () => {
  for (const lang of Object.keys(L)) {
    const html = totalsMarkup(JOB, lang);
    const sentence = L[lang].depositPurpose;
    // POSITIVE CONTROL: the block really drew the deposit for this fixture.
    assert.ok(html.includes(L[lang].depositToBegin), `${lang}: no deposit row at all`);
    assert.ok(html.includes("$1,800.00"), `${lang}: no deposit figure`);
    assert.ok(html.includes(sentence) || html.includes(sentence.replace(/&/g, "&amp;")),
      `${lang}: the rendered totals are missing the page's own depositPurpose string`);
    // A .depnote note, not a .totals money row: it explains the figure above,
    // it is not another figure in the column.
    const row = html.split("<div").find((chunk) => chunk.includes(sentence.slice(0, 24)));
    assert.ok(row && row.includes('class="depnote"'), `${lang}: the sentence is not in a depnote row`);
    assert.ok(!row.includes("$"), `${lang}: a dollar figure landed in the purpose row`);
  }
});

test("page: no deposit asked for -- no sentence, no empty row, in all three languages", () => {
  for (const lang of Object.keys(L)) {
    const html = totalsMarkup(NO_DEPOSIT, lang);
    // POSITIVE CONTROL: the totals still render; this is not an empty string.
    assert.ok(html.includes(L[lang].total) && html.includes("$9,710.00"), `${lang}: the zero-deposit totals are empty`);
    assert.ok(!html.includes(L[lang].depositPurpose), `${lang}: explains a deposit nobody is asking for`);
    assert.ok(!html.includes("depnote"), `${lang}: an empty note row was drawn`);
  }
});

test("page: the sentence is reached in ONE place, and that place is inside the deposit gate", () => {
  const script = stripComments(PAGE);
  const uses = [...script.matchAll(/tr\('depositPurpose'\)/g)];
  assert.equal(uses.length, 1, `depositPurpose is rendered in ${uses.length} places -- one of them can drift`);
  /* There is more than one `if(q.deposit>0.005){` on the page (showPayButton
     has its own), so the gate is found by walking BACK from the use rather
     than forward from the first match -- the same reason the Kotlin check
     below walks back from its draw call. */
  const gate = script.lastIndexOf("if(q.deposit>0.005){", uses[0].index);
  assert.ok(gate > 0, "the render of depositPurpose is not inside any deposit gate");
  let depth = 0, end = -1;
  for (let j = script.indexOf("{", gate); j < script.length; j++) {
    if (script[j] === "{") depth++;
    else if (script[j] === "}") { depth--; if (!depth) { end = j; break; } }
  }
  assert.ok(end > gate, "the deposit gate is unbalanced");
  assert.ok(uses[0].index < end,
    "depositPurpose is rendered OUTSIDE the deposit gate -- it would print on a job with no deposit");
  // PLANTED: the same walk sees a use that has escaped the gate.
  const escaped = script.slice(0, end + 1).replace("rows.push('<div class=\"depnote\"><span>'+esc(tr('depositPurpose'))", "X")
    + "\nrows.push(esc(tr('depositPurpose')));";
  const gate2 = escaped.lastIndexOf("if(q.deposit>0.005){", escaped.indexOf("tr('depositPurpose')"));
  let d2 = 0, e2 = -1;
  for (let j = escaped.indexOf("{", gate2); j < escaped.length; j++) {
    if (escaped[j] === "{") d2++;
    else if (escaped[j] === "}") { d2--; if (!d2) { e2 = j; break; } }
  }
  assert.ok(escaped.indexOf("tr('depositPurpose')") > e2,
    "the planted escape is not actually outside the gate, so this walk proves nothing");
});

test("CANARY: the page checks fail against the page with the purpose row taken back out", () => {
  const line = PAGE.split("\n").find((l) => l.includes("tr('depositPurpose')"));
  assert.ok(line, "could not find the line to remove");
  const OLD = PAGE.replace(line + "\n", "");
  assert.ok(!OLD.includes("tr('depositPurpose')"), "the canary did not remove the row");
  const oldMarkup = totalsMarkupFrom(OLD);
  for (const lang of Object.keys(L)) {
    const html = oldMarkup(JOB, lang);
    // POSITIVE CONTROL on the canary: it is still the real block, still drawing
    // the deposit -- so what fails below is the sentence and nothing else.
    assert.ok(html.includes(L[lang].depositToBegin) && html.includes("$1,800.00"), `${lang}: canary broke the block`);
    assert.ok(!html.includes(L[lang].depositPurpose), `${lang}: the old page already said it`);
    assert.throws(() => assert.ok(html.includes(L[lang].depositPurpose)), `${lang}: the check does not fail on the old page`);
  }
});

// ===================================================================== 5 =====
// SURFACE C -- the copy she downloads. The real buildQuoteDocument.
// ============================================================================

const docBuilder = (src) => new Function(
  grabFn(src, "buildQuoteDocument") + "\n" + grabConstLine(src, "esc")
  + "\nreturn { buildQuoteDocument, esc };"
)();
const { buildQuoteDocument } = docBuilder(PAGE);

const docArgs = (over = {}) => ({
  lang: "en",
  title: "Fence quote for Pat Buyer",
  companyName: "Test Fence Co",
  companyContact: "555-0199",
  customerHeading: "Quote for Pat Buyer",
  customerName: "Pat Buyer",
  address: "1 Test Street, Testville",
  scopeHeading: "The work",
  scopeHtml: "<p class=\"sub\">Vinyl fence, 140 ft</p>",
  totalsHeading: "Price",
  totalsHtml: totalsMarkup(JOB, "en"),
  approvalText: "Approved by Pat Buyer.",
  signatureDataUrl: null,
  signatureAlt: "",
  pay: null,
  ...over,
});

test("download: the saved copy carries the sentence, in every language, and can style it with no network", () => {
  for (const lang of Object.keys(L)) {
    const doc = buildQuoteDocument(docArgs({ lang, totalsHtml: totalsMarkup(JOB, lang) }));
    // POSITIVE CONTROL: the file really is the quote -- total and deposit in it.
    assert.ok(doc.includes("$9,710.00") && doc.includes("$1,800.00"), `${lang}: the file lost its figures`);
    assert.ok(doc.includes(L[lang].depositPurpose), `${lang}: the downloaded copy is missing the sentence`);
    // It is the page's own markup carried over, so it needs the .depnote rule
    // the file brings with it -- otherwise the note renders as a flex row with
    // nothing in the right-hand column.
    assert.match(doc, /\.totals div\.depnote\{[^}]*display:block/, `${lang}: no depnote rule in the saved copy's style`);
    assert.ok(doc.includes('class="depnote"'), `${lang}: the note row did not reach the file`);
  }
});

test("download: no deposit asked for -- the saved copy says nothing about one", () => {
  for (const lang of Object.keys(L)) {
    const doc = buildQuoteDocument(docArgs({ lang, totalsHtml: totalsMarkup(NO_DEPOSIT, lang) }));
    assert.ok(doc.includes("$9,710.00"), `${lang}: the zero-deposit file lost its total`);
    assert.ok(!doc.includes(L[lang].depositPurpose), `${lang}: explains a deposit nobody is asking for`);
    // Not `includes("depnote")`: the file's <style> block always carries the
    // .depnote RULE (it has to, for the part-paid note). What must be absent
    // is a row using it.
    assert.ok(!doc.includes('class="depnote"'), `${lang}: an empty note row reached the file`);
    // CONTROL: the rule is in the style block either way, so the check above
    // is about the row and not about the stylesheet.
    assert.match(doc, /\.totals div\.depnote\{/, `${lang}: lost the depnote rule`);
  }
});

test("CANARY: the download check fails against the page with the purpose row taken back out", () => {
  const line = PAGE.split("\n").find((l) => l.includes("tr('depositPurpose')"));
  const OLD = PAGE.replace(line + "\n", "");
  const oldMarkup = totalsMarkupFrom(OLD);
  const doc = buildQuoteDocument(docArgs({ totalsHtml: oldMarkup(JOB, "en") }));
  assert.ok(doc.includes("$1,800.00"), "canary broke the file's figures");
  assert.ok(!doc.includes(L.en.depositPurpose), "the old download already said it");
});

// ------- and, while we are in here: the empty payment method (his words) -----
// "if I don't have any information on the payment method, don't even put it for
// the customer, I only want to present what is there."

const payHalves = new Function(
  grabFn(PAGE, "payMethodsFrom") + "\n" + grabFn(PAGE, "payHowModel") + "\n" + grabFn(PAGE, "payDocModel") + "\n"
  + pageTableDecl(PAGE) + "\nlet LANG='en';\n" + grabFn(PAGE, "tr") + "\n"
  + "const PAY_ORDER=['cashapp','zelle','wire','cash'];"
  + "const PAY_FIELD={cashapp:'cashApp',zelle:'zelle',wire:'wire',cash:'cash'};"
  + "const PAY_NAME_KEY={cashapp:'pmCashApp',zelle:'pmZelle',wire:'pmWire',cash:'pmCash'};"
  + "\nreturn { payMethodsFrom, payHowModel, payDocModel };"
)();

test("payment methods: nothing filled in means no panel on the page and no section in the file", () => {
  const empties = [
    undefined, {}, { paymentMethods: {} },
    { paymentMethods: { cashApp: "", zelle: "   ", wire: "\n\t ", cash: false } },
    { paymentMethods: { cashApp: null, zelle: 0, wire: undefined, cash: "true" } },
  ];
  for (const q of empties) {
    const methods = payHalves.payMethodsFrom(q);
    assert.deepEqual(methods, [], JSON.stringify(q));
    const model = payHalves.payHowModel(q, 7910, true);
    assert.equal(model.show, false, `panel shown for ${JSON.stringify(q)}`);
    assert.deepEqual(model.methods, []);
    // Nothing to put in the file either -- null means "say nothing at all".
    assert.equal(payHalves.payDocModel(methods, "1/10/2026"), null);
    // And the file built from that null has no heading, no row, no control.
    const doc = buildQuoteDocument(docArgs({ pay: payHalves.payDocModel(methods, "1/10/2026") }));
    assert.ok(!doc.includes(L.en.howToPayHead), "a How-to-pay heading with nothing under it reached the file");
    assert.ok(!/<button|<a\s/i.test(doc), "a dead control reached the file");
  }
  // POSITIVE CONTROL: one method filled in and all of it comes back.
  const q = { paymentMethods: { cashApp: "$TestOnly", zelle: "", wire: "", cash: false } };
  const methods = payHalves.payMethodsFrom(q);
  assert.deepEqual(methods, [{ key: "cashapp", value: "$TestOnly" }]);
  assert.equal(payHalves.payHowModel(q, 7910, true).show, true);
  const model = payHalves.payDocModel(methods, "1/10/2026");
  assert.ok(model && model.rows.length === 1);
  const doc = buildQuoteDocument(docArgs({ pay: model }));
  assert.ok(doc.includes("$TestOnly") && doc.includes(L.en.howToPayHead));
  // Still no control in the file: the live Copy button would do nothing there.
  assert.ok(!/<button|<a\s/i.test(doc), "a dead control reached the file");
});

test("payment methods: a row that is somehow empty is dropped by the file builder itself", () => {
  // Belt and braces: payDocModel cannot produce one, but buildQuoteDocument
  // filters anyway, so a future caller cannot put a blank box in her file.
  const doc = buildQuoteDocument(docArgs({
    pay: { heading: "How to pay", lead: "lead", rows: [{ name: "Zelle", value: "   ", how: "" }], notes: [] },
  }));
  assert.ok(!doc.includes("How to pay"), "a heading over an empty row reached the file");
  // CONTROL: the same shape with a value in it does reach the file.
  const ok = buildQuoteDocument(docArgs({
    pay: { heading: "How to pay", lead: "lead", rows: [{ name: "Zelle", value: "test@example.test", how: "" }], notes: [] },
  }));
  assert.ok(ok.includes("How to pay") && ok.includes("test@example.test"));
});

// ===================================================================== 6 =====
// SURFACE D -- the contract PDF. Kotlin source: gradlew is off limits.
// ============================================================================

const PDF_SRC = read("app/src/main/java/com/fenceestimator/app/estimate/PdfExporter.kt");
const DOC_SRC = read("app/src/main/java/com/fenceestimator/app/estimate/JobDocument.kt");

/** The three arguments of `val <name> = pick( "en", "es", "fr" )`. */
function pickArgs(src, name) {
  const at = src.indexOf("val " + name + " = pick(");
  if (at < 0) return null;
  const open = src.indexOf("(", at);
  let depth = 0, close = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") { depth--; if (!depth) { close = j; break; } }
  }
  if (close < 0) return null;
  const args = [...src.slice(open + 1, close).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return args.length === 3 ? args : null;
}

test("contract: PdfLabels carries the sentence in all three languages, and it passes every check", () => {
  const args = pickArgs(PDF_SRC, "depositPurpose");
  assert.ok(args, "PdfLabels has no depositPurpose = pick(en, es, fr)");
  const seen = new Set();
  for (const [i, s] of args.entries()) {
    const lang = ["en", "es", "fr"][i];
    assert.deepEqual(purposeProblems(s), [], `${lang}: ${s}`);
    assert.ok(!seen.has(norm(s)), `${lang} repeats another language's sentence`);
    seen.add(norm(s));
  }
  // POSITIVE CONTROL: the same extractor reads a label that was always there,
  // so a null above means the sentence is missing and not that pickArgs broke.
  assert.deepEqual(pickArgs(PDF_SRC, "deposit"), ["Deposit", "Depósito", "Acompte"]);
});

test("contract: the sentence is drawn in exactly one place, on the contract only, and only when a deposit is asked for", () => {
  const src = stripComments(PDF_SRC);
  const uses = [...src.matchAll(/labels\.depositPurpose/g)];
  assert.equal(uses.length, 1, `drawn in ${uses.length} places -- one of them can drift`);
  /* The gate is found by walking back from the draw call to the `if (...)`
     that encloses it, rather than by matching a literal condition: which
     deposit field this reads is another agent's business (it was
     job.depositAmount and is now the capped JobMoney.depositAsked, which is
     the better figure and agrees with the row above it). What must not change
     is the SHAPE -- the contract, and a deposit above zero. */
  const at = src.lastIndexOf("if (", uses[0].index);
  assert.ok(at > 0, "the draw call is not inside any if at all");
  const condEnd = src.indexOf(") {", at);
  assert.ok(condEnd > at, "could not read the enclosing condition");
  const condition = src.slice(at, condEnd + 1);
  assert.match(condition, /docKind\.showsContractTerms/, `the draw site is not gated on the contract: ${condition}`);
  assert.match(condition, /deposit\w*\s*>\s*0(\.0)?\b/i, `the draw site is not gated on a non-zero deposit: ${condition}`);
  let depth = 0, end = -1;
  for (let j = src.indexOf("{", condEnd); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) { end = j; break; } }
  }
  assert.ok(end > at, "the gate block is unbalanced");
  assert.ok(uses[0].index > at && uses[0].index < end, "the draw call is outside its own gate");
  // The deposit figure the gate reads is the one the row above PRINTS, so the
  // sentence cannot appear beside a deposit row that is not there.
  const printed = /if \((\w+) > 0\.0\) totalRow\(labels\.deposit,/.exec(src);
  if (printed) {
    assert.match(condition, new RegExp(`\\b${printed[1]}\\b`),
      `the row prints ${printed[1]} but the sentence is gated on something else`);
  }
  // The gate's left half means the CONTRACT and nothing else.
  const kinds = [...DOC_SRC.matchAll(/^\s{4}([A-Z_]+)\(/gm)].map((m) => m[1]);
  assert.deepEqual(kinds, ["WORKING_ESTIMATE", "CUSTOMER_CONTRACT", "SUPPLIER_REQUEST", "CUSTOMER_INVOICE"],
    "JobDocument changed shape -- recheck which kinds carry contract terms");
  const trueFor = kinds.filter((k) => {
    const from = DOC_SRC.indexOf("    " + k + "(");
    const to = DOC_SRC.indexOf("),", from) < 0 ? DOC_SRC.indexOf(");", from) : DOC_SRC.indexOf("),", from);
    return /showsContractTerms\s*=\s*true/.test(DOC_SRC.slice(from, to));
  });
  assert.deepEqual(trueFor, ["CUSTOMER_CONTRACT"], "showsContractTerms no longer means the contract alone");
  // It is drawn through the wrapping helper, so a long translation cannot run
  // off the edge of the page where nobody would read it.
  assert.match(src.slice(at, end), /noteLine\(labels\.depositPurpose/);
  assert.ok(src.includes("fun noteLine("), "noteLine is gone -- the sentence would be a single unwrapped line");
});

test("CANARY: the contract checks fail against the Kotlin source with the sentence taken back out", () => {
  // The label removed: pickArgs returns null, the way it did yesterday.
  const noLabel = PDF_SRC.replace(/\n\s*val depositPurpose = pick\([\s\S]*?\n\s*\)\n/, "\n");
  assert.equal(pickArgs(noLabel, "depositPurpose"), null, "the canary did not remove the label");
  // POSITIVE CONTROL on the canary: the rest of PdfLabels is intact.
  assert.deepEqual(pickArgs(noLabel, "deposit"), ["Deposit", "Depósito", "Acompte"]);
  // The draw call removed: nothing draws it.
  const noDraw = stripComments(PDF_SRC).replace(/noteLine\(labels\.depositPurpose, labelPaint\)/, "");
  assert.equal([...noDraw.matchAll(/labels\.depositPurpose/g)].length, 0, "the canary did not remove the draw call");
  // The gate removed: the sentence would print on the invoice and on a job with
  // no deposit. This is the shape the check has to reject.
  const src = stripComments(PDF_SRC);
  const use = src.indexOf("labels.depositPurpose");
  const at = src.lastIndexOf("if (", use);
  const condEnd = src.indexOf(") {", at);
  const condition = src.slice(at, condEnd + 1);
  const noGate = src.slice(0, at) + "if (true" + src.slice(condEnd);
  const newCond = noGate.slice(noGate.lastIndexOf("if (", noGate.indexOf("labels.depositPurpose")),
    noGate.indexOf(") {", noGate.lastIndexOf("if (", noGate.indexOf("labels.depositPurpose"))) + 1);
  assert.doesNotMatch(newCond, /docKind\.showsContractTerms/, "the canary did not remove the gate");
  assert.match(condition, /docKind\.showsContractTerms/, "the real gate is still there");
});

// ===================================================================== 7 =====
// All four surfaces say the same thing -- he reads them side by side.
// ============================================================================

test("the four surfaces carry one sentence per language, not four near-misses", () => {
  const pdf = pickArgs(PDF_SRC, "depositPurpose");
  const byLang = { en: pdf[0], es: pdf[1], fr: pdf[2] };
  for (const lang of LANGS) {
    const email = norm(ALL_WORDS[lang].depositPurpose);
    const page = norm(L[lang].depositPurpose);
    const contract = norm(byLang[lang]);
    assert.equal(page, email, `${lang}: the quote page and the email disagree`);
    assert.equal(contract, email, `${lang}: the contract and the email disagree`);
    // The download is the page's own rendered markup, so it cannot disagree
    // with the page -- proved by execution rather than by comparing strings.
    const doc = buildQuoteDocument(docArgs({ lang, totalsHtml: totalsMarkup(JOB, lang) }));
    assert.ok(doc.includes(L[lang].depositPurpose), `${lang}: the saved copy disagrees with the page`);
  }
  // PLANTED: a one-word difference between two surfaces is a failure, because
  // that is exactly what he notices when he opens both.
  assert.notEqual(norm(ALL_WORDS.en.depositPurpose), norm(ALL_WORDS.en.depositPurpose) + " Thanks.");
});

// ===================================================================== 8 =====
// THE CANARY THAT MADE THIS A PIECE OF WORK: the OLD email guard rejected it.
// ============================================================================

/* tests/a55-approval-email-builder.test.mjs used to hold ONE flat list, and it
   banned the bare words. This is that list, kept here as a canary and nowhere
   else: it must reject the sentence the owner asked for, in all three
   languages, or the narrowing in a55 was not needed and should be reverted.
   Measured on 2 Oct 2026: en on /schedul/ and /materials?/, es on /agend/ and
   /materiales/, fr on /matériaux/. */
const OLD_A55_WORDING = [
  /transport/i, /transporte|traslado|desplaz/i,
  /surcharge|recargo|suppl[eé]ment|majoration/i,
  /mobili[sz]ation|movilizaci[oó]n/i,
  /schedul/i,
  /program(ar|aci[oó]n|ado)|agend|calendario/i,
  /planifi|calendrier|ordonnanc/i,
  /\bfees?\b|\bcharges?\b|tarifa|\bfrais\b|cargo adicional/i,
  /\$\s?100(\.00)?\b/,
  /\b(extra|additional|adicional|suppl[eé]mentaire)\b/i,
  /\bplus\b/i,
  /round(ed|ing)?\b|redonde|arrondi/i,
  /next\s+(\$\s?)?hundred|siguiente\s+cien|centaine/i,
  /materials?|materiales?|mat[eé]riaux|mat[eé]riel/i,
];

test("CANARY: the OLD flat email guard rejected this sentence in all three languages -- the narrowing was necessary", () => {
  const rejected = {};
  for (const lang of LANGS) {
    const s = ALL_WORDS[lang].depositPurpose;
    rejected[lang] = OLD_A55_WORDING.filter((re) => re.test(s)).map(String);
    assert.ok(rejected[lang].length > 0, `${lang}: the old guard would have allowed it, so nothing needed narrowing`);
  }
  assert.ok(rejected.en.some((x) => /schedul/.test(x)), "en was rejected for something other than the schedule word");
  assert.ok(rejected.es.some((x) => /agend/.test(x)), "es was rejected for something other than the agenda word");
  assert.ok(rejected.fr.some((x) => /riaux/.test(x)), "fr was rejected for something other than the materials word");
  // And the NEW guard allows it -- the two together are the whole claim.
  for (const lang of LANGS) assert.deepEqual(wordingProblems(ALL_WORDS[lang].depositPurpose), [], lang);
  // The narrowing did not blunt the guard: everything the old list caught for a
  // real reason is still caught by the new one.
  const stillCaught = [
    "Deposit includes $100 for scheduling and transport",
    "Includes a $100 transport charge",
    "Rounded up to the next hundred",
    "plus an extra $100",
    "Incluye $100 para programación y transporte",
    "Recargo por traslado",
    "Redondeado a la centena siguiente (siguiente cien)",
    "Comprend 100 $ pour la planification et le transport",
    "Supplément de transport",
    "Frais de planification",
    "Based on the cost of materials",
    "Basé sur le coût du matériel",
  ];
  for (const s of stillCaught) {
    assert.ok(OLD_A55_WORDING.some((re) => re.test(s)), `the old guard did not catch ${s} either`);
    assert.ok(wordingProblems(s).length > 0, `the NARROWED guard lost: ${s}`);
  }
});
