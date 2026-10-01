// The cases the three real supplier PDFs cannot show: a scan, a document with no heading, columns in
// another order, numbers that do not add up, two price columns, text that did not decode, a locked or
// damaged file, and a reader that downloads something other than what the page pinned.
//
// These PDFs are written here (see makePdf in a27-pricelist-lib.mjs) so every number in them is known.
// Everything runs the page's own functions. Each refusal is checked for the reason it gives, because a
// PDF that "imports nothing" is indistinguishable from a file with nothing in it unless it says which.
//
// Run:  node tests/a45-pdf-synthetic.test.mjs
import { src, loadPdfJs, loadPdfFns, makePdf, pdfDialog, makeTr, loadTL, runner } from "./a27-pricelist-lib.mjs";
import { createHash } from "node:crypto";

const t = runner();
const J = await loadPdfJs();
const P = loadPdfFns();
const TL = loadTL();
const read = (pdf, p = P) => p.ppPdfRead(pdf, J.lib);
const PUA = String.fromCharCode(0xE001), REPL = String.fromCharCode(0xFFFD);   // private-use and replacement characters: what an undecoded font leaves behind
const num = (s) => Number(String(s).replace(/,/g, ""));

// ---- fixtures ------------------------------------------------------------------------------
const X = { desc: 20, c1: 380, c2: 440, c3: 510 };
/** One page: an optional heading row, then rows of [description, c1, c2, c3] (null leaves a cell empty). */
function page(rows, { head = ["DESCRIPTION", "QTY", "RATE", "AMOUNT"], top = 700, step = 20, wrap = {} } = {}) {
  const texts = [];
  if (head) head.forEach((s, i) => texts.push({ x: [X.desc, X.c1, X.c2, X.c3][i], y: top, s }));
  let y = top - 24;
  rows.forEach((r, i) => {
    r.forEach((s, c) => { if (s != null) texts.push({ x: [X.desc, X.c1, X.c2, X.c3][c], y, s }); });
    (wrap[i] || []).forEach((w, k) => texts.push({ x: X.desc, y: y - 12 * (k + 1), s: w }));
    y -= step + 12 * (wrap[i] || []).length;
  });
  return { texts };
}
const doc = (...pages) => makePdf(pages);
const good = [["Panel 6x6 white", "16", "54.15", "866.40"], ["Post 5x5", "14", "16.56", "231.84"], ["Gate latch", "1", "25.87", "25.87"]];

console.log("\n-- a scan is refused, and says it is a scan");
{
  const scan = await read(doc({ image: true }));
  t.eq("a PDF that is only a picture is refused, not read as an empty list", [scan.ok, scan.refuse], [false, "ppPdfScanned"]);
  t.ok("the message says it is a picture of a page, that nothing was imported, and what to do instead",
    /picture of a page/.test(TL.en.ppPdfScanned) && /nothing was imported/.test(TL.en.ppPdfScanned) && /spreadsheet/.test(TL.en.ppPdfScanned) && /CSV or \.xlsx/.test(TL.en.ppPdfScanned));
  t.ok("and says it in Spanish and French too", /imagen de una página/.test(TL.es.ppPdfScanned) && /image de page/.test(TL.fr.ppPdfScanned));
  t.eq("control: the same page with text on it is read", (await read(doc(page(good)))).ok, true);
  const several = await read(doc({ image: true }, { image: true }, { image: true }));
  t.eq("three scanned pages are refused the same way", several.refuse, "ppPdfScanned");
  const mixed = await read(doc(page(good), { image: true }));
  t.eq("a PDF with one text page and one scanned page is read, and COUNTS the page it could not read", [mixed.ok, mixed.rows.length, mixed.pagesUnread, mixed.pages], [true, 3, 1, 2]);
  const Hh = { tr: makeTr(), esc: (s) => s };
  const warn = P.ppPdfCountsHtml({ pdf: mixed }, { rowsRead: 3, unreadable: [], unmatched: [] }, Hh.tr, Hh.esc);
  t.ok("the preview warns that one of two pages had no text and its lines were not read", /1 of 2 page\(s\) had no text this page could read/.test(warn), warn);
  const clean = await read(doc(page(good)));
  t.ok("control: with every page readable there is no such warning", !/had no text/.test(P.ppPdfCountsHtml({ pdf: clean }, { rowsRead: 3, unreadable: [], unmatched: [] }, Hh.tr, Hh.esc)));
}
{
  // Teeth: with the scan refusal removed from a copy of the page, the scanned PDF is no longer refused AS a scan.
  const guard = "if(!total) return { ok: false, refuse: 'ppPdfScanned' };";
  t.ok("the scan guard to be removed is on the page", src.includes(guard));
  const mutant = loadPdfFns([], {}, src.replace(guard, ""));
  t.ok("mutant: scan guard removed -> the scan is no longer refused as a scan", (await mutant.ppPdfRead(doc({ image: true }), J.lib)).refuse !== "ppPdfScanned");
  const g2 = "if(!rows.length) return { ok: false, refuse: 'ppPdfNoRows' };";
  t.ok("the no-rows guard to be removed is on the page", src.includes(g2));
  const m2 = loadPdfFns([], {}, src.replace(g2, ""));
  const none = await m2.ppPdfRead(doc(page([["Terms and conditions apply", null, null, null]])), J.lib);
  t.ok("mutant: no-rows guard removed -> a PDF with no priced line comes back OK with zero rows, the silent empty import", none.ok === true && none.rows.length === 0);
}

console.log("\n-- text but no priced line, and text that did not decode");
{
  const r = await read(doc(page([["Terms and conditions apply to every sale", null, null, null], ["Thank you for your business", null, null, null]])));
  t.eq("a PDF with a heading and only sentences is refused, naming the reason", [r.ok, r.refuse], [false, "ppPdfNoRows"]);
  const lone = await read(doc(page([["Panel 6x6 white", null, null, "866.40"]])));
  t.eq("a line holding only a total is not an item, so a PDF of only those is refused too", lone.refuse, "ppPdfNoRows");
  const decoded = P.ppPdfParse([{ n: 1, items: [{ s: PUA.repeat(5), x: 20, y: 700, w: 50, h: 10 }, { s: REPL.repeat(3), x: 20, y: 680, w: 30, h: 10 }, { s: "ab", x: 20, y: 660, w: 10, h: 10 }] }]);
  t.eq("text that came out as private-use and replacement characters is refused as undecodable", decoded.refuse, "ppPdfGarbled");
  const fine = P.ppPdfParse([{ n: 1, items: [{ s: "Panel " + PUA, x: 20, y: 700, w: 50, h: 10 }, { s: "Panel and post and gate", x: 20, y: 680, w: 100, h: 10 }] }]);
  t.ok("control: a stray odd character among real text does not trigger it", fine.refuse !== "ppPdfGarbled");
}

console.log("\n-- the unit price is the column the heading calls the price");
{
  const r = await read(doc(page(good)));
  t.eq("RATE beside AMOUNT: 54.15 is the price and 866.40 is not", [r.rows[0].priceRaw, r.rows[0].amountRaw, r.rows[0].verified], ["54.15", "866.40", true]);
  t.eq("and its quantity x price = total is what confirmed it", [r.rows[0].qty, r.rows[0].how, r.rows[0].priceLabel], ["16", "header", "RATE"]);
  const swapped = await read(doc(page([["Panel 6x6 white", "16", "866.40", "54.15"]], { head: ["DESCRIPTION", "QTY", "AMOUNT", "RATE"] })));
  t.eq("with the columns the other way round (AMOUNT before RATE) the heading, not the position, decides", [swapped.rows[0].priceRaw, swapped.rows[0].why], ["54.15", ""]);
  for (const [heads, label] of [[["DESCRIPTION", "QTY", "UNIT PRICE", "EXT PRICE"], "UNIT PRICE"], [["Item", "Quantity", "Price", "Extended"], "Price"],
    [["Description", "Ordered", "Cost", "Total"], "Cost"], [["Description", "Qty", "Each", "Line Total"], "Each"]]) {
    const v = await read(doc(page(good, { head: heads })));
    t.eq(`headings ${heads.slice(1).join(" / ")}: price from "${label}", every row confirmed`, [v.priceLabel, v.rows.map((x) => x.priceRaw), v.rows.every((x) => x.verified)], [label, ["54.15", "16.56", "25.87"], true]);
  }
  const list = await read(doc(page([["Panel 6x6 white", null, "54.15", null], ["Post 5x5", null, "16.56", null]], { head: ["Description", "", "Price", ""] })));
  t.eq("a plain price list (Description, Price) is read from its price heading, with nothing to check it against",
    [list.rows.map((x) => x.priceRaw), list.rows.map((x) => x.verified), list.rows.map((x) => x.how)], [["54.15", "16.56"], [false, false], ["header", "header"]]);
  const noTotal = await read(doc(page([["Panel 6x6 white", "16", "54.15", null]], { head: ["DESCRIPTION", "QTY", "PRICE", ""] })));
  t.eq("a quantity and a price with no total column: taken from the heading, not marked as checked", [noTotal.rows[0].priceRaw, noTotal.rows[0].verified], ["54.15", false]);
  const pv = P.ppPdfLineHtml({ ...list.rows[0], page: 1 }, makeTr(), (s) => s);
  t.ok("and the preview says where an unchecked price came from", /Unit price used: 54\.15 \(from the “Price” column\)/.test(pv), pv);
  const cv = P.ppPdfLineHtml({ ...r.rows[0], page: 1 }, makeTr(), (s) => s);
  t.ok("while a checked one shows the sum", /Unit price used: 54\.15 \(checked: 16 × 54\.15 = 866\.40\)/.test(cv), cv);
}

console.log("\n-- a line that does not add up is listed, never priced");
{
  const r = await read(doc(page([["Panel 6x6 white", "16", "54.15", "900.00"], ["Post 5x5", "14", "16.56", "231.84"]])));
  const [bad, ok] = r.rows;
  t.eq("16 x 54.15 against a printed 900.00: unreadable, with the numbers that did not add up", [bad.why, bad.priceRaw, bad.whyArgs], ["pdfrel", "", ["16", "54.15", "866.40", "900.00"]]);
  t.eq("control: the next line, which does add up, is priced", [ok.why, ok.priceRaw], ["", "16.56"]);
  const rows = P.ppPdfRowsForPlan(r).rows;
  t.eq("it has no price for the plan (not 54.15, not 900.00)", [rows[0].price, rows[1].price], [null, 16.56]);
  const text = P.ppWhyText(rows[0], makeTr());
  t.ok("and the reason shown to him names all four numbers", /16 × 54\.15 is 866\.40, but the PDF says the line total is 900\.00/.test(text), text);
  const one = await read(doc(page([["Gate latch", "1", "25.87", "25.00"]])));
  t.eq("a quantity of one is checked too: 1 x 25.87 is not 25.00", one.rows[0].why, "pdfrel");
  const close = await read(doc(page([["Cap", "18", "0.78", "14.04"], ["Hinge", "14", "18.99929", "265.99"], ["Cap", "18", "0.78", "14.30"]])));
  t.eq("a cent of rounding in the total is tolerated (14 x 18.99929 = 265.99) and twenty-six cents on 18 caps is not", close.rows.map((x) => x.why), ["", "", "pdfrel"]);
}
{
  const gaps = await read(doc(page([["No quantity", null, "54.15", "866.40"], ["No total", "16", "54.15", null], ["No rate", "16", null, "866.40"], ["Zero quantity", "0", "54.15", "0.00"]])));
  t.eq("a line missing its quantity, its total, or its rate cannot be confirmed and is not priced",
    gaps.rows.map((x) => [x.name, x.why, x.priceRaw]), [["No quantity", "pdfnorel", ""], ["No total", "pdfnorel", ""], ["No rate", "pdfnoprice", ""], ["Zero quantity", "pdfnorel", ""]]);
  t.ok("least of all is the total taken as the price of the line that has no rate", !gaps.rows.some((x) => x.priceRaw === "866.40"));
  const extra = await read(doc({ texts: [...page([["Too many numbers", "16", "54.15", "866.40"]]).texts, { x: 350, y: 676, s: "7" }] }));
  t.eq("a line with more numbers than the table has columns is not guessed at", [extra.rows[0].why, extra.rows[0].priceRaw], ["pdfcols", ""]);
  const total = await read(doc(page([...good, ["SUBTOTAL", null, null, "1,124.11"], ["TAX", null, null, "73.07"]])));
  t.eq("lines holding only a total (SUBTOTAL, TAX) are totals and not items", [total.rows.length, total.totals.length], [3, 2]);
  t.eq("and the lines read add up to the subtotal, so the page says nothing was missed", [total.recon.agree, total.recon.how], [true, "subtotal"]);
  const missing = await read(doc(page([...good.slice(0, 2), ["SUBTOTAL", null, null, "1,124.11"]])));
  t.eq("control: drop a priced line and the same document no longer adds up, and says so", [missing.recon.agree, missing.recon.read, missing.recon.printed], [false, 1098.24, 1124.11]);
  const warn = P.ppPdfCountsHtml({ pdf: missing }, { rowsRead: 2, unreadable: [], unmatched: [] }, makeTr(), (s) => s);
  t.ok("and the preview names both figures", /add up to \$1,098\.24, but the PDF’s own total before tax is \$1,124\.11/.test(warn), warn);
}

console.log("\n-- with no heading, a price is accepted only where quantity x price = total");
{
  const r = await read(doc(page(good, { head: null })));
  t.eq("three numbers per line, no heading: the price is the one that satisfies the sum", [r.mode, r.rows.map((x) => x.priceRaw), r.rows.map((x) => x.how)], ["relation", ["54.15", "16.56", "25.87"], ["relation", "relation", "relation"]]);
  const bad = await read(doc(page([["Panel 6x6 white", "16", "54.15", "900.00"], ["Post 5x5", "14", "16.56", "231.84"]], { head: null })));
  t.eq("a line whose three numbers do not satisfy it is unreadable, never guessed", bad.rows.map((x) => [x.why, x.priceRaw]), [["pdfrel", ""], ["", "16.56"]]);
  const two = await read(doc(page([["Panel 6x6 white", null, "54.15", "866.40"]], { head: null })));
  t.eq("two numbers and no heading cannot say which is the price: nothing is read, and that is refused as such", [two.ok, two.refuse], [false, "ppPdfNoRows"]);
  const lineNo = await read(doc({ texts: [{ x: 5, y: 676, s: "1" }, { x: 20, y: 676, s: "Panel 6x6 white" }, { x: 380, y: 676, s: "16" }, { x: 440, y: 676, s: "54.15" }, { x: 510, y: 676, s: "866.40" }] }));
  t.eq("a line number in front of the quantity does not shift the columns", [lineNo.rows[0].priceRaw, lineNo.rows[0].qty], ["54.15", "16"]);
  const ambiguous = await read(doc({ texts: [{ x: 20, y: 676, s: "Odd line" }, { x: 380, y: 676, s: "2" }, { x: 440, y: 676, s: "2" }, { x: 510, y: 676, s: "4" }, { x: 560, y: 676, s: "8" }] }));
  t.eq("two different readings that both satisfy the sum (2 x 2 = 4 and 2 x 4 = 8) are not resolved by choosing one", [ambiguous.rows[0].why, ambiguous.rows[0].priceRaw], ["pdfambig", ""]);
  const noPriceHead = await read(doc(page(good, { head: ["DESCRIPTION", "QTY", "", "AMOUNT"] })));
  t.eq("a heading with a quantity and a total but no price label falls back to the same sum", [noPriceHead.mode, noPriceHead.rows.map((x) => x.priceRaw)], ["relation", ["54.15", "16.56", "25.87"]]);
}

console.log("\n-- more than one price column is refused");
{
  const two = await read(doc({ texts: [{ x: 20, y: 700, s: "DESCRIPTION" }, { x: 330, y: 700, s: "QTY" }, { x: 380, y: 700, s: "LIST PRICE" }, { x: 450, y: 700, s: "NET PRICE" }, { x: 520, y: 700, s: "AMOUNT" },
    { x: 20, y: 676, s: "Panel" }, { x: 330, y: 676, s: "16" }, { x: 380, y: 676, s: "60.00" }, { x: 450, y: 676, s: "54.15" }, { x: 520, y: 676, s: "866.40" }] }));
  t.eq("List price and Net price: refused, naming both", [two.ok, two.refuse, two.arg], [false, "ppPdfAmbiguous", "LIST PRICE, NET PRICE"]);
  t.ok("the message tells him why and what to do", /more than one price column \(%s\)/.test(TL.en.ppPdfAmbiguous) && /spreadsheet/.test(TL.en.ppPdfAmbiguous));
  const one = await read(doc({ texts: [{ x: 20, y: 700, s: "DESCRIPTION" }, { x: 330, y: 700, s: "QTY" }, { x: 380, y: 700, s: "NET PRICE" }, { x: 450, y: 700, s: "AMOUNT" },
    { x: 20, y: 676, s: "Panel" }, { x: 330, y: 676, s: "16" }, { x: 380, y: 676, s: "54.15" }, { x: 450, y: 676, s: "866.40" }] }));
  t.eq("control: with only the Net price column the same table is read", [one.ok, one.rows[0].priceRaw], [true, "54.15"]);
}

console.log("\n-- descriptions that wrap, sub-headings, a heading repeated or missing on the next page");
{
  const wrapped = await read(doc(page([["PANEL T&G WHITE", "16", "54.15", "866.40"], ["POST 5x5", "14", "16.56", "231.84"]], { wrap: { 0: ["PRIVACY 6 FT", "(EA) LINE"] } })));
  t.eq("a description wrapped onto three lines is one item, named by all three, priced once", [wrapped.rows.length, wrapped.rows[0].name, wrapped.rows[0].priceRaw], [2, "PANEL T&G WHITE PRIVACY 6 FT (EA) LINE", "54.15"]);
  t.eq("and the line below is the next item, not part of it", wrapped.rows[1].name, "POST 5x5");
  const sub = await read(doc({ texts: [...page([["Panel", "16", "54.15", "866.40"]]).texts, { x: 20, y: 660, s: "***4' Closed Top***" }, { x: 20, y: 640, s: "Picket", }, { x: 380, y: 640, s: "2" }, { x: 440, y: 640, s: "10.00" }, { x: 510, y: 640, s: "20.00" }] }));
  t.eq("a ***sub-heading*** between items is a heading, not an item and not part of the item above it", [sub.rows.map((x) => x.name), sub.headings], [["Panel", "Picket"], ["4' Closed Top"]]);
  const carried = await read(doc(page(good), { texts: [{ x: X.desc, y: 700, s: "Hinge set" }, { x: X.c1, y: 700, s: "2" }, { x: X.c2, y: 700, s: "32.25" }, { x: X.c3, y: 700, s: "64.50" }] }));
  t.eq("a second page with no heading of its own reads under the first page's columns", [carried.rows.length, carried.rows[3].name, carried.rows[3].priceRaw, carried.rows[3].page], [4, "Hinge set", "32.25", 2]);
  const repeated = await read(doc(page(good), page([["Hinge set", "2", "32.25", "64.50"]])));
  t.eq("a second page that repeats the heading reads the same, and its heading is not an item", [repeated.rows.length, repeated.rows[3].priceRaw, repeated.rows.some((x) => /QTY|RATE|AMOUNT/.test(x.name))], [4, "32.25", false]);
  const above = await read(doc({ texts: [{ x: 20, y: 760, s: "ACME FENCE SUPPLY" }, { x: 380, y: 760, s: "2026" }, { x: 20, y: 745, s: "Quote 17407" }, { x: 380, y: 745, s: "12" }, { x: 440, y: 745, s: "3" }, ...page(good).texts] }));
  t.eq("numbers above the heading (a quote number, a date) are not items", above.rows.map((x) => x.name), ["Panel 6x6 white", "Post 5x5", "Gate latch"]);
  const land = await read(makePdf([{ landscape: true, texts: page(good, { top: 560 }).texts }]));
  t.eq("a landscape page (a portrait sheet marked rotated, its text turned to match) is read like any other", [land.ok, land.rows && land.rows.map((x) => x.priceRaw)], [true, ["54.15", "16.56", "25.87"]]);
  const sideways = await read(makePdf([{ rotate: 90, texts: page(good).texts }]));
  t.eq("control: the same table on a page marked rotated WITHOUT turning its text comes out sideways, and is refused rather than misread", sideways.ok, false);
  const stamped = await read(makePdf([{ texts: [...page(good).texts, { x: 150, y: 300, s: "DRAFT", size: 60, angle: 45 }] }]));
  t.eq("a diagonal DRAFT stamp across a page is not a table cell and is not listed", [stamped.rows.length, stamped.headings.some((h) => /DRAFT/.test(h)), stamped.rows.map((x) => x.name)], [3, false, ["Panel 6x6 white", "Post 5x5", "Gate latch"]]);
}

console.log("\n-- a PDF can hold anything: the preview shows it as text");
{
  const evil = '<img src=x onerror=alert(1)>';
  const r = await read(doc({ texts: [...page([[evil, "2", "10.00", "20.00"], ["Plain", "1", "5.00", "5.00"]]).texts, { x: 20, y: 640, s: "***<b>bold</b> heading***" }, { x: 20, y: 600, s: "<script>alert(2)</script>" }] }));
  t.eq("positive control: the hostile description was read as an item, with its price", [r.rows[0].name, r.rows[0].priceRaw], [evil, "10.00"]);
  const tr = makeTr();
  const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const L = loadPdfFns(["ppBuildPlan", "ppNormSku", "ppPreviewHtml", "ppPct", "isSeededUnverifiedPrice"], { tr, catFenceTypeLabel: (s) => s, bizPretty: (s) => s }, src, `const esc = ${esc.toString()};`);
  const items = [{ sync_id: "a", name: evil, unit_price: 5, manufacturer_sync_id: "s1", supplier_sku: null, source_doc: "", deleted_at: null, fence_type: "VINYL", role: "PANEL", unit: "EA" }];
  const rows = L.ppPdfRowsForPlan(r);
  const plan = L.ppBuildPlan(items, "s1", rows.rows, { nameOf: () => "" });
  const html = L.ppPreviewHtml({ plan, headings: rows.headings, pdf: r }, new Set(), "<i>Supplier</i>", { tr, esc, fence: (s) => s, role: (s) => s });
  t.ok("it is on screen as text: &lt;img src=x onerror=alert(1)&gt;", html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  for (const raw of ["<img", "<b>bold", "<script", "<i>Supplier"]) t.ok(`no raw ${raw} reaches the markup (item, PDF line, heading or supplier name)`, !html.includes(raw));
  t.ok("and the heading text is among what was listed, escaped", html.includes("&lt;b&gt;bold&lt;/b&gt; heading"));
}

console.log("\n-- a locked, damaged or overlong file is refused with its reason, and nothing throws");
{
  const fake = (over) => ({ getDocument: () => ({ promise: over }) });
  const locked = await P.ppPdfRead(new Uint8Array([1]), fake(Promise.reject(Object.assign(new Error("No password given"), { name: "PasswordException" }))));
  t.eq("a password-protected PDF", [locked.ok, locked.refuse], [false, "ppPdfLocked"]);
  const bad = await P.ppPdfRead(new Uint8Array([1]), fake(Promise.reject(Object.assign(new Error("Invalid PDF structure."), { name: "InvalidPDFException" }))));
  t.eq("a damaged PDF", [bad.ok, bad.refuse], [false, "ppPdfRefused"]);
  const garbage = await read(new TextEncoder().encode("%PDF-1.4 this is not really a pdf at all"));
  t.eq("the real reader on bytes that only start like a PDF: refused, not thrown", [garbage.ok, garbage.refuse], [false, "ppPdfRefused"]);
  const long = await P.ppPdfRead(new Uint8Array([1]), fake(Promise.resolve({ numPages: 41, destroy: async () => {} })));
  t.eq("a 41-page PDF is over the 40-page limit", [long.ok, long.refuse, long.arg], [false, "ppPdfTooLong", 40]);
  const okLen = await P.ppPdfRead(new Uint8Array([1]), fake(Promise.resolve({ numPages: 1, getPage: async () => ({ getViewport: () => ({ transform: [1, 0, 0, -1, 0, 792], height: 792 }), getTextContent: async () => ({ items: [] }), cleanup() {} }), destroy: async () => {} })));
  t.eq("control: one page of nothing is not 'too long' but refused as a scan", okLen.refuse, "ppPdfScanned");
  for (const k of ["ppPdfLocked", "ppPdfRefused", "ppPdfTooLong"]) t.ok(`${k} has a message in every language`, ["en", "es", "fr"].every((l) => TL[l][k] && TL[l][k].length > 20));
}

console.log("\n-- the reader is fetched once, checked against its fingerprint, and a bad copy is never run");
{
  const sha = (b) => createHash("sha384").update(b).digest("base64");
  const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const URL_ = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.mjs";
  const calls = [];
  const serve = (bytes, status = 200) => async (url, opts) => { calls.push([url, opts]); return { ok: status === 200, status, arrayBuffer: async () => toAB(bytes) }; };
  const F = loadPdfFns();
  const tampered = Buffer.from(J.libBytes); tampered[1000] ^= 1;
  t.eq("the real bytes pass", (await F.ppPdfFetchVerified(URL_, J.want.lib, serve(J.libBytes))).byteLength, J.libBytes.length);
  let err = null;
  try { await F.ppPdfFetchVerified(URL_, J.want.lib, serve(tampered)); } catch (e) { err = e; }
  t.eq("control: the same file with ONE bit changed is refused as not matching its fingerprint", err && err.message, "fingerprint");
  err = null;
  try { await F.ppPdfFetchVerified(URL_, J.want.lib, serve(Buffer.from("<html>Not found</html>"))); } catch (e) { err = e; }
  t.eq("an error page served with a 200 is refused too", err && err.message, "fingerprint");
  err = null;
  try { await F.ppPdfFetchVerified(URL_, J.want.lib, serve(J.libBytes, 404)); } catch (e) { err = e; }
  t.eq("a 404 is refused", err && err.message, "http 404");
  err = null;
  try { await F.ppPdfFetchVerified(URL_, J.want.worker, serve(J.libBytes)); } catch (e) { err = e; }
  t.eq("the main file offered against the worker's fingerprint is refused (each file has its own)", err && err.message, "fingerprint");
  t.ok("the request carries no cookies and no referrer", calls.every(([, o]) => o.credentials === "omit" && o.referrerPolicy === "no-referrer" && o.mode === "cors"));
  t.eq("the fingerprint is SHA-384 and is what the page compares", [sha(J.libBytes) === J.want.lib, J.want.lib.length], [true, 64]);

  // The whole loader, in order, against a counting fake network.
  const dialogCalls = [];
  const bytesFor = (url) => (String(url).endsWith("pdf.min.mjs") ? J.libBytes : J.workerBytes);
  let mode = "good";
  const scope = {
    fetch: async (url) => { dialogCalls.push(url); const b = mode === "bad" ? tampered : bytesFor(url); return { ok: true, status: 200, arrayBuffer: async () => toAB(b) }; },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: (blob) => "data:text/javascript;base64," + Buffer.from(blob.parts[0]).toString("base64") },
  };
  const G = loadPdfFns([], scope);
  mode = "bad";
  const first = await G.ppPdfRead(new Uint8Array([1]));
  t.eq("a tampered download: the reader is not run and the file is refused for that reason", [first.ok, first.refuse], [false, "ppPdfLibFingerprint"]);
  t.eq("that failure is not remembered: nothing is cached", G.libPromise(), null);
  mode = "good"; dialogCalls.length = 0;
  const [a, b] = await Promise.all([G.ppPdfRead(doc(page(good))), G.ppPdfRead(doc(page(good)))]);
  t.eq("the next PDF tries again and reads; two at once share one download of each file", [a.ok, b.ok, dialogCalls.length], [true, true, 2]);
  const c = await G.ppPdfRead(doc(page(good)));
  t.eq("a third PDF does not download it again", [c.ok, dialogCalls.length], [true, 2]);
  const offline = loadPdfFns([], { ...scope, fetch: async () => { throw new TypeError("Failed to fetch"); } });
  const off = await offline.ppPdfRead(new Uint8Array([1]));
  t.eq("no connection: refused with its own message, not a stack trace", [off.ok, off.refuse], [false, "ppPdfLibOffline"]);
  t.ok("and that message does not contain the words the page rewrites into a generic network error", !/failed to fetch|load failed|networkerror/i.test(TL.en.ppPdfLibOffline));
}

console.log("\n-- through the dialog: a scan, and a PDF with no lines, change nothing and show nothing");
{
  const dlg = async (pdf) => {
    const D = await pdfDialog({ items: [], mfrs: [{ sync_id: "s1", name: "Acme", deleted_at: null }] });
    D.el("ppSupplier").value = "s1";
    await D.P.ppOnFile(D.file(pdf, "quote.pdf"));
    return D;
  };
  const scan = await dlg(doc({ image: true }));
  const last = scan.msgs[scan.msgs.length - 1];
  t.ok("a scanned PDF: the message on screen is the scan message, as an error", last.kind === "err" && /picture of a page/.test(last.text), JSON.stringify(last));
  t.ok("no preview is shown, no PDF is held, and the database was not touched", scan.el("ppPreviewBox").style.display === "none" && scan.state().pdf === null && scan.writes.length === 0);
  const empty = await dlg(doc(page([["Terms and conditions", null, null, null]])));
  t.ok("a PDF with no priced lines: refused with its own message", /no line in it reads as an item/.test(empty.msgs[empty.msgs.length - 1].text), empty.msgs[empty.msgs.length - 1].text);
  const okd = await dlg(doc(page(good)));
  t.ok("control: a PDF with lines shows the preview (so the two checks above are checks of something)", okd.el("ppPreviewBox").style.display === "" && okd.state().pdf && okd.state().pdf.rows.length === 3);
}

t.done();
