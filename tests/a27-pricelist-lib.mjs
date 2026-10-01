// Shared by the a27-pricelist-*.test.mjs files. Not a test itself.
//
// Lifts the REAL functions out of the office page and runs them, rather than
// re-implementing them here: a copy would keep passing after the page's own
// code stopped doing what the copy does. The page under test is
// website/dashboard.html unless A27_PAGE names another file, which is how the
// red runs are done -- the same tests pointed at a scratch copy of the page with
// one guard removed, to prove each check can actually fail.
import { readFileSync, existsSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

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
export function load(names, scope = {}, prelude = "", expose = {}, text = src) {
  const code = names.map((n) => grab(n, text)).join("\n\n");
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

// ---- PDF support, for the a45-pdf-*.test.mjs files ------------------------------------------
// The real supplier PDFs are the acceptance test, so they are read from where they were saved
// (A45_PDF_DIR names another folder). A missing file is a FAILURE, never a skip: a test that
// quietly does not run reads as a test that passes.

export const PDF_DIR = process.env.A45_PDF_DIR || "C:/Users/march/Downloads";
export const REAL_PDFS = {
  flori6: "Estimate 17827.pdf",
  flori4: "Estimate 17828.pdf",
  hartford: "Est_64792_from_Hartford_Fence_Supply_27668.pdf",
};

export function realPdf(key) {
  const p = join(PDF_DIR, REAL_PDFS[key]);
  if (!existsSync(p)) throw new Error(`the real supplier PDF is not on this machine: ${p} (set A45_PDF_DIR to the folder that holds it)`);
  return new Uint8Array(readFileSync(p));
}

/** The value of a one-line `const NAME = ...;` on the page. */
export function pageConst(name, text = src) {
  return new Function("return " + grabConstLine(name, text).replace(/^const \w+ = /, "").replace(/;$/, ""))();
}

/** Where a copy of PDF.js at the page's pinned version can be found: A45_PDFJS_DIR (the folder
    holding pdf.min.mjs and pdf.worker.min.mjs), a node_modules next to the repo, or the scratch
    install the supplier-quote work was done against. Nothing is downloaded by a test. */
export function pdfJsDirs() {
  const dirs = [];
  if (process.env.A45_PDFJS_DIR) dirs.push(process.env.A45_PDFJS_DIR);
  dirs.push(join(process.cwd(), "node_modules/pdfjs-dist/build"), "C:/tmp/node_modules/pdfjs-dist/build");
  return dirs;
}

const sha384 = (buf) => createHash("sha384").update(buf).digest("base64");

/** PDF.js from disk -- and the proof that it is the very build the page will fetch: the SHA-384 of
    both files must equal the fingerprints written into the page. A different version on disk
    would otherwise make every PDF test pass or fail for the wrong reason. */
export async function loadPdfJs() {
  const dir = pdfJsDirs().find((d) => existsSync(join(d, "pdf.min.mjs")) && existsSync(join(d, "pdf.worker.min.mjs")));
  if (!dir) {
    throw new Error("PDF.js " + pageConst("PP_PDFJS_VERSION") + " is not installed where the tests look. Run `npm install pdfjs-dist@"
      + pageConst("PP_PDFJS_VERSION") + "` in an empty folder and point A45_PDFJS_DIR at node_modules/pdfjs-dist/build. Looked in: " + pdfJsDirs().join(", "));
  }
  const libBytes = readFileSync(join(dir, "pdf.min.mjs")), workerBytes = readFileSync(join(dir, "pdf.worker.min.mjs"));
  const got = { lib: sha384(libBytes), worker: sha384(workerBytes) };
  const want = { lib: pageConst("PP_PDFJS_LIB_SHA384"), worker: pageConst("PP_PDFJS_WORKER_SHA384") };
  const lib = await import(pathToFileURL(join(dir, "pdf.min.mjs")).href);
  lib.GlobalWorkerOptions.workerSrc = pathToFileURL(join(dir, "pdf.worker.min.mjs")).href;
  return { lib, dir, got, want, libBytes, workerBytes, matchesPage: got.lib === want.lib && got.worker === want.worker && lib.version === pageConst("PP_PDFJS_VERSION") };
}

export const PDF_CONST_NAMES = ["PP_PDF_MAX_PAGES", "PP_PDF_NUM", "PP_PDF_DECOR", "PP_PDF_SUBTOTAL", "PP_PDF_TOTAL", "PP_PDF_TAX", "PP_PDF_WHY",
  "PP_PDFJS_VERSION", "PP_PDFJS_LIB_URL", "PP_PDFJS_LIB_SHA384", "PP_PDFJS_WORKER_URL", "PP_PDFJS_WORKER_SHA384"];

/** The PDF reading functions from the page, plus what they lean on. `scope` supplies page globals
    (fetch, URL, Blob...) a test wants to replace. `extra` is more page functions to load. */
export function loadPdfFns(extra = [], scope = {}, text = src, extraPrelude = "") {
  const names = ["ppClassifyHeader", "ppUnitCode", "ppParsePrice", "ppMoney", "ppNorm", "ppTr",
    "ppPdfSha384", "ppPdfFetchVerified", "ppPdfLib", "ppPdfPages", "ppPdfNum", "ppPdfLines", "ppPdfHeaderRole", "ppPdfFindHeader",
    "ppPdfCells", "ppPdfRelation", "ppPdfAssign", "ppPdfJudge", "ppPdfParse", "ppPdfReconcile", "ppPdfRowsForPlan", "ppPdfRead",
    "ppWhyText", "ppPdfLineHtml", "ppPdfCountsHtml"].concat(extra);
  const NL = String.fromCharCode(10);
  const prelude = PDF_CONST_NAMES.map((n) => grabConstLine(n, text)).join(NL) + NL + "let ppPdfLibPromise = null;" + NL + extraPrelude + NL;
  return load(names, scope, prelude, { libPromise: "(() => ppPdfLibPromise)" }, text);
}

// ---- a minimal PDF writer, for fixtures ------------------------------------------------------
// pages: [{ texts: [{ x, y, s, size? }], image?: true, rotate?: 90 }]. Text is Helvetica, drawn at the
// given point; `image` puts a picture on the page and no text, which is what a scan is.
export function makePdf(pages) {
  const enc = (s) => Buffer.from(s, "latin1");
  const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const objs = [];
  const add = (b) => { objs.push(Buffer.isBuffer(b) ? b : enc(b)); return objs.length; };
  const stream = (dict, data) => Buffer.concat([enc(`${dict} /Length ${data.length} >>\nstream\n`), data, enc("\nendstream")]);
  add(""); add("");                                   // 1 catalog, 2 pages: filled in below
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");   // 3
  const kids = [];
  for (const pg of pages) {
    let content = "", xobj = "";
    if (pg.image) {
      const im = add(stream("<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8",
        Buffer.from([0, 64, 128, 255, 255, 128, 64, 0, 0, 64, 128, 255, 255, 128, 64, 0])));
      content += "q 400 0 0 400 100 200 cm /Im1 Do Q\n";
      xobj = `/XObject << /Im1 ${im} 0 R >>`;
    }
    for (const t of pg.texts || []) {
      // `landscape` gives the text in the page as DISPLAYED (792 wide, 612 tall, y up) and writes it the way a
      // landscape page is usually made: a portrait sheet marked /Rotate 90 with the text turned to match.
      const x = pg.landscape ? 612 - t.y : t.x, y = pg.landscape ? t.x : t.y;
      const a = (((t.angle || 0) + (pg.landscape ? 90 : 0)) * Math.PI) / 180, c = Math.cos(a).toFixed(6), s = Math.sin(a).toFixed(6);
      content += `BT /F1 ${t.size || 10} Tf ${c} ${s} ${-s} ${c} ${x} ${y} Tm (${esc(t.s)}) Tj ET\n`;
    }
    const c = add(stream("<<", enc(content)));
    const rotate = pg.landscape ? 90 : pg.rotate;
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${rotate ? ` /Rotate ${rotate}` : ""} /Contents ${c} 0 R /Resources << /Font << /F1 3 0 R >> ${xobj} >> >>`));
  }
  objs[0] = enc("<< /Type /Catalog /Pages 2 0 R >>");
  objs[1] = enc(`<< /Type /Pages /Kids [${kids.map((k) => k + " 0 R").join(" ")}] /Count ${kids.length} >>`);
  const parts = [enc("%PDF-1.4\n")], offsets = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([enc(`${i + 1} 0 obj\n`), o, enc("\nendobj\n")]);
    parts.push(b); pos += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  parts.push(enc(xref + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

// ---- the price-list dialog, run whole with a fake page around it --------------------------------
/** `const NAME = expr;` even when a trailing comment follows the semicolon. */
export function grabConstLoose(name, text = src) {
  const m = new RegExp("^const " + name + "\\s*=\\s*([^;]*);", "m").exec(text);
  if (!m) throw new Error("const not found on the page: " + name);
  return "const " + name + " = " + m[1] + ";";
}

/** The English strings as the page's own tr() would build them. */
export function makeTr(text = src) {
  const TL = loadTL(text);
  return (key, ...args) => {
    let out = (TL.en && TL.en[key]) || "";
    args.forEach((a) => { out = out.replace("%s", a); });
    return out;
  };
}

/** Every `pp*` function of the page, wired to: a fake DOM (any id gives an element), a fake database that
    answers the catalog read and RECORDS every write it is asked for (`writes`), the English strings, and a
    stand-in for the network that serves PDF.js from disk (`served` lists what it was asked for). The same
    code the office runs, so what a test sees is what the dialog does. `items` is the catalog, `mfrs` the
    suppliers. `text` is the page source, so a red run can hand in a copy with one guard removed. */
export async function pdfDialog({ items = [], mfrs = [], text = src, extraScope = {}, writable = false } = {}) {
  const pdfjs = await loadPdfJs();
  const els = {}, msgs = [], writes = [], served = [];
  const el = (id) => (els[id] ||= { id, style: {}, value: "", checked: true, textContent: "", innerHTML: "", className: "", dataset: {} });
  const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const recordWrite = (kind) => () => { writes.push(kind); throw new Error("a write was attempted: " + kind); };
  // With `writable`, a material_items update is applied to the row in `items` and answered the way the server does
  // (the row back, so ppWriteRows can verify it); every write is recorded in `writes` as "update:<sync_id>:<patch>".
  // Anything else -- insert, upsert, delete, rpc, or an update when not writable -- is refused and recorded.
  const update = (table) => (patch) => {
    const q = { _id: null };
    q.eq = (col, v) => { if (col === "sync_id") q._id = v; return q; };
    q.is = () => q;
    q.select = async () => {
      const row = items.find((r) => r.sync_id === q._id);
      writes.push(`update:${q._id}:${JSON.stringify(patch)}`);
      if (!row) return { data: [], error: null };
      Object.assign(row, patch, { updated_at: "2026-10-01T12:00:00.000Z" });
      return { data: [{ ...row }], error: null };
    };
    return q;
  };
  const db = {
    from(table) {
      const q = {
        select: () => q, is: () => q, order: () => q, eq: () => q,
        range: async (a, b) => ({ data: items.slice(a, b + 1), error: null }),
        update: writable && table === "material_items" ? update(table) : recordWrite("update:" + table),
        insert: recordWrite("insert:" + table),
        upsert: recordWrite("upsert:" + table), delete: recordWrite("delete:" + table),
      };
      return q;
    },
    rpc: recordWrite("rpc"),
  };
  const scope = {
    $: el, db, profile: { company_id: "co-1" }, manufacturers: mfrs, catalog: items, canEdit: () => true,
    msg: (id, t, kind) => { msgs.push({ id, text: t, kind }); }, tr: makeTr(text),
    plainError: (s) => s, catFenceTypeLabel: (s) => s, bizPretty: (s) => s, refreshCatalog: async () => {}, downloadCsv() {},
    fetch: async (url) => {
      served.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => toAB(String(url).endsWith("pdf.min.mjs") ? pdfjs.libBytes : pdfjs.workerBytes) };
    },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: (blob) => "data:text/javascript;base64," + Buffer.from(blob.parts[0]).toString("base64") },
    ...extraScope,
  };
  const prelude = [grabConstLine("esc", text), grabConstLoose("PP_MAX_BYTES", text), grabConstLoose("PP_MAX_ROWS", text)]
    .concat(PDF_CONST_NAMES.map((n) => grabConstLine(n, text))).join("\n")
    + "\nlet ppState = null, ppLast = null, ppBusy = false, ppPdfLibPromise = null;\n";
  const names = ppFunctionNames(text).concat(["isSeededUnverifiedPrice", "manufacturerName"]);
  const P = load(names, scope, prelude, { state: "(() => ppState)" }, text);
  const file = (bytes, name) => ({ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  return { P, el, msgs, writes, served, pdfjs, file, state: () => P.state() };
}
