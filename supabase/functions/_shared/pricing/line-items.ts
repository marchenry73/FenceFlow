/**
 * Port of EstimateEngine.buildLineItems plus the price carry-over from
 * TakeoffRefresher.refreshRun (app/src/main/java/com/fenceestimator/app/estimate/).
 *
 * Builds priced, editable line items from suggested quantities and the
 * current material catalog, scoped to the run's fence type. Prefers the
 * run's chosen color/finish and the job's preferred manufacturer when
 * more than one catalog item matches a role; falls back gracefully when
 * a role has no matching catalog item at all.
 */
import { compareBoolean, compareIeee, compareString, f32, floatSum, minWithOrNull, sortedWith } from "./f32.ts";
import { equalsIgnoreCase, isBlank, kotlinFloatToString } from "./kotlin-text.ts";
import { nameUUIDFromString } from "./uuid3.ts";
import type { EstimateSuggestions, QtyEntry } from "./takeoff.ts";
import type { EstimateLineItem, FenceRun, MaterialItem, MaterialRole } from "./types.ts";

/**
 * A stable uuid for one run's line of a given material role.
 *
 * nameUUIDFromBytes is a content hash, so the same run and role always
 * produce the same uuid on every device and every regenerate -- which is
 * what makes the cloud upsert replace the row rather than add another.
 */
export function deterministicSyncId(runSyncId: string, role: string): string {
  return nameUUIDFromString(`fenceflow-line:${runSyncId}:${role}`);
}

/**
 * The same, for a role that legitimately appears more than once on a run.
 *
 * Entries are merged by role AND width, so a run with a 4 ft gate and a 6 ft
 * gate keeps two GATE_PANEL lines -- and both were being handed the same
 * id, because the id was built from the role alone. Two rows with one
 * primary key do not survive an upsert: the estimate push for that job
 * failed as a batch, so NONE of its line items reached the cloud.
 *
 * Only used when a role really does repeat, so every run that was already
 * syncing keeps the ids it has. The width is rendered exactly as Kotlin's
 * `"${coversFt ?: 0f}"` renders a Float -- "4.0", not "4".
 */
export function deterministicSyncIdForWidth(runSyncId: string, role: string, coversFt: number | null): string {
  return nameUUIDFromString(`fenceflow-line:${runSyncId}:${role}:${kotlinFloatToString(coversFt ?? 0)}`);
}

export interface BuiltItems {
  /**
   * EstimateLineItem field for field. No category: the phone's line item
   * has none, so the contract reports `category: null` on every row.
   */
  items: EstimateLineItem[];
  /** Roles the takeoff called for that the catalog has nothing priced for. */
  unmatchedRoles: MaterialRole[];
  /** Matched items whose catalog price is still zero, so the estimate would read $0. */
  zeroPricedNames: string[];
}

/**
 * The map key for `groupBy { it.role to it.preferCoversFt }`. A boxed Float
 * compares by bit pattern there, so -0.0 and 0.0 are different keys and NaN
 * equals itself; Object.is has the same view, and String() of a double is
 * unique per value.
 */
function mergeKey(role: MaterialRole, coversFt: number | null): string {
  if (coversFt === null) return role + "|null";
  return role + "|" + (Object.is(coversFt, -0) ? "-0" : String(coversFt));
}

export function buildLineItems(
  run: FenceRun,
  suggestions: EstimateSuggestions,
  catalog: readonly MaterialItem[],
  preferredManufacturerSyncId: string | null,
): BuiltItems {
  const candidatesByRole = new Map<MaterialRole, MaterialItem[]>();
  for (const item of catalog) {
    if (!(item.isActive && (item.fenceType === run.fenceType || item.fenceType === "UNIVERSAL"))) continue;
    const group = candidatesByRole.get(item.role);
    if (group === undefined) candidatesByRole.set(item.role, [item]);
    else group.push(item);
  }

  const items: EstimateLineItem[] = [];
  const unmatched: MaterialRole[] = [];
  const zeroPriced: string[] = [];
  let order = 0;

  // The same role can be suggested more than once (two braces on a wide
  // gate, hinges for each of several gates). Merge before pricing so the
  // estimate shows one line with the full count instead of duplicates.
  const groups = new Map<string, QtyEntry[]>();
  for (const entry of suggestions.entries) {
    if (!(entry.quantity > 0.0)) continue;
    const key = mergeKey(entry.role, entry.preferCoversFt);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  const mergedEntries: QtyEntry[] = [];
  for (const group of groups.values()) {
    let quantity = 0;
    for (const e of group) quantity += e.quantity;
    const feet = group.filter((e) => e.coversLinearFt !== null).map((e) => e.coversLinearFt as number);
    mergedEntries.push({
      role: group[0].role,
      quantity,
      preferCoversFt: group[0].preferCoversFt,
      coversLinearFt: feet.length > 0 ? floatSum(feet) : null,
    });
  }

  // How many lines each role ends up with, so the id only needs
  // qualifying where it would otherwise collide.
  const entriesPerRole = new Map<MaterialRole, number>();
  for (const e of mergedEntries) entriesPerRole.set(e.role, (entriesPerRole.get(e.role) ?? 0) + 1);

  for (const entry of mergedEntries) {
    let candidates = candidatesByRole.get(entry.role) ?? [];
    if (candidates.length === 0) {
      unmatched.push(entry.role);
      continue;
    }

    if (!isBlank(run.colorOrFinish)) {
      const colorMatches = candidates.filter((c) => equalsIgnoreCase(c.colorOrFinish, run.colorOrFinish));
      if (colorMatches.length > 0) candidates = colorMatches;
    }

    if (preferredManufacturerSyncId !== null) {
      const manufacturerMatches = candidates.filter((c) => c.manufacturerSyncId === preferredManufacturerSyncId);
      if (manufacturerMatches.length > 0) candidates = manufacturerMatches;
    }

    let chosen: MaterialItem | null;
    const preferCoversFt = entry.preferCoversFt;
    if (preferCoversFt !== null) {
      // Nearest width, but among items that have a price if any do.
      // The other branch has always preferred a priced item; this one
      // did not, so a $0.00 placeholder that happened to be the
      // closest width could carry an entire panel line and quietly
      // zero out the biggest number on the estimate.
      const priced = candidates.filter((c) => c.unitPrice > 0.0);
      const pool = priced.length > 0 ? priced : candidates;
      // Two items at the same distance must resolve the same way
      // every single time -- minByOrNull alone keeps whichever came
      // first in an unordered list, which is a coin toss dressed as
      // a choice. Distance, then price, then id: total order.
      //
      // The id is the sync id, not the Room row id: the office has no
      // Room ids, and the phone was pinned to the same key so both
      // sides break the tie identically.
      const distance = (c: MaterialItem): number => Math.abs(f32((c.coversFt ?? preferCoversFt) - preferCoversFt));
      chosen = minWithOrNull(pool, (a, b) =>
        compareIeee(distance(a), distance(b)) ||
        compareIeee(a.unitPrice, b.unitPrice) ||
        compareString(a.syncId, b.syncId));
    } else {
      // Prefer something actually priced. Picking the first match blind
      // is how a $0.00 placeholder ended up representing a whole role
      // and quietly zeroed out the materials total.
      // Same rule: never let list position decide. Priced beats
      // unpriced, then cheapest, then lowest id.
      const sorted = sortedWith(candidates, (a, b) =>
        compareBoolean(a.unitPrice <= 0.0, b.unitPrice <= 0.0) ||
        compareIeee(a.unitPrice, b.unitPrice) ||
        compareString(a.syncId, b.syncId));
      chosen = sorted.length > 0 ? sorted[0] : null;
    }
    if (chosen === null) {
      unmatched.push(entry.role);
      continue;
    }
    if (chosen.unitPrice <= 0.0) zeroPriced.push(chosen.name);

    // How many, against what the chosen item actually covers.
    //
    // The count came from the width the RUN is spec'd for, and the item
    // was then picked separately as the nearest available width -- with
    // nothing reconciling the two. Spec a 100 ft run at 8 ft panels
    // when the catalog only stocks that colour at 6 ft, and the takeoff
    // ordered thirteen panels covering 78 ft: 22 ft of fence with
    // nothing to put in it, found on the day. It goes the other way
    // too -- a 4 ft spec against a 6 ft item ordered fifty percent more
    // panel than the run needs.
    //
    // Only for PANEL, which is bought by the foot of fence. A gate is
    // not: a 5 ft opening takes one 4 ft-ish gate, never two.
    let quantity = entry.quantity;
    const preferred = entry.preferCoversFt;
    const feetToCover = entry.coversLinearFt;
    if (entry.role === "PANEL" && preferred !== null && feetToCover !== null) {
      const actualCoverage = chosen.coversFt ?? preferred;
      if (actualCoverage > 0 && Math.abs(f32(actualCoverage - preferred)) > f32(0.01)) {
        // Double division of the two Floats, as `feetToCover.toDouble() / actualCoverage.toDouble()`.
        quantity = Math.ceil(feetToCover / actualCoverage);
      }
    }

    // Same run + same role always lands on the same sync id, so
    // regenerating overwrites the cloud row instead of adding a
    // second one next to it.
    //
    // It has to BE a uuid, not merely be unique: the cloud column
    // is typed uuid, and "<uuid>:PANEL" was rejected outright --
    // which broke syncing estimates entirely. Hashing the same
    // two inputs into a uuid keeps the determinism and the type.
    //
    // Roles are NOT always unique per run: the merge above groups by
    // role and width, so two gates of different widths keep two
    // GATE_PANEL lines. Those get the width folded in as well.
    const syncId = (entriesPerRole.get(entry.role) ?? 1) > 1
      ? deterministicSyncIdForWidth(run.syncId, entry.role, entry.preferCoversFt)
      : deterministicSyncId(run.syncId, entry.role);

    items.push({
      syncId,
      fenceRunSyncId: run.syncId,
      sortOrder: order++,
      description: chosen.name,
      quantity,
      unit: chosen.unit,
      unitPrice: chosen.unitPrice,
      taxable: chosen.taxable,
      role: entry.role,
      isAutoGenerated: true,
      supplierUnitPrice: null,
    });
  }

  return {
    items,
    unmatchedRoles: distinct(unmatched),
    zeroPricedNames: distinct(zeroPriced),
  };
}

/** Kotlin `distinct()`: first occurrence kept, order preserved. */
function distinct<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

/**
 * TakeoffRefresher's carry-over, applied to a freshly built run.
 *
 * A price somebody typed by hand is a decision, and regenerating must not
 * quietly revert it to the catalog figure. Matched on role, and only for
 * real roles -- the column is not nullable, so testing for null would sweep
 * in every hand-typed line that has no role at all.
 *
 * A price read off the supplier's own quote is the most authoritative
 * number on the job, and regenerating threw every one of them away --
 * silently, while the job went on claiming its prices were confirmed.
 * The next reason to regenerate is usually the takeoff changing by a
 * few feet, which is no reason at all to go back to catalog guesses.
 *
 * `existing` must already be this run's items only; `associate` keeps the
 * LAST value for a repeated role, and so does Map.set.
 */
export function carryOverPrices(built: readonly EstimateLineItem[], existing: readonly EstimateLineItem[]): EstimateLineItem[] {
  const editedPrices = new Map<MaterialRole, number>();
  for (const item of existing) {
    if (!item.isAutoGenerated && item.role !== "NONE") editedPrices.set(item.role, item.unitPrice);
  }

  const quotedPrices = new Map<MaterialRole, number>();
  for (const item of existing) {
    if (item.supplierUnitPrice !== null && item.role !== "NONE") quotedPrices.set(item.role, item.supplierUnitPrice);
  }

  return built.map((item) => {
    const quoted = quotedPrices.get(item.role);
    const withQuote = quoted !== undefined ? { ...item, supplierUnitPrice: quoted } : item;
    const kept = editedPrices.get(item.role);
    if (kept !== undefined && kept !== withQuote.unitPrice) {
      return { ...withQuote, unitPrice: kept, isAutoGenerated: false };
    }
    return withQuote;
  });
}
