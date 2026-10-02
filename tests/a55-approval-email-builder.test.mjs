// a55 -- THE CONTRACT EMAIL'S WORDS AND FIGURES (pure: no network, no database).
//
// supabase/functions/quote-approval-email/email.ts builds the email a customer
// gets when they approve their quote: the agreement, the total, the deposit
// required to start, and how to pay. Run with:
//
//   node --test tests/a55-approval-email-builder.test.mjs
//
// THE RULE THIS FILE EXISTS TO HOLD. The owner's deposit rule (the materials
// rounded up to the next $100, plus another $100 for scheduling and transport)
// is his own business and the customer must NEVER see it taken apart. The email
// states ONE deposit figure. So, in all three languages the quote page speaks:
//
//   1. no sentence the email can print mentions scheduling, transport, rounding,
//      a surcharge, a fee, or the materials -- every template is read, not just
//      the ones a fixture happens to reach;
//   2. every dollar figure in a finished email is the total, the deposit, or
//      (only when part of the deposit is already in) what has been received and
//      what is left -- nothing else, never the materials, never the rounded
//      figure, never a lone hundred;
//   3. the builder reads NOTHING but its whitelist: fed extra fields named for
//      the rule (materials, roundedMaterials, extra, schedulingFee, ...) it
//      produces byte-for-byte the same email;
//   4. nothing in the module can reach the rule (ruleDeposit and friends).
//
// Every "nothing leaks" check sits beside a control built from the same
// fixture that proves the scan CAN find what it looks for, and a PLANTED run
// that shows it fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALL_WORDS, buildApprovalEmail, contractKey, gateCount, installTotals, LANGS, longDate, maskEmail, money, oneLine, pickLang,
  runFeet, safeUrl, scopeRows, typedByCustomer,
} from "../supabase/functions/quote-approval-email/email.ts";
import { INVISIBLE_CHARS, publicPaymentMethods } from "../supabase/functions/quote-approval-email/payment-methods.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const U = (...codes) => String.fromCharCode(...codes);
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ----------------------------------------------------------------- fixtures
// Every address and name here is obviously fake. The total and the deposit are
// chosen so that none of the numbers the rule works with (1630 of materials,
// 1700 rounded, 100 extra) can appear by coincidence.
const RULE_NUMBERS = [1630, 1700, 100];
const BASE = Object.freeze({
  companyName: "Test Fence Co",
  companyPhone: "555-0100",
  customerName: "Pat Buyer",
  address: "1 Test Street, Testville",
  approvedBy: "Pat Buyer",
  approvedAt: "2026-10-02T01:30:00Z",
  timeZone: "America/New_York",
  runs: [
    { teardown: false, label: "Back yard", type: "WOOD_PRIVACY", finish: "Cedar", points: "0:0,2800:0", gates: "a,b", closed: false, heightFt: 6, manualFeet: 0 },
    { teardown: true, label: "", type: "CHAIN_LINK", finish: "", points: "", gates: "", closed: false, heightFt: 4, manualFeet: 90 },
  ],
  pxPerFoot: 20,
  total: 9710,
  deposit: 1800,
  depositDue: 1800,
  payments: { cashApp: "$TestOnly", zelle: "test@example.test", wire: "Bank: TEST ONLY BANK\nAccount name: TEST ONLY LLC", cash: true },
  cardOnline: true,
  quoteUrl: "https://example.test/quote.html?t=00000000-0000-4000-8000-000000000001",
});
const facts = (over = {}) => ({ ...structuredClone(BASE), ...over });
const textOf = (f, lang) => buildApprovalEmail(f, lang).text;

/** Wording that would explain the extra hundred, the rounding or the basis of the deposit -- English, Spanish and French. */
const WORDING = [
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
const wordingProblems = (s) => WORDING.filter((re) => re.test(s)).map(String);

/** Every "$1,234.56" in a text, as a number. A "$Tag" is not a figure. */
const figuresIn = (s) => [...s.matchAll(/\$(\d{1,3}(?:,\d{3})*(?:\.\d\d)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));

// ====================================================== 1. the words =====

test("every sentence template, in every language, is free of scheduling, transport, rounding, surcharge and materials wording", () => {
  assert.deepEqual([...LANGS].sort(), ["en", "es", "fr"], "the three languages the quote page speaks");
  let read = 0;
  const samples = [["Acme Fence", "555-0100"], ["Acme Fence"], ["5"], ["$1,000.00", "$500.00"], ["https://example.test/q"], ["Pat", "1 October 2026"]];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(ALL_WORDS[lang])) {
      const outputs = [];
      if (typeof value === "string") outputs.push(value);
      else {
        // Call each template with every plausible argument list; counts of 1 and 2 for the gate pluraliser.
        for (const args of [...samples, [1], [2]]) {
          try { outputs.push(String(value(...args))); } catch { /* wrong arity for this sample */ }
        }
        assert.ok(outputs.length, `${lang}.${key} could not be called`);
      }
      for (const out of outputs) {
        read++;
        assert.deepEqual(wordingProblems(out), [], `${lang}.${key} says: ${out}`);
      }
    }
  }
  assert.ok(read > 150, `only ${read} strings were read -- the scan lost its input`);
  // Positive control: the table really does carry the deposit sentence in each language.
  assert.match(ALL_WORDS.en.deposit, /deposit/i);
  assert.match(ALL_WORDS.es.deposit, /dep[oó]sito/i);
  assert.match(ALL_WORDS.fr.deposit, /acompte/i);
});

test("PLANTED: the wording scan catches each way the extra hundred could be explained, in each language", () => {
  const planted = [
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
  for (const s of planted) assert.ok(wordingProblems(s).length > 0, `not caught: ${s}`);
  // And the real, clean sentences are not flagged by the same scan.
  for (const lang of LANGS) assert.deepEqual(wordingProblems(ALL_WORDS[lang].deposit), [], lang);
});

// =================================================== 2. a finished email =====

test("a full email carries the total, the deposit and every way to pay -- the positive control for every 'not there' test below", () => {
  for (const lang of LANGS) {
    const { subject, text } = buildApprovalEmail(facts(), lang);
    assert.ok(subject.includes("Test Fence Co"), `${lang} subject names the company`);
    assert.ok(text.includes("$9,710.00"), `${lang} states the total`);
    assert.ok(text.includes("$1,800.00"), `${lang} states the deposit`);
    for (const must of ["$TestOnly", "test@example.test", "TEST ONLY BANK", "TEST ONLY LLC", "https://example.test/quote.html?t="]) {
      assert.ok(text.includes(must), `${lang} is missing ${must}`);
    }
    assert.ok(text.includes("Pat Buyer") && text.includes("1 Test Street"), `${lang} names the customer and the property`);
    assert.ok(text.includes("140"), `${lang} gives the installed length (the 2,800 px run at 20 px/ft)`);
  }
  assert.match(textOf(facts(), "en"), /Deposit required to start: \$1,800\.00/);
  assert.match(textOf(facts(), "es"), /Depósito requerido para empezar: \$1,800\.00/);
  assert.match(textOf(facts(), "fr"), /Acompte requis pour démarrer : \$1,800\.00/);
});

test("the only dollar figures in the email are the total and the deposit -- never the materials, the rounded figure or a lone hundred", () => {
  for (const lang of LANGS) {
    const text = textOf(facts(), lang);
    assert.deepEqual(figuresIn(text).sort((a, b) => a - b), [1800, 9710], `${lang}: ${figuresIn(text)}`);
    assert.deepEqual(wordingProblems(text), [], `${lang} email wording`);
    for (const n of RULE_NUMBERS) {
      assert.ok(!figuresIn(text).includes(n), `${lang}: ${n} appears as a figure`);
      assert.ok(!text.includes(money(n)), `${lang}: ${money(n)} appears`);
    }
  }
  // CONTROL: the same scan DOES see a figure when one is there -- a deposit of exactly 1,700.
  assert.ok(figuresIn(textOf(facts({ deposit: 1700, depositDue: 1700 }), "en")).includes(1700));
});

test("when part of the deposit is already in, the email says what has been received and what is left -- and still nothing else", () => {
  for (const lang of LANGS) {
    const text = textOf(facts({ depositDue: 550 }), lang);
    assert.deepEqual([...new Set(figuresIn(text))].sort((a, b) => a - b), [550, 1250, 1800, 9710], lang);
    assert.deepEqual(wordingProblems(text), [], lang);
  }
  // Nothing paid: no received/left sentence, so no extra figure.
  assert.deepEqual([...new Set(figuresIn(textOf(facts({ depositDue: 1800 }), "en")))].sort((a, b) => a - b), [1800, 9710]);
});

test("a job with no deposit asked for says nothing about one, exactly like the quote page", () => {
  for (const lang of LANGS) {
    const text = textOf(facts({ deposit: 0, depositDue: 0 }), lang);
    assert.deepEqual(figuresIn(text), [9710], lang);
    assert.ok(!text.includes(ALL_WORDS[lang].deposit), `${lang} still names a deposit`);
  }
});

test("the builder reads NOTHING but its whitelist: fields named for the rule change not one byte of the email", () => {
  const poison = {
    materials: 1630, materialCost: 1630, outstandingMaterials: 1630, roundedMaterials: 1700, roundedDeposit: 1700,
    extra: 100, plus: 100, add: 100, schedulingFee: 100, transport: 100, transportFee: 100, surcharge: 100,
    depositBase: 1700, depositBreakdown: { base: 1700, plus: 100 }, ruleDeposit: 1800, note: "includes $100 for scheduling and transport",
    runs: BASE.runs.map((r) => ({ ...r, materials: 1630, extra: 100, note: "transport" })),
    payments: { ...BASE.payments, extra: 100, note: "scheduling" },
  };
  for (const lang of LANGS) {
    const clean = buildApprovalEmail(facts(), lang);
    const dirty = buildApprovalEmail(facts(poison), lang);
    assert.deepEqual(dirty, clean, `${lang}: an unlisted field reached the email`);
  }
  // CONTROL: a field the builder DOES read changes the email, so the equality above is not vacuous.
  assert.notDeepEqual(buildApprovalEmail(facts({ total: 9711 }), "en"), buildApprovalEmail(facts(), "en"));
});

test("PLANTED: the same checks fail on an email that does give the extra hundred away", () => {
  const leaked = textOf(facts(), "en") + "\nDeposit includes $100 for scheduling and transport.\n";
  assert.ok(wordingProblems(leaked).length > 0, "wording scan");
  assert.ok(!figuresIn(leaked).every((n) => [1800, 9710].includes(n)), "figures scan");
  const itemised = textOf(facts(), "en").replace("$1,800.00", "$1,700.00 + $100.00");
  assert.ok(!figuresIn(itemised).every((n) => [1800, 9710].includes(n)), "itemised deposit");
});

test("nothing in the module can reach the deposit rule, and the email code never imports it", () => {
  for (const file of ["email.ts", "payment-methods.ts", "office-push.ts", "index.ts"]) {
    const src = code(read(`supabase/functions/quote-approval-email/${file}`));
    for (const name of ["ruleDeposit", "suggestedDeposit", "DEPOSIT_PLUS", "DEPOSIT_ROUND_UP_TO", "DepositSuggestion", "materialCost", "outstandingMaterials"]) {
      assert.ok(!src.includes(name), `${file} reaches for ${name}`);
    }
  }
  // The sender takes the deposit from the same place the page does: the stored figure, capped at the job.
  const index = code(read("supabase/functions/quote-approval-email/index.ts"));
  assert.match(index, /deposit: money\.asked,/);
  assert.match(index, /depositFigures\(/);
});

// ============================================== 3. what people typed =====

test("a link in the name the customer typed is removed, so the email cannot carry a clickable link of their choosing", () => {
  const f = facts({ approvedBy: "Pat https://evil.example.test/login Buyer www.evil.example.test" });
  for (const lang of LANGS) {
    const text = textOf(f, lang);
    assert.ok(!/evil\.example/.test(text), lang);
    assert.ok(/Pat\s+Buyer/.test(text), `${lang}: the rest of the name is kept`);
  }
  assert.equal(typedByCustomer("see http://x.test/a b", 80), "see b");
  // CONTROL: the company's OWN link (the quote page) is a real link and stays.
  assert.ok(textOf(facts(), "en").includes("https://example.test/quote.html?t="));
});

test("control characters, line breaks and invisible characters in typed fields cannot split a line or hide text", () => {
  const nasty = "Pat\r\nBcc: victim@example.test" + U(0x202e) + "Kcab" + U(0x200b) + U(0) + " Buyer";
  const f = facts({ customerName: nasty, approvedBy: nasty, address: nasty, companyName: nasty, runs: [{ ...BASE.runs[0], label: nasty }] });
  for (const lang of LANGS) {
    const { subject, text } = buildApprovalEmail(f, lang);
    assert.ok(![13, 0x2028, 0x2029, 0x202e, 0x200b, 0].some((c) => (subject + text).includes(U(c))), lang);
    assert.ok(!/\n\s*Bcc:/i.test(text), `${lang}: a typed line break started a header-looking line`);
    assert.ok(!/[\r\n]/.test(subject), `${lang}: the subject is one line`);
  }
  assert.equal(oneLine("a\tb\n c" + U(0xad) + " d", 20), "a b c d");
});

test("markup typed anywhere stays plain text in the builder's output (the HTML twin escapes it later)", () => {
  const f = facts({ customerName: "<b>Pat</b>", address: "<script>alert(1)</script>", runs: [{ ...BASE.runs[0], label: "<img src=x onerror=alert(1)>" }] });
  const text = textOf(f, "en");
  assert.ok(text.includes("<script>alert(1)</script>"), "kept verbatim as text, never interpreted or half-removed");
  assert.ok(!/<(html|body|table|div|a)\b/i.test(text.replace(/<(script|img|b)[^>]*>|<\/b>|<\/script>/g, "")), "the builder adds no markup of its own");
});

test("the quote link is only ever an https link we built: anything else is no link at all", () => {
  assert.equal(safeUrl("https://example.test/quote.html?t=abc"), "https://example.test/quote.html?t=abc");
  for (const bad of ["http://example.test/q", "javascript:alert(1)", "https://a b", "https://a\"b", "https://a<b", "", null, undefined, "https://x\\y"]) {
    assert.equal(safeUrl(bad), "", String(bad));
  }
  const text = textOf(facts({ quoteUrl: "javascript:alert(1)", cardOnline: true }), "en");
  assert.ok(!/javascript:/.test(text));
  assert.ok(!/pay the deposit by card/i.test(text), "no card sentence without a link to put it behind");
});

// ====================================================== 4. how to pay =====

test("only the methods the owner switched on AND filled in appear; with none, the email says to contact the company instead", () => {
  const none = facts({ payments: { cashApp: "", zelle: "", wire: "", cash: false }, cardOnline: false });
  for (const lang of LANGS) {
    const text = textOf(none, lang);
    assert.ok(!text.includes(ALL_WORDS[lang].howToPay.toUpperCase()), `${lang}: a How-to-pay heading with nothing under it`);
    assert.ok(text.includes("Test Fence Co") && text.includes("555-0100"), `${lang}: how to reach the company`);
  }
  const onlyZelle = textOf(facts({ payments: { cashApp: "", zelle: "z@example.test", wire: "", cash: false }, cardOnline: false }), "en");
  assert.ok(onlyZelle.includes("Zelle: z@example.test"));
  assert.ok(!/Cash App|Wire transfer|Cash:/i.test(onlyZelle));
  // The name-in-the-note sentence is for methods with a payment note, not for cash alone.
  const cashOnly = textOf(facts({ payments: { cashApp: "", zelle: "", wire: "", cash: true }, cardOnline: false }), "en");
  assert.ok(/Cash is accepted/.test(cashOnly) && !/payment note/.test(cashOnly));
  assert.ok(/payment note/.test(onlyZelle));
});

test("wire instructions keep the owner's own lines, in order, indented under the heading", () => {
  const text = textOf(facts({ payments: { ...BASE.payments, wire: "Bank: X\n\nRouting: 000\nAccount: 111" } }), "en");
  assert.ok(text.includes("Wire transfer:\n  Bank: X\n  Routing: 000\n  Account: 111"), text);
});

// ===================================================== 5. the scope =====

test("the scope is worked out the way the quote page works it out", () => {
  const rows = scopeRows(BASE.runs, 20);
  assert.deepEqual(rows.map((r) => [r.teardown, r.type, r.feet, r.gates]), [[false, "Wood Privacy", 140, 2], [true, "Chain Link", 90, 0]]);
  assert.deepEqual(installTotals(rows), { feet: 140, gates: 2 }, "a teardown run is old fence coming out, not fence being installed");
  assert.equal(gateCount({ gates: "a, b ,," }), 2);
  // Row order does not depend on how the database returned the runs.
  assert.deepEqual(scopeRows([...BASE.runs].reverse(), 20), rows);
});

test("runFeet is quote.html's runFeet, to the digit, over a spread of drawings", () => {
  const page = read("website/quote.html");
  const start = page.indexOf("function runFeet(r, pxPerFoot){");
  assert.ok(start > 0, "found the page's runFeet");
  let depth = 0, end = start;
  for (let i = page.indexOf("{", start); i < page.length; i++) {
    if (page[i] === "{") depth++;
    if (page[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  const pageRunFeet = new Function(`${page.slice(start, end)}; return runFeet;`)();
  const cases = [
    { manualFeet: 0, points: "0:0,200:0", closed: false }, { manualFeet: 0, points: "0:0,300:0,300:400,0:400", closed: true },
    { manualFeet: 0, points: "0:0,300:0,300:400,0:400", closed: false }, { manualFeet: 90, points: "0:0,9999:0", closed: false },
    { manualFeet: 0, points: "", closed: false }, { manualFeet: 0, points: "5:5", closed: true }, { manualFeet: 0, points: "0:0,1:1,2:0", closed: true },
    { manualFeet: 12.5, points: "", closed: false }, { manualFeet: 0, points: "0:0,333:777", closed: false },
  ];
  for (const c of cases) for (const ppf of [20, 25, 13.7, 0, undefined]) {
    assert.equal(runFeet(c, ppf), pageRunFeet(c, ppf), JSON.stringify([c, ppf]));
  }
});

// ============================================== 6. language, date, key =====

test("the language is the page's own choice, else the browser's, else English -- and only ever en, es or fr", () => {
  assert.equal(pickLang("es", "fr"), "es");
  assert.equal(pickLang("FR-ca", ""), "fr");
  assert.equal(pickLang(undefined, "es-MX,es;q=0.9,en;q=0.8"), "es");
  assert.equal(pickLang(undefined, "en;q=0.4,fr;q=0.9"), "fr", "q-values rank the choices");
  assert.equal(pickLang(undefined, "de,it;q=0.8"), "en");
  assert.equal(pickLang("zz", "de"), "en");
  assert.equal(pickLang(undefined, "fr;q=0,en"), "en", "q=0 means not acceptable");
  for (const v of [null, undefined, 42, {}, [], "", "x".repeat(10000)]) assert.equal(pickLang(v, v), "en");
});

test("the approval date is written in the company's zone, not UTC -- an evening approval is not tomorrow's", () => {
  assert.equal(longDate("2026-10-02T01:30:00Z", "en", "America/New_York"), "October 1, 2026");
  assert.equal(longDate("2026-10-02T01:30:00Z", "en", "UTC"), "October 2, 2026", "CONTROL: the zone is what moves it");
  assert.equal(longDate("2026-10-02T01:30:00Z", "en", "America/Not_A_Zone"), "October 1, 2026", "a bad zone falls back to the default, not to a crash");
  assert.equal(longDate("not a date", "en", "UTC"), "");
  assert.match(longDate("2026-10-02T01:30:00Z", "es", "America/New_York"), /1 de octubre de 2026/);
  assert.match(longDate("2026-10-02T01:30:00Z", "fr", "America/New_York"), /1(er)? octobre 2026/);
});

test("contractKey fingerprints what the email states: the same contract has the same key, a changed one does not", async () => {
  const key = await contractKey(facts());
  assert.match(key, /^[0-9a-f]{64}$/);
  // The same contract, approved again by someone else, later, in another language, with the runs in another order.
  assert.equal(await contractKey(facts({ approvedBy: "Someone Else", approvedAt: "2027-01-01T00:00:00Z", runs: [...BASE.runs].reverse(), customerName: "Renamed" })), key);
  assert.equal(await contractKey(facts({ address: "1 TEST STREET, TESTVILLE" })), key, "address case is not a different contract");
  // Anything the email states changes the key.
  for (const [what, over] of [
    ["the total", { total: 9711 }], ["the deposit", { deposit: 1900 }], ["the address", { address: "2 Test Street" }],
    ["a run's height", { runs: [{ ...BASE.runs[0], heightFt: 8 }, BASE.runs[1]] }], ["a run's footage", { runs: [{ ...BASE.runs[0], points: "0:0,3000:0" }, BASE.runs[1]] }],
    ["the gate count", { runs: [{ ...BASE.runs[0], gates: "a" }, BASE.runs[1]] }], ["a run removed", { runs: [BASE.runs[0]] }],
    ["the fence type", { runs: [{ ...BASE.runs[0], type: "VINYL" }, BASE.runs[1]] }],
  ]) assert.notEqual(await contractKey(facts(over)), key, `${what} must be a different contract`);
  // The deposit DUE (payments so far) is not part of what was agreed.
  assert.equal(await contractKey(facts({ depositDue: 100 })), key);
});

test("maskEmail shows enough to recognise an address and not enough to learn it", () => {
  assert.equal(maskEmail("jane.doe@mail.example.test"), "j***@mail.example.test");
  assert.equal(maskEmail("ünï@example.test"), "ü***@example.test");
  for (const bad of ["", "nope", "@x.test", null, undefined]) assert.equal(maskEmail(bad), "");
});

// ================ 7. the payment-methods reduction is the page's own =====

test("publicPaymentMethods is quote-view's publicPaymentMethods: the same answer for every input tried, and the same characters filtered", () => {
  const src = read("supabase/functions/quote-view/index.ts");
  const a = src.indexOf("const INVISIBLE_CHARS");
  const b = src.indexOf("/**\n * The company's stored payment methods");
  assert.ok(a > 0 && b > a, "found quote-view's reduction");
  const original = new Function(`${src.slice(a, b).replace(/type PublicPaymentMethods[^\n]*\n/, "").replace(/: Record<string, unknown> \| null/g, "").replace(/\(raw: unknown\): PublicPaymentMethods/, "(raw)").replace(/: PublicPaymentMethods/g, "").replace(/\(key: string\)/g, "(key)").replace(/\(v: unknown\)/g, "(v)").replace(/ as Record<string, unknown>/g, "").replace(/\bconst stored = raw as Record<string, unknown>/, "const stored = raw")}; return { publicPaymentMethods, INVISIBLE_CHARS };`)();
  // 1. The invisible-character class: every UTF-16 code unit, both ways.
  for (let c = 0; c < 0x10000; c++) {
    const ch = String.fromCharCode(c);
    const mine = ch.replace(INVISIBLE_CHARS, "") !== ch;
    const theirs = ch.replace(original.INVISIBLE_CHARS, "") !== ch;
    assert.equal(mine, theirs, `code unit 0x${c.toString(16)} is filtered differently`);
  }
  // 2. The whole reduction over a spread of blocks, including everything a38 throws at it.
  const full = {
    cash_app: { on: true, tag: "TestOnlyTag" }, zelle: { on: true, to: "test-only@example.invalid" },
    wire: { on: true, details: "Bank: TEST ONLY BANK\nAccount name: TEST ONLY LLC\nRouting: 000000000" }, cash: { on: true },
  };
  const corpus = [
    undefined, null, {}, [], "cash app please", 42, true, [full], { cash_app: "TestOnlyTag" }, { cash_app: [] }, { cash_app: null },
    { cash_app: { on: true } }, { wire: { on: true, details: { not: "text" } } }, full,
    ...["true", 1, "yes", "on", {}, []].map((on) => Object.fromEntries(Object.entries(full).map(([k, v]) => [k, { ...v, on }]))),
    Object.fromEntries(Object.entries(full).map(([k, v]) => [k, { ...v, on: false }])),
    ...["TestOnlyTag", "$TestOnlyTag", "$$TestOnlyTag", "  $TestOnlyTag  ", "Test_Only.Tag-1", "Test Only", "a/b", "x".repeat(30), "x".repeat(31), "$", ""].map((tag) => ({ cash_app: { on: true, tag } })),
    ...["813-555-0100", "a@b.test", "  a@b.test \n\t ", "a\n\n b", "a".repeat(200), "a".repeat(201), "", "   "].map((to) => ({ zelle: { on: true, to } })),
    ...["Line one\nLine two", "\r\n  Bank: X  \r\n\r\n\r\n\r\nAccount: 1 2 3\r\n\r\n", "<b>x</b>", "9".repeat(1500), "9".repeat(1501), "", "\n\n"].map((details) => ({ wire: { on: true, details } })),
    { cash: { on: true } }, { cash: { on: false } }, { cash: {} },
  ];
  // 3. A fuzz: random mixes of the above fields with hostile values.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const junk = ["", " ", U(0x200e) + "$Tag" + U(0x200b), U(0x202e) + "abc", "x".repeat(31), "a\nb", null, 7, true, [], {}, "$Tag", "$$$", "a@b.test", U(0) + "x" + U(7)];
  for (let i = 0; i < 400; i++) {
    corpus.push({
      cash_app: pick([undefined, { on: pick([true, false, "true", 1]), tag: pick(junk) }]),
      zelle: pick([undefined, { on: pick([true, false]), to: pick(junk) }]),
      wire: pick([undefined, { on: pick([true, false]), details: pick(junk) }]),
      cash: pick([undefined, { on: pick([true, false, 0]) }]),
    });
  }
  for (const block of corpus) {
    assert.deepEqual(publicPaymentMethods(block), original.publicPaymentMethods(block), JSON.stringify(block));
  }
  // CONTROL: the comparison is not vacuous -- the full block really does reduce to something.
  assert.equal(publicPaymentMethods(full).cashApp, "$TestOnlyTag");
  assert.equal(publicPaymentMethods(full).cash, true);
});
