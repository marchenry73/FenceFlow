// a85: AN UNFILLED PLACEHOLDER MUST NOT REACH A CUSTOMER.
//
// fillTemplate leaves {{customer_first_name}} standing when it has no value,
// which is right -- a visible gap beats a silent blank -- and the compose sheet
// names the missing ones in red. But sendCompose checked addresses, recipient
// counts, subject length, body bytes and attachments, and never once looked at
// the text it was about to send. So ignoring the red note and clicking Send
// mailed "Hi {{customer_first_name}}," to a real customer.
//
// Behavioural, not static: mail-render.mjs is a real module, so these call the
// function the way the page calls it and assert on what comes back. The static
// half -- that sendCompose actually calls it -- is section 4, because a guard
// nothing reaches is the bug this repo keeps re-learning.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unfilledPlaceholders, fillTemplate, firstNameOf } from "../website/js/lib/mail-render.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(join(ROOT, "website/dashboard.html"), "utf8");

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};
const eq = (id, what, got, want) =>
  ok(id, what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

console.log("\n1. IT FINDS WHAT WOULD EMBARRASS HIM");
eq("1a", "the exact case that prompted this",
  unfilledPlaceholders("Hi {{customer_first_name}}, your quote is ready."), ["customer_first_name"]);
eq("1b", "subject and body are checked together, because either can carry one",
  unfilledPlaceholders("Quote for {{job_address}}", "Hi {{customer_first_name}}"),
  ["job_address", "customer_first_name"]);
eq("1c", "the same name twice is reported once, so the message does not repeat itself",
  unfilledPlaceholders("{{a_b}} and {{a_b}}"), ["a_b"]);
eq("1d", "whitespace inside the braces is still a placeholder -- fillTemplate accepts it, so this must too",
  unfilledPlaceholders("{{  customer_first_name  }}"), ["customer_first_name"]);
eq("1e", "case is folded, matching fillTemplate's own flags",
  unfilledPlaceholders("{{Customer_First_Name}}"), ["customer_first_name"]);

console.log("\n2. IT DOES NOT ACCUSE HIM OF SOMETHING HE DID NOT DO");
eq("2a", "a filled template is clean", unfilledPlaceholders("Hi Makayla, your quote is ready."), []);
eq("2b", "empty and null are clean, not a crash", unfilledPlaceholders("", null, undefined), []);
eq("2c", "a single brace in prose is not a placeholder",
  unfilledPlaceholders("The cost is {not a placeholder}"), []);
eq("2d", "neither is a lone opening pair",
  unfilledPlaceholders("Use {{ for a template"), []);
eq("2e", "nor anything that is not the {{lower_snake}} shape this app writes",
  unfilledPlaceholders("{{not-a-name}} {{has space}} {{}}"), []);

console.log("\n3. IT AGREES WITH fillTemplate -- one source of truth for the shape");
{
  // If these two ever disagree, one of them is wrong about what a placeholder
  // is, and the gap between them is exactly where a leak would live.
  const tpl = "Hi {{customer_first_name}}, quote for {{job_address}} is {{quote_total}}.";
  const partial = fillTemplate(tpl, { customer_first_name: "Makayla", job_address: "" });
  eq("3a", "fillTemplate reports what it could not fill",
    partial.missing.sort(), ["job_address", "quote_total"]);
  eq("3b", "and the guard finds exactly those still standing in its output",
    unfilledPlaceholders(partial.text).sort(), ["job_address", "quote_total"]);
  eq("3c", "a fully filled template leaves the guard nothing",
    unfilledPlaceholders(fillTemplate(tpl, {
      customer_first_name: "Makayla", job_address: "123 Main St", quote_total: "$4,200",
    }).text), []);
  // A blank name is reported missing rather than inserting a stray space --
  // and the guard must then still see the placeholder.
  eq("3d", "a blank first name leaves the placeholder standing, and the guard catches it",
    unfilledPlaceholders(fillTemplate("Hi {{customer_first_name}}", { customer_first_name: firstNameOf("  ") }).text),
    ["customer_first_name"]);
}

console.log("\n4. THE SEND PATH ACTUALLY ASKS -- a guard nothing calls is not a guard");
ok("4a", "sendCompose imports it", page.includes("unfilledPlaceholders"));
ok("4b", "and calls it on the subject and body it is about to send",
  /unfilledPlaceholders\(\s*subject\s*,\s*text\s*\)/.test(page));
ok("4c", "the refusal happens BEFORE the send is marked busy, so a refused attempt leaves the sheet usable",
  page.indexOf("unfilledPlaceholders(subject, text)") < page.indexOf("c.busy = true;") &&
  page.indexOf("unfilledPlaceholders(subject, text)") > 0);
ok("4d", "a second click sends anyway, so a literal {{ in prose cannot lock him out of his own mail",
  page.includes("c.placeholderWarned"));

console.log("\n5. CANARIES");
ok("5a", "CANARY: the matcher really is anchored to the braces -- a bare name is not a placeholder",
  unfilledPlaceholders("customer_first_name").length === 0);
ok("5b", "CANARY: 4b is a regex on the real call, so renaming the arguments fails it",
  !/unfilledPlaceholders\(\s*subject\s*,\s*text\s*\)/.test("unfilledPlaceholders(subj, bod)"));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
