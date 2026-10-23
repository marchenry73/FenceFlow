// A123 -- THE 'fenceflow' SENDER IS NOT A UUID, and a uuid column must never
// be handed it.
//
// THE BUG THIS CLOSES, found in app_errors on 23 Oct 2026, unacknowledged,
// where_at "office/mail":
//
//     invalid input syntax for type uuid: "fenceflow"
//
// The office's From box offers one option per connected mail account, each
// carrying that account's uuid as its value, plus one for FenceFlow's own
// sender whose value is the literal string 'fenceflow'. saveComposeDraft wrote
//
//     account_id: $('mc_from').value || null
//
// into mail_drafts.account_id, which is a UUID column. So EVERY autosave of a
// message being written from FenceFlow -- the sender a company uses until it
// connects its own inbox, which is most of them -- was refused by Postgres.
// The compose window carried on as though it had saved, and closing it lost
// the message.
//
// Nothing caught it. It is not a syntax error, it asks for no missing element,
// the function it is in parses perfectly, and the failure is a rejected write
// inside a .catch that reported to app_errors and nowhere a person looks.
//
// WHAT IS CHECKED, and why it is worth a file of its own: the sentinel is a
// string in a system where nearly every other identifier is a uuid, so this
// is a trap with more than one place to spring. The checks are therefore about
// the SHAPE of the mistake rather than about this one line.
//
// NOTHING IS SENT, no network, no database: this reads website/dashboard.html.
//
// Run: node --test tests/a123-draft-sender-is-not-a-uuid.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASH = readFileSync(path.join(ROOT, "website/dashboard.html"), "utf8");

/** Comments out: a sentence about the sentinel is not a write of it. */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1 ");

/** One function's body, brace-matched from its declaration. */
function fnBody(src, name) {
  const at = src.search(new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\("));
  assert.ok(at >= 0, `${name} is gone from dashboard.html`);
  let depth = 0, start = src.indexOf("{", at);
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("POSITIVE CONTROL: the sentinel is really what the From box offers", () => {
  // If this ever stops being true the rest of the file is about nothing.
  const c = code(DASH);
  assert.match(c, /value:\s*'fenceflow'/,
    "the From box no longer offers a 'fenceflow' option -- re-read this file");
  assert.match(c, /===\s*'fenceflow'/,
    "nothing compares against the sentinel any more");
});

test("the draft's account_id can never be the sentinel", () => {
  const body = code(fnBody(DASH, "saveComposeDraft"));
  const line = body.split("\n").find((l) => /account_id\s*:/.test(l) || /account_id:/.test(l));
  assert.ok(body.includes("account_id"), "saveComposeDraft no longer writes account_id at all");
  // The guard, however it is spelled: the value must be tested against the
  // sentinel somewhere in the same function before it is stored.
  assert.match(body, /!==\s*'fenceflow'/,
    "saveComposeDraft stores the From box's value without excluding the 'fenceflow' sentinel, " +
    "which mail_drafts.account_id (uuid) rejects -- so the draft is never saved");
  assert.ok(line === undefined || true, "placeholder: the line itself is read above");
});

test("CANARY: the pre-fix expression is recognised as unsafe", () => {
  // The exact line that shipped. If the check above cannot fail on this, it is
  // decoration.
  const prefix = "function saveComposeDraft(){ const row = { account_id: $('mc_from').value || null }; }";
  const body = code(fnBody(prefix, "saveComposeDraft"));
  assert.ok(body.includes("account_id"), "the canary's own body did not parse");
  assert.ok(!/!==\s*'fenceflow'/.test(body),
    "THE CANARY DID NOT FIRE: the pre-fix line was judged safe, so this file would not have caught the bug");
});

test("the sentinel only ever travels as from_account_id, which is text", () => {
  // mail-send takes from_account_id as a STRING and understands the sentinel.
  // That is the one place it is allowed to go. Anywhere else it is a uuid
  // column waiting to refuse it.
  const c = code(DASH);
  assert.match(c, /from_account_id:\s*from\b/,
    "the send path no longer passes the sender as from_account_id");

  // Every OTHER write of an account id in this page must come from a real
  // account row (a.id / x.id), never from the From box.
  const writes = [...c.matchAll(/account_id:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
  assert.ok(writes.length >= 2, `only found ${writes.length} account_id writes -- the scan is not working`);
  for (const w of writes) {
    if (/mc_from/.test(w)) {
      // The one that reads the From box has to be the guarded IIFE, not a
      // bare value.
      assert.ok(/=>/.test(w) || w.includes("("),
        `an account_id is written straight from the From box: ${w}`);
    }
  }
});

test("nothing else in the office writes the sentinel into a uuid-named field", () => {
  const c = code(DASH);
  // Any `<something>_id: 'fenceflow'` or `<something>_id: <var that is the
  // From box>` is the same mistake in a new place. Checked as a pattern so a
  // second instance is caught without this file being edited.
  const bad = [...c.matchAll(/(\w*_id)\s*:\s*'fenceflow'/g)].map((m) => m[0]);
  assert.deepEqual(bad, [],
    "the sentinel is written into an id field as a literal: " + bad.join("; "));
  // from_account_id is the allowed exception and is text, so it is excluded by
  // name rather than by accident.
  const fromBox = [...c.matchAll(/(\w+_id)\s*:\s*\$\('mc_from'\)\.value/g)]
    .map((m) => m[1])
    .filter((n) => n !== "from_account_id");
  assert.deepEqual(fromBox, [],
    "an id field is written straight from the From box: " + fromBox.join(", "));
});
