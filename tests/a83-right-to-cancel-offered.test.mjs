// a83 -- C1, "Cancellation is not filled in -- make it work."
//
// WHAT WAS WRONG, and what was not. The cancellation FEATURE is live and
// correct: supabase_r45_job_cancellation.sql, job_cancellation_terms() (present
// on the live database, checked), CancellationApi, and the dialog on
// JobDetailScreen. What is not filled in is the CONTRACT. Every contract ships
// with
//
//     YOUR RIGHT TO CANCEL -- [REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]
//
// and four lines underneath explaining to the OWNER that he must go and obtain
// the wording. Those four lines print on the customer's copy, and the app warns
// before every send while the marker is there.
//
// WHY THE DEFAULT IS NOT SIMPLY FILLED IN. I wrote the clause straight into the
// three shipped defaults first. tests/a42-cancellation-clause.test.mjs went red
// in five places, and its header says why in terms that changed my mind rather
// than the test: "The statutory right-to-cancel block is NOT removed by
// accident. It is attorney wording; the app warns, and gates sending, while it
// is still in the text." Legal wording shipped as a silent default puts text
// nobody chose on every contractor's contracts, in every state.
//
// SO IT IS OFFERED, NOT IMPOSED, and that is what this file pins:
//
//   1. The shipped defaults still carry the marker, and the warning still
//      fires. (a42 guards this from its side; checked here too, because the
//      whole design of this change rests on it.)
//   2. The federal three-day notice exists, written out, in all three
//      languages, as something separate from the defaults.
//   3. withFederalRightToCancel swaps the marked PARAGRAPH -- heading,
//      marker and the owner-facing instructions under it -- for that clause,
//      choosing by WHICH MARKER is present rather than by the app's current
//      language, so an English clause is never written into Spanish terms.
//   4. It leaves alone any terms with no marker. It is not a reset, and it must
//      never touch a word the owner wrote himself.
//   5. The clause is customer-facing only: not one sentence in it is addressed
//      to the contractor. That is half of what makes the present block wrong.
//   6. The Settings screen actually calls it. A function that exists and is
//      never reached reads as a fix and is not one.
//
// WHAT THE CLAUSE STATES: the three-business-day right in the Federal Trade
// Commission's Cooling-Off Rule, 16 C.F.R. Part 429, which covers sales of $25
// or more agreed anywhere other than the seller's own place of business -- so
// nearly every fence job, since they are signed at the customer's home. Florida
// (Fla. Stat. 501.021-501.055) gives the same three business days. Not legal
// advice; the Settings screen says so above the button, and says a state may
// add to it.
//
//     node --test tests/a83-right-to-cancel-offered.test.mjs   (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const TPL_REL = "app/src/main/java/com/fenceestimator/app/data/ContractTemplate.kt";
const SET_REL = "app/src/main/java/com/fenceestimator/app/ui/settings/SettingsScreen.kt";
const TPL = read(TPL_REL);
const SET = read(SET_REL);

/** The body of a `const val NAME: String = """..."""`. */
function constantIn(name) {
  const key = 'const val ' + name + ': String = """';
  const i = TPL.indexOf(key);
  assert.ok(i >= 0, name + " is not in ContractTemplate.kt");
  const j = TPL.indexOf('"""', i + key.length);
  assert.ok(j > i, name + " has no closing triple quote");
  return TPL.slice(i + key.length, j);
}

const DEFAULTS = {
  EN: constantIn("DEFAULT_CONTRACT_TERMS"),
  ES: constantIn("DEFAULT_CONTRACT_TERMS_ES"),
  FR: constantIn("DEFAULT_CONTRACT_TERMS_FR"),
};
const CLAUSE = {
  EN: constantIn("FEDERAL_RIGHT_TO_CANCEL_EN"),
  ES: constantIn("FEDERAL_RIGHT_TO_CANCEL_ES"),
  FR: constantIn("FEDERAL_RIGHT_TO_CANCEL_FR"),
};
const MARKER = {
  EN: "[REPLACE THIS BLOCK",
  ES: "[REEMPLACE ESTE BLOQUE",
  FR: "[REMPLACEZ CE BLOC",
};

/**
 * withFederalRightToCancel, ported from its Kotlin. Pinned to that source by
 * check 7 below, so an edit to the Kotlin that moves this logic fails rather
 * than leaving a model that quietly describes code nobody runs any more.
 */
function withFederalRightToCancel(terms) {
  const lang = ["EN", "ES", "FR"].find(
    (l) => terms.toUpperCase().includes(MARKER[l].toUpperCase()));
  if (!lang) return terms;
  const at = terms.toUpperCase().indexOf(MARKER[lang].toUpperCase());
  if (at < 0) return terms;
  const nl = terms.lastIndexOf("\n", at);
  const lineStart = nl < 0 ? 0 : nl + 1;
  const m = /\r?\n[ \t]*\r?\n/.exec(terms.slice(at));
  const endOfPara = m ? at + m.index : terms.length;
  return terms.slice(0, lineStart) + CLAUSE[lang] + terms.slice(endOfPara);
}

// ====================================================== 1. the guard is intact
test("1. every shipped default STILL carries its replace-me marker", () => {
  // The premise of this whole change. If a default is ever filled in directly,
  // the offer below becomes pointless and this file should be re-read, not
  // adjusted.
  for (const lang of ["EN", "ES", "FR"]) {
    assert.ok(DEFAULTS[lang].includes(MARKER[lang]),
      `the ${lang} shipped default no longer carries ${MARKER[lang]} -- legal wording is now going out unchosen`);
  }
  // And the matcher that drives the warning must still hold all three.
  for (const lang of ["EN", "ES", "FR"]) {
    const fn = TPL.slice(TPL.indexOf("fun contractTermsNeedLegalReview"));
    assert.ok(fn.slice(0, 400).includes(MARKER[lang]),
      `contractTermsNeedLegalReview no longer matches ${MARKER[lang]}`);
  }
});

// ========================================================== 2. the swap works
test("2. the marked paragraph is replaced, heading and owner instructions with it", () => {
  for (const lang of ["EN", "ES", "FR"]) {
    const out = withFederalRightToCancel(DEFAULTS[lang]);
    assert.ok(!out.includes(MARKER[lang]),
      `${lang}: the marker survived the swap`);
    assert.ok(out.includes(CLAUSE[lang].trim().split("\n")[0]),
      `${lang}: the clause's own heading is not in the result`);
    // The owner-facing instructions that used to print on the customer's copy.
    for (const phrase of ["Ask your attorney", "Pregunte a su abogado", "Demandez"]) {
      if (DEFAULTS[lang].includes(phrase)) {
        assert.ok(!out.includes(phrase),
          `${lang}: "${phrase}" is still in the contract -- the swap kept the instructions addressed to the owner`);
      }
    }
    // Nothing else moved: the clause before it and the signature line after it
    // are both still there.
    const tail = DEFAULTS[lang].trim().split("\n").slice(-1)[0];
    assert.ok(out.includes(tail), `${lang}: the end of the terms was eaten`);
  }
});

test("3. CANARY: a swap that did nothing is caught", () => {
  // Without the real function this check is measuring a no-op, so prove the
  // assertion above can fail.
  const noop = (t) => t;
  const out = noop(DEFAULTS.EN);
  assert.ok(out.includes(MARKER.EN),
    "CANARY BROKEN: the untouched default has no marker, so check 2 proves nothing");
});

test("4. the clause is chosen by MARKER, never by the app's language", () => {
  // The case that matters: untouched defaults are stored in English on a phone
  // the owner later switches to Spanish. The terms are English, so the English
  // clause belongs in them -- and the reverse for Spanish terms.
  const fromEs = withFederalRightToCancel(DEFAULTS.ES);
  assert.ok(fromEs.includes(CLAUSE.ES.trim().split("\n")[0]),
    "Spanish terms did not get the Spanish clause");
  assert.ok(!fromEs.includes(CLAUSE.EN.trim().split("\n")[0]),
    "Spanish terms got the ENGLISH clause written into them");
  const fromFr = withFederalRightToCancel(DEFAULTS.FR);
  assert.ok(fromFr.includes(CLAUSE.FR.trim().split("\n")[0]),
    "French terms did not get the French clause");
});

test("5. terms with no marker are returned untouched", () => {
  // It is an offer, not a reset. An owner who pasted his attorney's wording
  // must never have it replaced by this.
  const mine = "MY OWN TERMS\nWhatever my attorney wrote, exactly as he wrote it.\n";
  assert.equal(withFederalRightToCancel(mine), mine,
    "terms the owner wrote himself were rewritten");
  // Idempotent: applying it twice changes nothing, because the marker is gone.
  const once = withFederalRightToCancel(DEFAULTS.EN);
  assert.equal(withFederalRightToCancel(once), once,
    "a second tap changed the terms again");
});

// ============================================== 6. customer-facing words only
test("6. not one sentence of the clause is addressed to the contractor", () => {
  // The shipped block's defect, and the one this must not repeat: text telling
  // the OWNER what to do, printed on the document the CUSTOMER signs.
  const owner = [
    /ask your attorney/i, /your state/i, /FenceFlow/i, /replace this/i,
    /to the contractor/i, /pregunte a su abogado/i, /su estado/i,
    /demandez . votre avocat/i, /votre .tat/i, /al contratista/i,
  ];
  for (const lang of ["EN", "ES", "FR"]) {
    for (const re of owner) {
      assert.ok(!re.test(CLAUSE[lang]),
        `${lang} clause contains owner-facing text (${re}) -- it prints on the customer's contract`);
    }
  }
  // It must say which paragraph wins, or the contract contradicts itself: the
  // CANCELLATION paragraph above charges for non-returnable materials and r45
  // charges $1 a foot, and inside three business days the federal rule gives
  // every payment back.
  assert.match(CLAUSE.EN, /overrides the CANCELLATION paragraph above/,
    "the English clause does not say it overrides the paragraph above it, so the contract contradicts itself inside the three-day window");
  assert.match(CLAUSE.ES, /prevalece/i, "the Spanish clause does not state the override");
  assert.match(CLAUSE.FR, /pr.vaut/i, "the French clause does not state the override");
  // And the substance: three business days, ten business days to refund.
  assert.match(CLAUSE.EN, /THIRD\s+BUSINESS DAY/, "the English clause lost the three-day right");
  assert.match(CLAUSE.EN, /TEN BUSINESS DAYS/, "the English clause lost the refund deadline");
});

// ===================================================== 7. and it is reachable
test("7. Settings offers it, and the Kotlin is what the model above describes", () => {
  // A dead helper reads as a fix and is not one.
  assert.match(SET, /withFederalRightToCancel\(base\)/,
    "the Settings screen never calls withFederalRightToCancel");
  assert.match(SET, /R\.string\.set_contract_terms_federal_use/,
    "there is no button label, so nothing is offered");
  assert.match(SET, /R\.string\.set_contract_terms_federal_offer/,
    "the offer is made with no explanation of what it is and is not");
  // Offered only where the warning is -- inside the termsNeedReview branch.
  const warn = SET.indexOf("if (termsNeedReview) {");
  const call = SET.indexOf("withFederalRightToCancel(base)");
  assert.ok(warn >= 0 && call > warn,
    "the offer is not inside the needs-review branch, so it is shown to owners whose terms are already written");
  // Applied to the STORED terms, not to the display copy. shownTerms
  // substitutes the language default for display; writing that back would
  // silently change the language of his contract.
  assert.doesNotMatch(SET, /withFederalRightToCancel\(shownTerms\)/,
    "the offer is applied to the display copy, which would rewrite the terms in another language");

  // The three pins that keep the JS model honest.
  const fn = TPL.slice(TPL.indexOf("fun withFederalRightToCancel"));
  assert.ok(fn.length > 200, "withFederalRightToCancel is not in ContractTemplate.kt");
  assert.match(fn.slice(0, 1200), /RIGHT_TO_CANCEL_BY_MARKER\.firstOrNull/,
    "the Kotlin no longer chooses the clause by marker -- the model above is wrong");
  assert.match(fn.slice(0, 1200), /lastIndexOf\('\\n', at\)/,
    "the Kotlin no longer replaces from the start of the marker's line");
  assert.match(fn.slice(0, 1200), /\?: terms\.length/,
    "the Kotlin no longer falls back to the end of the terms when there is no following blank line");
});

test("8. the three clauses carry the same placeholders", () => {
  // {COMPANY} is substituted by PdfExporter; a placeholder in one language and
  // not another prints a raw brace on somebody's contract.
  const used = (t) => [...new Set(t.match(/\{[A-Z_]+\}/g) || [])].sort();
  assert.deepEqual(used(CLAUSE.ES), used(CLAUSE.EN), "Spanish uses different placeholders");
  assert.deepEqual(used(CLAUSE.FR), used(CLAUSE.EN), "French uses different placeholders");
  assert.deepEqual(used(CLAUSE.EN), ["{COMPANY}"],
    "the clause uses a placeholder PdfExporter may not substitute");
});
