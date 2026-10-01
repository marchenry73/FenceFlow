// Reading a supplier's price list: the part that decides whether a row of the
// file lands on the right item with the right price.
//
// Everything here runs the page's own functions (lifted out of
// website/dashboard.html by a27-pricelist-lib.mjs), not copies. The cases are the
// ones that would make a price silently wrong rather than visibly broken:
//   - an inch mark inside an item name opening a "quote" that swallows the next
//     rows (7" SS Gate Handle, 5"x5" post -- fence names are full of them);
//   - a tab-separated Excel paste whose item names contain commas;
//   - an .xlsx whose empty cells are left out, which slides every value one
//     column left if cells are counted instead of placed by their reference;
//   - two price columns (List and Net) and the wrong one being picked;
//   - "12,50" read as twelve hundred and fifty, or "call" read as zero;
//   - a PDF, an old .xls or a renamed web page being fed to a text parser.
//
// Run:  node tests/a27-pricelist-parse.test.mjs
import { load, makeXlsx, makeZip, runner } from "./a27-pricelist-lib.mjs";

const t = runner();
const P = load([
  "ppStripBom", "ppParseDelimited", "ppSniffDelimiter", "ppParseTable", "ppSniffKind", "ppDecodeText",
  "ppColIndex", "ppColLetter", "ppU16", "ppU32", "ppZipEntries", "ppZipRead", "ppXmlText", "ppXlsxSharedStrings",
  "ppXlsxSheetRows", "ppXlsxOpen", "ppXlsxSheet", "ppClassifyHeader", "ppDetectColumns", "ppReadRows", "ppParsePrice",
]);
const bytes = (...a) => new Uint8Array(a);
const BOM = String.fromCharCode(0xFEFF);

// ---------------------------------------------------------------- delimited text
console.log("\n-- delimited text");
t.eq("plain csv, quoted comma stays inside the cell",
  P.ppParseDelimited('Item,Price\n"Gate, 4ft wide",85\n', ","),
  [["Item", "Price"], ["Gate, 4ft wide", "85"]]);
{
  const rows = P.ppParseDelimited('Item,Price\n7" SS Gate Handle (box of 50),5.00\n5"x5" Co-Ex Line Post, White,16.56\nLatch,25.87\n', ",");
  t.eq("an inch mark in the middle of a cell does not open a quote",
    rows[1], ['7" SS Gate Handle (box of 50)', "5.00"]);
  t.eq("positive control: the row AFTER the inch marks is still its own row",
    rows[3], ["Latch", "25.87"]);
  t.eq("two inch marks and a comma inside one unquoted cell split on the comma, not the marks",
    rows[2], ['5"x5" Co-Ex Line Post', " White", "16.56"]);
}
t.eq("doubled quotes inside a quoted cell are one quote",
  P.ppParseDelimited('"7"" SS Gate Handle",5', ","), [['7" SS Gate Handle', "5"]]);
t.eq("CRLF line ends, a blank line and a byte-order mark",
  P.ppParseDelimited(BOM + "Item,Price\r\n\r\nPost,9.5\r\n", ","), [["Item", "Price"], ["Post", "9.5"]]);
t.eq("a quoted cell may hold a newline", P.ppParseDelimited('"two\nlines",3', ","), [["two\nlines", "3"]]);
t.eq("a space before the opening quote is tolerated", P.ppParseDelimited('Item, "Gate, wide",3', ","), [["Item", "Gate, wide", "3"]]);

// ---------------------------------------------------------------- which separator
console.log("\n-- separator");
t.eq("comma", P.ppSniffDelimiter("Item,Price\nPost,9\nCap,1\n"), ",");
t.eq("tab", P.ppSniffDelimiter("Item\tPrice\nPost\t9\nCap\t1\n"), "\t");
t.eq("semicolon", P.ppSniffDelimiter("Item;Price\nPost;9\nCap;1\n"), ";");
t.eq("pipe", P.ppSniffDelimiter("Item|Price\nPost|9\nCap|1\n"), "|");
t.eq("nothing to go on falls back to comma", P.ppSniffDelimiter("just one column\nof words\n"), ",");
{
  const paste = 'Description\tPrice\n5"x5" Co-Ex Line Post, White\t16.56\n"Gate, 5ft, white"\t145.05\nHinge Set, 12 pairs\t32.25\n';
  t.eq("a tab-separated paste whose item names hold commas is read as tab-separated", P.ppSniffDelimiter(paste), "\t");
  t.eq("and comes out as two columns per row, names intact",
    P.ppParseTable(paste), [["Description", "Price"], ['5"x5" Co-Ex Line Post, White', "16.56"], ["Gate, 5ft, white", "145.05"], ["Hinge Set, 12 pairs", "32.25"]]);
}

// ---------------------------------------------------------------- what kind of file
console.log("\n-- what the bytes are, not what the name says");
t.eq("PDF", P.ppSniffKind(new TextEncoder().encode("%PDF-1.7\n...")), "pdf");
t.eq("old .xls / encrypted xlsx (OLE container)", P.ppSniffKind(bytes(0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0)), "ole");
t.eq("zip (an .xlsx)", P.ppSniffKind(bytes(0x50, 0x4B, 3, 4, 0, 0)), "zip");
t.eq("UTF-16 text with a byte-order mark is text, zero bytes and all", P.ppSniffKind(bytes(0xFF, 0xFE, 0x49, 0, 0x74, 0)), "text");
t.eq("a file with zero bytes and no byte-order mark is not text", P.ppSniffKind(bytes(0x41, 0, 0x42, 0)), "other");
t.eq("a web page saved as .xls is not a spreadsheet", P.ppSniffKind(new TextEncoder().encode("  \n<html><table>")), "other");
t.eq("an .xml 2003 spreadsheet is not read as csv", P.ppSniffKind(new TextEncoder().encode("<?xml version='1.0'?><Workbook>")), "other");
t.eq("ordinary csv", P.ppSniffKind(new TextEncoder().encode("Item,Price\nPost,9\n")), "text");
t.eq("csv with a UTF-8 byte-order mark", P.ppSniffKind(bytes(0xEF, 0xBB, 0xBF, 0x49, 0x74)), "text");

console.log("\n-- text decoding");
t.eq("utf-8", P.ppDecodeText(new TextEncoder().encode("Café 5½")), "Café 5½");
t.eq("Excel's Windows 'CSV' is windows-1252: a lone 0xE9 is e-acute, not a replacement character",
  P.ppDecodeText(bytes(0x43, 0x61, 0x66, 0xE9)), "Café");
t.eq("UTF-16 little-endian with a byte-order mark (Excel 'Unicode Text')",
  P.ppDecodeText(bytes(0xFF, 0xFE, 0x49, 0, 0x74, 0, 0x65, 0, 0x6D, 0)), "Item");
t.eq("UTF-16 big-endian with a byte-order mark",
  P.ppDecodeText(bytes(0xFE, 0xFF, 0, 0x49, 0, 0x74, 0, 0x65, 0, 0x6D)), "Item");

// ---------------------------------------------------------------- which column is which
console.log("\n-- header classification");
for (const [h, want] of [
  ["Item Description", "name"], ["Description", "name"], ["Product Name", "name"], ["Item", "name"], ["Material", "name"],
  ["Item #", "sku"], ["Part Number", "sku"], ["Part #", "sku"], ["SKU", "sku"], ["Vendor SKU", "sku"], ["Mfr Part No.", "sku"], ["UPC", "sku"], ["Product Code", "sku"],
  ["Price", "price"], ["Unit Price", "price"], ["Net Price", "price"], ["List Price", "price"], ["Contractor Price", "price"],
  ["Cost", "price"], ["Unit Cost", "price"], ["MSRP", "price"], ["Cost ($)", "price"], ["Net", "price"],
  ["Unit", "unit"], ["UOM", "unit"], ["U/M", "unit"], ["Unit of Measure", "unit"],
  ["Extended Price", ""], ["Qty", ""], ["Previous Price", ""], ["Old Price", ""], ["Price Change %", ""], ["Total", ""], ["Color", ""], ["Category", ""], ["", ""],
]) t.eq(`"${h}" is ${want || "nothing we use"}`, P.ppClassifyHeader(h), want);

console.log("\n-- finding the header row and the columns");
{
  const table = [
    ["ACME FENCE SUPPLY - 2026 PRICE LIST"], ["Effective 10/1/2026"], [],
    ["Item #", "Description", "Unit", "Price"],
    ["VP-6W", "6' Vinyl Panel, White", "EA", "52.35"],
  ].filter((r) => r.length);
  const d = P.ppDetectColumns(table);
  t.eq("a title and a date above the header are skipped", [d.found, d.headerRow], [true, 2]);
  t.eq("item # is the part number and description is the name", [d.sku, d.name, d.unit, d.price], [0, 1, 2, 3]);
}
{
  const d = P.ppDetectColumns([["Description", "List Price", "Contractor Price", "Net"], ["Post", "20", "16", "14"]]);
  t.eq("three price columns: price is NOT guessed", [d.found, d.price, d.priceCandidates], [true, -1, [1, 2, 3]]);
}
{
  const d = P.ppDetectColumns([["Description", "Previous Price", "New Price"], ["Post", "9", "10"]]);
  t.eq("a Previous Price column is not a price candidate; New Price is picked", [d.price, d.priceCandidates], [2, [2]]);
}
t.eq("no recognisable header: found is false and nothing is chosen",
  (({ found, name, price }) => [found, name, price])(P.ppDetectColumns([["a", "b"], ["1", "2"]])), [false, -1, -1]);
{
  // the real "Fencing Cost Calculator.xlsx" header, as the by-hand run over that file showed it
  const d = P.ppDetectColumns([["Fencing Material", "Use", "Price Range", "Unit", "Your Price", "Your Amount Needed", "Your Cost Estimate"], ["47\" Field Fence", "x", "$0.45-0.61", "Linear foot", "", "", "0"]]);
  t.eq("a real consumer worksheet with Price Range / Your Price / Cost Estimate asks rather than guesses", [d.found, d.price, d.priceCandidates.length], [true, -1, 3]);
}

console.log("\n-- reading the rows under the header");
{
  const table = [
    ["Item", "Price", "Unit"],
    ["VINYL"],                                  // a section heading
    ["6' Panel", "52.35", "EA"],
    ["", "", ""],
    ["Gate Hinge", "call", "SET"],              // a real item with no usable price
    ["Item", "Price", "Unit"],                  // a header repeated by a page break
    ["Latch", "", ""],                          // a name and nothing else: a heading by our rule
    ["Brace", "", "EA"],                        // a name and a unit but no price: an item, not a heading
  ];
  const { rows, headings } = P.ppReadRows(table, { headerRow: 0, name: 0, price: 1, sku: -1, unit: 2 });
  t.eq("headings are returned, not dropped", headings, ["VINYL", "Latch"]);
  t.eq("blank rows vanish; every other row is kept",
    rows.map((r) => r.name), ["6' Panel", "Gate Hinge", "Item", "Brace"]);
  t.eq("a repeated header row stays in as a row whose price is unreadable, so it is reported rather than hidden",
    P.ppParsePrice(rows[2].priceRaw).ok, false);
}

console.log("\n-- reading a price");
for (const [raw, ok, value, why] of [
  ["52.35", true, 52.35], ["$1,234.50", true, 1234.5], ["12", true, 12], [".5", true, 0.5], ["0.145", true, 0.145],
  [" $ 9.00 ", true, 9], ["USD 7.25", true, 7.25], [3.5, true, 3.5], ["12.340000000000002", true, 12.34], [1.1 + 2.2, true, 3.3],
  ["", false, null, "blank"], ["call", false, null, "bad"], ["TBD", false, null, "bad"], ["12,50", false, null, "bad"],
  ["1.234,50", false, null, "bad"], ["$0.45-0.61", false, null, "bad"], ["(5.00)", false, null, "bad"], ["-3", false, null, "bad"],
  ["0", false, null, "zero"], ["0.00", false, null, "zero"], [0, false, null, "zero"], ["12.50 /ea", false, null, "bad"], ["N/A", false, null, "bad"],
  ["9999999", false, null, "bad"], [NaN, false, null, "bad"],
]) {
  const r = P.ppParsePrice(raw);
  t.ok(`price ${JSON.stringify(raw)} -> ${ok ? value : "refused (" + why + ")"}`,
    r.ok === ok && (ok ? Math.abs(r.value - value) < 1e-9 : r.why === why), JSON.stringify(r));
}

// ---------------------------------------------------------------- Excel
console.log("\n-- .xlsx without a library");
const C = (ref, v, extra = "") => `<c r="${ref}"${extra}><v>${v}</v></c>`;
const S = (ref, ix) => C(ref, ix, ' t="s"');
const I = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const shared = [
  "<si><t>Item Description</t></si>",                                              // 0
  "<si><t>Part #</t></si>",                                                       // 1
  "<si><t>Unit</t></si>",                                                         // 2
  "<si><t>Net Price</t></si>",                                                    // 3
  "<si><r><rPr><b/></rPr><t xml:space=\"preserve\">6' Vinyl </t></r><r><t>Panel, White</t></r><rPh sb=\"0\" eb=\"1\"><t>IGNORED</t></rPh></si>", // 4 rich text
  "<si><t>VINYL</t></si>",                                                        // 5
  "<si><t>7&quot; SS Gate Handle &amp; Latch</t></si>",                           // 6
  "<si><t>EA</t></si>",                                                           // 7
  "<si/>",                                                                        // 8 empty
  "<si><t>Second sheet item</t></si>",                                            // 9
].join("");
const sheet1 = [
  `<row r="1">${I("A1", "ACME FENCE SUPPLY")}</row>`,
  `<row r="2">${I("A2", "Effective 10/1/2026")}</row>`,
  `<row r="4">${S("A4", 0)}${S("B4", 1)}${S("C4", 2)}${S("D4", 3)}</row>`,
  `<row r="5">${S("A5", 5)}</row>`,
  // C6 is simply absent: Excel omits empty cells, and D6 is still column D
  `<row r="6">${S("A6", 4)}${I("B6", "VP-6W")}${C("D6", "52.35", ' s="2"')}</row>`,
  `<row r="7" hidden="1">${I("A7", "OLD DISCONTINUED ITEM")}${C("D7", "9.99")}</row>`,
  `<row r="8">${S("A8", 6)}<c r="B8" s="1"/>${S("C8", 7)}<c r="D8"><f>1.25+1.25</f><v>2.5</v></c></row>`,
  `<row r="9">${I("A9", "Line_x000D_Break")}${I("B9", "LB-1")}${S("C9", 8)}${C("D9", "4")}</row>`,
  `<row r="10"><c r="A10"/><c r="B10" s="3"/></row>`,                                // all empty: dropped
].join("");
const sheet2 = `<row r="1">${S("A1", 9)}${C("B1", "7")}</row>`;
const book = makeXlsx({ sharedXml: shared, sheets: [
  { name: "Price List", xml: sheet1 },
  { name: "Old Prices", state: "hidden", xml: sheet2 },
] });
{
  const wb = await P.ppXlsxOpen(book);
  t.eq("sheet names and visibility are read", wb.sheets.map((s) => [s.name, s.state]), [["Price List", "visible"], ["Old Prices", "hidden"]]);
  t.eq("shared strings: rich-text runs are joined and the phonetic run is dropped", wb.shared[4], "6' Vinyl Panel, White");
  t.eq("entities are decoded", wb.shared[6], '7" SS Gate Handle & Latch');
  t.eq("an empty <si/> is an empty string, and does not swallow its neighbour", [wb.shared[8], wb.shared[9]], ["", "Second sheet item"]);
  const sh = await P.ppXlsxSheet(wb, 0);
  t.eq("hidden rows are skipped and counted", sh.hidden, 1);
  t.ok("the discontinued item in the hidden row is not in the data", !JSON.stringify(sh.rows).includes("DISCONTINUED"));
  t.eq("a cell the file leaves out does not slide the price into the wrong column",
    sh.rows.find((r) => r[0] === "6' Vinyl Panel, White"), ["6' Vinyl Panel, White", "VP-6W", "", "52.35"]);
  t.eq("a formula cell gives the value Excel last calculated; a self-closing styled cell is empty",
    sh.rows.find((r) => r[0].startsWith("7\"")), ['7" SS Gate Handle & Latch', "", "EA", "2.5"]);
  t.eq("an escaped carriage return is decoded", sh.rows.find((r) => r[1] === "LB-1")[0], "Line\rBreak");
  t.eq("a row of only empty cells is dropped (7 data rows + 0)", sh.rows.length, 7);
  const d = P.ppDetectColumns(sh.rows);
  t.eq("header found on the real row 4 even with title rows above it", [d.found, d.headerRow, d.name, d.sku, d.unit, d.price], [true, 2, 0, 1, 2, 3]);
  const { rows, headings } = P.ppReadRows(sh.rows, d);
  t.eq("a section heading is a heading, not an item", headings, ["VINYL"]);
  t.eq("end to end: names and prices line up",
    rows.map((r) => [r.name, P.ppParsePrice(r.priceRaw).value]),
    [["6' Vinyl Panel, White", 52.35], ['7" SS Gate Handle & Latch', 2.5], ["Line\rBreak", 4]]);
  const sh2 = await P.ppXlsxSheet(wb, 1);
  t.eq("the second sheet reads as its own table", sh2.rows, [["Second sheet item", "7"]]);
}
{
  const stored = makeXlsx({ sharedXml: shared, sheets: [{ name: "P", xml: sheet1 }], deflate: false });
  const wb = await P.ppXlsxOpen(stored);
  const sh = await P.ppXlsxSheet(wb, 0);
  t.eq("zip entries stored without compression read the same", sh.rows.length, 7);
  const abs = await P.ppXlsxOpen(makeXlsx({ sharedXml: shared, sheets: [{ name: "P", xml: sheet1 }], absoluteTargets: true }));
  t.eq("workbook relationships written as absolute paths still find the sheet", (await P.ppXlsxSheet(abs, 0)).rows.length, 7);
}
{
  const noShared = makeXlsx({ sheets: [{ name: "P", xml: `<row r="1">${I("A1", "x")}${C("B1", "5")}</row>` }] });
  const wb = await P.ppXlsxOpen(noShared);
  t.eq("a workbook with no shared-strings part (all inline) opens", (await P.ppXlsxSheet(wb, 0)).rows, [["x", "5"]]);
}

console.log("\n-- files that must be refused, loudly");
async function throwsWith(label, fn, want) {
  let got = null;
  try { await fn(); } catch (e) { got = String(e.message); }
  t.ok(label, got !== null && got.includes(want), `threw ${JSON.stringify(got)}, wanted something containing ${JSON.stringify(want)}`);
}
await throwsWith("bytes that are not a zip at all", () => P.ppXlsxOpen(new TextEncoder().encode("Item,Price\nPost,9\n".repeat(5))), "not a zip file");
await throwsWith("a zip that is not a workbook (a .docx, say)",
  () => P.ppXlsxOpen(makeZip([{ name: "word/document.xml", data: "<w/>" }])), "not an Excel workbook");
await throwsWith("an encrypted zip entry", async () => {
  const z = makeZip([{ name: "xl/workbook.xml", data: "<workbook/>", flags: 1 }]);
  await P.ppXlsxOpen(z);
}, "encrypted");
await throwsWith("a workbook with no worksheets",
  () => P.ppXlsxOpen(makeXlsx({ sheets: [] })), "no worksheets");
await throwsWith("a file cut short", () => P.ppXlsxOpen(book.subarray(0, Math.floor(book.length / 2))), "");
{
  const z = makeZip([{ name: "big.xml", data: "A".repeat(100) }]);
  const ent = P.ppZipEntries(z)["big.xml"];
  await throwsWith("a part larger than the cap is refused before it is inflated", () => P.ppZipRead(z, ent, 10), "part too large");
  // A zip bomb tells the truth in nobody's header: declare 5 bytes, deliver a megabyte.
  const bomb = Buffer.from(makeZip([{ name: "bomb.xml", data: Buffer.alloc(1024 * 1024, 0x41) }]));
  const cd = bomb.indexOf(Buffer.from([0x50, 0x4B, 0x01, 0x02]));
  bomb.writeUInt32LE(5, cd + 24);
  const be = P.ppZipEntries(new Uint8Array(bomb))["bomb.xml"];
  t.eq("positive control: the bomb's header does claim 5 bytes", be.usize, 5);
  await throwsWith("an entry that inflates past the cap is stopped while inflating, whatever its header says",
    () => P.ppZipRead(new Uint8Array(bomb), be, 1000), "part too large");
}
{
  const saved = globalThis.DecompressionStream;
  globalThis.DecompressionStream = undefined;
  try { await throwsWith("a browser with no DecompressionStream says so in a way the page can act on", () => P.ppXlsxOpen(book), "no-decompression"); }
  finally { globalThis.DecompressionStream = saved; }
  t.ok("positive control: with DecompressionStream back, the same file opens", (await P.ppXlsxOpen(book)).sheets.length === 2);
}

t.eq("column letters round trip", [0, 1, 25, 26, 27, 701, 702].map((i) => P.ppColIndex(P.ppColLetter(i))), [0, 1, 25, 26, 27, 701, 702]);
t.eq("AA is 26 and Z is 25", [P.ppColIndex("AA"), P.ppColIndex("Z")], [26, 25]);

t.done();
