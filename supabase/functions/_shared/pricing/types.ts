/**
 * The shapes the pricing engine works on.
 *
 * These mirror the Kotlin entities in
 * app/src/main/java/com/fenceestimator/app/data/Entities.kt field for field,
 * under the same names, so that a line of the port can be read next to the
 * line of Kotlin it came from. The snake_case cloud rows the edge function
 * receives are turned into these by the adapters in index.ts; nothing below
 * knows a column name.
 *
 * Enums are string unions rather than TypeScript enums so the same source
 * runs unchanged under tsx and under Deno, and so a value read from JSON is
 * already the right thing without a lookup table.
 */

export const FENCE_TYPES = [
  "VINYL", "WOOD", "CHAIN_LINK", "ALUMINUM", "ORNAMENTAL_IRON", "SPLIT_RAIL", "COMPOSITE", "UNIVERSAL",
] as const;
export type FenceType = (typeof FENCE_TYPES)[number];

export const WOOD_STYLES = ["PRIVACY", "SPACED_PICKET"] as const;
export type WoodStyle = (typeof WOOD_STYLES)[number];

export const ALUMINUM_STYLES = ["RACKABLE", "FLAT_TOP"] as const;
export type AluminumStyle = (typeof ALUMINUM_STYLES)[number];

export const MATERIAL_ROLES = [
  "PANEL", "GATE_PANEL",
  "LINE_POST", "END_POST", "CORNER_POST", "GATE_POST",
  "POST_CAP", "CONCRETE_BAG", "HOLE_PLUG",
  /** Undrilled post a wall-hung gate bolts through; it is not set in concrete. */
  "BLANK_POST",
  "HINGE_SET", "LATCH", "HANDLE", "BRACE", "STIFFENER", "TRIM",
  "WOOD_PICKET", "WOOD_RAIL", "GATE_FRAME_KIT",
  "CHAIN_FABRIC", "TOP_RAIL", "TENSION_WIRE", "TENSION_BAND", "BRACE_BAND", "RAIL_END",
  "BARBED_WIRE_ARM", "PRIVACY_SLAT",
  "NONE",
] as const;
export type MaterialRole = (typeof MATERIAL_ROLES)[number];

/**
 * Where a gate is hung, which decides what it is built from.
 *
 * This is not cosmetic -- the three cases need genuinely different material,
 * and guessing wrong is a truck coming back from the yard. A wall-hung gate
 * needs no concrete at all, which is the single biggest difference.
 */
export const GATE_MOUNTINGS = ["WALL", "LINE", "LINE_TO_WALL"] as const;
export type GateMounting = (typeof GATE_MOUNTINGS)[number];

/** Which way a gate opens. Recorded on the gate; the takeoff does not read it. */
export const GATE_SWINGS = ["IN", "OUT", "BOTH"] as const;
export type GateSwing = (typeof GATE_SWINGS)[number];

/**
 * Kotlin's `Enum.valueOf(name)`: the exact name or nothing. Every caller in
 * the Kotlin app wraps it in runCatching and picks its own fallback, so this
 * returns null and lets the caller choose the same fallback.
 */
export function enumValueOf<T extends string>(values: readonly T[], name: string): T | null {
  return (values as readonly string[]).includes(name) ? (name as T) : null;
}

/** One drawn fence line on the job's survey, with its own type and spec. */
export interface FenceRun {
  syncId: string;
  label: string;
  fenceType: FenceType;
  sortOrder: number;

  // Geometry, drawn on the job's shared survey image (or grid, if no photo)
  pointsEncoded: string;
  gatesEncoded: string;
  closedLoop: boolean;
  /**
   * Unused on the phone -- the teardown length is typed on the job instead.
   * Carried because the engine still reads it in two places (linearFeet and
   * teardownLinearFeet), and the port replicates those reads exactly.
   */
  isTeardown: boolean;

  /** Preferred color/finish, matched against the catalog when picking priced items. Blank = no preference. */
  colorOrFinish: string;

  // Panel-based spec (vinyl / aluminum / ornamental iron). All Float.
  panelWidthFt: number;
  panelHeightFt: number;
  aluminumStyle: AluminumStyle;

  // Wood / composite spec
  woodStyle: WoodStyle;
  woodRailCount: number;
  picketWidthIn: number;
  picketGapIn: number;

  // Chain link spec
  fabricHeightFt: number;
  includeTopRail: boolean;
  includeTensionWire: boolean;
  includeBarbedWireArms: boolean;
  includePrivacySlats: boolean;

  // Split-rail spec
  splitRailCount: number;

  // Post spacing / concrete. Both Float.
  postSpacingFt: number;
  concreteBagsPerPost: number;

  /**
   * Typed-in footage. When set, this is the truth and the drawing is ignored.
   * Null means "measure it from the drawing".
   */
  manualLinearFeet: number | null;
  /** Corners to assume when working from manualLinearFeet -- there's no drawing to count them from. */
  manualCornerCount: number;
  /** Roles the user deleted off this run's estimate; the takeoff skips them. Already parsed from the CSV. */
  suppressedRoles: ReadonlySet<MaterialRole>;
}

/** The Job fields the engine reads. Money is Double; the calibration is Float. */
export interface Job {
  calibrationPixelsPerFoot: number | null;
  taxRatePercent: number;
  markupPercent: number;
  laborRatePerFt: number;
  laborFlatFee: number;
  discountPercent: number;
  minimumJobCharge: number;
  wastePercent: number;
  gateRatePerFt: number;
  trashHaulFee: number;
  teardownEnabled: boolean;
  teardownFlatFee: number;
  teardownRatePerFt: number;
  teardownFeet: number;
  /**
   * The phone holds a Room id here and matches it against MaterialItem.manufacturerId.
   * Both sides of the cloud speak sync ids, so the port matches on those; the
   * comparison is the same "equal or not" either way.
   */
  preferredManufacturerSyncId: string | null;
}

export interface MaterialItem {
  syncId: string;
  /** Never read by the matching logic; echoed onto the line so the office can group by it. */
  category: string;
  role: MaterialRole;
  /** Which fence type this price applies to, or UNIVERSAL if shared (e.g. concrete). */
  fenceType: FenceType;
  name: string;
  unit: string;
  unitPrice: number;
  taxable: boolean;
  /**
   * For PANEL/GATE_PANEL: width in feet this unit covers.
   * For CHAIN_FABRIC: the fabric height in feet this row represents.
   * Float.
   */
  coversFt: number | null;
  colorOrFinish: string;
  /** Null = generic/no specific manufacturer. */
  manufacturerSyncId: string | null;
  isActive: boolean;
}

export interface EstimateLineItem {
  syncId: string;
  /** Null for job-level items not tied to a specific fence run. */
  fenceRunSyncId: string | null;
  sortOrder: number;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  taxable: boolean;
  role: MaterialRole;
  isAutoGenerated: boolean;
  /**
   * What the supplier actually quoted, once they have come back. Null until
   * then, and that distinction is the point: unitPrice is the catalog guess.
   */
  supplierUnitPrice: number | null;
}

/** What this line actually costs: the supplier quote if it exists, the catalog guess if not. */
export function effectiveUnitPrice(item: EstimateLineItem): number {
  return item.supplierUnitPrice ?? item.unitPrice;
}

export function lineTotal(item: EstimateLineItem): number {
  return item.quantity * effectiveUnitPrice(item);
}

/** Extra work agreed after the original estimate. The engine reads two of its fields. */
export interface ChangeOrder {
  syncId: string;
  additionalFeet: number;
  /** What the customer is charged for this change, materials included. */
  additionalCost: number;
  /** Not read by the pricing formula; carried so the input row round-trips. */
  materialCost: number;
}
