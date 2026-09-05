/**
 * Database rows <-> the pricing contract.
 *
 * `price-job/index.ts` does the querying and the writing; every decision
 * about what a row MEANS -- which columns are Float and need `Math.fround`,
 * what a null falls back to, which existing lines survive a re-price, what
 * a commit actually writes -- lives here instead, as plain functions with no
 * Supabase client in sight. That is what makes them checkable from
 * `load_test.ts` with hand-built rows and no database in the loop, and it is
 * what keeps the edge function itself to "load rows, call these, write rows
 * back" with no pricing judgement of its own.
 *
 * The Db*Row types below are deliberately narrower than the tables they come
 * from (no `id`, `company_id`, `updated_at`, `deleted_at` on the read side):
 * they are exactly the columns price-job's own `.select()` calls ask for, so
 * a column this file was never told about cannot silently ride along into
 * the engine.
 */
import { f32 } from "./f32.ts";
import { enumValueOf, MATERIAL_ROLES } from "./types.ts";
import type {
  ChangeOrderRow,
  FenceRunRow,
  ItemOutput,
  JobRow,
  LineItemRow,
  ManufacturerRow,
  MaterialItemRow,
  PricingInput,
  PricingOutput,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Database rows, exactly as price-job selects them.
// ---------------------------------------------------------------------------

/** `jobs`, plus the two columns the engine itself never reads: the id used
 * to load everything else, and the clock `commit`'s 409 check compares. */
export type DbJobRow = JobRow & { sync_id: string; updated_at: string };

/** `fence_runs`, non-deleted, in `sort_order`. Same shape as the contract's
 * own `FenceRunRow` -- the table was designed to be read straight across. */
export type DbFenceRunRow = FenceRunRow;

/** `material_items`, active and inactive both (the engine itself filters). */
export type DbMaterialItemRow = MaterialItemRow;

/** `manufacturers`. */
export type DbManufacturerRow = ManufacturerRow;

/** `change_orders`, non-deleted. */
export type DbChangeOrderRow = ChangeOrderRow;

/** `estimate_line_items`, non-deleted, for the whole job. */
export interface DbLineItemRow {
  sync_id: string;
  fence_run_sync_id: string | null;
  role: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  supplier_unit_price: number | null;
  taxable: boolean;
  auto_generated: boolean;
  sort_order: number;
}

/** The columns `sample` mode copies off a row from the `my_build_templates()`
 * RPC. Gate defaults (`gate_width_ft`, `gate_mounting`) are not here on
 * purpose -- a sample run is "no gates", so nothing reads them. */
export interface DbBuildTemplateRow {
  sync_id: string;
  name: string;
  fence_type: string;
  color_or_finish: string;
  panel_width_ft: number;
  panel_height_ft: number;
  post_spacing_ft: number;
  concrete_bags_per_post: number;
  aluminum_style: string;
  wood_style: string;
  wood_rail_count: number;
  picket_width_in: number;
  picket_gap_in: number;
  fabric_height_ft: number;
  include_top_rail: boolean;
  include_tension_wire: boolean;
  include_barbed_wire_arms: boolean;
  include_privacy_slats: boolean;
  split_rail_count: number;
}

// ---------------------------------------------------------------------------
// Row -> contract. Money stays Double (plain numbers); everything the
// contract calls Float goes through Math.fround here, once, so a value read
// back from Postgres can never fail priceJob's own floatExact re-check.
// ---------------------------------------------------------------------------

export function jobRowToInput(row: DbJobRow): JobRow {
  return {
    calibration_pixels_per_foot: row.calibration_pixels_per_foot === null || row.calibration_pixels_per_foot === undefined
      ? null
      : f32(row.calibration_pixels_per_foot),
    tax_rate_percent: row.tax_rate_percent,
    markup_percent: row.markup_percent,
    discount_percent: row.discount_percent,
    labor_rate_per_ft: row.labor_rate_per_ft,
    labor_flat_fee: row.labor_flat_fee,
    minimum_job_charge: row.minimum_job_charge,
    waste_percent: row.waste_percent,
    gate_rate_per_ft: row.gate_rate_per_ft,
    trash_haul_fee: row.trash_haul_fee,
    teardown_enabled: row.teardown_enabled,
    teardown_flat_fee: row.teardown_flat_fee,
    teardown_rate_per_ft: row.teardown_rate_per_ft,
    teardown_feet: row.teardown_feet,
    preferred_manufacturer_sync_id: row.preferred_manufacturer_sync_id ?? null,
  };
}

export function fenceRunRowToInput(row: DbFenceRunRow): FenceRunRow {
  return {
    sync_id: row.sync_id,
    label: row.label,
    fence_type: row.fence_type,
    color_or_finish: row.color_or_finish,
    points_encoded: row.points_encoded,
    gates_encoded: row.gates_encoded,
    closed_loop: row.closed_loop,
    manual_linear_feet: row.manual_linear_feet === null || row.manual_linear_feet === undefined
      ? null
      : f32(row.manual_linear_feet),
    manual_corner_count: row.manual_corner_count,
    panel_width_ft: f32(row.panel_width_ft),
    panel_height_ft: f32(row.panel_height_ft),
    post_spacing_ft: f32(row.post_spacing_ft),
    concrete_bags_per_post: f32(row.concrete_bags_per_post),
    aluminum_style: row.aluminum_style,
    wood_style: row.wood_style,
    wood_rail_count: row.wood_rail_count,
    picket_width_in: f32(row.picket_width_in),
    picket_gap_in: f32(row.picket_gap_in),
    fabric_height_ft: f32(row.fabric_height_ft),
    include_top_rail: row.include_top_rail,
    include_tension_wire: row.include_tension_wire,
    include_barbed_wire_arms: row.include_barbed_wire_arms,
    include_privacy_slats: row.include_privacy_slats,
    split_rail_count: row.split_rail_count,
    suppressed_roles: row.suppressed_roles,
    is_teardown: row.is_teardown,
    sort_order: row.sort_order,
  };
}

export function materialItemRowToInput(row: DbMaterialItemRow): MaterialItemRow {
  return {
    sync_id: row.sync_id,
    name: row.name,
    category: row.category,
    role: row.role,
    fence_type: row.fence_type,
    color_or_finish: row.color_or_finish,
    unit: row.unit,
    unit_price: row.unit_price,
    taxable: row.taxable,
    covers_ft: row.covers_ft === null || row.covers_ft === undefined ? null : f32(row.covers_ft),
    is_active: row.is_active,
    manufacturer_sync_id: row.manufacturer_sync_id ?? null,
  };
}

export function manufacturerRowToInput(row: DbManufacturerRow): ManufacturerRow {
  return { sync_id: row.sync_id, name: row.name };
}

export function changeOrderRowToInput(row: DbChangeOrderRow): ChangeOrderRow {
  return {
    sync_id: row.sync_id,
    additional_feet: row.additional_feet,
    additional_cost: row.additional_cost,
    material_cost: row.material_cost,
  };
}

/** No Float fields (quantity/unit_price/supplier_unit_price are Double), and
 * the shape already matches `LineItemRow` -- kept as its own function anyway
 * so every row source goes through the same "row -> contract" pipeline and a
 * future column lands here rather than being spread in unread. */
export function lineItemRowToInput(row: DbLineItemRow): LineItemRow {
  return {
    sync_id: row.sync_id,
    fence_run_sync_id: row.fence_run_sync_id,
    role: row.role,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    unit_price: row.unit_price,
    supplier_unit_price: row.supplier_unit_price,
    taxable: row.taxable,
    auto_generated: row.auto_generated,
    sort_order: row.sort_order,
  };
}

export interface PricingInputSource {
  job: DbJobRow;
  /** Non-deleted, in `sort_order` -- callers must load them that way; this file does not sort. */
  runs: readonly DbFenceRunRow[];
  catalog: readonly DbMaterialItemRow[];
  manufacturers: readonly DbManufacturerRow[];
  changeOrders: readonly DbChangeOrderRow[];
  existingItems: readonly DbLineItemRow[];
  /** Always the module's own `PRICING_ENGINE_VERSION` in production; a
   * parameter here only so this function needs no import from index.ts to
   * be exercised in isolation. */
  engineVersion: string;
}

/**
 * Assembles one `PricingInput`. `pixels_per_foot` is worked out here, not
 * left to the caller, because getting the fallback right (the job's own
 * calibration, or the survey grid's 20 px/ft when there is none) is the one
 * genuinely stateful decision in "turn rows into a PricingInput" -- see
 * PRICING_CONTRACT.md's note that this fallback and `linear_feet`'s do NOT
 * agree, on purpose.
 */
export function buildPricingInput(src: PricingInputSource): PricingInput {
  const job = jobRowToInput(src.job);
  return {
    engine_version: src.engineVersion,
    pixels_per_foot: f32(job.calibration_pixels_per_foot ?? 20),
    job,
    runs: src.runs.map(fenceRunRowToInput),
    catalog: src.catalog.map(materialItemRowToInput),
    manufacturers: src.manufacturers.map(manufacturerRowToInput),
    change_orders: src.changeOrders.map(changeOrderRowToInput),
    existing_items: src.existingItems.map(lineItemRowToInput),
  };
}

/**
 * `sample` mode's hypothetical run: a template's spec with typed footage
 * standing in for a drawing. "Typed-in footage... the drawing is ignored"
 * (PRICING_CONTRACT.md), so points/gates are blank rather than synthesised,
 * and "open run, no gates" per the office wizard's own description of what a
 * sample is -- a company sizing up "what would 150 ft of this cost" before
 * anyone has drawn or gated anything.
 */
export function buildSampleRun(template: DbBuildTemplateRow, feet: number, syncId: string): FenceRunRow {
  return {
    sync_id: syncId,
    label: template.name,
    fence_type: template.fence_type,
    color_or_finish: template.color_or_finish,
    points_encoded: "",
    gates_encoded: "",
    closed_loop: false,
    manual_linear_feet: f32(feet),
    manual_corner_count: 0,
    panel_width_ft: f32(template.panel_width_ft),
    panel_height_ft: f32(template.panel_height_ft),
    post_spacing_ft: f32(template.post_spacing_ft),
    concrete_bags_per_post: f32(template.concrete_bags_per_post),
    aluminum_style: template.aluminum_style,
    wood_style: template.wood_style,
    wood_rail_count: template.wood_rail_count,
    picket_width_in: f32(template.picket_width_in),
    picket_gap_in: f32(template.picket_gap_in),
    fabric_height_ft: f32(template.fabric_height_ft),
    include_top_rail: template.include_top_rail,
    include_tension_wire: template.include_tension_wire,
    include_barbed_wire_arms: template.include_barbed_wire_arms,
    include_privacy_slats: template.include_privacy_slats,
    split_rail_count: template.split_rail_count,
    suppressed_roles: "",
    is_teardown: false,
    sort_order: 0,
  };
}

// ---------------------------------------------------------------------------
// Optimistic concurrency for `commit`.
// ---------------------------------------------------------------------------

/**
 * Whether somebody else's edit landed between the caller reading the job and
 * this commit arriving. No `expected_updated_at` means the caller is not
 * asking for the check (a wizard step that just created the job, say) --
 * exact string equality is tried first so the common case (the caller echoes
 * back exactly what it was handed) needs no date parsing at all; a value
 * that fails to parse on either side cannot be proven fresh, so it is
 * treated as stale rather than let through.
 */
export function isStale(actualUpdatedAt: string, expectedUpdatedAt: string | null | undefined): boolean {
  if (expectedUpdatedAt === null || expectedUpdatedAt === undefined || expectedUpdatedAt === "") return false;
  if (expectedUpdatedAt === actualUpdatedAt) return false;
  const actual = Date.parse(actualUpdatedAt);
  const expected = Date.parse(expectedUpdatedAt);
  if (Number.isNaN(actual) || Number.isNaN(expected)) return true;
  return actual !== expected;
}

// ---------------------------------------------------------------------------
// PricingOutput -> what `commit` writes.
// ---------------------------------------------------------------------------

export interface CommitLineItemWrite {
  company_id: string;
  sync_id: string;
  job_sync_id: string;
  fence_run_sync_id: string;
  sort_order: number;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  supplier_unit_price: number | null;
  taxable: boolean;
  role: string;
  auto_generated: boolean;
  /** Reset on every upsert -- see buildCommitPlan's tombstone note. */
  deleted_at: null;
  deleted_by: "";
}

export interface CommitPlan {
  /** Rows to upsert into `estimate_line_items` on (company_id, sync_id). */
  upsertItems: CommitLineItemWrite[];
  /** Sync ids of existing rows to tombstone -- update, never delete. */
  tombstoneSyncIds: string[];
  jobPatch: {
    contract_total: number;
    priced_by: "OFFICE";
    priced_at: string;
    pricing_engine_version: string;
  };
}

/** One `estimate_line_items` row for an item the engine just priced. */
export function commitLineItemWrite(item: ItemOutput, companyId: string, jobSyncId: string): CommitLineItemWrite {
  return {
    company_id: companyId,
    sync_id: item.sync_id,
    job_sync_id: jobSyncId,
    fence_run_sync_id: item.fence_run_sync_id,
    sort_order: item.sort_order,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    supplier_unit_price: item.supplier_unit_price,
    taxable: item.taxable,
    role: item.role,
    auto_generated: item.auto_generated,
    // Line-item sync ids are deterministic (uuid3 of run + role + width), so
    // a role that was tombstoned by an earlier commit and has now come back
    // (a suppressed role un-suppressed, or a catalog match re-added) upserts
    // onto the SAME row a previous commit soft-deleted. Leaving deleted_at
    // set would regenerate an estimate line that stays invisible everywhere
    // that filters on it -- resurrecting it explicitly is the only way an
    // upsert-by-sync-id can un-delete a row at all.
    deleted_at: null,
    deleted_by: "",
  };
}

/**
 * A role is a real material line, not a hand-typed extra, using the same
 * fallback the engine itself applies when reading `existing_items` (null or
 * unrecognised -> NONE): `lineItemFromRow` in index.ts. The tombstone rule
 * has to agree with THAT reading of the row, not with the raw column, or a
 * legacy role string neither side recognises would be tombstoned here while
 * the engine's own survivor check kept it.
 */
function hasMaterialRole(role: string | null): boolean {
  const adapted = role === null || role === undefined ? null : enumValueOf(MATERIAL_ROLES, role);
  return (adapted ?? "NONE") !== "NONE";
}

/**
 * What `commit` writes, in the order index.ts must apply it: `upsertItems`
 * first, then tombstone `tombstoneSyncIds`, then `jobPatch`. This mirrors
 * `TakeoffRefresher.replaceGeneratedForRun` exactly: every NOT-deleted
 * existing row of a priced run whose role is not NONE is replaced -- edited
 * prices included, since editing a price is what clears the auto flag, not
 * what protects the row -- while a row with no run, or role NONE (a
 * hand-typed extra), is never touched. `pricedRunSyncIds` is every run this
 * call priced (dry_run and commit price the whole job, so that is every
 * non-deleted fence_run; `sample` never commits, so this function is never
 * called for it) -- a teardown run is included, and since it produced no
 * `output.items` at all, every one of its existing roled rows tombstones,
 * which is TakeoffRefresher's own "marking a run teardown clears its
 * materials" rule.
 */
export function buildCommitPlan(args: {
  output: PricingOutput;
  companyId: string;
  jobSyncId: string;
  pricedRunSyncIds: readonly string[];
  existingItems: readonly DbLineItemRow[];
  /** Now, read once by the caller so every row in one commit shares a timestamp. */
  nowIso: string;
}): CommitPlan {
  const { output, companyId, jobSyncId, pricedRunSyncIds, existingItems, nowIso } = args;

  const upsertItems = output.items.map((item) => commitLineItemWrite(item, companyId, jobSyncId));

  const writtenSyncIds = new Set(output.items.map((i) => i.sync_id));
  const runSet = new Set(pricedRunSyncIds);
  const tombstoneSyncIds = existingItems
    .filter((e) => e.fence_run_sync_id !== null && runSet.has(e.fence_run_sync_id))
    .filter((e) => hasMaterialRole(e.role))
    .filter((e) => !writtenSyncIds.has(e.sync_id))
    .map((e) => e.sync_id);

  return {
    upsertItems,
    tombstoneSyncIds,
    jobPatch: {
      contract_total: output.totals.grand_total,
      priced_by: "OFFICE",
      priced_at: nowIso,
      // The module's own version, read off the output priceJob just
      // produced -- priceJob refuses to run at all when its input names a
      // different one, so this is always PRICING_ENGINE_VERSION, but reading
      // it off the output rather than importing the constant keeps this
      // file's only coupling to index.ts in its type imports.
      pricing_engine_version: output.engine_version,
    },
  };
}
