// Shared by the a27-pricelist-*.test.mjs files. Not a test itself.
//
// Lifts the REAL functions out of the office page and runs them, rather than
// re-implementing them here: a copy would keep passing after the page's own
// code stopped doing what the copy does. The page under test is
// website/dashboard.html unless A27_PAGE names another file, which is how the
// red runs are done -- the same tests pointed at a scratch copy of the page with
// one guard removed, to prove each check can actually fail.
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

export const PAGE = process.env.A27_PAGE || "website/dashboard.html";
export const src = readFileSync(PAGE, "utf8");

/** The source of `function name(` or `async function name(`, brace-balanced. */
export function grab(name, text = src) {
  let start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error("not found on the page: " + name);
  if (text.slice(start - 6, start) === "async ") start -= 6;
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") { depth--; if (!depth) return text.slice(start, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

/** The one-line `const name = ...;` declaration. */
export function grabConstLine(name, text = src) {
  const m = new RegExp("^const " + name + " = .*;$", "m").exec(text);
  if (!m) throw new Error("const not found on the page: " + name);
  return m[0];
}

/** Loads the named page functions into a closure. `scope` supplies the page
    globals they read (db, profile, $, ...); `prelude` is extra source placed
    first (let-declared page state, const lines); `expose` are extra expressions
    returned alongside the functions, for reaching closure state. */
export function load(names, scope = {}, prelude = "", expose = {}) {
  const code = names.map((n) => grab(n)).join("\n\n");
  const ret = names.concat(Object.entries(expose).map(([k, v]) => `${k}: ${v}`)).join(",");
  const keys = Object.keys(scope);
  return new Function(...keys, prelude + "\n" + code + "\nreturn {" + ret + "};")(...keys.map((k) => scope[k]));
}

/** The TL translation table, evaluated the way office-language-parity does. */
export function loadTL(text = src) {
  const start = text.indexOf("const TL = {");
  const open = text.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return eval("(" + text.slice(open, end) + ")");
}

/** The page's price-list section as text, for assertions about what it does NOT contain. */
export function ppRegion(text = src) {
  const a = text.indexOf("/* ===================== Update prices from a supplier's price list");
  const b = text.indexOf("/* ===================== Customer import");
  if (a < 0 || b < 0 || b < a) throw new Error("the price-list section is not on the page");
  return text.slice(a, b);
}

/** Every `pp...` function in the price-list section, so a test can load the
    whole feature rather than the handful it happens to name. */
export function ppFunctionNames(text = src) {
  return [...ppRegion(text).matchAll(/^(?:async )?function (pp[A-Za-z0-9_]*)\(/gm)].map((m) => m[1]);
}

// ---- a minimal .xlsx writer, for fixtures -------------------------------------
// The reader is also run over real Excel-made workbooks by hand (see the final
// report); these are the shapes Excel produces, written here so the test is
// hermetic.

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    crc ^= buf[n];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** entries: [{ name, data: string|Buffer, deflate?: boolean, flags?: number }] */
export function makeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = Buffer.from(e.name);
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = e.deflate === false ? raw : deflateRawSync(raw);
    const method = e.deflate === false ? 0 : 8;
    const flags = e.flags || 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034B50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014B50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, eocd]));
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** sheets: [{ name, state?, xml }]; sharedXml optional. Builds the parts Excel writes. */
export function makeXlsx({ sheets, sharedXml, absoluteTargets = false, deflate = true }) {
  const entries = [
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', deflate },
    { name: "xl/workbook.xml", deflate, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS}><sheets>`
      + sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("")
      + "</sheets></workbook>" },
    { name: "xl/_rels/workbook.xml.rels", deflate, data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="${absoluteTargets ? "/xl/" : ""}worksheets/sheet${i + 1}.xml"/>`).join("")
      + `<Relationship Id="rId99" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, deflate,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><dimension ref="A1:Z99"/><cols><col min="1" max="1" width="30"/></cols><sheetData>${s.xml}</sheetData></worksheet>` })),
  ];
  if (sharedXml !== undefined) {
    entries.push({ name: "xl/sharedStrings.xml", deflate, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst ${NS}>${sharedXml}</sst>` });
  }
  return makeZip(entries);
}

/** A tiny assertion runner for the files that are plain scripts. */
export function runner() {
  let pass = 0, fail = 0;
  const failures = [];
  return {
    ok(label, cond, detail = "") {
      if (cond) { pass++; console.log("  ok    " + label); }
      else { fail++; failures.push(label); console.log("  FAIL  " + label + (detail ? "  -- " + detail : "")); }
    },
    eq(label, got, want) {
      const same = JSON.stringify(got) === JSON.stringify(want);
      this.ok(label, same, same ? "" : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    },
    done() {
      console.log(`\n${pass} passed, ${fail} failed`);
      if (fail) process.exit(1);
    },
  };
}
