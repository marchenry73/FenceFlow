/**
 * Port of EstimateEngine.buildLineItems (app/src/main/java/com/fenceestimator/app/estimate/),
 * plus what a regenerate does to the lines already on the run: the phone's
 * TakeoffLineMerge (app/src/main/java/com/fenceestimator/app/data/).
 *
 * Builds priced, editable line items from suggested quantities and the
 * current material catalog, scoped to the run's fence type. Prefers the
 * run's chosen color/finish and the job's preferred manufacturer when
 * more than one catalog item matches a role -- and, between rows of one width
 * in a height-aware role (a panel, a gate panel, or a POST), the row whose
 * declared height is the run's panel height;
 * falls back gracefully when a role has no matching catalog item at all.
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

    // Height, for the roles whose row has to physically suit a fence this tall:
    // the two panel roles, and the POSTS. Width alone cannot tell a 4 ft high
    // panel from a 6 ft high one when both are 6 ft wide, and the cheaper one
    // then won every quote of the dearer height -- the starting catalog's
    // ornamental iron, short by $40 a panel.
    //
    // POSTS are here because the same choice on a post is not a price, it is a
    // fence that falls over. A post has no width, so it was picked by price
    // alone, and on a 72 ft run six feet high the cheapest LINE_POST in the
    // owner's catalog was "5x5 Utility Post White 6' (Flori, 4ft run)" at
    // $13.18 -- the post the supplier quotes for a FOUR foot fence, six feet
    // long, so nothing of it is in the ground. The right row is the 8.5 ft
    // Co-Ex at $16.56. It only became reachable the day both suppliers' posts
    // were loaded: before that there was one post per role and nothing to
    // choose wrongly between.
    //
    // On a POST, heightFt is THE FENCE HEIGHT THE POST IS FOR, not the post's
    // own length. That is the one reading that lets a single comparison serve
    // panels and posts alike -- the run says "I am 6 ft" and every row that
    // says 6 is a candidate -- and the post's physical length stays in its
    // name, where no engine reads it. See MaterialItem.heightFt.
    //
    // A row says how tall it is in heightFt, a column of its own; the NAME is
    // never read for it. The same "narrow only if something matches" shape as
    // colour and manufacturer, with one difference that matters: it narrows
    // WITHIN a width. Height is what separates rows that tie on width; it must
    // not change which widths are in the running. Dropping every row that does
    // not declare the run's height hid the other widths of a role -- a 4 ft and a
    // 6 ft gate beside a 5 ft one that declared its height -- and moved 3 of the
    // 85 recorded quotes that have nothing to do with height, one of them down.
    // So a row is set aside only when another row of ITS OWN width declares the
    // run's height and it does not. When no row declares the run's height -- which
    // is every catalog that declares no height at all -- nothing is set aside and
    // the choice below is exactly what it always was, and a row that does declare
    // it never sets itself aside, so the list cannot be emptied.
    //
    // WHY PER-WIDTH IS STILL RIGHT FOR POSTS, which have no width at all:
    // coversFt is null on every post row, and `null === null` is true here
    // exactly as Kotlin's `==` on two `Float?` nulls is true (it is
    // Intrinsics.areEqual, which answers true for null against null). So every
    // post of a role falls into ONE width group and the rule narrows the whole
    // list -- which is what posts want, since there are no other widths of a
    // post to hide. Had null not equalled null the rule would have silently
    // done nothing for posts, and the phone and the office would still have
    // bought different posts. The two sides agree on this case; where they do
    // NOT agree is a heightFt or coversFt of NaN or -0.0, which Kotlin compares
    // with Float.equals (NaN equals itself, -0.0 differs from 0.0) and this
    // compares with IEEE `===` (the reverse on both). No catalog can reach that
    // -- a fence is not NaN feet tall -- and null, the only value that matters
    // here, behaves identically.
    //
    // Not for any other role. CHAIN_FABRIC keeps its height in coversFt, so it is
    // already chosen by it; POST_CAP, rails, bands, concrete and gate hardware are
    // still chosen by price alone, and no row of those roles declares a height in
    // the starting catalog or in the owner's (checked 1 Oct 2026) -- see
    // tests/a51-post-height-choice.test.mjs, which pins that list. A run's height here is
    // always panelHeightFt, including on a chain-link run, whose real height is
    // fabricHeightFt -- no chain-link post declares a height today, so the rule
    // is inert there, and teaching it that second column is a decision for the
    // owner, not a silent one.
    if (
      entry.role === "PANEL" || entry.role === "GATE_PANEL" ||
      entry.role === "LINE_POST" || entry.role === "END_POST" ||
      entry.role === "CORNER_POST" || entry.role === "GATE_POST" ||
      entry.role === "BLANK_POST"
    ) {
      const current = candidates;
      candidates = current.filter((c) =>
        c.heightFt === run.panelHeightFt ||
        !current.some((d) => d.coversFt === c.coversFt && d.heightFt === run.panelHeightFt));
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
 * What a regenerate does to the lines already on one run: the phone's
 * TakeoffLineMerge (app/src/main/java/com/fenceestimator/app/data/), ported
 * rule for rule, so the office's re-price and the phone's agree on a run
 * somebody edited and not only on one nobody touched.
 *
 * The bug this replaces: price-job replaced every line of the run that had a
 * material role, edited ones included, and carried only the PRICE somebody
 * typed across, by role. The office re-prices whenever a tax, markup,
 * discount or labour rate is saved, so a quantity the owner typed on the
 * phone went back to the engine's number the next time anyone saved a rate,
 * and the price moved with it.
 *
 *  - **A line somebody changed by hand is never deleted or overwritten.**
 *    Editing saves it with auto_generated = false. It stays exactly as it is
 *    and counts in the totals as it is. The cost, accepted on purpose: an
 *    edited line no longer follows the drawing.
 *  - **No second line for something the person already corrected.** An
 *    edited line stands for the built line with its sync id; failing that,
 *    for the one built line of its role still unclaimed, or the one with its
 *    product name ([claimedByEdits]). The built line it stands for is not
 *    written.
 *  - **Only auto-generated lines are replaced.** Hand-typed extras (role
 *    NONE) were never part of this and still are not.
 *  - **A typed price is not copied onto other lines.** Once the edited line
 *    itself stays, carrying its price by role could only ever reach a
 *    DIFFERENT line of the same role -- the 6 ft gate panel taking the price
 *    typed for the 4 ft one, and then counting as hand-edited for good.
 *    Supplier quotes still carry ([withQuotedPrices]).
 *
 * What a commit writes from this, including "a rebuild that matches what is
 * there writes nothing", is load.ts buildCommitPlan.
 */
export interface TakeoffMerge {
  /** Freshly built lines to write. */
  insert: EstimateLineItem[];
  /** Lines somebody changed by hand. Left exactly as they are. */
  keptEdited: EstimateLineItem[];
  /** The auto-generated takeoff lines on the run now. All of them give way to `insert`. */
  replacedAuto: EstimateLineItem[];
}

/**
 * TakeoffLineMerge.plan.
 *
 * `existingForRun` is every line on the run, in the order the phone's DAO
 * reads them (sort_order, then sync_id; priceJob sorts them so). That order
 * decides which quote wins when two lines of one role carry one, and the
 * order the kept lines come out in. Lines with role NONE are ignored.
 * `built` is what buildLineItems produced for the run.
 */
export function mergeTakeoff(existingForRun: readonly EstimateLineItem[], built: readonly EstimateLineItem[]): TakeoffMerge {
  const takeoffLines = existingForRun.filter((e) => e.role !== "NONE");
  const edited = takeoffLines.filter((e) => !e.isAutoGenerated);
  const auto = takeoffLines.filter((e) => e.isAutoGenerated);

  const claimed = claimedByEdits(edited, built);
  // filterNot { claimed }, then distinctBy { syncId }: the first one kept.
  const seen = new Set<string>();
  const insert: EstimateLineItem[] = [];
  for (const item of withQuotedPrices(built, takeoffLines)) {
    if (claimed.has(item.syncId) || seen.has(item.syncId)) continue;
    seen.add(item.syncId);
    insert.push(item);
  }
  return { insert, keptEdited: edited, replacedAuto: auto };
}

/**
 * The sync ids of the built lines that an edited line already stands for,
 * and which therefore must not be written beside it.
 *
 * First by sync id: an edited line with the id the build produces IS that
 * line. Then, for an edited line whose id the build no longer produces (a
 * role that starts repeating gets a width folded into its id, see
 * deterministicSyncIdForWidth), the built line of the same role that nothing
 * has claimed yet -- when there is exactly one, or else the one carrying the
 * same product name. If nothing identifies it, nothing is claimed: an extra
 * line on screen beats a gate silently missing from the material order.
 *
 * Edits are taken in order and each claim is seen by the next one, as
 * TakeoffLineMerge.claimedByEdits takes them.
 */
export function claimedByEdits(edited: readonly EstimateLineItem[], built: readonly EstimateLineItem[]): Set<string> {
  const builtIds = new Set(built.map((b) => b.syncId));
  const claimed = new Set(edited.map((e) => e.syncId).filter((id) => builtIds.has(id)));
  for (const e of edited) {
    if (builtIds.has(e.syncId)) continue;
    const open = built.filter((b) => b.role === e.role && !claimed.has(b.syncId));
    // Kotlin: open.singleOrNull() ?: open.firstOrNull { it.description == e.description }
    const pick = open.length === 1 ? open[0] : open.find((b) => b.description === e.description);
    if (pick !== undefined) claimed.add(pick.syncId);
  }
  return claimed;
}

/**
 * A price read off the supplier's own quote is the most authoritative number
 * on the job, and regenerating must not throw it away. Carried by role, and
 * only for real roles. The last row per role in the order handed in wins
 * (Kotlin `associate`, and Map.set). Carrying a quote does not mark a line
 * as hand-edited.
 */
export function withQuotedPrices(built: readonly EstimateLineItem[], existing: readonly EstimateLineItem[]): EstimateLineItem[] {
  const quotedByRole = new Map<MaterialRole, number>();
  for (const item of existing) {
    if (item.supplierUnitPrice !== null && item.role !== "NONE") quotedByRole.set(item.role, item.supplierUnitPrice);
  }
  return built.map((item) => {
    const price = quotedByRole.get(item.role);
    return price !== undefined ? { ...item, supplierUnitPrice: price } : item;
  });
}
