// a46-catalog-height-office-chain -- does a height typed on the office catalog page reach the engines, and where
// does a height still get lost?
//
// The catalog page now writes material_items.height_ft (tests/a46-catalog-height-office-editor.test.mjs holds the
// page). This file holds the hops AFTER it, read out of the sources, because a box that saves a number nothing
// reads is the worst outcome this change can have:
//
//   hop 1  the page's write           an upsert to material_items on (company_id, sync_id), never carrying updated_at
//   hop 2  the database clock         touch_updated_at() bumps updated_at for ANY column not on its quiet list --
//                                     so a changed height_ft moves the clock the phone pulls by
//   hop 3  the phone's pull           per row, cloud updated_at newer than the local clock -> the cloud row is
//                                     copied in, heightFt with it, on all three copy paths; a crew phone reads
//                                     material_items_crew, which carries height_ft and no price
//   hop 4  the engines                the phone's EstimateEngine reads MaterialItem.heightFt; the office's
//                                     price-job reads catalog columns BY NAME -- see the todo below
//
// And it pins, as GAPs, the places a row is still created or changed with no height, so that the day somebody
// closes one the test says so instead of passing quietly beside a changed behaviour.
//
//   node --test tests/a46-catalog-height-office-chain.test.mjs        (no network, no writes)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Line endings normalised: a checkout with core.autocrlf turns every file CRLF, and these checks match across line breaks.
const read = (rel) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const SRC = read("website/dashboard.html");
const KT = "app/src/main/java/com/fenceestimator/app/";

function grabFn(src, name) {
  const re = new RegExp("(^|\\n)(async )?function " + name + "\\(");
  const m = re.exec(src);
  if (!m) throw new Error("function not found: " + name);
  const start = m.index + m[1].length;
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error("unbalanced: " + name);
}

// ======================================================= hop 1: the page's write ==
test("hop 1: the page saves through ONE upsert to material_items on (company_id, sync_id), and never names updated_at", () => {
  const save = grabFn(SRC, "saveCatItemDialog");
  assert.match(save, /db\.from\('material_items'\)\s*\.upsert\(\{ \.\.\.row, company_id: profile\.company_id \}, \{ onConflict: 'company_id,sync_id' \}\)/);
  const payload = grabFn(SRC, "catalogItemPayload");
  assert.equal(/updated_at/.test(payload.replace(/\/\/[^\n]*/g, "")), false, "the payload builder never sets updated_at: the trigger owns the clock");
  assert.match(save, /form\.height_ft = h\.value;/, "the typed height is put on the form that becomes the payload");
  assert.equal([...SRC.matchAll(/db\.from\('material_items'\)\s*\n?\s*\.upsert\(/g)].length, 1, "one upsert into material_items on this page, so there is no second save path to forget the height");
});

// ================================================== hop 2: the database clock ==
/** Every definition of touch_updated_at in the repo's migrations: the quiet list each one declares. */
function quietLists() {
  const out = [];
  for (const f of readdirSync(ROOT).filter((n) => /^supabase_.*\.sql$/.test(n))) {
    const text = read(f);
    for (const m of text.matchAll(/quiet constant text\[\] := array\[([\s\S]*?)\];/g)) out.push({ file: f, list: [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) });
  }
  return out;
}
const silencesHeight = (defs) => defs.filter((d) => d.list.includes("height_ft")).map((d) => d.file);
test("hop 2: no migration puts height_ft on touch_updated_at's quiet list, so changing a height bumps updated_at", () => {
  const defs = quietLists();
  assert.ok(defs.length >= 5, "control: the quiet lists were found (" + defs.length + ")");
  assert.ok(defs.every((d) => d.list.includes("updated_at")), "control: each list is the real thing (it names updated_at itself)");
  assert.deepEqual(silencesHeight(defs), []);
  // TEETH: a list that did name height_ft would be reported.
  const planted = defs.concat([{ file: "planted.sql", list: [...defs[0].list, "height_ft"] }]);
  assert.deepEqual(silencesHeight(planted), ["planted.sql"], "the check can fail");
});

// ================================================= hop 3: the phone's pull ==
test("hop 3: the phone pulls by comparing each row's updated_at, and copies heightFt on every path it copies a row", () => {
  const kt = read(KT + "cloud/EntitySync.kt");
  const at = kt.indexOf("private suspend fun pullCatalog");
  const pull = kt.slice(at, kt.indexOf("private suspend fun pullJobChildren", at));
  assert.ok(at > 0 && pull.length > 500, "control: the function was found");
  assert.match(pull, /row\.updatedAtMillis\(\) > existing\.lastUpdated/, "the clock compare the office write relies on");
  assert.equal([...pull.matchAll(/heightFt = row\.heightFt,/g)].length, 3, "the three places a cloud row is copied in");
  assert.match(pull, /"material_items_crew"/, "a crew phone reads the crew door");
  assert.match(pull, /pagedList<CloudMaterialItem>\("material_items"\)/, "and the others read the base table");
  // The crew door carries the height and no price (a40 holds the whole definition; this is the pointer).
  const view = read("supabase_a40_material_height.sql").match(/create or replace view public\.material_items_crew[\s\S]*?from public\.material_items/i)[0];
  assert.match(view, /height_ft\s*\n?\s*from public\.material_items/);
  assert.equal(/unit_price|supplier_sku/.test(view), false, "and no price");
});

test("hop 4a: the phone's engine reads the column the page writes", () => {
  const engine = read(KT + "estimate/EstimateEngine.kt");
  assert.match(engine, /c\.heightFt == run\.panelHeightFt/);
  const ts = read("supabase/functions/_shared/pricing/line-items.ts");
  assert.match(ts, /c\.heightFt === run\.panelHeightFt/);
});

// ============================================== hop 4b: the office's own engine ==
const catalogColumns = () => (read("supabase/functions/price-job/index.ts").match(/const CATALOG_COLUMNS = ([\s\S]*?);\n/) || [])[1] || "";
test("control: price-job's CATALOG_COLUMNS is readable and is the string that picks the catalog columns by name", () => {
  const cols = catalogColumns();
  assert.match(cols, /covers_ft/, "it names covers_ft");
  assert.match(cols, /unit_price/);
  assert.equal([...read("supabase/functions/price-job/index.ts").matchAll(/\.select\(CATALOG_COLUMNS\)/g)].length, 2, "and both catalog reads (a job, and a sample) use it");
});
// Was a todo while CATALOG_COLUMNS did not name height_ft. FIXED IN THE SOURCE on 2 Oct 2026, so it is a real
// assertion now -- a todo that has started passing reports as a pass and would never tell anyone it had been fixed.
//
// STILL NOT TRUE OF THE DEPLOYED FUNCTION: price-job in production is version 12 of 5 Sep 2026 (supabase functions
// list, read 2 Oct 2026), which predates both this column and the height rule itself. Until it is redeployed the
// office keeps pricing every panel and post as if no height were set, whatever this page saves and whatever this
// file asserts about the source. docs/OFFICE_DEPLOY_PENDING.md is the one-page version of that, and
// tests/a63-office-height-parity.test.mjs measures what the difference is worth.
test("price-job selects height_ft, so a height set on the catalog page reaches the OFFICE re-price", () => {
  assert.match(catalogColumns(), /height_ft/);
});

// ============================================ the places a row still lands with no height ==
test("GAP (pinned): the Jobs-page price-list import creates catalog rows with no height_ft, no covers_ft and no supplier", () => {
  const run = grabFn(SRC, "runImport");
  const at = run.indexOf("const chunk=impReady.slice(i,i+100).map(p=>({");
  assert.ok(at > 0, "control: the pricelist insert was found");
  const chunk = run.slice(at, run.indexOf("}));", at));
  assert.match(chunk, /unit_price:p\.price\|\|0/, "control: it is the catalog insert");
  for (const col of ["height_ft", "covers_ft", "manufacturer_sync_id"]) assert.equal(chunk.includes(col), false, col + " is not written by the import");
  assert.match(SRC, /function impMaterial\(/, "the role (PANEL, ...) is guessed from the item name, which is why a height cannot be read from it either");
});
test("GAP (pinned): the New-client wizard's 'Add to catalog and re-price' form creates a row of the missing role with no height", () => {
  const add = grabFn(SRC, "wizAddCatalogItem");
  assert.match(add, /unit_price: price/, "control");
  assert.equal(/height_ft|covers_ft/.test(add), false);
});
test("GAP (pinned): 'Start from FenceFlow's catalog' inserts the starting list with no heights", () => {
  const start = SRC.indexOf("const CATALOG_SEED = ");
  const open = SRC.indexOf("[", start);
  let depth = 0, end = -1;
  for (let j = open; j < SRC.length; j++) { if (SRC[j] === "[") depth++; else if (SRC[j] === "]") { depth--; if (!depth) { end = j; break; } } }
  const seed = SRC.slice(open, end + 1);
  assert.ok(/role:'PANEL'/.test(seed) || /role: *'PANEL'/.test(seed) || /PANEL/.test(seed), "control: the seed list was read and has panels");
  assert.equal(/height_ft/.test(seed), false, "no seed row carries a height");
  assert.match(grabFn(SRC, "startFromSeedCatalog"), /toAdd\.map\(s => \(\{ \.\.\.s, sync_id: crypto\.randomUUID\(\), company_id: profile\.company_id \}\)\)/, "and the insert is the seed row as it is");
});
test("an 'Update prices from a price list' write cannot lose or overwrite a height: it names only price, supplier, sku and source", () => {
  const body = grabFn(SRC, "ppPatchFor");
  const keys = [...body.matchAll(/\bp\.([a-z_]+) =/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["manufacturer_sync_id", "source_doc", "supplier_sku", "unit_price"]);
});
