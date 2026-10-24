// Does a letter with two link lines now render TWO buttons, and does
// hideCtaUrl drop the grey address under them? Rendered for real rather than
// reasoned about -- this is what a customer opens.
import { composeBody } from "./mime-build.ts";

const letter = [
  "Hello Marc,",
  "",
  "Your quote for 123 Oak Street is ready.",
  "",
  "Open your quote: https://fenceflowapp.com/quote.html?t=abc123",
  "",
  "Pay your deposit: https://buy.stripe.com/test_9AQ123",
  "",
  "Any questions, just reply.",
].join("\n");

function count(h: string, needle: string): number {
  return h.split(needle).length - 1;
}

let bad = 0;
function check(what: string, got: unknown, want: unknown) {
  const ok = String(got) === String(want);
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: got ${got}, want ${want}`);
}

console.log("\nWith hideCtaUrl (the quote email):");
const hidden = composeBody({ text: letter, hideCtaUrl: true });
check("buttons rendered", count(hidden.html, "padding:12px 26px"), 2);
check("grey address lines under them", count(hidden.html, "word-break:break-all"), 0);
check("the quote link is one of them", hidden.html.includes("quote.html?t=abc123"), true);
check("the pay link is the other", hidden.html.includes("buy.stripe.com/test_9AQ123"), true);
check("plain-text part still carries both",
  hidden.text.includes("quote.html") && hidden.text.includes("buy.stripe.com"), true);

console.log("\nDefault, every other email (addresses still shown):");
const shown = composeBody({ text: letter });
check("buttons rendered", count(shown.html, "padding:12px 26px"), 2);
check("grey address lines under them", count(shown.html, "word-break:break-all"), 2);

console.log("\nA third link must NOT become a button:");
const three = composeBody({
  text: letter + "\n\nTerms: https://fenceflowapp.com/terms.html\n",
});
check("buttons capped at two", count(three.html, "padding:12px 26px"), 2);
check("the third is still a link", three.html.includes("terms.html"), true);

console.log(bad === 0 ? "\nall checks passed" : `\n${bad} FAILED`);
if (bad > 0) process.exit(1);
