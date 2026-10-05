// a88: THE PRICE REQUEST WE SEND OUT MUST COME BACK IMPORTABLE.
//
// docs/SUPPLIER_PRICE_REQUEST.csv exists so a supplier can fill in a Price
// column and have it load straight into the catalog. That claim is only worth
// anything if the office's OWN importer can read the file -- so this runs the
// real ppParseTable / ppDetectColumns lifted out of dashboard.html, not a
// re-implementation, and asserts on what they return.
//
// Two things make this easy to get wrong, and both are why the file is
// generated rather than typed:
//
//   - fence names are full of inch marks: 5"x5" Co-Ex Corner Post, White.
//     That is a quote character AND a comma in one field. Get the escaping
//     wrong and the parser swallows the following rows.
//   - ppDetectColumns leaves price at -1 when more than one heading reads as a
//     price, rather than guessing, because picking List over Net silently
//     reprices the whole catalog. So the sheet must offer exactly one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { load } from "./a27-pricelist-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const csv = readFileSync(join(ROOT, "docs/SUPPLIER_PRICE_REQUEST.csv"), "utf8");

const P = load(["ppStripBom", "ppParseDelimited", "ppSniffDelimiter", "ppParseTable",
                "ppClassifyHeader", "ppColIndex", "ppColLetter", "ppDetectColumns", "ppReadRows"]);

let passed = 0, failed = 0;
const ok = (id, what, cond, detail) => {
  if (cond) { passed++; console.log(`  ok    ${id} ${what}`); }
  else { failed++; console.log(`  FAIL  ${id} ${what}${detail ? " -- " + detail : ""}`); }
};

const table = P.ppParseTable(csv);
const det = P.ppDetectColumns(table);
// The importer's own next step, so this measures the pipeline rather than my
// idea of it. ppReadRows treats a row with a name and nothing else as a
// section heading; ours carry a unit, so they are items.
const read = det.found ? P.ppReadRows(table, det) : { rows: [], headings: [] };

console.log("\n1. THE OFFICE'S OWN PARSER READS IT");
ok("1a", "it parses to a table at all", Array.isArray(table) && table.length > 1, `got ${table && table.length}`);
ok("1b", "every data row survives -- a mis-quoted inch mark swallows the rows after it",
  table.length === 49, `expected 49 (1 header + 48 items), got ${table.length}`);
ok("1c", "and every row has the three columns, so nothing slid sideways",
  table.every((r) => r.length === 3), `widths seen: ${[...new Set(table.map((r) => r.length))].join(",")}`);

console.log("\n2. IT FINDS THE COLUMNS, AND EXACTLY ONE PRICE");
ok("2a", "it recognises the sheet", det.found === true, JSON.stringify(det));
ok("2b", "Description is the name column", table[det.headerRow][det.name] === "Description",
  `name col = ${det.name}`);
ok("2c", "Price is found and NOT -1 -- which is what a second price column would cause",
  det.price >= 0 && table[det.headerRow][det.price] === "Price",
  `price col = ${det.price}, candidates ${JSON.stringify(det.priceCandidates)}`);
ok("2d", "Unit is recognised too, so the supplier's unit can be checked against mine",
  det.unit >= 0 && table[det.headerRow][det.unit] === "Unit", `unit col = ${det.unit}`);
ok("2e", "all 48 items read as ITEMS, none silently demoted to a section heading",
  read.rows.length === 48 && read.headings.length === 0,
  `rows ${read.rows.length}, headings ${read.headings.length}`);

console.log("\n3. THE INCH MARKS SURVIVE INTACT");
{
  const names = read.rows.map((r) => r.name);
  const inchy = names.filter((n) => n && n.includes('"'));
  ok("3a", "names with inch marks are present and still carry them",
    inchy.length >= 3, `found ${inchy.length}`);
  ok("3b", "and one of them is the corner post whose name has an inch mark AND a comma",
    names.includes('5"x5" Co-Ex Corner Post, White'),
    `closest: ${JSON.stringify(inchy.slice(0, 2))}`);
  // NOT "an even number of quotes": 7" SS Gate Handle legitimately has one.
  // That was the first version of this check and it failed on good data, which
  // is its own lesson -- a rule invented about the data rather than taken from
  // it. The real question is whether the name that comes back out is the name
  // that went in, because the importer matches on it character for character.
  // Self-contained on purpose: comparing against the live catalog would tie
  // this to a scratch file that does not exist on the CI runner, and a test
  // that cannot run is worse than one that checks a little less.
  //
  // A doubled quote in the OUTPUT means the parser handed back the CSV's own
  // escaping instead of resolving it, and a name that starts or ends with a
  // bare quote means a field boundary landed inside the text. Either way the
  // name no longer matches the catalog, which is the only thing it has to do.
  const mangled = names.filter((n) => n.includes('""') || /^"|"$/.test(n));
  ok("3c", "no name came back with the CSV's escaping still in it, or a quote at either end",
    mangled.length === 0, mangled.slice(0, 2).join(" | "));
}

console.log("\n4. IT ASKS FOR WHAT IT IS SUPPOSED TO ASK FOR");
{
  const names = read.rows.map((r) => r.name);
  ok("4a", "the 4 ft corner post -- the row he does not have -- is on the sheet",
    names.some((n) => /Corner Post, 5x5x72/.test(n)));
  ok("4b", "and it is marked as not-his-catalog, so the supplier names it rather than echoing mine",
    names.some((n) => /NOT IN MY CATALOG/.test(n)));
  ok("4c", "every Price cell is blank -- we are asking, not telling them our numbers",
    read.rows.every((r) => r.priceRaw === ""));
  ok("4d", "his own prices are nowhere in the file", !/16\.56|16\.75|18\.99/.test(csv));
}

console.log("\n5. CANARIES -- each proves a check above can fail");
{
  // A second price column is the documented failure: ppDetectColumns refuses
  // to guess and leaves price at -1.
  const two = csv.replace("Description,Unit,Price", "Description,Unit,List,Net");
  const d2 = P.ppDetectColumns(P.ppParseTable(two));
  ok("5a", "CANARY: two price columns really does leave price unresolved, which is what 2c guards",
    d2.price < 0 && d2.priceCandidates.length > 1,
    `price col ${d2.price}, candidates ${JSON.stringify(d2.priceCandidates)}`);

  // Break one escaped field and the row count must change -- proving 1b is
  // actually watching the thing it claims to watch.
  const broken = csv.replace('"5""x5"" Co-Ex Corner Post, White"', '5"x5" Co-Ex Corner Post, White');
  const t2 = P.ppParseTable(broken);
  ok("5b", "CANARY: un-escaping one inch-mark name changes what the parser sees, so 1b/1c have teeth",
    t2.length !== table.length || t2.some((r) => r.length !== 3),
    `rows ${t2.length} vs ${table.length}`);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
