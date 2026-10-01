// Applying a supplier's price list: which catalog items it touches, what it
// writes, and what it refuses to do.
//
// Runs the page's own functions (see a27-pricelist-lib.mjs). The cases are the
// ones that change money without looking broken:
//   - a price list for supplier A repricing supplier B's item that happens to
//     share a name (the whole point of choosing a manufacturer);
//   - a file that matches nothing reading as "all done" -- every row has to be
//     accounted for, and a positive control proves the plan CAN find matches;
//   - a write the server answers 200 to while keeping the old price
//     (hold_money_columns), which must not be reported as saved;
//   - the roles that may do it, with a signed-out / guest session and every
//     non-office role making zero database calls.
//
// Run:  node tests/a27-pricelist-plan.test.mjs
import { load, grabConstLine, ppFunctionNames, runner } from "./a27-pricelist-lib.mjs";

const t = runner();

// ---- the plan ---------------------------------------------------------------
const L = load(["ppNorm", "ppNormSku", "ppUnitCode", "isSeededUnverifiedPrice", "ppBuildPlan", "ppPatchFor", "ppBefore",
  "ppVerifyRow", "ppMoney", "ppPct", "ppProvenance"]);

const A = "aaaaaaaa-0000-4000-8000-000000000001";   // the supplier the list is from
const B = "bbbbbbbb-0000-4000-8000-000000000002";   // a different supplier
const names = { [A]: "Acme Fence Supply", [B]: "Beta Vinyl" };
let n = 0;
const item = (o) => ({ sync_id: "item-" + (++n), name: "x", fence_type: "VINYL", role: "PANEL", unit: "EA", unit_price: 10,
  manufacturer_sync_id: null, supplier_sku: null, source_doc: "", deleted_at: null, ...o });
const row = (name, price, o = {}) => ({ name, priceRaw: String(price), price, sku: "", unitRaw: "", ...o });
const build = (items, rows, o = {}) => L.ppBuildPlan(items, A, rows, { nameOf: (id) => names[id], ...o });

console.log("\n-- per supplier");
{
  const mine = item({ name: "6' Vinyl Panel", unit_price: 50, manufacturer_sync_id: A });
  const theirs = item({ name: "6' Vinyl Panel", unit_price: 47, manufacturer_sync_id: B });
  const none = item({ name: "6' Vinyl Panel", unit_price: 44, manufacturer_sync_id: null });
  const plan = build([mine, theirs, none], [row("6' Vinyl Panel", 52.35)]);
  t.eq("the chosen supplier's item is the one that changes", plan.changes.map((c) => [c.item.sync_id, c.oldPrice, c.newPrice]), [[mine.sync_id, 50, 52.35]]);
  t.ok("the same-named item under another supplier is not in the plan at all",
    !plan.changes.concat(plan.same, plan.conflicts).some((c) => c.item && c.item.sync_id === theirs.sync_id));
  t.ok("nor is the one with no supplier, when the box is not ticked", !plan.changes.some((c) => c.item.sync_id === none.sync_id));
  t.eq("the other two are counted as untouched, not as this supplier's missing items",
    [plan.notInFile.length, plan.otherUntouched], [0, 2]);
}
{
  const theirs = item({ name: "Gate Latch", manufacturer_sync_id: B });
  const plan = build([theirs], [row("Gate Latch", 12)]);
  t.eq("a row that matches ONLY another supplier's item changes nothing and says whose it is",
    [plan.changes.length, plan.unmatched.map((u) => [u.reason, u.other])], [0, [["other", "Beta Vinyl"]]]);
}
{
  const none = item({ name: "Gate Latch", unit_price: 9 });
  const off = build([none], [row("Gate Latch", 12)]);
  t.eq("unassigned item, box NOT ticked: left alone and reported as 'unassigned'",
    [off.changes.length, off.unmatched.map((u) => u.reason)], [0, ["unassigned"]]);
  const on = build([none], [row("Gate Latch", 12)], { assignUnassigned: true });
  t.eq("positive control: the same file with the box ticked finds it, will assign it, and will change its price",
    on.changes.map((c) => [c.assign, c.priceChanged, c.oldPrice, c.newPrice]), [[true, true, 9, 12]]);
  t.eq("and the patch for it carries the supplier", L.ppPatchFor(on.changes[0], A, "prov").manufacturer_sync_id, A);
}
{
  const mine = item({ name: "Cap", unit_price: 1, manufacturer_sync_id: A });
  const untouched1 = item({ name: "Other thing", manufacturer_sync_id: A });
  const untouched2 = item({ name: "Another thing", manufacturer_sync_id: B });
  const untouched3 = item({ name: "Third thing" });
  const plan = build([mine, untouched1, untouched2, untouched3], [row("Cap", 2)]);
  t.eq("items not in the file: this supplier's own are listed, the rest are counted",
    [plan.notInFile.map((i) => i.name), plan.otherUntouched], [["Other thing"], 2]);
}
{
  const dead = item({ name: "Retired", manufacturer_sync_id: A, deleted_at: "2026-09-01T00:00:00Z" });
  const plan = build([dead], [row("Retired", 5)]);
  t.eq("a retired (soft-deleted) item is never matched", [plan.changes.length, plan.unmatched.map((u) => u.reason)], [0, ["none"]]);
}

console.log("\n-- matching is exact, never fuzzy");
{
  const it = item({ name: "5\"x5\" Co-Ex Line Post, White", unit_price: 16.56, manufacturer_sync_id: A });
  const quote = String.fromCharCode(0x201D);
  const hits = [
    ["5\"x5\" Co-Ex Line Post, White", true], ["  5\"x5\"   co-ex line post,  WHITE ", true],
    ["5" + quote + "x5" + quote + " Co-Ex Line Post, White", true],
    ["5x5 Co-Ex Line Post, White", false], ["5\"x5\" Co-Ex Line Post", false], ["5\"x5\" Co-Ex Line Post, Tan", false],
    ["Line Post", false], ["", false],
  ];
  for (const [name, want] of hits) {
    const p = build([it], [row(name, 20)]);
    t.eq(`"${name}" ${want ? "matches" : "does not match"}`, p.changes.length === 1, want);
  }
}
{
  const a = item({ name: "4x4x8' Pressure-Treated Post", role: "LINE_POST", fence_type: "WOOD", unit_price: 9.5, manufacturer_sync_id: A });
  const b = item({ name: "4x4x8' Pressure-Treated Post", role: "END_POST", fence_type: "WOOD", unit_price: 9.5, manufacturer_sync_id: A });
  const plan = build([a, b], [row("4x4x8' Pressure-Treated Post", 10.25)]);
  t.eq("one file row prices every catalog item of that name (the seed lists the same post under four roles)",
    plan.changes.map((c) => c.item.role).sort(), ["END_POST", "LINE_POST"]);
}
{
  const it = item({ name: "Panel", unit_price: 5, manufacturer_sync_id: A, supplier_sku: "VP-6W" });
  const bySku = build([it], [row("Totally different words", 6, { sku: " vp-6w " })]);
  t.eq("a part number match wins over a name that reads differently", [bySku.changes.length, bySku.changes[0] && bySku.changes[0].how], [1, "sku"]);
  const skuDiffers = build([it], [row("Panel", 6, { sku: "ZZ-9" })]);
  t.eq("a name match whose part number DISAGREES is flagged, so it is not ticked by default",
    skuDiffers.changes[0].flags.map((f) => f.k), ["sku"]);
}

console.log("\n-- nothing is silent");
{
  const items = [item({ name: "Real item", unit_price: 5, manufacturer_sync_id: A })];
  const rows = [row("Real item", 6), row("Renamed by the supplier", 7), row("Another new one", 8), { name: "Call us", priceRaw: "call", price: null, why: "bad", sku: "", unitRaw: "" }];
  const plan = build(items, rows);
  t.eq("positive control: one row matches and becomes a change", plan.changes.length, 1);
  t.eq("the two rows that match nothing are BOTH reported", plan.unmatched.map((u) => u.row.name), ["Renamed by the supplier", "Another new one"]);
  t.eq("the unreadable price is reported", plan.unreadable.map((u) => u.row.name), ["Call us"]);
  t.eq("every row is accounted for exactly once",
    plan.changes.length + plan.same.length + plan.unmatched.length + plan.unreadable.length + plan.conflicts.length, rows.length);
}
{
  const items = [item({ name: "A", manufacturer_sync_id: A }), item({ name: "B", manufacturer_sync_id: A })];
  const plan = build(items, [row("Zebra", 1), row("Yak", 2), row("Xerus", 3)]);
  t.eq("a file that matches nothing is not 'nothing to do' -- all of it is listed as unmatched", [plan.changes.length, plan.unmatched.length], [0, 3]);
}

console.log("\n-- the same item twice with different prices");
{
  const it = item({ name: "Black Panel", unit_price: 80, manufacturer_sync_id: A });
  const conflict = build([it], [row("Black Panel", 85), row("Black Panel", 90)]);
  t.eq("two prices for one item: neither is applied, and it is reported",
    [conflict.changes.length, conflict.conflicts.map((c) => c.prices)], [0, [[85, 90]]]);
  const dup = build([it], [row("Black Panel", 85), row("Black Panel", 85)]);
  t.eq("positive control: the same price twice is one change, not a conflict", [dup.changes.length, dup.conflicts.length], [1, 0]);
}

console.log("\n-- what the plan refuses to tick");
{
  const it = (o) => item({ manufacturer_sync_id: A, ...o });
  const jump = build([it({ name: "J", unit_price: 10 })], [row("J", 16)]);
  t.eq("+60% is flagged", jump.changes[0].flags.map((f) => f.k), ["jump"]);
  const ok = build([it({ name: "J", unit_price: 10 })], [row("J", 14)]);
  t.eq("positive control: +40% is not", ok.changes[0].flags, []);
  const drop = build([it({ name: "J", unit_price: 10 })], [row("J", 4)]);
  t.eq("-60% is flagged too", drop.changes[0].flags.map((f) => f.k), ["jump"]);
  const placeholder = build([it({ name: "J", unit_price: 0 })], [row("J", 4)]);
  t.eq("a $0 placeholder going to a real price is not a 'jump'", placeholder.changes[0].flags, []);
  const unit = build([it({ name: "H", unit: "EA", unit_price: 3 })], [row("H", 32, { unitRaw: "box" })]);
  t.eq("price per box against a catalog price per each is flagged", unit.changes[0].flags.map((f) => f.k), ["jump", "unit"]);
  const sameUnit = build([it({ name: "H", unit: "EA", unit_price: 3 })], [row("H", 3.5, { unitRaw: "Each" })]);
  t.eq("positive control: 'Each' against EA is the same unit", sameUnit.changes[0].flags, []);
  const unknown = build([it({ name: "H", unit: "EA", unit_price: 3 })], [row("H", 3.5, { unitRaw: "bag" })]);
  t.eq("a unit it cannot classify raises no flag either way", unknown.changes[0].flags, []);
}

console.log("\n-- what a change writes");
{
  const seeded = item({ name: "Seeded", unit_price: 10, manufacturer_sync_id: A, source_doc: "Starting price — verify with your supplier" });
  const same = build([seeded], [row("Seeded", 10)]);
  t.eq("same price on an unchecked starting price is still a change: the supplier's own list checks it",
    same.changes.map((c) => [c.priceChanged, c.confirm]), [[false, true]]);
  const patch = L.ppPatchFor(same.changes[0], A, "Price list — Acme, f.csv, 2026-10-01");
  t.eq("and its patch writes only the source note, not the price", Object.keys(patch), ["source_doc"]);

  const checked = item({ name: "Checked", unit_price: 10, manufacturer_sync_id: A, source_doc: "Invoice 4471" });
  const sameChecked = build([checked], [row("Checked", 10)]);
  t.eq("same price on a price somebody already checked: nothing to write, counted as already there",
    [sameChecked.changes.length, sameChecked.same.length], [0, 1]);

  const guessed = item({ name: "Guessed", unit_price: 10, manufacturer_sync_id: A, source_doc: "Imported — check this one" });
  const g = build([guessed], [row("Guessed", 12)]);
  const gp = L.ppPatchFor(g.changes[0], A, "prov");
  t.eq("the importer's 'check this one' note is about where the item was filed, so it is left in place",
    [Object.keys(gp), gp.source_doc], [["unit_price"], undefined]);

  const full = build([item({ name: "Full", unit_price: 10, manufacturer_sync_id: null })], [row("Full", 11, { sku: "F-1" })],
    { assignUnassigned: true, saveSku: true, skuColumnPresent: true });
  const fp = L.ppPatchFor(full.changes[0], A, "prov");
  t.eq("a full patch: price, supplier, part number, provenance -- and never updated_at",
    Object.keys(fp).sort(), ["manufacturer_sync_id", "source_doc", "supplier_sku", "unit_price"]);
  const noSku = build([item({ name: "Full", unit_price: 10, manufacturer_sync_id: A })], [row("Full", 11, { sku: "F-1" })],
    { saveSku: true, skuColumnPresent: false });
  t.eq("without the supplier_sku column the part number is not written", Object.keys(L.ppPatchFor(noSku.changes[0], A, "p")).includes("supplier_sku"), false);
  const hasSku = build([item({ name: "Full", unit_price: 10, manufacturer_sync_id: A, supplier_sku: "KEEP-ME" })], [row("Full", 11, { sku: "F-1" })],
    { saveSku: true, skuColumnPresent: true });
  t.eq("an existing part number is never overwritten", Object.keys(L.ppPatchFor(hasSku.changes[0], A, "p")).includes("supplier_sku"), false);
  t.eq("before-values cover exactly the columns that change",
    L.ppBefore(full.changes[0].item, fp), { unit_price: 10, manufacturer_sync_id: null, supplier_sku: null, source_doc: "" });
}

console.log("\n-- small helpers");
t.eq("money keeps the cents a supplier quotes", [L.ppMoney(52.35), L.ppMoney(1234.5), L.ppMoney(0.145), L.ppMoney(0.74)], ["$52.35", "$1,234.50", "$0.145", "$0.74"]);
t.eq("percent", [L.ppPct(10, 12), L.ppPct(10, 8), L.ppPct(10, 10), L.ppPct(0, 5)], ["+20.0%", "-20.0%", "0.0%", ""]);
t.eq("provenance names the supplier, the file and the day", L.ppProvenance("Acme", "list.xlsx", "2026-10-01"), "Price list — Acme, list.xlsx, 2026-10-01");
t.eq("a pasted list says so", L.ppProvenance("Acme", "", "2026-10-01"), "Price list — Acme, pasted rows, 2026-10-01");
t.ok("provenance is never a string the phone or the office reads as 'unverified'",
  !L.isSeededUnverifiedPrice(L.ppProvenance("Placeholder Co", "", "2026-10-01")) && !/^(Starting price|Placeholder|Imported)/.test(L.ppProvenance("Imported Inc", "", "d")));

// ---- writing, and checking what was written ------------------------------------
console.log("\n-- writing");
/** A stand-in for the one table. `hold` copies the server's hold_money_columns
    trigger: an update that names unit_price keeps the old value, no error. */
function fakeDb(rows, { hold = false, errorOn = null, errorOnCall = 0 } = {}) {
  const calls = [];
  const db = { from(table) {
    if (table !== "material_items") throw new Error("unexpected table " + table);
    const q = { patch: null, eqs: {}, iss: {},
      update(p) { this.patch = p; return this; },
      eq(k, v) { this.eqs[k] = v; return this; },
      is(k, v) { this.iss[k] = v; return this; },
      async select(cols) {
        calls.push({ patch: this.patch, eqs: { ...this.eqs }, cols });
        const r = rows[this.eqs.sync_id];
        if (!r || r.company_id !== this.eqs.company_id) return { data: [], error: null };
        if ("deleted_at" in this.iss && this.iss.deleted_at === null && r.deleted_at) return { data: [], error: null };
        for (const [k, v] of Object.entries(this.eqs)) if (!["sync_id", "company_id"].includes(k) && r[k] !== v) return { data: [], error: null };
        if (errorOn === r.sync_id) return { data: null, error: { message: "boom" } };
        if (errorOnCall && calls.length === errorOnCall) return { data: null, error: { message: "dropped" } };
        const next = { ...r, ...this.patch };
        if (hold && "unit_price" in this.patch) next.unit_price = r.unit_price;
        next.updated_at = new Date(Date.parse(r.updated_at) + 1000).toISOString();
        rows[r.sync_id] = next;
        const want = cols.split(",");
        return { data: [Object.fromEntries(want.map((c) => [c, next[c]]))], error: null };
      } };
    return q;
  } };
  return { db, calls };
}
const dbRow = (id, o = {}) => ({ sync_id: id, company_id: "co-1", unit_price: 10, manufacturer_sync_id: null, source_doc: "", supplier_sku: null, deleted_at: null, updated_at: "2026-10-01T00:00:00.000Z", ...o });
const writer = (rows, opts) => {
  const f = fakeDb(rows, opts);
  const w = load(["ppVerifyRow", "ppWriteRows"], { db: f.db, profile: { company_id: "co-1" } });
  return { ...w, calls: f.calls, rows };
};
{
  const rows = { a: dbRow("a"), b: dbRow("b"), c: dbRow("c") };
  const w = writer(rows);
  const res = await w.ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12 } }, { item: { sync_id: "b" }, patch: { unit_price: 13 } }]);
  t.eq("a normal write is saved and read back", [res.ok.length, res.failed.length, rows.a.unit_price, rows.b.unit_price], [2, 0, 12, 13]);
  t.ok("every update is scoped to this company and to live rows",
    w.calls.every((c) => c.eqs.company_id === "co-1") && w.calls.length === 2);
  t.ok("updated_at is never written", w.calls.every((c) => !("updated_at" in c.patch)));
  t.ok("the read-back asks for the columns it wrote, plus the new updated_at", w.calls[0].cols.split(",").sort().join() === "sync_id,unit_price,updated_at".split(",").sort().join());
}
{
  const rows = { a: dbRow("a") };
  const w = writer(rows, { hold: true });
  const res = await w.ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12, source_doc: "x" } }]);
  t.eq("THE QUIET REFUSAL: the server answers normally but keeps the old price -- not counted as saved",
    [res.ok.length, res.failed.map((f) => f.why)], [0, ["held"]]);
  t.eq("and the rest of the change is NOT written either: no source note claiming a price the list did not give it",
    [rows.a.source_doc, w.calls.length], ["", 1]);
  t.eq("positive control: the fake really did keep the old price", rows.a.unit_price, 10);
  const res2 = await writer({ a: dbRow("a") }, { hold: false }).ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12 } }]);
  t.eq("positive control: without the hold the identical write is saved", res2.ok.length, 1);
}
{
  const rows = { a: dbRow("a") };
  const w = writer(rows);
  const res = await w.ppWriteRows([{ item: { sync_id: "a" }, patch: { source_doc: "Price list — Acme, f.csv, d", manufacturer_sync_id: "sup", unit_price: 12 } }]);
  t.eq("a change with a price and other columns is two writes: the price first, alone, then the rest",
    [w.calls.map((c) => Object.keys(c.patch)), res.ok.length], [[["unit_price"], ["source_doc", "manufacturer_sync_id"]], 1]);
  t.eq("both took", [rows.a.unit_price, rows.a.manufacturer_sync_id, rows.a.source_doc], [12, "sup", "Price list — Acme, f.csv, d"]);
  t.eq("the result carries the row as it ended up, with the LAST updated_at", [res.ok[0].after.updated_at, res.ok[0].after.unit_price], [rows.a.updated_at, 12]);
  const rows2 = { a: dbRow("a") };
  const w2 = writer(rows2, { errorOnCall: 2 });
  const res2 = await w2.ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12, source_doc: "x" } }]);
  t.eq("a failure AFTER the price was written is reported as partial, not as a clean failure and not as saved",
    [res2.ok.length, res2.failed.map((f) => [f.why, f.partial]), rows2.a.unit_price], [0, [["error", true]], 12]);
  const res3 = await writer({ a: dbRow("a") }, { errorOnCall: 1 }).ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12, source_doc: "x" } }]);
  t.eq("positive control: a failure on the FIRST write is not partial", res3.failed.map((f) => [f.why, f.partial]), [["error", false]]);
}
{
  // undo of a multi-column change: the guard has to follow the updated_at the first write produced
  const rows = { a: dbRow("a") };
  const w = writer(rows);
  const done = await w.ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12, source_doc: "x" }, before: { unit_price: 10, source_doc: "" } }]);
  const undo = await w.ppWriteRows(done.ok.map((j) => ({ item: j.item, patch: j.before, guard: { updated_at: j.after.updated_at } })));
  t.eq("undoing a two-column change puts both columns back", [undo.ok.length, undo.failed.length, rows.a.unit_price, rows.a.source_doc], [1, 0, 10, ""]);
}
{
  const rows = { a: dbRow("a") };
  const res = await writer(rows).ppWriteRows([{ item: { sync_id: "ghost" }, patch: { unit_price: 12 } }]);
  t.eq("an item that is not there (retired meanwhile) is a failure, not a silent success", [res.ok.length, res.failed.map((f) => f.why)], [0, ["norows"]]);
  const res2 = await writer({ a: dbRow("a", { deleted_at: "2026-09-30T00:00:00Z" }) }).ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12 } }]);
  t.eq("a row retired since the page loaded is not revived by an update", [res2.ok.length, res2.failed.map((f) => f.why)], [0, ["norows"]]);
  const res3 = await writer({ a: dbRow("a") }, { errorOn: "a" }).ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12 } }]);
  t.eq("a database error is reported with its message", [res3.failed[0].why, res3.failed[0].detail], ["error", "boom"]);
  const res4 = await writer({ a: dbRow("a") }).ppWriteRows([{ item: { sync_id: "a" }, patch: { manufacturer_sync_id: "sup" } }]);
  t.eq("a supplier assignment is read back too", res4.ok.length, 1);
}
{
  const rows = { a: dbRow("a"), b: dbRow("b", { unit_price: 99 }) };
  const w = writer(rows, { hold: false });
  const done = await w.ppWriteRows([{ item: { sync_id: "a" }, patch: { unit_price: 12 } }, { item: { sync_id: "b" }, patch: { unit_price: 13 } }]);
  // undo: guarded on the updated_at each write returned
  rows.b.updated_at = "2027-01-01T00:00:00.000Z";           // somebody (a phone sync, a person) touched b afterwards
  const undo = await w.ppWriteRows(done.ok.map((j) => ({ item: j.item, patch: { unit_price: j.item.sync_id === "a" ? 10 : 99 }, guard: { updated_at: j.after.updated_at } })));
  t.eq("undo puts back the row nobody touched", [rows.a.unit_price, undo.ok.map((j) => j.item.sync_id)], [10, ["a"]]);
  t.eq("undo leaves alone the row that changed since, and counts it", [rows.b.unit_price, undo.failed.map((f) => [f.entry.item.sync_id, f.why])], [13, [["b", "norows"]]]);
}
{
  const rows = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`r${i}`, dbRow(`r${i}`)]));
  const w = writer(rows);
  const seen = [];
  await w.ppWriteRows(Object.keys(rows).map((id) => ({ item: { sync_id: id }, patch: { unit_price: 11 } })), (d, total) => seen.push([d, total]));
  t.eq("progress reaches the total", seen[seen.length - 1], [30, 30]);
  t.eq("all thirty written", Object.values(rows).every((r) => r.unit_price === 11), true);
}

// ---- what gets drawn --------------------------------------------------------------
console.log("\n-- the preview and the failure list escape everything a file can contain");
{
  const evil = '<img src=x onerror=alert(1)>';
  const P = load(["ppPreviewHtml", "ppFailHtml", "ppFailText", "ppMoney", "ppPct", "ppNorm", "ppTr"],
    { tr: (k, ...a) => k + ":" + a.join("|"), catFenceTypeLabel: (s) => s, bizPretty: (s) => s, plainError: (s) => s }, grabConstLine("esc"));
  const items = [item({ name: evil, unit_price: 5, manufacturer_sync_id: A }), item({ name: "Quiet", unit_price: 5, manufacturer_sync_id: A })];
  const rows = [row(evil, 6, { sku: "<script>alert(2)</script>" }), row('"><svg onload=alert(3)>', 7), { name: "<u>bad</u>", priceRaw: "<b>x</b>", price: null, why: "bad", sku: "", unitRaw: "" }];
  const plan = build(items, rows);
  const html = P.ppPreviewHtml({ plan, headings: ["<i>heading</i>"] }, new Set([0]), "<b>Evil Supply</b>");
  t.ok("positive control: the hostile item name is on screen (as text)", html.includes("&lt;img src=x onerror=alert(1)&gt;"), html.slice(0, 300));
  for (const raw of ["<img", "<script", "<svg", "<b>Evil", "<i>heading", "<u>bad", "<b>x"]) {
    t.ok(`no raw ${raw} reaches the markup`, !html.includes(raw));
  }
  const fails = P.ppFailHtml([{ entry: { item: { name: evil } }, why: "error", detail: "<script>x</script>" }]);
  t.ok("the failure list escapes an item name and a server message too", fails.includes("&lt;img") && !fails.includes("<img") && !fails.includes("<script"), fails);
}

// ---- reading the catalog fresh -----------------------------------------------------
console.log("\n-- reading the catalog fresh, past the thousand-row cap");
{
  const all = Array.from({ length: 2300 }, (_, i) => ({ sync_id: "s" + i, name: "Item " + i, unit_price: 1, manufacturer_sync_id: null, deleted_at: null }));
  const ranges = [], msgs = [];
  let R = null, fail = false, swapMidway = false;
  const db = { from() {
    return { select() { return this; }, is() { return this; }, order() { return this; },
      async range(a, b) {
        ranges.push([a, b]);
        if (swapMidway && ranges.length === 2) R.swap();
        return fail ? { data: null, error: { message: "boom" } } : { data: all.slice(a, b + 1), error: null };
      } };
  } };
  R = load(["ppRefreshItems"], { db, msg: (id, text, kind) => msgs.push([id, text, kind]), plainError: (s) => "plain:" + s },
    "let ppState = { items: null };", { st: "(() => ppState)", swap: "(() => { ppState = { items: null }; })", reset: "(() => { ppState = { items: null }; })" });
  t.eq("all 2,300 rows are read, in three requests", [await R.ppRefreshItems(), R.st().items.length, ranges], [true, 2300, [[0, 999], [1000, 1999], [2000, 2999]]]);
  const plan = L.ppBuildPlan(R.st().items, A, [{ name: "Item 2200", priceRaw: "5", price: 5, sku: "", unitRaw: "" }], { assignUnassigned: true });
  t.eq("positive control: an item past row 1,000 can be matched (a single unpaged read would have called it 'not in your catalog')", plan.changes.length, 1);
  R.reset(); ranges.length = 0; fail = true;
  t.eq("a failed read says so and plans nothing", [await R.ppRefreshItems(), R.st().items, msgs.slice(-1)[0]], [false, null, ["ppMsg", "plain:boom", "err"]]);
  R.reset(); ranges.length = 0; fail = false; swapMidway = true;
  t.eq("a file chosen while the read was in flight does not receive the older read", [await R.ppRefreshItems(), R.st().items], [false, null]);
}

// ---- who may do it ---------------------------------------------------------------
console.log("\n-- who may do it");
const gate = grabConstLine("canEdit");
t.eq("the page's own gate is OWNER or MANAGER and nothing else (the catalog's gate, not a new one)",
  gate.replace(/\s+/g, ""), "constcanEdit=()=>profile&&(profile.role==='OWNER'||profile.role==='MANAGER');");

function entryHarness(role) {
  const dom = {};
  const el = (id) => (dom[id] ??= { id, style: {}, className: "", textContent: "", innerHTML: "", value: "", checked: false, disabled: false, classList: { add() { this.on = true; }, remove() { this.on = false; } } });
  const msgs = [];
  let dbCalls = 0;
  const db = { from() { dbCalls++; throw new Error("the database must not be reached"); } };
  const profile = role === null ? null : { role, company_id: "co-1" };
  const lib = load(
    [...ppFunctionNames(), "openPriceListDialog", "isSeededUnverifiedPrice"],
    { $: el, db, profile, manufacturers: [{ sync_id: "s1", name: "Acme", deleted_at: null }], catalog: [], esc: (s) => String(s), tr: (k) => k, msg: (id, text, kind) => msgs.push([id, text, kind]),
      catalogHasSupplierSku: () => false, canEdit: new Function("profile", gate.replace("const canEdit =", "return") + "")(profile),
      refreshCatalog: async () => { dbCalls++; }, PP_MAX_BYTES: 1e6, PP_MAX_ROWS: 3000,
      catFenceTypeLabel: (s) => s, bizPretty: (s) => s, plainError: (s) => s, manufacturerName: () => "", downloadCsv: () => {}, openSupplierDialog: () => {} },
    "let ppState = null, ppLast = { jobs: [{ item: { sync_id: 'a' }, before: {}, after: { updated_at: 'x' } }], undone: false }, ppBusy = false;",
    { state: "(() => ppState)", setState: "((s) => { ppState = s; })", last: "(() => ppLast)" });
  return { lib, el, dom, msgs, calls: () => dbCalls };
}
for (const [role, allowed] of [["OWNER", true], ["MANAGER", true], ["SALES", false], ["ACCOUNTANT", false], ["FOREMAN", false], ["CREW", false], [null, false]]) {
  const h = entryHarness(role);
  h.lib.openPriceListDialog();
  const opened = !!(h.dom.ppOverlay && h.dom.ppOverlay.classList.on);
  h.el("ppText").value = "Item,Price\nPost,9\n";
  await h.lib.ppOnPaste();
  await h.lib.ppOnFile({ size: 10, name: "x.csv", arrayBuffer: async () => new Uint8Array([73, 44, 80]).buffer });
  h.lib.setState({ plan: { changes: [{ item: { sync_id: "a" }, priceChanged: true, newPrice: 1, row: {}, flags: [] }] }, selected: new Set([0]), supplierId: "s1" });
  await h.lib.ppApply();
  await h.lib.ppUndo();
  const label = role === null ? "a signed-out / guest session (no profile)" : role;
  if (allowed) {
    t.ok(`${label}: the dialog opens`, opened);
    t.ok(`${label}: and reaches the database (so the refusals below are the gate, not a broken harness)`, h.calls() > 0);
  } else {
    t.ok(`${label}: the dialog does not open`, !opened);
    t.eq(`${label}: nothing reaches the database -- not apply, not undo, not a file or paste`, h.calls(), 0);
    t.eq(`${label}: and nothing was said or drawn`, h.msgs.length, 0);
  }
}

t.done();
