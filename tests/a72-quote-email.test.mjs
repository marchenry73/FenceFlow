// A72 -- "email this quote to the customer".
//
// WHAT THIS GUARDS, in the order a regression would hurt him:
//
//   1. NO FIGURE REACHES THE EMAIL. The quote-send email goes out BEFORE the
//      customer has accepted anything, and the job's total is still moving
//      (JobSync.kt's `else ->` branch keeps pushing a fresh contract_total for
//      a phone-priced job after quote_sent_at is set -- only the
//      `officePriced ->` branch above it checks quoteSentAt). A total typed
//      into the email is then wrong in her inbox for ever while the page
//      beside it is right. This project has paid for that shape of bug twice
//      (see _shared/quote-deposit.ts's header). So: the page owns every
//      figure, and these tests fail if any money-shaped token appears in any
//      line in any language -- checked against jobs whose depositFigures()
//      returns a REAL total and a REAL deposit, so the absence of a number is
//      proved to be a choice and not an unpriced fixture.
//
//   2. The three copies of the words cannot drift. The server's
//      _shared/email-templates.ts, the office's website/js/lib/quote-email.mjs
//      and the phone's three strings_email.xml files all say the same thing in
//      all three languages, or this goes red.
//
//   3. A quote with nowhere to go is REFUSED, with a sentence. A Send button
//      that cannot send is the fake-feature trap.
//
//   4. A send that did not happen does not mark the quote as sent. Once
//      quote_sent_at is set the office-priced branch of JobSync stops pushing
//      a fresh contract_total, so a false stamp freezes a price.
//
//   5. The office's new door to the quote link carries the same two gates the
//      other three doors carry. "A gate on one door only" is dashboard.html's
//      own recorded mistake.
//
// NOTHING IS SENT. No network, no Resend, no address. Every assertion is
// against a template FUNCTION, a generated resource or source text -- never
// against English on a screen, because this ships in three languages and a
// translation must not turn a test red.
//
// Run: node --test tests/a72-quote-email.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { STRINGS_FILES, stringsXmlFor, resourcesFor } from "./a72-quote-email-strings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const SERVER = "supabase/functions/_shared/email-templates.ts";
const OFFICE = "website/js/lib/quote-email.mjs";
const DEPOSIT = "supabase/functions/_shared/quote-deposit.ts";
const APPROVAL = "supabase/functions/quote-approval-email/email.ts";
const DASH = "website/dashboard.html";
const JOBSCREEN = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt";

const server = await load(SERVER);
const office = await load(OFFICE);
const deposit = await load(DEPOSIT);
const approval = await load(APPROVAL);

const LANGS = ["en", "es", "fr"];

// ---------------------------------------------------------------------------
// The job shapes. Real COLUMNS, invented values -- these are the columns the
// office reads (JOB_COLUMNS) and quote-approval-email reads (JOB_COLUMNS):
// customer_name, email, address, quote_token, contract_total, deposit_amount,
// amount_paid, refunded_amount, accepted_total, signed_at, quote_approved_at.
// No real customer's name, address or address book entry appears anywhere.
// ---------------------------------------------------------------------------
const TOKEN = "7c2a1f90-4b61-4f0e-9a3d-2b55e1d0c8aa";
const OTHER_TOKEN = "11111111-2222-3333-4444-555555555555";
const linkFor = (tok) => `https://fenceflowapp.com/quote.html?t=${tok}`;

/** A priced job with a stored deposit: the case where a figure WOULD be available. */
const PRICED = {
  customer_name: "Customer 1",
  email: "customer1@example.invalid",
  address: "1200 Example Row",
  quote_token: TOKEN,
  contract_total: 4548.07,
  deposit_amount: 2100,
  amount_paid: 0,
  refunded_amount: 0,
  accepted_total: null,
  signed_at: null,
  quote_approved_at: null,
};

/** The same job part-paid: depositFigures() then has a due, a netPaid and a balance. */
const PART_PAID = { ...PRICED, amount_paid: 500.01, deposit_amount: 2619.99 };

/** Priced, but the contractor asked for NO deposit. */
const NO_DEPOSIT = { ...PRICED, deposit_amount: 0 };

/** Nothing typed but the token: every optional clause must drop cleanly. */
const BARE = {
  customer_name: "",
  email: "customer2@example.invalid",
  address: "",
  quote_token: TOKEN,
  contract_total: 0,
  deposit_amount: 0,
  amount_paid: 0,
  refunded_amount: 0,
};

const JOB_SHAPES = { PRICED, PART_PAID, NO_DEPOSIT, BARE };

const COMPANY = { companyName: "Example Fence LLC", companyPhone: "(813) 555-0100" };
const COMPANY_NO_PHONE = { companyName: "Example Fence LLC", companyPhone: "" };

function factsFor(job, company = COMPANY) {
  return {
    companyName: company.companyName,
    companyPhone: company.companyPhone,
    customerName: job.customer_name,
    address: job.address,
    quoteUrl: linkFor(job.quote_token),
  };
}

/** depositFigures() as _shared/quote-deposit.ts takes it -- the SAME call the quote page and the payment link make. */
function figuresFor(job) {
  return deposit.depositFigures({
    depositAmount: job.deposit_amount,
    contractTotal: job.contract_total,
    amountPaid: job.amount_paid,
    refundedAmount: job.refunded_amount,
    acceptedTotal: job.accepted_total,
    signedAt: job.signed_at,
    quoteApprovedAt: job.quote_approved_at,
    changeOrders: [],
  });
}

// ---------------------------------------------------------------------------
// The money detector, and the only place "a figure" is defined.
// ---------------------------------------------------------------------------

/**
 * Every way a figure could reach the body, as a list of offending matches.
 *
 * Deliberately NOT "does it contain a digit": the body legitimately contains
 * "3D" and a URL full of hex. What it must never contain is money -- a
 * currency symbol, a thousands-grouped number, a two-decimal amount, or any
 * of the figures depositFigures() actually returns for this job, in any of the
 * ways a careless template would format them.
 */
function moneyIn(text, figures) {
  const hits = [];
  const patterns = [
    [/[$\u20ac\u00a3]/g, "currency symbol"],
    [/\d[\d,]*\.\d{2}(?!\d)/g, "two-decimal amount"],
    [/\b\d{1,3}(?:,\d{3})+\b/g, "thousands-grouped number"],
    [/\b(?:USD|EUR|dollars?|d\u00f3lares|dollars)\b/gi, "currency word"],
  ];
  for (const [re, what] of patterns) {
    for (const m of text.match(re) || []) hits.push(`${what}: ${m}`);
  }
  if (figures) {
    for (const [key, value] of Object.entries(figures)) {
      if (typeof value !== "number" || value === 0) continue;
      const forms = [
        String(value),
        value.toFixed(2),
        value.toFixed(0),
        value.toLocaleString("en-US"),
        value.toLocaleString("en-US", { minimumFractionDigits: 2 }),
      ];
      for (const f of new Set(forms)) {
        if (f.length >= 3 && text.includes(f)) hits.push(`depositFigures().${key} = ${f}`);
      }
    }
  }
  return hits;
}

/** Deposit vocabulary, in all three languages, in case a sentence talks about one without a number. */
const DEPOSIT_WORDS = [
  "deposit", "down payment",
  "dep\u00f3sito", "deposito", "anticipo", "adelanto",
  "acompte", "d\u00e9p\u00f4t", "depot", "arrhes",
];

// ===========================================================================

test("POSITIVE CONTROL: the template renders a real letter in all three languages", () => {
  for (const lang of LANGS) {
    const email = server.buildQuoteSendEmail(factsFor(PRICED), lang);
    assert.ok(email.subject.length > 10, `${lang}: subject too short`);
    // Eight paragraphs: hello, intro, link, what is on it, approving, live, questions.
    const paras = email.text.split("\n\n").filter((p) => p.trim());
    assert.ok(paras.length >= 6, `${lang}: only ${paras.length} paragraphs`);
    assert.ok(email.text.includes(linkFor(TOKEN)), `${lang}: the link is missing`);
    assert.ok(email.subject.includes(COMPANY.companyName), `${lang}: the company is not named`);
    // The control that makes every other assertion below mean something: if
    // this fixture produced an empty body, "no figure in it" would pass for
    // the wrong reason.
    assert.ok(email.text.length > 300, `${lang}: body is ${email.text.length} chars -- too short to be the letter`);
  }
});

test("POSITIVE CONTROL: these fixtures really do have money on them", () => {
  // Without this, "there is no figure in the email" could be true because the
  // job was never priced. It is a choice, not an accident.
  const priced = figuresFor(PRICED);
  assert.ok(priced.total > 1000, `fixture total is ${priced.total}`);
  assert.ok(priced.asked > 1000, `fixture deposit asked is ${priced.asked}`);
  assert.ok(priced.due > 1000, `fixture deposit due is ${priced.due}`);

  const part = figuresFor(PART_PAID);
  assert.ok(part.netPaid > 0, "part-paid fixture has nothing paid");
  assert.ok(part.due > 0 && part.due < part.asked, "part-paid fixture: due is not less than asked");
  assert.ok(part.balance > 0, "part-paid fixture has no balance");

  // And the one that must produce no deposit at all.
  assert.equal(figuresFor(NO_DEPOSIT).asked, 0);
});

test("NO FIGURE reaches the email, for any job shape, in any language", () => {
  for (const [name, job] of Object.entries(JOB_SHAPES)) {
    const figures = figuresFor(job);
    for (const lang of LANGS) {
      for (const company of [COMPANY, COMPANY_NO_PHONE]) {
        const email = server.buildQuoteSendEmail(factsFor(job, company), lang);
        const whole = email.subject + "\n" + email.text;
        const hits = moneyIn(whole, figures);
        assert.deepEqual(hits, [], `${name}/${lang}: money reached the email -- ${hits.join("; ")}`);
      }
    }
  }
});

test("a blank deposit produces no deposit sentence -- and neither does a set one", () => {
  // The email has no deposit sentence at all, which is the only way "a blank
  // deposit produces no deposit sentence" can be true without a branch that
  // could one day be got wrong. Checked for the job that HAS a deposit too,
  // because that is the case a careless change would add one for.
  for (const [name, job] of Object.entries(JOB_SHAPES)) {
    for (const lang of LANGS) {
      const email = server.buildQuoteSendEmail(factsFor(job, COMPANY), lang);
      const lower = (email.subject + "\n" + email.text).toLowerCase();
      for (const word of DEPOSIT_WORDS) {
        assert.ok(!lower.includes(word), `${name}/${lang}: the email talks about a deposit ("${word}")`);
      }
    }
  }
});

test("CANARY: a template that does state the total FAILS the money check", () => {
  // Teeth. The checks above are only worth something if they go red against a
  // template that does the wrong thing. This is the email somebody would write
  // without reading the header -- "Total: $4,548.07", "Deposit to begin ...".
  const figures = figuresFor(PRICED);
  const wrong = [
    `Hi ${PRICED.customer_name},`,
    "",
    `Here is your quote from ${COMPANY.companyName} for the fence at ${PRICED.address}.`,
    "",
    `Total: $${figures.total.toFixed(2)}`,
    `Deposit to begin: $${figures.due.toFixed(2)}`,
    "",
    `Open it here: ${linkFor(TOKEN)}`,
  ].join("\n");

  const hits = moneyIn(wrong, figures);
  assert.ok(hits.length > 0, "THE CANARY DID NOT FAIL: a template stating the total passed the money check");
  // And it must be caught for the right reasons, not just on the dollar sign.
  assert.ok(hits.some((h) => h.startsWith("depositFigures().total")),
    `the canary was not caught on the total itself: ${hits.join("; ")}`);
  assert.ok(hits.some((h) => h.startsWith("depositFigures().due")),
    `the canary was not caught on the deposit due: ${hits.join("; ")}`);
  assert.ok(hits.some((h) => h.includes("currency symbol")), "the canary was not caught on the currency symbol");

  // The deposit-sentence check must have teeth too.
  assert.ok(/deposit/i.test(wrong), "canary sanity: the wrong template does mention a deposit");
  const lower = wrong.toLowerCase();
  assert.ok(DEPOSIT_WORDS.some((w) => lower.includes(w)), "THE DEPOSIT CANARY DID NOT FAIL");
});

test("the link carries THIS job's token, and no other", () => {
  for (const lang of LANGS) {
    const email = server.buildQuoteSendEmail(factsFor(PRICED), lang);
    assert.ok(email.text.includes(linkFor(TOKEN)), `${lang}: the job's own link is missing`);
    assert.ok(!email.text.includes(OTHER_TOKEN), `${lang}: another job's token reached the email`);
    // Exactly one link, so nobody can be sent two and pick the stale one.
    const urls = email.text.match(/https:\/\/\S+/g) || [];
    assert.equal(urls.length, 1, `${lang}: ${urls.length} links in the body`);
    assert.equal(urls[0], linkFor(TOKEN));
  }
});

test("a job with no email address CANNOT be sent, and says why", () => {
  const base = { quoteUrl: linkFor(TOKEN), companyName: COMPANY.companyName };

  assert.equal(server.quoteSendRefusal({ ...base, recipient: "" }), "no_address");
  assert.equal(server.quoteSendRefusal({ ...base, recipient: "   " }), "no_address");
  assert.equal(server.quoteSendRefusal({ ...base, recipient: null }), "no_address");
  assert.equal(server.quoteSendRefusal({ ...base, recipient: undefined }), "no_address");

  // Not an address, and not repaired into one either.
  for (const bad of ["jane", "jane@", "@example.invalid", "jane@example", "a b@c.co",
                     "one@example.invalid, two@example.invalid", "jane@example.invalid>"]) {
    assert.equal(server.quoteSendRefusal({ ...base, recipient: bad }), "bad_address", `accepted "${bad}"`);
  }

  // No link yet (a job that has not reached the cloud), and a link that is not https.
  for (const bad of ["", null, "http://fenceflowapp.com/quote.html?t=" + TOKEN, "javascript:alert(1)"]) {
    assert.equal(
      server.quoteSendRefusal({ recipient: "customer1@example.invalid", companyName: "X", quoteUrl: bad }),
      "no_link", `accepted link "${bad}"`);
  }

  // Nothing to send FROM.
  assert.equal(
    server.quoteSendRefusal({ recipient: "customer1@example.invalid", quoteUrl: linkFor(TOKEN), companyName: "" }),
    "no_company_name");

  // And a good one goes through -- the control, or every line above passes
  // because the function always refuses.
  assert.equal(server.quoteSendRefusal({ ...base, recipient: "customer1@example.invalid" }), null);

  // Every refusal has a real sentence in every language.
  for (const lang of LANGS) {
    for (const code of ["no_address", "bad_address", "no_link", "no_company_name"]) {
      const sentence = server.REFUSAL_REASON[lang][code];
      assert.ok(typeof sentence === "string" && sentence.length > 25,
        `${lang}/${code}: no usable sentence`);
      assert.equal(sentence, office.REFUSAL_REASON[lang][code],
        `${lang}/${code}: the office and the server refuse differently`);
    }
  }
});

test("a refused send is refused BEFORE any words are built", () => {
  // The order matters: a template rendered for a job with no recipient is the
  // beautiful-template-no-recipient trap. With no link there is no link line
  // at all, which is why the refusal has to be asked first.
  const noLink = server.buildQuoteSendEmail({ ...factsFor(PRICED), quoteUrl: "" }, "en");
  assert.ok(!/https?:/.test(noLink.text), "a bad link still produced a link line");
  assert.equal(server.quoteSendRefusal({ recipient: PRICED.email, quoteUrl: "", companyName: "X" }), "no_link");
});

test("the office's copy and the server's copy render the SAME email", () => {
  // Not a phrase grepped out of the file -- the actual output, character for
  // character, across every job shape, both company shapes and all three
  // languages.
  let compared = 0;
  for (const [name, job] of Object.entries(JOB_SHAPES)) {
    for (const company of [COMPANY, COMPANY_NO_PHONE]) {
      for (const lang of LANGS) {
        const a = server.buildQuoteSendEmail(factsFor(job, company), lang);
        const b = office.buildQuoteSendEmail(factsFor(job, company), lang);
        assert.equal(b.subject, a.subject, `${name}/${lang}: subjects differ`);
        assert.equal(b.text, a.text, `${name}/${lang}: bodies differ`);
        compared++;
      }
    }
  }
  assert.equal(compared, Object.keys(JOB_SHAPES).length * 2 * LANGS.length);
  assert.ok(compared >= 24, `only ${compared} comparisons`);
});

test("CANARY: a word changed in one copy turns the parity check red", () => {
  // Teeth for the test above. The real files are not touched; the check is
  // re-run against a doctored words table.
  const doctored = JSON.parse(JSON.stringify({ x: 1 })); // keep the linter honest about intent
  assert.equal(doctored.x, 1);

  const a = server.buildQuoteSendEmail(factsFor(PRICED), "en");
  const drifted = a.text.replace(server.QUOTE_SEND_WORDS.en.pageIsLive,
    "The page is live, so it always shows the latest price. Open it again any time.");
  assert.notEqual(drifted, a.text, "the canary did not actually change anything");
  assert.notEqual(drifted, office.buildQuoteSendEmail(factsFor(PRICED), "en").text,
    "THE PARITY CANARY DID NOT FAIL: a reworded body still compared equal");
});

test("the phone's strings_email.xml files ARE the template, in all three languages", () => {
  for (const lang of LANGS) {
    const rel = STRINGS_FILES[lang];
    const expected = stringsXmlFor(lang, server.QUOTE_SEND_WORDS[lang]);
    const onDisk = read(rel);
    assert.equal(onDisk, expected,
      `${rel} is not what the template module generates. Run: node tests/a72-quote-email-strings.mjs --write`);
  }
});

test("the phone's resources assemble back into the same email the office sends", () => {
  // The phone joins these eleven strings in JobDetailScreen.kt. Joined the
  // same way here, they must come out as buildQuoteSendEmail's own body --
  // otherwise the phone and the office say different things to the same
  // customer and nothing else would notice.
  for (const lang of LANGS) {
    const byName = Object.fromEntries(resourcesFor(server.QUOTE_SEND_WORDS[lang]).map((r) => [r.name, r.text]));
    const fmt = (tpl, ...args) => tpl.replace(/%(\d)\$s/g, (_, i) => args[Number(i) - 1]);
    const company = COMPANY.companyName;

    for (const job of [PRICED, BARE]) {
      for (const phone of [COMPANY.companyPhone, ""]) {
        const assembled = [
          job.customer_name ? fmt(byName.quote_email_hello, job.customer_name) : byName.quote_email_hello_blank,
          "",
          job.address ? fmt(byName.quote_email_intro, company, job.address)
                      : fmt(byName.quote_email_intro_no_address, company),
          "",
          fmt(byName.quote_email_open, linkFor(job.quote_token)),
          "",
          byName.quote_email_whats_on_it,
          "",
          fmt(byName.quote_email_approving, company),
          "",
          byName.quote_email_page_is_live,
          "",
          phone ? fmt(byName.quote_email_questions, company, phone) : byName.quote_email_questions_no_phone,
        ].join("\n");

        const expected = server.buildQuoteSendEmail(
          factsFor(job, { companyName: company, companyPhone: phone }), lang).text;
        assert.equal(assembled, expected, `${lang}: the phone's resources do not assemble into the email`);

        const subject = fmt(byName.quote_email_subject, company);
        assert.equal(subject, server.buildQuoteSendEmail(
          factsFor(job, { companyName: company, companyPhone: phone }), lang).subject,
          `${lang}: the phone's subject differs`);
      }
    }
  }
});

test("the phone formats those resources with the arguments they declare", () => {
  // Source check, because Kotlin cannot be compiled here (Gradle is off limits
  // in this session) and a String.format with the wrong number of arguments is
  // a crash in the yard, not a compile error.
  const kt = read(JOBSCREEN);
  const words = server.QUOTE_SEND_WORDS.en;
  for (const r of resourcesFor(words)) {
    assert.ok(kt.includes(`R.string.${r.name}`), `JobDetailScreen.kt never reads ${r.name}`);
    const argCount = (r.text.match(/%\d\$s/g) || []).length;
    assert.equal(argCount, r.args.length, `${r.name}: declares ${r.args.length} args, text has ${argCount}`);
  }
  // Every resource that declares arguments is actually formatted with them,
  // through the same kotlin.text `.format()` idiom this file already uses for
  // bodyTemplate -- and every argument-free one is used raw. A resource with a
  // %1$s that nobody formats reaches the customer as the literal "%1$s".
  for (const r of resourcesFor(words)) {
    // qeSubject -> quote_email_subject, qeIntroNoAddress -> ..._intro_no_address
    const val = "qe" + r.name.replace(/^quote_email_/, "").replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
    const formatted = new RegExp(val + "\\.format\\(").test(kt);
    if (r.args.length) {
      assert.ok(formatted, `${r.name} declares ${r.args.length} argument(s) but ${val} is never formatted`);
    } else {
      assert.ok(!formatted, `${r.name} takes no arguments but ${val} is formatted`);
    }
  }
  // The body is joined with a single newline, the way buildQuoteSendEmail joins
  // its lines -- the test above compares the assembled text, this pins the join.
  assert.ok(/\.joinToString\("\\n"\)/.test(kt), "the phone does not join the lines with a single newline");
});

test("the phone's quote email does NOT mark the quote as sent", () => {
  // A mail app opening with a draft in it is not a quote sent. And a false
  // stamp is expensive: once quote_sent_at is set, JobSync's officePriced
  // branch stops pushing a fresh contract_total, which freezes a price.
  const kt = read(JOBSCREEN);
  const start = kt.indexOf("val quoteEmailBody: (String) -> String");
  assert.ok(start > 0, "the phone's quote-email block is gone");
  const end = kt.indexOf("R.string.field_email", start);
  assert.ok(end > start, "could not find the end of the phone's quote-email block");
  const block = kt.slice(start, end);
  assert.ok(block.includes("IntentHelpers.openEmailDraft"), "the block no longer opens a mail draft");
  assert.ok(!/markQuoteSent/.test(block),
    "the phone's email draft button now stamps quote_sent_at -- it cannot know anything was sent");
});

test("the office marks the quote sent ONLY where mail-send confirmed it", () => {
  const dash = read(DASH);

  // Exactly one caller, and it is inside composeSent().
  const calls = [...dash.matchAll(/markQuoteSentAfterEmail\(/g)];
  assert.equal(calls.length, 2, `markQuoteSentAfterEmail appears ${calls.length} times (definition + one call expected)`);

  const sentFn = dash.indexOf("function composeSent(");
  assert.ok(sentFn > 0, "composeSent() is gone");
  const sentEnd = dash.indexOf("\nasync function closeCompose(", sentFn);
  assert.ok(sentEnd > sentFn, "could not bound composeSent()");
  const body = dash.slice(sentFn, sentEnd);
  // Matched on the call and its FIRST argument, not on the whole argument list.
  // This read `includes("markQuoteSentAfterEmail(c.quoteSendFor)")` until
  // 2026-10-02, when the stamp gained a second argument -- the addresses the
  // message actually went to, so jobs.email stops disagreeing with who received
  // the quote (tests/a77). The exact-list match then failed on a correct change
  // while what it is actually guarding -- that composeSent stamps THIS job --
  // was never in doubt. Still catches the stamp being removed, or pointed at
  // some other job id.
  assert.match(body, /markQuoteSentAfterEmail\(c\.quoteSendFor\b/,
    "composeSent() no longer stamps the quote for the job it was composed for");

  // composeSent() is reached on state === 'sent' and nowhere else.
  assert.ok(/if \(body\.state === 'sent'\) return composeSent\(c, body\);/.test(dash),
    "composeSent() is no longer the 'sent' branch alone");

  // And the three not-sent answers return without it.
  const send = dash.slice(dash.indexOf("const { status, body } = await mailFn('mail-send'"), sentFn);
  for (const branch of ["body.state === 'sending'", "body.state === 'failed'"]) {
    assert.ok(send.includes(branch), `the ${branch} branch is gone from sendCompose()`);
  }
  // The failed and unconfirmed branches must not stamp.
  const failedAt = send.indexOf("body.state === 'failed'");
  assert.ok(failedAt > 0);
  assert.ok(!send.slice(failedAt).includes("markQuoteSentAfterEmail"),
    "a failed send now marks the quote as sent");
  assert.ok(!send.includes("markQuoteSentAfterEmail"),
    "sendCompose() stamps the quote itself, outside the confirmed-sent path");
});

test("CANARY: the stamp moved into the failed branch turns that check red", () => {
  // Teeth for the test above, on a copy of the source.
  const dash = read(DASH);
  const sentFn = dash.indexOf("function composeSent(");
  const sabotaged = dash.slice(0, sentFn)
    .replace("if (body.state === 'failed') {", "if (body.state === 'failed') { markQuoteSentAfterEmail(c.quoteSendFor);");
  assert.notEqual(sabotaged, dash.slice(0, sentFn), "the canary did not change the source");
  assert.ok(sabotaged.includes("markQuoteSentAfterEmail"),
    "THE CANARY DID NOT FAIL: a stamp inside the failed branch went unnoticed");
});

test("the office's new door carries the SAME two gates as the other three", () => {
  const dash = read(DASH);
  const start = dash.indexOf("function quoteSendBlock(");
  assert.ok(start > 0, "quoteSendBlock() is gone");
  const end = dash.indexOf("\nasync function jobQuoteMailCompose(", start);
  assert.ok(end > start, "could not bound quoteSendBlock()");
  const gate = dash.slice(start, end);
  // The same two functions the job view's Copy link / Preview use.
  assert.ok(gate.includes("zeroQuoteBlockedOn("), "the $0-on-an-uncalibrated-photo gate is missing");
  assert.ok(gate.includes("unverifiedPricesOn("), "the unverified-catalog-price gate is missing");

  // And the compose handler actually asks it, before anything else.
  const h = dash.slice(end, dash.indexOf("async function markQuoteSentAfterEmail(", end));
  const askedAt = h.indexOf("quoteSendBlock(");
  const composeAt = h.indexOf("openCompose(");
  assert.ok(askedAt > 0, "jobQuoteMailCompose() never asks quoteSendBlock()");
  assert.ok(composeAt > askedAt, "the compose window opens before the gates are checked");

  // The refusal is asked before the compose window too.
  const refuseAt = h.indexOf("quoteSendRefusal(");
  assert.ok(refuseAt > 0 && refuseAt < composeAt,
    "jobQuoteMailCompose() opens compose before checking there is anywhere to send");
});

test("the office does not advance a job that is past DRAFT, and keeps the first send's date", () => {
  const dash = read(DASH);
  const start = dash.indexOf("async function markQuoteSentAfterEmail(");
  assert.ok(start > 0);
  const fn = dash.slice(start, dash.indexOf("\n}", dash.indexOf("renderQuoteBlock();", start)));
  assert.ok(/j\.status === 'DRAFT'/.test(fn),
    "the status is advanced without checking it is still DRAFT -- an ACCEPTED job would be dragged back");
  assert.ok(/!j\.quote_sent_at/.test(fn),
    "quote_sent_at is overwritten on a resend instead of keeping the first send's date");
});

test("the primitives behave like the originals they were copied from", () => {
  // _shared/email-templates.ts cannot import quote-approval-email/email.ts (a
  // shared module must not depend on one function's folder), so oneLine,
  // safeUrl and pickLang are copies. They must not diverge.
  const cases = [
    "plain", "  spaced  out  ", "tab\there", "line\nbreak", "zero\u200bwidth",
    "bidi\u202eoverride", "", "   ", "\u2028separator", "a".repeat(400),
  ];
  for (const c of cases) {
    assert.equal(server.oneLine(c, 120), approval.oneLine(c, 120), `oneLine differs on ${JSON.stringify(c)}`);
    assert.equal(office.oneLine(c, 120), approval.oneLine(c, 120), `office oneLine differs on ${JSON.stringify(c)}`);
  }
  const urls = [
    "https://fenceflowapp.com/quote.html?t=" + TOKEN,
    "http://fenceflowapp.com/x", "javascript:alert(1)", "", "https://a b.com",
    'https://a"b.com', "https://" + "a".repeat(500),
  ];
  for (const u of urls) {
    assert.equal(server.safeUrl(u), approval.safeUrl(u), `safeUrl differs on ${u}`);
    assert.equal(office.safeUrl(u), approval.safeUrl(u), `office safeUrl differs on ${u}`);
  }
  const langs = [
    ["es", undefined], [undefined, "fr-CA,fr;q=0.9,en;q=0.8"], [undefined, "de"],
    ["", ""], ["ES", null], [null, "en-US,en;q=0.5,es;q=0.9"],
  ];
  for (const [req, hdr] of langs) {
    assert.equal(server.pickLang(req, hdr), approval.pickLang(req, hdr), `pickLang differs on ${req}/${hdr}`);
    assert.equal(office.pickLang(req, hdr), approval.pickLang(req, hdr), `office pickLang differs on ${req}/${hdr}`);
  }
});

test("a stranger cannot put a second link in his outgoing email", () => {
  // lead-intake runs with verify_jwt = false and writes customer_name, address,
  // phone, email and notes onto a new job straight from the public website
  // form. So both the name and the address in this email can be typed by
  // somebody who is not him, and a link in either would be made clickable by
  // the HTML twin of an email that arrives FROM HIS COMPANY.
  //
  // Nothing here builds markup, so markup cannot be injected -- the company
  // name below arrives as literal text and composeBody()/textToHtml() escape
  // it downstream, exactly as quote-approval-email documents. What IS cleaned
  // here is a link, and a line break that could carry a header.
  const nasty = {
    companyName: "Example <b>Fence</b> & Co",
    companyPhone: "(813) 555-0100\nX-Injected: yes",
    customerName: "Jane http://evil.invalid/steal \u202e www.also-evil.invalid",
    address: "1 A St\r\nBcc: someone@example.invalid https://evil.invalid/x",
    quoteUrl: linkFor(TOKEN),
  };
  for (const lang of LANGS) {
    for (const mod of [server, office]) {
      const email = mod.buildQuoteSendEmail(nasty, lang);
      const whole = email.subject + "\n" + email.text;
      assert.ok(!/\r/.test(whole), `${lang}: a carriage return survived`);
      // No header can be smuggled in: every field is collapsed to one line.
      // No field spans two lines, so nothing typed into one can start a line
      // of its own. (It can still read as "X-Injected: yes" in the middle of a
      // sentence, which is harmless: this is a plain-text BODY, and mail-send
      // builds the MIME and the headers itself -- nothing from here reaches
      // them. What matters is that a line break cannot survive.)
      assert.ok(!/\n(Bcc|Cc|To|From|Reply-To|X-[A-Za-z-]+):/i.test(whole),
        `${lang}: a field spanning two lines let a header start a line`);
      const phoneLine = email.text.split("\n").filter((l) => l.includes("555-0100"));
      assert.equal(phoneLine.length, 1, `${lang}: the phone field reached ${phoneLine.length} lines`);
      assert.ok(phoneLine[0].includes("X-Injected: yes"),
        `${lang}: control -- the injected text should be collapsed INTO the one line, not removed`);
      // EXACTLY ONE link, and it is the one we built.
      const urls = whole.match(/https?:\/\/\S+/g) || [];
      assert.equal(urls.length, 1, `${lang}: ${urls.length} links after injection (${urls.join(" ")})`);
      assert.equal(urls[0], linkFor(TOKEN));
      assert.ok(!/evil\.invalid/.test(whole), `${lang}: a stranger's link survived`);
      assert.ok(!/www\./.test(whole), `${lang}: a bare www link survived`);
      // The bidi override is gone; it can reorder a whole line on screen.
      assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(whole), `${lang}: a bidi override survived`);
    }
  }
});

test("CANARY: without the link stripping, a stranger's link reaches the email", () => {
  // Teeth. oneLine alone -- what this template used before lead-intake was
  // read -- leaves the link in. If this stops being true, the check above has
  // stopped meaning anything.
  const stranger = "Jane http://evil.invalid/steal";
  assert.ok(server.oneLine(stranger, 120).includes("evil.invalid"),
    "canary sanity: oneLine no longer keeps a link");
  assert.ok(!server.typedByStranger(stranger, 120).includes("evil.invalid"),
    "THE CANARY DID NOT FAIL: typedByStranger left a link in");
  assert.equal(server.typedByStranger(stranger, 120), office.typedByStranger(stranger, 120));
});

test("CREW CANNOT REACH THE QUOTE EMAIL, and it is not this feature's own gate", () => {
  // Reused rather than re-invented: the button lives inside the Email panel,
  // which is shown only when canUseMail is true, and canUseMail is
  // can_use_company_mail() -- which refuses CREW outright and requires
  // SEE_MONEY of everyone else. Checked in the FUNCTION BODY, not its comment.
  const sql = read("supabase_mail.sql");
  const start = sql.indexOf("create or replace function public.can_use_company_mail()");
  assert.ok(start > 0, "can_use_company_mail() is gone");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  assert.ok(/p\.role::text <> 'CREW'/.test(body), "the crew exclusion left can_use_company_mail()");
  assert.ok(/has_permission\('SEE_MONEY'\)/.test(body), "SEE_MONEY is no longer required for company mail");

  // And the office really does hang the panel and the button off that gate.
  const dash = read(DASH);
  const render = dash.slice(dash.indexOf("function renderJobMail()"), dash.indexOf("async function loadJobMailRows("));
  assert.ok(/if \(!canUseMail/.test(render), "the Email panel is no longer gated on canUseMail");
  const handler = dash.slice(dash.indexOf("async function jobQuoteMailCompose("),
                             dash.indexOf("async function markQuoteSentAfterEmail("));
  assert.ok(/if \(!canUseMail/.test(handler), "jobQuoteMailCompose() no longer checks canUseMail");

  // The phone's side is money-gated too: the quote link shows sell prices.
  const kt = read(JOBSCREEN);
  const at = kt.indexOf("val quoteEmailBody: (String) -> String");
  assert.ok(at > 0);
  const before = kt.slice(kt.lastIndexOf("if (session.canSeeMoney) item {", at), at);
  assert.ok(before.length > 0, "the phone's quote-email button is no longer inside a canSeeMoney item");
});

test("mail-send is reused rather than a second sender written", () => {
  // The office sends through the generic sender, which already owns one-send-
  // per-client_send_id, the four honest states, the Sent copy and the thread
  // on the job. A second Resend path would be a second set of those bugs.
  const dash = read(DASH);
  const h = dash.slice(dash.indexOf("async function jobQuoteMailCompose("),
                       dash.indexOf("async function markQuoteSentAfterEmail("));
  assert.ok(h.includes("openCompose("), "the office no longer goes through the compose window");
  assert.ok(!/api\.resend\.com|RESEND_API_KEY/.test(h), "a Resend call appeared in the office");
  assert.ok(h.includes("jobSyncId"), "the thread is no longer linked to the job");
  // And no new edge function was invented for this.
  assert.ok(!/functions\/v1\/send-quote-email/.test(dash), "the office calls a send-quote-email function");
});
