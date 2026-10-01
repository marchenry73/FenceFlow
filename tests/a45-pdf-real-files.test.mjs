// Reading the three real supplier PDFs into the price-list preview.
//
// The files are the ones the owner was actually sent (Flori Fence 17827 and 17828, Hartford Fence
// Supply 64792). The numbers asserted are the ones SUPPLIER_QUOTES_2026-10-01.md reads off them.
// Everything runs the page's own functions, lifted out of website/dashboard.html (see
// a27-pricelist-lib.mjs), and PDF.js is the very build the page will fetch: its SHA-384 is checked
// against the fingerprint written into the page before a single PDF is read.
//
// The dangerous choice here is RATE against AMOUNT. A line reads "16  54.15  866.40": 54.15 is the
// unit price, and importing 866.40 would multiply his material cost by the quantity on every future
// quote, silently. So each price is asserted alongside the amount it must not be, and the whole group
// of checks is run against a copy of the page with a guard removed, to prove it can fail.
//
// Run:  node tests/a45-pdf-real-files.test.mjs
//       A45_PDF_DIR=<folder holding the PDFs>  A45_PDFJS_DIR=<node_modules/pdfjs-dist/build>
import { src, realPdf, loadPdfJs, loadPdfFns, pdfDialog, makeTr, grabConstLine, loadTL, runner } from "./a27-pricelist-lib.mjs";

const t = runner();
const esc = new Function(grabConstLine("esc") + "; return esc;")();
const J = await loadPdfJs();
const P = loadPdfFns();

console.log("\n-- the reader under test is the build the page will fetch");
t.eq("PDF.js on disk is the version the page pins", J.lib.version, "4.6.82");
t.ok("the main file hashes to the fingerprint written into the page", J.got.lib === J.want.lib, J.got.lib + " vs " + J.want.lib);
t.ok("the worker file hashes to the fingerprint written into the page", J.got.worker === J.want.worker, J.got.worker + " vs " + J.want.worker);
t.ok("positive control: the two fingerprints are different from each other, so equality above is not vacuous", J.want.lib !== J.want.worker);

// Reads a real PDF the way the dialog does, up to the rows the plan is built from.
const read = async (key) => {
  const r = await P.ppPdfRead(realPdf(key), J.lib);
  if (!r.ok) throw new Error(key + " was refused: " + JSON.stringify(r));
  return r;
};
const flori6 = await read("flori6"), flori4 = await read("flori4"), hartford = await read("hartford");

// Exactly one row whose name matches, optionally on one page; anything else is a failure of the check.
const only = (r, re, page) => {
  const hits = r.rows.filter((x) => re.test(x.name) && (page === undefined || x.page === page));
  if (hits.length !== 1) throw new Error(`${re} matched ${hits.length} rows, expected exactly 1: ${hits.map((h) => h.name).join(" | ")}`);
  return hits[0];
};
const num = (s) => Number(String(s).replace(/,/g, ""));

// [name pattern, page or undefined, quantity, the unit price AS PRINTED, what the importer will hold]
// Hartford prints two unit costs to five places (54.99875 is 879.98 / 16). The page keeps six places, so they are
// held exactly as printed (SUPPLIER_QUOTES rounds the first to 55.00, and the catalog now holds the exact figure).
const FLORI6 = [
  [/^PANEL T&G WHITE PVC 6'H X 6'W$/, 1, 16, "54.15", 54.15],
  [/\(EA\) LINE$/, 1, 14, "16.56", 16.56], [/\(EA\) END$/, 1, 2, "16.56", 16.56], [/\(EA\) BLANK$/, 1, 2, "16.56", 16.56],
  [/PYRAMID PVC POST CAP/, 1, 18, "0.78", 0.78], [/^REGULAR WHITE PVC GATE 6Hx5W$/, 1, 1, "120.66", 120.66],
  [/ECONO STIFFENER/, 1, 1, "52.75", 52.75], [/^Gate Support Brace/, 1, 1, "6.90", 6.9], [/TRIM U CHANNEL/, 1, 2, "2.00", 2],
  [/SELF CLOSING HINGE/, 1, 1, "32.25", 32.25], [/TWO WAY LATCH/, 1, 1, "25.87", 25.87], [/GATE HANDLE/, 1, 1, "5.00", 5],
];
const FLORI4 = [
  [/^PANEL MELROSE FLAT TOP 2-RAILS 4H X 6W WHITE$/, 1, 16, "61.74", 61.74],
  [/\(EA\) LINE$/, 1, 14, "13.18", 13.18], [/\(EA\) END$/, 1, 2, "13.18", 13.18], [/\(EA\) BLANK$/, 1, 2, "13.18", 13.18],
  [/PYRAMID PVC POST CAP/, 1, 18, "0.78", 0.78], [/^GATE MELROSE FLAT TOP 4'HX5'W \(WHITE\)$/, 1, 1, "170.00", 170],
  [/ECONO STIFFENER/, 1, 1, "52.75", 52.75], [/^Gate Support Brace/, 1, 1, "6.90", 6.9], [/TRIM U CHANNEL/, 1, 2, "2.00", 2],
  [/SELF CLOSING HINGE/, 1, 1, "32.25", 32.25], [/TWO WAY LATCH/, 1, 1, "25.87", 25.87], [/GATE HANDLE/, 1, 1, "5.00", 5],
];
const HARTFORD = [
  [/^6X6 HFS PRO SERIES PRIVACY PANEL WHITE$/, 1, 16, "54.99875", 54.99875],
  [/^HFS 59" U CHANNEL WHITE$/, 1, 2, "2.99", 2.99],
  [/LINE POST WHITE 1\.75 6' PRIVACY$/, 1, 14, "18.99929", 18.99929], [/BLANK POST WHITE 6' PRIVACY$/, 1, 2, "19.00", 19],
  [/END POST WHITE 1\.75 6' PRIVACY$/, 1, 2, "19.00", 19],
  [/PYRAMID POST CAP/, 1, 18, "1.65", 1.65], [/ECONO STIFFENER/, 1, 1, "50.00", 50],
  [/WALK GATE KIT/, 2, 1, "149.99", 149.99], [/SS-POST LATCH/, 2, 1, "26.75", 26.75], [/SELF CLOSING HINGE/, 2, 1, "37.45", 37.45],
  [/NYLON GATE HANDLE/, 2, 1, "6.50", 6.5],
  [/CLEARWATER PRO SERIES PICKET PANEL/, 2, 16, "71.50", 71.5],
  [/LINE POST WHITE 4' CLOSED TOP$/, 3, 14, "16.75", 16.75], [/END POST WHITE 4' CLOSED TOP$/, 3, 2, "16.75", 16.75],
  [/BLANK POST WHITE$/, 3, 2, "16.75", 16.75], [/PYRAMID POST CAP/, 3, 18, "1.65", 1.65], [/ECONO STIFFENER/, 3, 1, "50.00", 50],
  [/CLEARWATER 4Hx5W CLOSED TOP GATE/, 3, 1, "113.75", 113.75], [/V-Brace/, 3, 1, "19.99", 19.99],
  [/U CHANNEL WHITE$/, 3, 1, "2.99", 2.99], [/SS-POST LATCH/, 3, 1, "26.75", 26.75], [/SELF CLOSING HINGE/, 3, 1, "37.45", 37.45],
  [/NYLON GATE HANDLE/, 3, 1, "6.50", 6.5],
];

console.log("\n-- every priced line is found, with the unit price printed on it");
for (const [label, r, table, count] of [["Flori 6 ft (17827)", flori6, FLORI6, 12], ["Flori 4 ft (17828)", flori4, FLORI4, 12], ["Hartford (64792)", hartford, HARTFORD, 23]]) {
  t.eq(`${label}: ${count} item lines are found`, r.rows.length, count);
  t.eq(`${label}: the table below lists every one of them (so no line is unchecked)`, table.length, count);
  for (const [re, page, qty, printed, held] of table) {
    const row = only(r, re, page);
    const plan = P.ppPdfRowsForPlan(r).rows.find((x) => x === x && x.name === row.name && x.page === row.page);
    t.eq(`${label}: ${row.name.slice(0, 54)} -- unit price as printed`, [row.priceRaw, row.qty, row.why], [printed, String(qty), ""]);
    t.eq(`${label}: ${row.name.slice(0, 54)} -- price the importer will hold`, plan.price, held);
  }
}
t.eq("Flori 6 ft panel is 54.15", P.ppPdfRowsForPlan(flori6).rows.find((x) => /^PANEL T&G/.test(x.name)).price, 54.15);
t.eq("Flori 4 ft panel is 61.74", P.ppPdfRowsForPlan(flori4).rows.find((x) => /^PANEL MELROSE/.test(x.name)).price, 61.74);
t.eq("Hartford Clearwater 4 ft panel is 71.50", P.ppPdfRowsForPlan(hartford).rows.find((x) => /CLEARWATER PRO SERIES PICKET PANEL/.test(x.name)).price, 71.5);
t.eq("Hartford 4 ft gate is 113.75", P.ppPdfRowsForPlan(hartford).rows.find((x) => /CLEARWATER 4Hx5W CLOSED TOP GATE/.test(x.name)).price, 113.75);

console.log("\n-- the unit price is the RATE, never the AMOUNT");
// The same checks as a function, so they can be run against a copy of the page with a guard removed.
const rateNotAmount = (rd, label) => {
  const rows = rd.rows.filter((x) => num(x.qty) > 1);
  const bad = rows.filter((x) => !(x.priceRaw && num(x.priceRaw) !== num(x.amountRaw) && Math.abs(num(x.qty) * num(x.priceRaw) - num(x.amountRaw)) <= 0.005 * num(x.qty) + 0.0051));
  return { label, multi: rows.length, bad: bad.map((x) => `${x.name}: price ${x.priceRaw}, amount ${x.amountRaw}`) };
};
for (const [label, r] of [["Flori 6 ft", flori6], ["Flori 4 ft", flori4], ["Hartford", hartford]]) {
  const c = rateNotAmount(r, label);
  t.ok(`${label}: ${c.multi} lines have a quantity above 1, so the check has something to bite on`, c.multi >= 6, String(c.multi));
  t.eq(`${label}: on every one the price is not the amount, and quantity x price is the amount`, c.bad, []);
}
{
  const rows = P.ppPdfRowsForPlan(flori6).rows;
  const panel = rows.find((x) => /^PANEL T&G/.test(x.name));
  t.ok("Flori panel: 54.15 is taken and 866.40 is not", panel.price === 54.15 && panel.price !== 866.4);
  const h = P.ppPdfRowsForPlan(hartford).rows.find((x) => /CLEARWATER PRO SERIES PICKET PANEL/.test(x.name));
  t.ok("Hartford Clearwater panel: 71.50 is taken and 1,144.00 is not", h.price === 71.5 && h.price !== 1144);
  // Control: the check is able to see a wrong answer. Hand it a row that took the amount.
  const wrong = { rows: [{ name: "x", qty: "16", priceRaw: "866.40", amountRaw: "866.40" }] };
  t.eq("control: a row that took the amount as the price IS reported by the check", rateNotAmount(wrong, "x").bad.length, 1);
  const right = { rows: [{ name: "x", qty: "16", priceRaw: "54.15", amountRaw: "866.40" }] };
  t.eq("control: and the right row is not", rateNotAmount(right, "x").bad.length, 0);
}
{
  // Mutants: the same checks, run on copies of the page with a guard taken out. Each edit is made to a copy,
  // never to the page. Swapping the roles of the Rate and Amount columns is exactly the bug this feature
  // must never have: it makes the AMOUNT the unit price.
  const edit = (text, from, to) => { if (!text.includes(from)) throw new Error("mutation anchor missing: " + from); return text.split(from).join(to); };
  const ORDER = "if(k === m) return { ok: true, roles: cols.map(c => c.role) };";
  const SWAPPED = "if(k === m) return { ok: true, roles: cols.map(c => c.role === 'price' ? 'amount' : c.role === 'amount' ? 'price' : c.role) };";
  const RELATION = "return Math.abs(q * r - a) <= 0.005 * q + 0.0051 ? { ok: true, product } : { ok: false, why: 'pdfrel', product };";
  const readWith = (text) => loadPdfFns([], {}, text).ppPdfRead(realPdf("flori6"), J.lib);

  const swappedOnly = await readWith(edit(src, ORDER, SWAPPED));
  const sc1 = rateNotAmount(swappedOnly, "swapped");
  t.ok("mutant: Rate and Amount roles swapped, relation check still on -> the check is red (lines come out unreadable)", sc1.bad.length > 0, JSON.stringify(sc1));
  t.ok("and even so the amount is never imported as a price: the relation check refused those lines instead",
    P.ppPdfRowsForPlan(swappedOnly).rows.every((x) => x.price === null || num(x.qty) === 1)
    && !P.ppPdfRowsForPlan(swappedOnly).rows.some((x) => x.price === 866.4), "relation check is the second lock");

  const swappedNoCheck = await readWith(edit(edit(src, ORDER, SWAPPED), RELATION, "return { ok: true, product };"));
  const sc2 = rateNotAmount(swappedNoCheck, "swapped, unchecked");
  t.ok("mutant: roles swapped AND the relation check removed -> 866.40 IS imported as the panel's price", P.ppPdfRowsForPlan(swappedNoCheck).rows.some((x) => x.price === 866.4));
  t.ok("and the rate-not-amount check goes red on it", sc2.bad.length > 0, JSON.stringify(sc2));

  const noCheckOnly = await readWith(edit(src, RELATION, "return { ok: true, product };"));
  t.eq("positive control: with only the relation check removed the heading still picks the Rate column, so these twelve prices stay right",
    [rateNotAmount(noCheckOnly, "x").bad, P.ppPdfRowsForPlan(noCheckOnly).rows.find((x) => /^PANEL T&G/.test(x.name)).price], [[], 54.15]);
}

console.log("\n-- what is not an item is not an item");
t.ok("Hartford: the sub-headings ***6' Privacy*** and ***4' Closed Top*** are headings, with the stars removed",
  hartford.headings.includes("6' Privacy") && hartford.headings.includes("4' Closed Top"), JSON.stringify(hartford.headings));
t.ok("and neither is in any item's name", !hartford.rows.some((r) => /Privacy\*|\*|Closed Top\*/.test(r.name) || r.name === "6' Privacy" || r.name === "4' Closed Top"));
t.eq("Flori 6 ft: SUBTOTAL, TAX and TOTAL are totals, not items", flori6.totals.map((x) => x.split(" ")[0]), ["SUBTOTAL", "TAX", "TOTAL"]);
t.ok("none of them became a row", !flori6.rows.some((r) => /SUBTOTAL|^TAX|^TOTAL/.test(r.name)));
t.eq("Hartford: the tax line and the total are totals", hartford.totals.length, 2);
t.ok("Flori: the paragraph of terms above the first item is text, not an item", flori6.headings.some((x) => /Dear Valued Customer/.test(x)) && !flori6.rows.some((r) => /Dear Valued/.test(r.name)));
t.ok("positive control: the first real item is still found after that paragraph", flori6.rows[0].name.startsWith("PANEL T&G WHITE"));

console.log("\n-- a description that wraps is one item, and the price is on its first line");
{
  const wrapped = only(hartford, /CLEARWATER PRO SERIES PICKET PANEL/, 2);
  t.eq("Hartford 4 ft panel is three lines of description joined", wrapped.name, '4X6 HFS CLOSED TOP CLEARWATER PRO SERIES PICKET PANEL WHITE - 7/8" x 3" PICKETS, 3" SPACING');
  t.eq("two of them are kept as the wrapped lines, for the preview to show", wrapped.contText.length, 2);
  t.eq("and it has one price, 71.50, from the first line", [wrapped.priceRaw, wrapped.qty], ["71.50", "16"]);
  const kit = only(hartford, /WALK GATE KIT/, 2);
  t.eq("the gate kit is the three lines that wrap, and not the kit contents listed after a blank line",
    kit.name, `6' HFS 1.75 RAIL WHITE PRIVACY WALK GATE KIT WITH P-CHANNEL STIFFENERS - UP TO 70" WIDE`);
  t.ok("those contents are listed as text with no price instead", hartford.headings.includes("GATE KIT INCLUDES:") && hartford.headings.some((x) => /20 RIVETS/.test(x)));
  const flori = only(flori6, /\(EA\) END$/);
  t.eq("Flori: the line, END and BLANK posts have the same first line and are three different items",
    [only(flori6, /\(EA\) LINE$/).name, flori.name, only(flori6, /\(EA\) BLANK$/).name],
    ['5" X 5" CO-EX UTL WHITE 8.5 PLT-81 (EA) LINE', '5" X 5" CO-EX UTL WHITE 8.5 PLT-81 (EA) END', '5" X 5" CO-EX UTL WHITE 8.5 PLT-81 (EA) BLANK']);
}

console.log("\n-- a table over three pages, its heading repeated on each");
t.eq("Hartford: rows come from all three pages", [...new Set(hartford.rows.map((r) => r.page))], [1, 2, 3]);
t.eq("per page: 7, 5, 11", [1, 2, 3].map((p) => hartford.rows.filter((r) => r.page === p).length), [7, 5, 11]);
t.ok("every row was read under a heading naming the price column Cost", hartford.rows.every((r) => r.how === "header" && r.priceLabel === "Cost"));
t.ok("Flori: every row was read under the heading RATE", flori6.rows.every((r) => r.how === "header" && r.priceLabel === "RATE"));
t.ok("Flori's second page has no heading and no items, and is not counted as unread", flori6.pages === 2 && flori6.pagesUnread === 0);
t.ok("Hartford part numbers are kept (30502-W) and the two the supplier cut short are not saved", only(hartford, /^6X6 HFS PRO SERIES PRIVACY PANEL WHITE$/).sku === "30502-W"
  && only(hartford, /WALK GATE KIT/, 2).sku === "" && only(hartford, /PYRAMID POST CAP/, 1).sku === "");
t.ok("the unit the supplier printed is carried (ea)", hartford.rows.every((r) => r.unitRaw === "ea"));
{
  // Hartford prints 30509-W-B against the line, the end AND the blank 4 ft post: three different items. A part
  // number that names three things names none, so it is not offered to be saved as a key for any of them.
  const posts = hartford.rows.filter((r) => /5X5X72 HFS (LINE|END|BLANK) POST/.test(r.name));
  t.eq("the three 4 ft posts share a printed part number and each is read with NO part number", [posts.length, posts.map((r) => r.sku)], [3, ["", "", ""]]);
  t.ok("control: a part number repeated on lines that ARE the same item (51000-ECO-8, pages 1 and 3) is kept",
    hartford.rows.filter((r) => /ECONO STIFFENER/.test(r.name)).every((r) => r.sku === "51000-ECO-8"));
  t.ok("control: and 50103-BLK, the same latch on pages 2 and 3, is kept", hartford.rows.filter((r) => /SS-POST LATCH/.test(r.name)).every((r) => r.sku === "50103-BLK"));
  const skus = hartford.rows.map((r) => r.sku).filter(Boolean);
  t.eq("what is left is a short list of distinct, real part numbers", [skus.length > 0, skus.every((s) => !/\.\.\.$/.test(s)), skus.includes("30509-W-B")], [true, true, false]);
}

console.log("\n-- nothing is dropped: the lines read add up to what the PDF says its lines come to");
{
  const cents = (r) => r.rows.reduce((n, x) => n + Math.round(num(x.amountRaw) * 100), 0);
  t.eq("Flori 6 ft: 12 line totals sum to the printed subtotal 1,425.95", cents(flori6), 142595);
  t.eq("Flori 4 ft: 12 line totals sum to the printed subtotal 1,535.89", cents(flori4), 153589);
  t.eq("Hartford: 23 line totals sum to the printed total less tax, 3,505.54 - 244.57 = 3,260.97", cents(hartford), 326097);
  t.eq("the page reaches the same verdict on its own", [flori6, flori4, hartford].map((r) => r.recon && r.recon.agree), [true, true, true]);
  t.eq("and says where the figure came from", [flori6.recon.how, hartford.recon.how], ["subtotal", "total-minus-tax"]);
  const lines = [{ text: "SUBTOTAL 1,425.95", nums: [{ v: 1425.95 }] }];
  t.eq("control: with all twelve rows the check agrees", P.ppPdfReconcile(flori6.rows, lines).agree, true);
  t.eq("control: with one row dropped it does not", P.ppPdfReconcile(flori6.rows.slice(1), lines).agree, false);
  t.eq("control: and it reports what it did read", P.ppPdfReconcile(flori6.rows.slice(1), lines).read, 559.55);
}

// ---- through the plan and the preview --------------------------------------------------------
console.log("\n-- through the same plan and preview a spreadsheet goes through");
const SUP = "sup-hartford", OTHER = "sup-other";
const cat = (id, name, price, o = {}) => ({ sync_id: id, name, unit_price: price, manufacturer_sync_id: SUP, supplier_sku: null, source_doc: "", deleted_at: null,
  fence_type: "VINYL", role: "PANEL", unit: "EA", ...o });
const catalog = [
  cat("c1", "6X6 HFS PRO SERIES PRIVACY PANEL WHITE", 50),
  cat("c2", '4X6 HFS CLOSED TOP CLEARWATER PRO SERIES PICKET PANEL WHITE - 7/8" x 3" PICKETS, 3" SPACING', 65),
  cat("c3", "50.00 is already right", 50),
  cat("c4", "HFS 59\" U CHANNEL WHITE", 2.99),
  cat("c5", "Not in the PDF at all", 7),
  cat("c6", "6X6 HFS PRO SERIES PRIVACY PANEL WHITE", 40, { manufacturer_sync_id: OTHER }),
];
const mfrs = [{ sync_id: SUP, name: "Hartford Fence Supply", deleted_at: null }, { sync_id: OTHER, name: "Other Vinyl", deleted_at: null }];
const tr = makeTr();
const H = { tr: (k, ...a) => tr(k, ...a), esc, fence: (s) => s, role: (s) => s };
{
  const L = loadPdfFns(["ppBuildPlan", "ppNormSku", "ppPatchFor", "ppPreviewHtml", "ppPct", "isSeededUnverifiedPrice"], { tr, catFenceTypeLabel: (s) => s, bizPretty: (s) => s }, src,
    grabConstLine("esc"));
  const rows = L.ppPdfRowsForPlan(hartford);
  const plan = L.ppBuildPlan(catalog, SUP, rows.rows, { nameOf: (id) => mfrs.find((m) => m.sync_id === id)?.name || "" });
  t.eq("the two catalog items named like PDF lines change to the PDF's unit prices, and not to the amounts",
    plan.changes.map((c) => [c.item.sync_id, c.oldPrice, c.newPrice]).sort(), [["c1", 50, 54.99875], ["c2", 65, 71.5]]);
  t.eq("the one already at its price is 'same'", plan.same.map((c) => c.item.sync_id), ["c4"]);
  t.ok("the item with the same name under ANOTHER supplier is never touched", !plan.changes.concat(plan.same).some((c) => c.item.sync_id === "c6"));
  // Rows, not plan entries: the U-channel is on page 1 and on page 3, two PDF rows for one catalog item.
  const outside = new Set(plan.unmatched.concat(plan.unreadable).map((u) => u.row));
  const matchedRows = rows.rows.filter((r) => !outside.has(r));
  t.eq("the four PDF rows that matched an item are the panel, the Clearwater panel and the U-channel on both pages",
    matchedRows.map((r) => `p${r.page} ${r.name}`).sort(),
    ['p1 6X6 HFS PRO SERIES PRIVACY PANEL WHITE', 'p1 HFS 59" U CHANNEL WHITE', 'p2 4X6 HFS CLOSED TOP CLEARWATER PRO SERIES PICKET PANEL WHITE - 7/8" x 3" PICKETS, 3" SPACING', 'p3 HFS 59" U CHANNEL WHITE']);
  t.eq("every PDF row is accounted for exactly once: matched 4 + not matched 19 + unreadable 0 = 23 found",
    [matchedRows.length, plan.unmatched.length, plan.unreadable.length, matchedRows.length + plan.unmatched.length + plan.unreadable.length], [4, 19, 0, 23]);
  const html = L.ppPreviewHtml({ plan, headings: rows.headings, pdf: hartford }, new Set(), "Hartford Fence Supply", H);
  t.ok("the counts line says 23 found on 3 pages, 4 matched, 19 not", html.includes("23 priced lines found on 3 page(s). Matched to an item in your catalog: 4. Could not be read or matched, listed below: 19."), html.slice(0, 600));
  t.ok("the reconciliation line says no lines were missed", html.includes("add up to $3,260.97") && html.includes("no lines were missed"));
  t.ok("the PDF line each price came from is beside it, as printed", html.includes(esc("p.2 30520-W  4X6 HFS CLOSED TOP CLEARWATER PRO  16  71.50  ea  1,144.00T")));
  t.ok("with its wrapped description lines under it", html.includes(esc("SERIES PICKET PANEL WHITE")) && html.includes(esc('- 7/8" x 3" PICKETS, 3" SPACING')));
  t.ok("and which number was taken, and the check that confirmed it", html.includes("Unit price used: 71.50 (checked: 16 × 71.50 = 1,144.00)"));
  t.ok("the table has an 'In the PDF' column", html.includes("<th>In the PDF</th>"));
  t.ok("an unmatched row shows its PDF line too, so a wrong or missing match can be seen", html.includes(esc("p.3 32001-CTG-45-W  CLEARWATER 4Hx5W CLOSED TOP GATE")));
  t.ok("nothing in the markup is ticked", !/<input type="checkbox" data-pp-i="\d+"[^>]*checked/.test(html));
  // The catalog was corrected to the supplier's exact figures (54.99875 and 18.99929, a double). Reading the same
  // PDF must find them already right, not "change" them by a twentieth of a cent by rounding to four places.
  {
    const exact = [cat("e1", "6X6 HFS PRO SERIES PRIVACY PANEL WHITE", 54.99875), cat("e2", "5X5X102 HFS LINE POST WHITE 1.75 6' PRIVACY", 18.99929)];
    const p = L.ppBuildPlan(exact, SUP, L.ppPdfRowsForPlan(hartford).rows, { nameOf: () => "" });
    t.eq("a catalog that already holds Hartford's exact 54.99875 and 18.99929 has nothing to change", [p.changes.length, p.same.map((x) => [x.item.sync_id, x.newPrice])], [0, [["e1", 54.99875], ["e2", 18.99929]]]);
    const old = [cat("e1", "6X6 HFS PRO SERIES PRIVACY PANEL WHITE", 55)];
    const q = L.ppBuildPlan(old, SUP, L.ppPdfRowsForPlan(hartford).rows, { nameOf: () => "" });
    t.eq("control: the old rounded 55.00 IS offered the exact 54.99875", q.changes.map((c) => [c.oldPrice, c.newPrice]), [[55, 54.99875]]);
    t.ok("and the preview shows all five places, so the figure on screen is the figure on the PDF", L.ppMoney(54.99875) === "$54.99875" && L.ppMoney(18.99929) === "$18.99929");
  }
  const csvLike = L.ppPreviewHtml({ plan, headings: [] }, new Set([0]), "Hartford Fence Supply", H);
  t.ok("control: with no PDF attached the preview has no 'In the PDF' column and no PDF counts", !csvLike.includes("In the PDF") && !csvLike.includes("priced lines found"));
  t.ok("control: and a ticked row IS drawn ticked, so the 'nothing ticked' check above can fail", /<input type="checkbox" data-pp-i="0"[^>]*checked/.test(csvLike));
}

// ---- the dialog, whole ----------------------------------------------------------------------
console.log("\n-- the dialog, from choosing the file to the preview: the way the office runs it");
const hartfordScenario = async (text) => {
  const D = await pdfDialog({ items: catalog, mfrs, text });
  D.el("ppSupplier").value = SUP; D.el("ppAssign").checked = false; D.el("ppSaveSku").checked = false;
  await D.P.ppOnFile(D.file(realPdf("hartford"), "Est_64792_from_Hartford_Fence_Supply_27668.pdf"));
  const st = D.state();
  return { D, st, ticked: st.selected.size, changes: st.plan ? st.plan.changes.length : -1, writes: D.writes.length, html: D.el("ppPreviewBody").innerHTML };
};
{
  const s = await hartfordScenario(src);
  t.eq("the PDF was read: 23 rows, 2 changes", [s.st.pdf.rows.length, s.changes], [23, 2]);
  t.eq("NOTHING is ticked, though two changes are waiting", [s.ticked, s.changes > 0], [0, true]);
  t.eq("the apply button's count says none selected", s.D.el("ppSelCount").textContent, "0 of 2 selected");
  t.eq("nothing was written to the database: no update, insert, upsert, delete or rpc", s.D.writes, []);
  t.ok("PDF.js was fetched from the pinned address and from nowhere else", s.D.served.length === 2 && s.D.served.every((u) => /^https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@4\.6\.82\/build\/pdf(\.worker)?\.min\.mjs$/.test(u)), s.D.served.join(" "));
  t.ok("the preview is on screen", s.D.el("ppPreviewBox").style.display === "");
  t.ok("the column pickers are put away and the PDF note says which column is the price", s.D.el("ppColPickers").style.display === "none" && /“Cost” column/.test(s.D.el("ppPdfNote").textContent), s.D.el("ppPdfNote").textContent);
  t.ok("the note says nothing is ticked", /Nothing is ticked/.test(s.D.el("ppPdfNote").textContent));
  // Control: the same dialog, given a spreadsheet, DOES tick its unflagged changes -- so "0 ticked" is a
  // property of PDFs and not of the harness.
  const D = await pdfDialog({ items: catalog, mfrs });
  D.el("ppSupplier").value = SUP; D.el("ppAssign").checked = false; D.el("ppSaveSku").checked = false;
  const csv = new TextEncoder().encode("Item,Price\n6X6 HFS PRO SERIES PRIVACY PANEL WHITE,54.99\n");
  await D.P.ppOnFile(D.file(csv, "list.csv"));
  t.eq("control: a CSV with one change starts with that change ticked", [D.state().plan.changes.length, D.state().selected.size], [1, 1]);
  t.ok("control: and it has no PDF state, no PDF note and its column pickers are showing", D.state().pdf === null && D.el("ppColPickers").style.display === "" && D.el("ppPdfNote").style.display === "none");
  // Teeth: with the guard removed from a copy of the page, the PDF starts ticked and this scenario goes red.
  const guard = "if(!st.pdf) st.plan.changes.forEach((c, i) => { if(!c.flags.length) st.selected.add(i); });";
  t.ok("the guard to be removed is on the page", src.includes(guard));
  const m = await hartfordScenario(src.replace(guard, "st.plan.changes.forEach((c, i) => { if(!c.flags.length) st.selected.add(i); });"));
  t.ok("mutant: PDF changes ticked by default -> the 'nothing ticked' check fails", m.ticked !== 0, String(m.ticked));
}

console.log("\n-- a PDF that matches nothing in the catalog is not 'nothing to do'");
{
  // His catalog names his parts his own way, so a first import will often match few lines. That must read as
  // "12 found, 0 matched, 12 not", with every price and its PDF line listed, and not as an empty result.
  const D = await pdfDialog({ items: [cat("z1", "A part with a name no supplier uses", 1)], mfrs });
  D.el("ppSupplier").value = SUP; D.el("ppAssign").checked = false; D.el("ppSaveSku").checked = false;
  await D.P.ppOnFile(D.file(realPdf("flori6"), "Estimate 17827.pdf"));
  const html = D.el("ppPreviewBody").innerHTML;
  t.ok("the counts say 12 found on 2 pages, 0 matched, 12 could not be matched", html.includes("12 priced lines found on 2 page(s). Matched to an item in your catalog: 0. Could not be read or matched, listed below: 12."), html.slice(0, 400));
  t.ok("the screen says nothing matched, in words, and offers no update button", /Nothing in this file matched an item in your catalog/.test(html) && D.el("ppApplyBtn").style.display === "none");
  t.ok("all twelve are listed with their price and the PDF line they came from", (html.match(/No item with this name or part number/g) || []).length === 12 && html.includes(esc("p.1 PANEL T&G WHITE PVC 6'H X 6'W  16  54.15  866.40T")) && html.includes("($54.15)"));
  t.eq("nothing was ticked, written or selected", [D.state().selected.size, D.writes.length], [0, 0]);
}

console.log("\n-- the apply path has one way in, and a PDF does not shortcut it");
{
  // The whole chain with a database that accepts the update: PDF -> preview -> nothing ticked -> he ticks ONE
  // line -> the existing ppApply writes that line and nothing else.
  const rowsDb = catalog.map((c) => ({ ...c }));
  const D = await pdfDialog({ items: rowsDb, mfrs, writable: true });
  D.el("ppSupplier").value = SUP; D.el("ppAssign").checked = false; D.el("ppSaveSku").checked = false;
  await D.P.ppOnFile(D.file(realPdf("hartford"), "Est_64792_from_Hartford_Fence_Supply_27668.pdf"));
  const st = D.state();
  t.eq("two changes are waiting and none is ticked", [st.plan.changes.length, st.selected.size], [2, 0]);
  t.ok("the apply button is disabled while nothing is ticked", D.el("ppApplyBtn").disabled === true);
  await D.P.ppApply();
  t.eq("pressing apply with nothing ticked writes nothing at all", D.writes, []);
  const at = st.plan.changes.findIndex((c) => c.item.sync_id === "c2");
  t.ok("the Clearwater panel is one of the two changes (control: the index is real)", at >= 0 && st.plan.changes.length === 2);
  D.P.ppOnPreviewChange({ target: { id: "", dataset: { ppI: String(at) }, checked: true } });
  t.eq("he ticks that one line: one of two is selected, and the button says so", [D.state().selected.size, D.el("ppApplyBtn").disabled], [1, false]);
  await D.P.ppApply();
  const patches = D.writes.map((w) => w.split(":").slice(0, 2).join(":"));
  t.eq("exactly that item was written: the price first and alone, then the source note", patches, ["update:c2", "update:c2"]);
  t.eq("the first write is the unit price, 71.5, and nothing else", JSON.parse(D.writes[0].slice("update:c2:".length)), { unit_price: 71.5 });
  const note = JSON.parse(D.writes[1].slice("update:c2:".length)).source_doc;
  t.ok("the second is the provenance, naming the supplier, the PDF's own file name and today", /^Price list — Hartford Fence Supply, Est_64792_from_Hartford_Fence_Supply_27668\.pdf, \d{4}-\d{2}-\d{2}$/.test(note), note);
  t.eq("the Clearwater panel now holds 71.5 and the privacy panel, never ticked, still holds 50", [rowsDb.find((r) => r.sync_id === "c2").unit_price, rowsDb.find((r) => r.sync_id === "c1").unit_price], [71.5, 50]);
  t.ok("it is the existing ppApply that writes, and no PDF function calls it", !/ppApply\(|ppWriteRows\(/.test([
    "ppPdfLib", "ppPdfFetchVerified", "ppPdfPages", "ppPdfParse", "ppPdfRead", "ppPdfRowsForPlan", "ppUsePdf", "ppPdfCountsHtml", "ppPdfLineHtml", "ppWhyText"]
    .map((n) => { const i = src.indexOf("function " + n + "("); return src.slice(i, src.indexOf("\n}\n", i)); }).join("\n")));
}

t.done();
