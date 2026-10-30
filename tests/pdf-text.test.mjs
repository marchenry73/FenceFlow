// The hand-written PDF: the scope of work that goes out as an attachment.
//
// NO LIBRARY, on purpose -- an edge function cannot pull a PDF package at
// runtime, and bundling one to lay out a page of text would sit in the path of
// every outgoing email. So _shared/pdf-text.ts writes the format itself, and
// THE BYTE OFFSETS ARE THE WHOLE RISK: the xref table gives the exact byte
// position of every object, and one multi-byte character ahead of an object
// shifts it and the file opens as damaged.
//
// So these checks do not stop at "it starts with %PDF". They walk the xref
// table and require every offset to land on its own object, for a one-page
// file, a seven-page file, a file with brackets in the text, and a file full
// of characters the font cannot encode.
//
// Independently confirmed once with pypdf (a real parser): it opened the
// sample, reported one page, and extracted the text back correctly.
import test from "node:test";
import assert from "node:assert/strict";
import { pdfFromText, wrapLine, toWinAnsi } from "../supabase/functions/_shared/pdf-text.ts";

const dec = (b) => Buffer.from(b).toString("latin1");

/** Walks the xref table and checks every offset points at its own object. */
function assertOffsetsLand(bytes, label) {
  const t = dec(bytes);
  // From startxref, NOT lastIndexOf("xref") -- which finds the "xref" inside
  // the word "startxref" and makes this check parse NaN objects and pass
  // without looking at anything.
  const sx = parseInt(t.slice(t.lastIndexOf("startxref") + 9), 10);
  assert.equal(t.slice(sx, sx + 4), "xref", `${label}: startxref does not point at the xref table`);
  const lines = t.slice(sx).split("\n");
  const count = parseInt(lines[1].split(" ")[1], 10);
  assert.ok(Number.isFinite(count) && count > 1, `${label}: the xref table declares ${count} objects`);
  for (let i = 1; i < count; i++) {
    const off = parseInt(lines[2 + i].slice(0, 10), 10);
    assert.ok(
      t.slice(off).startsWith(`${i} 0 obj`),
      `${label}: object ${i}'s offset lands on ${JSON.stringify(t.slice(off, off + 18))}`,
    );
  }
}

test("a one-page scope of work is a valid PDF", () => {
  const bytes = pdfFromText({
    title: "Scope of Work",
    lines: ["Back: 120 ft", "", "Front: 36 ft"],
    footer: "Fence solutions",
  });
  const t = dec(bytes);
  assert.ok(t.startsWith("%PDF-1.4"), "no PDF header");
  assert.ok(t.trimEnd().endsWith("%%EOF"), "no %%EOF");
  assert.match(t, /\(Back: 120 ft\) Tj/, "the text never reached the content stream");
  assertOffsetsLand(bytes, "one page");
});

test("a long specification paginates, and nothing is dropped", () => {
  // A dozen sides does not fit on one sheet, and a PDF that silently lost the
  // overflow would be worse than no PDF.
  const bytes = pdfFromText({
    title: "Long",
    lines: Array.from({ length: 300 }, (_, i) => `Line number ${i} with some words after it`),
    footer: "f",
  });
  const t = dec(bytes);
  const pages = parseInt(/\/Count (\d+)/.exec(t)[1], 10);
  assert.ok(pages > 1, `expected more than one page, got ${pages}`);
  assert.equal((t.match(/\/Type \/Page[^s]/g) || []).length, pages, "page objects do not match /Count");
  assert.match(t, /Line number 299/, "the last line did not survive pagination");
  assert.match(t, new RegExp(`page ${pages} of ${pages}`), "the footer does not number the pages");
  assertOffsetsLand(bytes, "many pages");
});

test("brackets and backslashes in the text cannot end the PDF string early", () => {
  const BS = String.fromCharCode(92);
  const bytes = pdfFromText({
    title: `A (test) ${BS} case`,
    lines: ["Gate (4 ft) wide", "100% (approx)"],
  });
  const t = dec(bytes);
  assert.ok(t.includes(`${BS}(test${BS})`), "parentheses were not escaped");
  assert.ok(t.includes(BS + BS), "the backslash was not escaped");
  assert.ok(!t.includes("(A (test)"), "an unescaped bracket reached the stream");
  assertOffsetsLand(bytes, "escaped");
});

test("characters the font cannot encode never reach the bytes", () => {
  // This is the offset-shifting case: a raw UTF-8 sequence would move every
  // object after it and the file would open as damaged.
  const bytes = pdfFromText({
    title: "Café — “quoted” …",
    lines: ["你好", "Résidentiel", "6′ fence"],
  });
  assert.ok(!Buffer.from(bytes).includes(Buffer.from([0xe4, 0xbd, 0xa0])),
    "raw UTF-8 bytes are in the file");
  const t = dec(bytes);
  assert.match(t, /Café -/, "the em dash was not folded, or the accent was lost");
  assert.match(t, /\?\?/, "an unmappable character did not become a question mark");
  assertOffsetsLand(bytes, "unicode folded");
});

test("folding keeps the meaning of typographic characters", () => {
  assert.equal(toWinAnsi("a—b"), "a-b");
  assert.equal(toWinAnsi("6′"), "6'");
  assert.equal(toWinAnsi("“q”"), '"q"');
});

test("lines wrap by WIDTH, not by character count", () => {
  // 70 characters of W and 70 of i are not the same width, and charging them
  // the same runs the first off the page.
  const wide = wrapLine("W".repeat(200), 10, 504);
  const thin = wrapLine("i".repeat(200), 10, 504);
  assert.ok(wide.length > thin.length, `W wrapped into ${wide.length}, i into ${thin.length}`);
  assert.equal(wrapLine("short", 10, 504).length, 1);
  const url = wrapLine("https://" + "x".repeat(300), 10, 504);
  assert.ok(url.length > 1, "an unbreakable word was not cut");
  assert.ok(url.every((l) => l.length > 0), "cutting produced an empty line");
});

test("an empty document is still a valid PDF, not a crash", () => {
  const bytes = pdfFromText({ title: "", lines: [] });
  assert.ok(dec(bytes).startsWith("%PDF"));
  assertOffsetsLand(bytes, "empty");
});

test("CANARY: the offset check can actually fail", () => {
  // Every assertion above leans on assertOffsetsLand. If it could not fail,
  // none of them mean anything -- so corrupt a file on purpose and require it
  // to complain.
  const good = pdfFromText({ title: "T", lines: ["one"] });
  const t = dec(good);
  // Move the first object's recorded offset by one byte.
  const sx = t.lastIndexOf("startxref");
  const tableAt = parseInt(t.slice(sx + 9), 10);
  const lines = t.slice(tableAt).split("\n");
  // lines[2] is the FREE entry ("0000000000 65535 f"), which nothing
  // validates -- corrupting that one passed and proved nothing. lines[3] is
  // object 1's real offset.
  const entry = lines[3];
  const broken = t.replace(entry, String(parseInt(entry.slice(0, 10), 10) + 1).padStart(10, "0") + " 00000 n ");
  assert.notEqual(broken, t, "the corruption changed nothing -- the canary proves nothing");
  assert.throws(
    () => assertOffsetsLand(Buffer.from(broken, "latin1"), "deliberately broken"),
    /offset lands on/,
    "a wrong xref offset was not detected",
  );
});
