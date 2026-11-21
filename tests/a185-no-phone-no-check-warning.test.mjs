/* a185: the phone says so BEFORE a quote link goes out for a job with
 * nobody to check against.
 *
 * quote-view asks whoever opens a quote link for the last four digits of the
 * phone on the job before it records an approval. A job carrying no phone has
 * nothing to check against, so that function lets the approval through on
 * purpose and writes quote_approved_without_phone_check. a184 is the office
 * seeing that afterwards; this is the phone saying it beforehand, while a
 * phone number is still something somebody can type.
 *
 * MEASURED 20 Nov 2026: four of the nine quotes ever approved online were
 * approved with no check at all, every one because the job had no phone. The
 * largest was $11,442.36.
 *
 * Kotlin cannot be run from here, so this reads the shipped source -- with
 * COMMENTS STRIPPED FIRST, because a check that can be satisfied by a comment
 * is a check that passes on a file where the code was deleted and the comment
 * left behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCREEN = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt";
const raw = readFileSync(SCREEN, "utf8");

/** The same source with every comment replaced by blanks of equal length, so
 *  offsets still line up with the real file. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

const code = stripComments(raw);

const GUARD = "if (!mayGoWithoutAPhone(j.phone)) return@launch";
const LINK = "val link = quoteLinkFor(context, app, session.signedIn, j.syncId)";

/** Every place the screen fetches a quote link, with the code that follows it. */
function linkSites(src) {
  const out = [];
  for (let i = src.indexOf(LINK); i >= 0; i = src.indexOf(LINK, i + 1)) {
    const launch = src.lastIndexOf("scope.launch {", i);
    out.push({
      at: i,
      // Between the launch that owns this fetch and the fetch itself: where a
      // guard would have to be to stop the work happening at all.
      before: src.slice(launch, i),
      after: src.slice(i, i + 2600),
    });
  }
  return out;
}

test("every site that SENDS asks first, and the one that only opens a link does not", () => {
  const sites = linkSites(code);
  assert.equal(sites.length, 4, "the screen fetches a quote link in four places");

  const guarded = sites.filter((s) => s.before.includes(GUARD));
  const open = sites.filter((s) => s.after.includes("Intent.ACTION_VIEW"));

  assert.equal(guarded.length, 3, "the three paths that put the link in front of a customer must ask");
  assert.equal(open.length, 1, "exactly one site opens the link on this phone instead of sending it");
  assert.equal(open[0].before.includes(GUARD), false,
    "opening a link sends nothing to anybody, so asking there is a question with no subject");
});

test("each of the three sends names a different way out", () => {
  // Proof the three guarded sites really are the three send paths and not the
  // same one counted three times: a text, FenceFlow's own email, and a
  // scheduled one.
  const sites = linkSites(code).filter((s) => s.before.includes(GUARD));
  const marks = sites.map((s) =>
    s.after.includes("openSmsDraft") ? "text"
      : s.after.includes("scheduleQuote") ? "scheduled"
        : "email");
  assert.deepEqual([...marks].sort(), ["email", "scheduled", "text"]);
});

test("the gate WARNS and does not refuse: a job with a phone never asks", () => {
  // Some customers really are email only. A send button that cannot send is
  // the fake control this project keeps writing rules against.
  const fn = code.slice(code.indexOf("suspend fun mayGoWithoutAPhone"));
  const body = fn.slice(0, fn.indexOf("\n    }") + 6);
  assert.match(body, /if \(phone\.isNotBlank\(\)\) return true/,
    "a job that HAS a phone must go straight out with no question");
  assert.match(body, /CompletableDeferred<Boolean>/);
  assert.match(body, /return answer\.await\(\)/,
    "the send has to WAIT for the answer, or the question is decoration");
});

test("there is one gate, not one per button", () => {
  const n = (code.match(/mayGoWithoutAPhone/g) ?? []).length;
  assert.equal(n, 4, "one declaration and three calls; a second copy is a second place to rot");
});

test("dismissing the dialog is a no, and only the confirm button is a yes", () => {
  const dlg = code.slice(code.indexOf("noPhoneAsk?.let { ask ->"));
  const box = dlg.slice(0, dlg.indexOf("\n    }") + 6);
  assert.match(box, /onDismissRequest = \{ noPhoneAsk = null; ask\.complete\(false\) \}/,
    "a tap outside is not an answer to 'send it anyway'");
  assert.equal((box.match(/ask\.complete\(true\)/g) ?? []).length, 1,
    "exactly one control may mean yes");
  assert.equal((box.match(/ask\.complete\(false\)/g) ?? []).length, 2,
    "dismiss and the cancel button both mean no");
});

test("PLANTED: drop the guard from the email-now path and this file notices", () => {
  // Without this, the first test would pass on a screen where the guard was
  // never added to that path at all -- it only ever counts what it finds.
  const mutated = code.replace(GUARD, "");
  assert.notEqual(mutated, code, "the planted edit did not apply");
  const guarded = linkSites(mutated).filter((s) => s.before.includes(GUARD));
  assert.equal(guarded.length, 2, "one guard removed must leave two");
});

// ------------------------------------------------------------- the words

const LANGS = {
  en: "app/src/main/res/values/strings.xml",
  es: "app/src/main/res/values-es/strings.xml",
  fr: "app/src/main/res/values-fr/strings.xml",
};
const KEYS = ["jd_no_phone_title", "jd_no_phone_body", "jd_no_phone_send", "jd_no_phone_cancel"];

test("all four strings exist in all three languages", () => {
  // A key missing from one dictionary is a blank dialog about who can approve
  // a quote, for a reader in that language.
  for (const [lang, path] of Object.entries(LANGS)) {
    const xml = readFileSync(path, "utf8");
    for (const key of KEYS) {
      assert.match(xml, new RegExp(`<string name="${key}">`), `${lang} is missing ${key}`);
    }
  }
});

test("the body says what actually happens, in every language", () => {
  // Compared by SHAPE, never by looking for an English word: it must mention
  // four digits (the thing that will not be checked) and must not promise
  // that sending is blocked.
  for (const [lang, path] of Object.entries(LANGS)) {
    const xml = readFileSync(path, "utf8");
    const body = xml.match(/<string name="jd_no_phone_body">([\s\S]*?)<\/string>/)[1];
    assert.ok(body.length > 80, `${lang}: the warning is too short to say what is lost`);
    assert.ok(/4|four|cuatro|quatre/i.test(body),
      `${lang}: the warning must name the check that will not run`);
  }
});

test("the strings carry no format placeholders", () => {
  // stringResource() is called with no arguments here; a %1$s would render
  // literally in the dialog.
  for (const path of Object.values(LANGS)) {
    const xml = readFileSync(path, "utf8");
    for (const key of KEYS) {
      const v = xml.match(new RegExp(`<string name="${key}">([\\s\\S]*?)</string>`))[1];
      assert.equal(/%\d?\$?[sd]/.test(v), false, `${key} carries a placeholder nothing fills`);
    }
  }
});

// ---------------------------------------------------------- THE OFFICE DOOR
//
// "A gate on one door only is this file's own recorded mistake" -- the
// comment above dashboard.html's own quote button, written after a previous
// gate was added to the phone and not to the office. So the office says it
// too, and because that door opens a compose window instead of sending on the
// tap, it says it beside the button rather than in a dialog.
//
// updateJobMailBtn is lifted out and RUN against a fake sheet, so this tests
// what the office actually does rather than that the words appear in the file.

const office = readFileSync("website/dashboard.html", "utf8");

const grabFn = (name) => {
  const start = office.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found: " + name);
  let depth = 0;
  for (let j = office.indexOf("{", start); j < office.length; j++) {
    if (office[j] === "{") depth++;
    else if (office[j] === "}") { depth--; if (!depth) return office.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
};

/** A sheet with the given phone typed into it, and the buttons it drives. */
function runOfficeMailRow(phoneTyped) {
  const els = {};
  const $ = (id) => (els[id] = els[id] || { id, value: "", textContent: "", style: {}, disabled: false, title: "" });
  $("j_phone").value = phoneTyped;
  $("j_email").value = "her@example.com";
  const run = new Function(
    "$", "tr", "jobMailTo", "openJob", "quoteSendBlock", "QUOTE_REFUSAL_REASON", "LANG",
    grabFn("updateJobMailBtn") + "\nreturn updateJobMailBtn;",
  )($, (k) => k, () => ["her@example.com"], { quote_token: "tok" }, () => "", { en: {} }, "en");
  run();
  return els;
}

test("THE OFFICE DOOR: a job with no phone is warned, beside the button", () => {
  const els = runOfficeMailRow("");
  assert.equal(els.jobQuoteNoPhoneNote.textContent, "jobQuoteNoPhone",
    "the office must say the approval will go unchecked");
});

test("THE OFFICE DOOR: typing a phone clears it, without saving first", () => {
  // Read from the sheet's own field, not the saved row -- the same reasoning
  // as jobMailTo() directly above it in the page.
  const els = runOfficeMailRow("813 555 0134");
  assert.equal(els.jobQuoteNoPhoneNote.textContent, "");
});

test("THE OFFICE DOOR: it warns and never disables the button", () => {
  // A send button that will not send is the fake control this project keeps
  // writing rules against, and some customers really are email only.
  for (const phone of ["", "813 555 0134"]) {
    assert.equal(runOfficeMailRow(phone).jobQuoteMailBtn.disabled, false,
      "the quote may still be emailed with no phone on the job (phone: " + JSON.stringify(phone) + ")");
  }
});

test("THE OFFICE DOOR: the wording exists in all three dictionaries", () => {
  const n = (office.match(/^\s*jobQuoteNoPhone:/gm) ?? []).length;
  assert.equal(n, 3, "jobQuoteNoPhone appears in " + n + " of the 3 dictionaries");
});
