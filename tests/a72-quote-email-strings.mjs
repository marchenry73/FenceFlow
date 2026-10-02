/**
 * The phone's copy of the quote-send email, DERIVED from the template module
 * rather than typed a second time.
 *
 * The three strings_email.xml files under app/src/main/res (values, values-es,
 * values-fr) hold the same sentences as
 * supabase/functions/_shared/email-templates.ts, because an Android screen
 * reads words out of a resource file and cannot import a TypeScript module.
 * Hand-copying eleven sentences into three locale files is how the phone comes
 * to say something the office does not, in one language, for months.
 *
 * So the files are GENERATED from QUOTE_SEND_WORDS, and
 * tests/a72-quote-email.test.mjs regenerates them and fails if what is on disk
 * differs by a character. Change a sentence in the template module, re-run
 * `node tests/a72-quote-email-strings.mjs --write`, and all three locales move
 * together or the test stays red.
 *
 * Usage:
 *   node tests/a72-quote-email-strings.mjs          print the three files
 *   node tests/a72-quote-email-strings.mjs --write   write them
 */

import { readFileSync, writeFileSync } from "node:fs";
// pathToFileURL, not a bare path: on Windows an absolute path starting "C:"
// reaches the ESM loader as the scheme "c:" and import() refuses it.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "supabase/functions/_shared/email-templates.ts");

/** Where each locale's file lives. "en" is the default values/ folder. */
export const STRINGS_FILES = {
  en: "app/src/main/res/values/strings_email.xml",
  es: "app/src/main/res/values-es/strings_email.xml",
  fr: "app/src/main/res/values-fr/strings_email.xml",
};

// Sentinels pushed through the words table so a rendered sentence can be
// turned back into an Android format string. Characters no sentence contains.
const C = "\u0001";   // the company name
const A = "\u0002";   // the property address
const N = "\u0003";   // the customer's name
const U = "\u0004";   // the quote link
const P = "\u0005";   // the company phone

/**
 * The eleven resources, in the order buildQuoteSendEmail() uses them, each
 * built by calling the SAME words table the email is built from.
 *
 * `args` names what each %n$s is, in order, for the Kotlin that formats it.
 */
export function resourcesFor(words) {
  const w = words;
  const sub = (s, map) => {
    let out = s;
    for (const [sentinel, token] of map) out = out.split(sentinel).join(token);
    return out;
  };
  const one = [[C, "%1$s"]];
  const first = [[N, "%1$s"]];
  const url = [[U, "%1$s"]];
  const two = [[C, "%1$s"], [A, "%2$s"]];
  const phone = [[C, "%1$s"], [P, "%2$s"]];

  return [
    { name: "quote_email_subject", args: ["company"], text: sub(w.subject(C), one) },
    { name: "quote_email_hello", args: ["customerName"], text: sub(w.hello(N), first) },
    { name: "quote_email_hello_blank", args: [], text: w.hello("") },
    { name: "quote_email_intro", args: ["company", "address"], text: sub(w.intro(C, A), two) },
    { name: "quote_email_intro_no_address", args: ["company"], text: sub(w.intro(C, ""), one) },
    { name: "quote_email_open", args: ["url"], text: sub(w.open(U), url) },
    { name: "quote_email_whats_on_it", args: [], text: w.whatIsOnIt },
    { name: "quote_email_approving", args: ["company"], text: sub(w.approving(C), one) },
    { name: "quote_email_page_is_live", args: [], text: w.pageIsLive },
    { name: "quote_email_questions", args: ["company", "phone"], text: sub(w.questions(C, P), phone) },
    { name: "quote_email_questions_no_phone", args: [], text: w.questions(C, "").split(C).join("") },
  ];
}

/**
 * One line of an Android string resource.
 *
 * Escaping, in the order it has to happen: the XML entities first, then the
 * two characters aapt2 itself treats as markup inside a string (a straight
 * apostrophe and a straight double quote). Paragraph breaks are written as
 * the two-character escape \n so the XML stays one line per string and a
 * trailing space can never be lost to whitespace collapsing.
 *
 * A sentence containing a literal percent sign would break String.format, so
 * it is refused outright rather than escaped into something that looks right
 * and formats wrong.
 */
function xmlEscape(text, name) {
  const placeholders = text.match(/%\d\$s/g) || [];
  const percents = text.match(/%/g) || [];
  if (percents.length !== placeholders.length) {
    throw new Error(`${name}: a literal % in a formatted Android string`);
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

/** The whole strings_email.xml for one language. */
export function stringsXmlFor(lang, words) {
  const rows = resourcesFor(words).map((r) => {
    const args = r.args.length ? `  <!-- ${r.args.map((a, i) => `%${i + 1}$s = ${a}`).join(", ")} -->\n` : "";
    return `${args}  <string name="${r.name}">${xmlEscape(r.text, r.name)}</string>`;
  });
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<!--`,
    `  The "here is your quote" email, as the phone sends it.`,
    ``,
    `  GENERATED. Do not edit by hand: these sentences are the ones in`,
    `  supabase/functions/_shared/email-templates.ts, and`,
    `  tests/a72-quote-email.test.mjs regenerates this file and fails if it`,
    `  differs by a character, so an edit here is a red test, not a change.`,
    `  To change the wording, change the template module and re-run this`,
    `  generator with its write flag; the generator's own usage line spells it.`,
    ``,
    // NO DOUBLE HYPHEN ANYWHERE IN THIS HEADER. XML forbids "--" inside a
    // comment, and the generated file is an Android resource: a "--" here makes
    // mergeReleaseResources fail, which it has done before. That is also why
    // the flag is described rather than written out, and why the sentence above
    // uses a comma where this project's prose would normally use a dash.
    // tests/strings-xml-wellformed.test.mjs is what catches it if this is lost.
    ``,
    `  THERE IS NO PRICE IN THIS EMAIL, deliberately. It goes out before the`,
    `  customer has accepted anything and the job's total is still moving, so`,
    `  the quote page owns every figure. See the template module's header.`,
    `-->`,
    `<resources>`,
    rows.join("\n"),
    `</resources>`,
    ``,
  ].join("\n");
}

/** The template module's words, loaded from source. */
export async function loadWords() {
  const mod = await import(pathToFileURL(TEMPLATE).href);
  return mod.QUOTE_SEND_WORDS;
}

export { ROOT, TEMPLATE };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const words = await loadWords();
  const write = process.argv.includes("--write");
  for (const [lang, rel] of Object.entries(STRINGS_FILES)) {
    const xml = stringsXmlFor(lang, words[lang]);
    const abs = path.join(ROOT, rel);
    if (write) {
      writeFileSync(abs, xml, "utf8");
      console.log("wrote", rel);
    } else {
      let same = null;
      try { same = readFileSync(abs, "utf8") === xml; } catch { same = false; }
      console.log(`--- ${rel}  (on disk matches: ${same})`);
      console.log(xml);
    }
  }
}
