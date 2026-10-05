// Build the supplier price request from the REAL catalog, so the reply imports.
//
// The office's price-list importer matches a supplier's row to an item by its
// DESCRIPTION, and classifies columns by their heading (ppClassifyHeader).
// Two things follow, and both are why this is generated rather than typed:
//
//  1. The descriptions must be his catalog's own names, character for
//     character. A retyped name is a row that imports as "no match".
//  2. There must be exactly ONE price column. ppDetectColumns leaves price at
//     -1 when several headings read as a price -- List, Net, Contractor -- and
//     refuses to guess, "because picking the wrong one reprices the whole
//     catalog and every number still looks plausible". So: one column, headed
//     "Price".
//
// It also adds the ONE row he does not have yet: the 4 ft vinyl corner post.
// That is the whole point of sending this -- it gets the supplier's real name
// for the part and their real price, which are the two things stopping that
// catalog row from being written.
import { readFileSync, writeFileSync } from "node:fs";

const OUT = "C:/Users/march/AndroidProjects/FenceEstimator/docs";
const rows = JSON.parse(readFileSync("C:/tmp/rfq.json", "utf8")).rows;

// The gap, marked so he can see it is not one of his rows.
const MISSING = {
  name: "Corner Post, 5x5x72, White, 4' Closed Top  [NOT IN MY CATALOG - please give your part name]",
  unit: "EA", h: 4, role: "CORNER_POST", unit_price: null,
};

const groups = [
  ["6 ft privacy", rows.filter((r) => r.h === 6)],
  ["4 ft closed top", rows.filter((r) => r.h === 4).concat([MISSING])],
  ["Any height (hardware, caps, trim)", rows.filter((r) => r.h === 0)],
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// RFC4180: double the quotes, wrap anything containing a comma or a quote.
// Fence names are full of inch marks (5"x5"), which is exactly the case the
// importer's own tests call out as breaking naive CSV.
const csvCell = (s) => {
  const t = String(s == null ? "" : s);
  return /[",\n]/.test(t) ? '"' + t.split('"').join('""') + '"' : t;
};

// ---------------------------------------------------------------- the CSV ---
const csv = [["Description", "Unit", "Price"]]
  .concat(groups.flatMap(([, items]) => items.map((r) => [r.name, r.unit, ""])))
  .map((cols) => cols.map(csvCell).join(","))
  .join("\r\n");
writeFileSync(`${OUT}/SUPPLIER_PRICE_REQUEST.csv`, csv + "\r\n", "utf8");

// --------------------------------------------------------------- the page ---
const today = process.env.RFQ_DATE || "";
const section = ([title, items]) => `
  <h2>${esc(title)}</h2>
  <table>
    <thead><tr><th class="d">Description</th><th class="u">Unit</th><th class="p">Price</th></tr></thead>
    <tbody>
      ${items.map((r) => `<tr${r.unit_price === null ? ' class="gap"' : ""}>
        <td class="d">${esc(r.name)}</td><td class="u">${esc(r.unit)}</td><td class="p"></td></tr>`).join("\n      ")}
    </tbody>
  </table>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Price Request — Vinyl Fence</title>
<style>
  /* Printed, so this is sized in points and leaves the table headers repeating
     across pages. Nothing here is theme-aware on purpose: it goes on paper or
     into a PDF, where there is no dark mode. */
  @page { size: letter; margin: 14mm; }
  body { font: 10pt/1.42 "Segoe UI", Arial, sans-serif; color: #111; max-width: 190mm; margin: 0 auto; padding: 16px; }
  h1 { font-size: 16pt; margin: 0 0 2pt; }
  h2 { font-size: 11pt; margin: 16pt 0 4pt; padding-bottom: 2pt; border-bottom: 1px solid #999; page-break-after: avoid; }
  .meta { color: #555; font-size: 9pt; margin: 0 0 10pt; }
  .ask { background: #f4f4f4; border-left: 3px solid #555; padding: 8pt 10pt; margin: 10pt 0 4pt; font-size: 9.5pt; }
  .ask p { margin: 0 0 5pt; } .ask p:last-child { margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th, td { border: 1px solid #bbb; padding: 3.5pt 5pt; text-align: left; vertical-align: top; }
  th { background: #eee; font-size: 9pt; }
  tr { page-break-inside: avoid; }
  .d { width: 72%; } .u { width: 10%; } .p { width: 18%; }
  td.p { background: #fffdf0; }
  .gap td { background: #fff3cd; font-weight: 600; }
  .foot { margin-top: 14pt; font-size: 8.5pt; color: #666; border-top: 1px solid #ccc; padding-top: 6pt; }
</style></head><body>

<h1>Price request — vinyl fence</h1>
<p class="meta">Fence Solutions Legacy${today ? " &middot; " + esc(today) : ""}</p>

<div class="ask">
  <p><strong>What I need:</strong> your current price per unit for the items below.
  Write it in the Price column and send the sheet back however suits you — this page,
  a spreadsheet, or your own price list. I can read it either way.</p>
  <p><strong>Two requests that save us both a round trip.</strong>
  Please keep the descriptions as they are written here, even if your part name differs —
  put yours in a separate column if you like. And please send <em>one</em> price column.
  If the sheet comes back with List and Net side by side I have to ask which one to use.</p>
  <p><strong>The highlighted row is the one I am missing.</strong> I do not have a
  4&nbsp;ft corner post on file and I need one: a 5x5, 72&nbsp;inch, white, closed top,
  for a four-foot fence — not the taller post used on six-foot privacy.
  Please tell me <em>your</em> name and part number for it along with the price.</p>
</div>

${groups.map(section).join("\n")}

<p class="foot">Items listed exactly as they appear in my own catalog, so your prices
load straight in. ${rows.length} items plus one I am asking you to name.</p>

</body></html>`;
writeFileSync(`${OUT}/SUPPLIER_PRICE_REQUEST.html`, html, "utf8");

console.log(`items: ${rows.length} (+1 missing)`);
for (const [t, items] of groups) console.log(`  ${t}: ${items.length}`);
console.log("wrote docs/SUPPLIER_PRICE_REQUEST.html and .csv");
