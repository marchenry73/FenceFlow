// The price-list dialog as it is wired into the office page: that the entry
// points exist and are gated, that nothing in it can add or delete a catalog
// row, that no dependency was added to a single static page, that every string
// it shows exists in all three languages, and that a PDF and an old .xls are
// refused with a way forward rather than fed to a text parser.
//
// Source-text checks, scoped to the price-list section so a word elsewhere on a
// 25,000-line page cannot satisfy or break them. The behavioural half (what the
// functions DO) is in a27-pricelist-parse and a27-pricelist-plan.
//
// Run:  node tests/a27-pricelist-page.test.mjs
import { src, grab, loadTL, ppRegion, ppFunctionNames, runner } from "./a27-pricelist-lib.mjs";

const t = runner();
const region = ppRegion();
const staticMarkup = src.replace(/<script[\s\S]*?<\/script>/g, "");
const count = (text, needle) => text.split(needle).length - 1;
const bodyOf = (name) => grab(name).slice(grab(name).indexOf("{") + 1);

console.log("\n-- the page has the entry point, once, hidden until the role is known");
for (const id of ["catPriceList", "ppOverlay", "ppClose", "ppMsg", "ppSupplier", "ppFile", "ppText", "ppReadBtn", "ppColName", "ppColPrice", "ppColSku",
  "ppColUnit", "ppAssign", "ppSaveSku", "ppPreviewBox", "ppPreviewBody", "ppApplyBtn", "ppSelCount", "ppDoneBox", "ppUndoBtn", "ppSaveOldBtn", "ppNoSuppliers", "ppAddSupplier", "ppSheet"]) {
  t.eq(`#${id} is in the markup exactly once`, count(staticMarkup, `id="${id}"`), 1);
}
t.ok("the Catalog button starts hidden, so nobody sees it before their role is known",
  /id="catPriceList"[^>]*style="display:none"/.test(staticMarkup));
{
  const rc = grab("renderCatalog");
  t.ok("renderCatalog shows it only when canEdit() says so", /catPriceList[\s\S]{0,80}canEdit\(\)\s*\?\s*''\s*:\s*'none'/.test(rc), rc.slice(0, 300));
}
t.ok("the file chooser takes spreadsheets as well as csv, and also lists .pdf and .xls so the refusal message can be reached",
  /id="ppFile"[^>]*accept="[^"]*\.csv[^"]*\.xlsx[^"]*"/.test(staticMarkup) && /id="ppFile"[^>]*accept="[^"]*\.pdf/.test(staticMarkup) && /id="ppFile"[^>]*accept="[^"]*\.xls[,"]/.test(staticMarkup));

console.log("\n-- every entry point checks the role itself, first thing");
for (const name of ["openPriceListDialog", "ppOnFile", "ppOnPaste", "ppApply", "ppUndo"]) {
  const body = bodyOf(name).replace(/\s+/g, " ").trim();
  t.ok(`${name}() begins with a canEdit() refusal`, /^if\(!canEdit\(\)\) return;/.test(body) || /^if\(!canEdit\(\) \|\|[^;]*\) return;/.test(body), body.slice(0, 80));
}
t.ok("the dialog cannot be closed, or a second write started, while one is in flight",
  /if\(ppBusy\) return;/.test(bodyOf("ppCloseDialog")) && /ppBusy/.test(bodyOf("ppApply")) && /ppBusy/.test(bodyOf("ppUndo")));

console.log("\n-- what the section is allowed to do to the database");
t.ok("it never inserts, upserts, deletes or calls a function (a Set's own .delete does not count)",
  !/\.(insert|upsert|delete|rpc)\(/.test(region.replace(/selected\.delete\(/g, "")));
t.ok("positive control: that check does see a database delete", /\.(insert|upsert|delete|rpc)\(/.test("db.from('material_items').delete().eq('a', 1)"));
t.ok("it never mentions the service key", !/service_role|SERVICE_ROLE/.test(region.replace(/\/\*[\s\S]*?\*\//g, "")));
t.eq("the only table it touches is material_items", [...new Set([...region.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]))], ["material_items"]);
t.eq("and it touches it in exactly two places: one read, one write", count(region, ".from('material_items')"), 2);
t.ok("the read is ppRefreshItems, which pages through every live row",
  grab("ppRefreshItems").includes(".from('material_items')") && /\.select\('\*'\)/.test(grab("ppRefreshItems")) && /\.range\(/.test(grab("ppRefreshItems"))
  && !/\.update\(/.test(grab("ppRefreshItems")));
t.ok("the write is ppWriteRows, which reads every row back", grab("ppWriteRows").includes(".from('material_items')") && /\.update\(/.test(grab("ppWriteRows")) && /ppVerifyRow/.test(grab("ppWriteRows")));
t.eq("an update is issued from exactly one place", count(region, ".update("), 1);
{
  const code = region.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // The only places updated_at may appear: asked for in the read-back, tested for in a guard,
  // and carried from one write's answer into the guard of the next. Strip those idioms; nothing
  // may be left, because a value written into updated_at would beat the touch trigger's clock.
  const left = code
    .replace(/'updated_at'/g, "")
    .replace(/guard: { updated_at: w.after.updated_at }/g, "")
    .replace(/{ updated_at: r.row.updated_at }/g, "");
  t.ok("updated_at is only ever read back or used as an undo guard, never written", !/updated_at/.test(left),
    (left.match(/.{30}updated_at.{30}/) || [""])[0]);
  t.ok("positive control: a write of updated_at WOULD be seen", /updated_at/.test("const patch = { unit_price: 1, updated_at: new Date() };".replace(/'updated_at'/g, "")));
}
t.ok("the patch is built in ppPatchFor and has no updated_at, no deleted_at, no is_active", (() => {
  const b = grab("ppPatchFor");
  return !/updated_at|deleted_at|deleted_by|is_active|taxable|fence_type|category|role/.test(b);
})());

console.log("\n-- no new dependency on a single static page");
t.eq("the page loads exactly the two scripts it loaded before", [...src.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]), ["vendor/purify.min.js", "config.js"]);
t.ok("the section imports nothing and fetches nothing", !/\bimport\s*\(|\bimport\s+[\w{*]|\bfetch\(|XMLHttpRequest|https?:\/\//.test(region.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")));
t.ok("it reaches DecompressionStream through globalThis, so a browser without it is detected rather than crashing", /globalThis\.DecompressionStream/.test(grab("ppZipRead")));

console.log("\n-- a PDF and an old .xls are refused, with a way forward");
{
  const f = grab("ppOnFile");
  t.ok("a PDF is refused before any parser sees it", /kind === 'pdf'\)\s*\{\s*refuse\('ppPdfRefused'\)/.test(f));
  t.ok("an OLE container (old .xls, password-protected .xlsx) is refused", /kind === 'ole'\)\s*\{\s*refuse\('ppXlsRefused'\)/.test(f));
  t.ok("binary or markup is refused", /kind === 'other'\)\s*\{\s*refuse\('ppNotText'\)/.test(f));
  t.ok("the refusals come before the file is decoded or parsed", f.indexOf("ppPdfRefused") < f.indexOf("ppDecodeText") && f.indexOf("ppXlsRefused") < f.indexOf("ppXlsxOpen"));
  t.ok("the file's size is capped before it is read", f.indexOf("PP_MAX_BYTES") > 0 && f.indexOf("PP_MAX_BYTES") < f.indexOf("arrayBuffer"));
}
{
  const TL = loadTL();
  t.ok("the PDF message tells him what to do instead: CSV or .xlsx", /CSV/.test(TL.en.ppPdfRefused) && /\.xlsx/.test(TL.en.ppPdfRefused) && /spreadsheet|Excel/.test(TL.en.ppPdfRefused));
  t.ok("the .xls message tells him what to do instead", /Save As/.test(TL.en.ppXlsRefused) && /\.xlsx|CSV/.test(TL.en.ppXlsRefused));
  t.ok("the dialog's own hint says PDF cannot be read, up front", /PDF/.test(TL.en.ppFileHint) && /cannot be read reliably/.test(TL.en.ppFileHint));
  t.ok("who may do it is stated on the dialog", /Owners and managers/.test(TL.en.ppIntro));
}

console.log("\n-- every string it shows exists in English, Spanish and French");
{
  const TL = loadTL();
  const overlay = src.slice(src.indexOf('<div class="overlay" id="ppOverlay">'), src.indexOf('<div class="overlay" id="satOverlay">'));
  const used = new Set();
  for (const m of region.matchAll(/\b(?:tr|ppTr|t)\(\s*'((?:pp|imp)[A-Za-z]+)'/g)) used.add(m[1]);
  for (const m of region.matchAll(/\b(?:refuse|note)\(\s*'(pp[A-Za-z]+)'/g)) used.add(m[1]);
  for (const m of region.matchAll(/'(ppCol(?:Choose|None))'/g)) used.add(m[1]);
  for (const m of overlay.matchAll(/data-t="([A-Za-z]+)"/g)) used.add(m[1]);
  for (const m of src.matchAll(/data-t="(ppOpenBtn)"/g)) used.add(m[1]);
  used.add("impPricelistNoUpdate");
  t.ok("the harness found the keys to check (more than 50)", used.size > 50, String(used.size));
  for (const lang of ["en", "es", "fr"]) {
    const missing = [...used].filter((k) => !(k in TL[lang]));
    t.eq(`${lang} has every key the dialog uses`, missing, []);
  }
  const ppKeys = (l) => Object.keys(TL[l]).filter((k) => /^pp[A-Z]/.test(k) || k === "impPricelistNoUpdate").sort();
  t.eq("es and fr carry exactly the keys en does", [ppKeys("es"), ppKeys("fr")], [ppKeys("en"), ppKeys("en")]);
  const slots = (s) => (s.match(/%s/g) || []).length;
  const off = ppKeys("en").filter((k) => slots(TL.en[k]) !== slots(TL.es[k]) || slots(TL.en[k]) !== slots(TL.fr[k]));
  t.eq("and every string takes the same number of %s in all three, so a translation cannot shift an argument", off, []);
  const same = ppKeys("en").filter((k) => TL.es[k] === TL.en[k] && TL.en[k].length > 12);
  t.eq("no Spanish string is a left-over copy of the English", same, []);
  t.ok("no string uses a straight apostrophe or a backslash that would end the quoted value early", ppKeys("en").every((k) => !/['\\]/.test(TL.en[k] + TL.es[k] + TL.fr[k])));
}

console.log("\n-- the old importer no longer stays silent about prices it threw away");
{
  const pv = grab("previewImport");
  const branch = pv.slice(pv.indexOf("kind==='pricelist'"), pv.indexOf("} else {", pv.indexOf("kind==='pricelist'")));
  t.ok("a 'Their price list' preview that skipped rows already in the catalog says their prices were not applied",
    /if\(dupes\)[^;]*impPricelistNoUpdate/.test(branch));
  t.ok("and that sentence says where updating lives", /Update prices from a price list/.test(loadTL().en.impPricelistNoUpdate));
}

console.log("\n-- the functions this section defines are all reachable");
{
  const names = ppFunctionNames();
  t.ok("found the section's functions", names.length > 40, String(names.length));
  const orphans = names.filter((n) => count(src, n + "(") + count(src, n + ",") + count(src, n + ")") < 2 && !["ppU16", "ppU32"].includes(n));
  t.eq("every one is defined and used (no dead function left behind)", orphans, []);
}

t.done();
