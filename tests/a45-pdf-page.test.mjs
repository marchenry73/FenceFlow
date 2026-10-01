// The PDF reader as it is wired into the office page: where it comes from, that it is checked before it
// runs, that it is fetched only when somebody adds a PDF, that nothing in it can write to the database,
// that every message it can show exists in all three languages, and that the markup it needs is there.
//
// Source-text checks, scoped to the price-list section so a word elsewhere on a 27,000-line page cannot
// satisfy or break them. What the functions DO is in a45-pdf-real-files and a45-pdf-synthetic.
//
// WHY THIS FILE EXISTS ALONGSIDE a27-pricelist-page.test.mjs. That file was written when a PDF was refused
// and the section imported and fetched nothing. Two of its assertions say exactly that and are now false by
// design: "a PDF is refused before any parser sees it" and "the section imports nothing and fetches nothing".
// The guard they stood for -- no unvetted code, nothing loaded behind the owner's back -- is restated here
// for what the section now does: one library, one version, one fingerprint each, loaded on demand.
//
// Run:  node tests/a45-pdf-page.test.mjs
import { src, grab, loadTL, ppRegion, grabConstLine, pageConst, runner } from "./a27-pricelist-lib.mjs";

const t = runner();
const region = ppRegion();
const count = (text, needle) => text.split(needle).length - 1;
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const pdfBlock = (() => {
  const a = region.indexOf("/* ---------- PDF: supplier quotes and price lists that carry text");
  const b = region.indexOf("/* ---------- reading the columns ---------- */");
  if (a < 0 || b < a) throw new Error("the PDF section is not where it should be");
  return region.slice(a, b);
})();
const bodyOf = (name) => grab(name).slice(grab(name).indexOf("{") + 1);

console.log("\n-- one library, one exact version, one fingerprint per file");
{
  const ver = pageConst("PP_PDFJS_VERSION");
  t.ok("the version is an exact x.y.z, not a range", /^\d+\.\d+\.\d+$/.test(ver), ver);
  for (const [name, file] of [["PP_PDFJS_LIB_URL", "pdf.min.mjs"], ["PP_PDFJS_WORKER_URL", "pdf.worker.min.mjs"]]) {
    t.eq(`${name} is jsDelivr's copy of pdfjs-dist at exactly that version`, pageConst(name), `https://cdn.jsdelivr.net/npm/pdfjs-dist@${ver}/build/${file}`);
  }
  for (const name of ["PP_PDFJS_LIB_SHA384", "PP_PDFJS_WORKER_SHA384"]) {
    const v = pageConst(name);
    t.ok(`${name} is a SHA-384 in base64 (64 characters, 48 bytes)`, /^[A-Za-z0-9+/]{64}$/.test(v) && Buffer.from(v, "base64").length === 48, v);
  }
  t.ok("positive control: a 'latest' or ranged URL would not satisfy the check above", !/^\d+\.\d+\.\d+$/.test("latest") && !/^\d+\.\d+\.\d+$/.test("^4.6.82"));
  const urls = [...code(pdfBlock).matchAll(/https?:\/\/[^'"\s)]+/g)].map((m) => m[0]);
  t.eq("the PDF section names exactly two addresses, and no others", urls.sort(), [pageConst("PP_PDFJS_LIB_URL"), pageConst("PP_PDFJS_WORKER_URL")].sort());
  t.eq("the page loads exactly the two scripts it loaded before: the reader is not a <script> tag",
    [...src.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]), ["vendor/purify.min.js", "config.js"]);
  t.ok("and no stylesheet or link to it either", !/<link[^>]*pdf|<script[^>]*pdf/i.test(src));
}

console.log("\n-- fetched on demand, checked before anything runs, run from what was checked");
{
  const lib = bodyOf("ppPdfLib").replace(/\s+/g, " ");
  t.eq("a dynamic import is made in exactly one place in the section: ppPdfLib", [count(code(region), "import("), count(code(grab("ppPdfLib")), "import(")], [1, 1]);
  t.eq("fetch is used in exactly one place: ppPdfFetchVerified", [count(code(region), "fetch)("), count(code(grab("ppPdfFetchVerified")), "fetch)(")], [1, 1]);
  t.ok("nothing else in the section calls fetch( or XMLHttpRequest", !/\bfetch\(|XMLHttpRequest|\bsendBeacon\(|\bWebSocket\b/.test(code(region)));
  t.ok("both files are downloaded and verified BEFORE either is turned into a runnable address",
    lib.indexOf("ppPdfFetchVerified(PP_PDFJS_LIB_URL") > -1 && lib.indexOf("ppPdfFetchVerified(PP_PDFJS_WORKER_URL") > -1
    && lib.indexOf("Promise.all") < lib.indexOf("createObjectURL") && lib.indexOf("createObjectURL") < lib.indexOf("import("));
  t.ok("what runs is made from the bytes that were checked (a blob address), not from the CDN address", /createObjectURL\(new Blob\(\[buf\]/.test(lib) && !/import\(PP_PDFJS/.test(lib));
  t.ok("the fingerprint is compared strictly and a mismatch throws", /!== sha384\)\s*throw new Error\('fingerprint'\)/.test(bodyOf("ppPdfFetchVerified").replace(/\s+/g, " ")));
  t.ok("the version the library reports is checked against the pin", /lib\.version !== PP_PDFJS_VERSION\)\s*throw/.test(lib));
  t.ok("a failed load is forgotten so the next PDF tries again", /\.catch\(\(\) => \{ ppPdfLibPromise = null; \}\)/.test(lib));
  t.ok("the request sends no cookies and no referrer", /credentials: 'omit'/.test(grab("ppPdfFetchVerified")) && /referrerPolicy: 'no-referrer'/.test(grab("ppPdfFetchVerified")));
  const callers = [...code(src).matchAll(/(?<!function )ppPdfLib\(\)/g)].length;
  t.eq("ppPdfLib() is called from one place only (ppPdfRead) and never at page load", [callers, /ppPdfLib\(\)/.test(code(grab("ppPdfRead"))), /^ppPdfLib\(\)/m.test(src)], [1, true, false]);
  t.ok("ppPdfRead is reached only from the file handler, which only a chosen PDF reaches",
    /kind === 'pdf'\)\s*\{[\s\S]*?await ppPdfRead\(bytes\)/.test(grab("ppOnFile")) && count(code(src), "ppPdfRead(") === 2);
  t.ok("the library is never loaded for a spreadsheet or pasted rows", !/ppPdfRead|ppPdfLib/.test(grab("ppOnPaste")) && !/ppPdfRead|ppPdfLib/.test(grab("ppXlsxOpen")));
  t.ok("positive control: the loader check above would see an import placed at page load", count("import('https://x')", "import(") === 1);
}

console.log("\n-- nothing in the PDF section can write, and nothing applies on its own");
{
  const c = code(pdfBlock) + code(grab("ppPdfCountsHtml")) + code(grab("ppPdfLineHtml")) + code(grab("ppWhyText")) + code(grab("ppUsePdf"));
  t.ok("no database call of any kind", !/\bdb\b|\.from\('|\.rpc\(|\.update\(|\.insert\(|\.upsert\(|\.delete\(/.test(c));
  t.ok("it never calls the function that writes, and never clicks the apply button", !/ppApply|ppWriteRows|ppApplyBtn|\.click\(/.test(c));
  t.ok("it never touches the selection: ticking is the only thing that adds a row to what will be written", !/\bselected\b/.test(c));
  t.ok("positive control: that check would see a write", /\.update\(/.test("db.from('x').update({})"));
  const rec = grab("ppRecompute");
  t.ok("a spreadsheet's unflagged changes are ticked by default and a PDF's are not, in one place", /if\(!st\.pdf\) st\.plan\.changes\.forEach\(/.test(rec));
  t.ok("a PDF's preview carries no 'apply' control of its own: the dialog's one button is the only one", count(src, 'id="ppApplyBtn"') === 1);
}

console.log("\n-- every message and reason it can give exists in English, Spanish and French");
{
  const TL = loadTL();
  const keys = new Set();
  for (const m of code(pdfBlock).matchAll(/refuse: '(pp[A-Za-z]+)'/g)) keys.add(m[1]);
  for (const m of code(pdfBlock).matchAll(/refuse: [^'\n]*\? '(pp[A-Za-z]+)' : '(pp[A-Za-z]+)'/g)) { keys.add(m[1]); keys.add(m[2]); }
  for (const v of Object.values(pageConst("PP_PDF_WHY"))) keys.add(v);
  for (const m of region.matchAll(/\b(?:tr|ppTr|t)\(\s*'(pp(?:Pdf|WhyPdf|ColPdf)[A-Za-z]*)'/g)) keys.add(m[1]);
  for (const m of region.matchAll(/'(ppPdf[A-Za-z]+)'/g)) if (m[1] !== 'ppPdfNote') keys.add(m[1]);   // ppPdfNote is an element id
  t.ok("found the keys (more than 20)", keys.size > 20, String(keys.size));
  t.ok("refusal keys include the scan, no-rows, ambiguous, garbled, locked, too-long, offline, fingerprint and damaged cases",
    ["ppPdfScanned", "ppPdfNoRows", "ppPdfAmbiguous", "ppPdfGarbled", "ppPdfLocked", "ppPdfTooLong", "ppPdfLibOffline", "ppPdfLibFingerprint", "ppPdfRefused"].every((k) => keys.has(k)), [...keys].join(","));
  for (const lang of ["en", "es", "fr"]) {
    t.eq(`${lang} has a non-empty string for every one`, [...keys].filter((k) => !(TL[lang][k] && TL[lang][k].length > 2)), []);
  }
  const slots = (s) => (s.match(/%s/g) || []).length;
  t.eq("each takes the same number of %s in all three languages", [...keys].filter((k) => slots(TL.en[k]) !== slots(TL.es[k]) || slots(TL.en[k]) !== slots(TL.fr[k])), []);
  t.eq("no Spanish or French string is a left-over copy of the English", [...keys].filter((k) => TL.en[k].length > 12 && (TL.es[k] === TL.en[k] || TL.fr[k] === TL.en[k])), []);
  t.ok("none uses a straight apostrophe or a backslash", [...keys].every((k) => !/['\\]/.test(TL.en[k] + TL.es[k] + TL.fr[k])));
  t.ok("the file hint no longer says every PDF is refused: it names what is read", /PDF quotes or price lists that contain real text/.test(TL.en.ppFileHint) && /scanned PDF/.test(TL.en.ppFileHint));
  t.ok("the old blanket claim is gone from every language", !/A PDF can’t be read reliably|Un PDF no se puede leer de forma confiable|Un PDF ne peut pas être lu de façon fiable/.test(Object.values(TL).map((l) => l.ppPdfRefused + l.ppFileHint).join("")));
  const why = Object.keys(pageConst("PP_PDF_WHY"));
  t.eq("every reason the parser can attach to a row has a key", why.sort(), ["pdfambig", "pdfcols", "pdfnoname", "pdfnoprice", "pdfnorel", "pdfrel"]);
  const emitted = new Set([...code(pdfBlock).matchAll(/why: '(pdf[a-z]+)'|\? '(pdf[a-z]+)'|'(pdf[a-z]+)'/g)].flatMap((m) => m.slice(1).filter(Boolean)));
  t.eq("and the parser emits no reason that has no key", [...emitted].filter((w) => !why.includes(w)), []);
}

console.log("\n-- the markup it needs is there exactly once, and the old comments no longer lie");
{
  const markup = src.replace(/<script[\s\S]*?<\/script>/g, "");
  for (const id of ["ppPdfNote", "ppColPickers", "ppColName", "ppColPrice", "ppColSku", "ppColUnit", "ppReadNote", "ppSheetWrap", "ppColsBox"]) {
    t.eq(`#${id} is in the markup exactly once`, count(markup, `id="${id}"`), 1);
  }
  t.ok("the four column pickers sit inside #ppColPickers, so putting it away puts all four away",
    /id="ppColPickers">[\s\S]*id="ppColName"[\s\S]*id="ppColPrice"[\s\S]*id="ppColSku"[\s\S]*id="ppColUnit"[\s\S]*<label id="ppAssignRow"/.test(markup));
  t.ok("the two checkboxes stay OUTSIDE it, because they apply to a PDF too", !/id="ppColPickers">[\s\S]*id="ppAssign"[\s\S]*<\/div>\s*<label id="ppAssignRow"/.test(markup) && markup.indexOf('id="ppAssign"') > markup.indexOf('id="ppColUnit"'));
  t.ok("the file chooser still lists .pdf", /id="ppFile"[^>]*accept="[^"]*\.pdf/.test(markup));
  t.ok("the section's header comment no longer says it will not read a PDF", !/Read a PDF\. Same reason/.test(region) && /A PDF IS read now/.test(region));
  t.ok("nothing on the page still tells him a PDF cannot be read at all", !/PDF or an old \.xls file cannot be read reliably/.test(src));
  t.ok("the stale refusal in ppOnFile is gone: a PDF is not refused before a parser sees it", !/kind === 'pdf'\)\s*\{\s*refuse\('ppPdfRefused'\)/.test(grab("ppOnFile")));
}

t.done();
