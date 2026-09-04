# Pricing contract: one input, one output, two engines

The phone (`EstimateEngine.kt` + `FenceGeometry.kt`) and the server
(`supabase/functions/_shared/pricing/`) implement the same arithmetic. This
file is the shape both speak. Three consumers, never a fourth: the edge
function `price-job`, the Kotlin fixture tests, the TypeScript fixture test.

Field names are Supabase column names (snake_case), exactly as `CloudJob`,
`CloudFenceRun`, `CloudLineItem`, `CloudMaterialItem` already serialise them.
If a Kotlin value has no column here, ADD it to this file in the same commit
— never invent a name on one side only.

## PricingInput

```jsonc
{
  "engine_version": "2026.09.1",
  "pixels_per_foot": 20,                 // job.calibration_pixels_per_foot ?? 20 (EstimateViewModel fallback)
  "job": {
    "calibration_pixels_per_foot": null, // number | null, as stored
    "tax_rate_percent": 7, "markup_percent": 0, "discount_percent": 0,
    "labor_rate_per_ft": 8, "labor_flat_fee": 0, "minimum_job_charge": 200,
    "waste_percent": 0, "gate_rate_per_ft": 20, "trash_haul_fee": 0,
    "teardown_enabled": false, "teardown_flat_fee": 0, "teardown_rate_per_ft": 0, "teardown_feet": 0,
    "preferred_manufacturer_sync_id": null
  },
  "runs": [ /* fence_runs rows, CloudFenceRun names, non-deleted, in sort order */
    { "sync_id": "…", "label": "Back", "fence_type": "VINYL", "color_or_finish": "White",
      "points_encoded": "x:y,x:y,…", "gates_encoded": "…", "closed_loop": false,
      "manual_linear_feet": null, "manual_corner_count": 0,
      "panel_width_ft": 6, "panel_height_ft": 6, "post_spacing_ft": 6, "concrete_bags_per_post": 1,
      "aluminum_style": "RACKABLE", "wood_style": "PRIVACY", "wood_rail_count": 3,
      "picket_width_in": 5.5, "picket_gap_in": 0, "fabric_height_ft": 4,
      "include_top_rail": true, "include_tension_wire": false, "include_barbed_wire_arms": false,
      "include_privacy_slats": false, "split_rail_count": 2, "suppressed_roles": "",
      "is_teardown": false, "sort_order": 0 }
  ],
  "catalog": [ /* material_items rows, CloudMaterialItem names, active and inactive both (the engine filters) */
    { "sync_id": "…", "name": "…", "category": "…", "role": "LINE_POST", "fence_type": "VINYL",
      "color_or_finish": "White", "unit": "EA", "unit_price": 12.5, "supplier_unit_price": null,
      "taxable": true, "covers_ft": 0, "is_active": true, "manufacturer_sync_id": null }
  ],
  "manufacturers": [ { "sync_id": "…", "name": "…" } ],
  "change_orders": [ /* non-deleted; fields the engine reads */
    { "sync_id": "…", "additional_feet": 0, "additional_cost": 0, "material_cost": 0 }
  ],
  "existing_items": [ /* estimate_line_items rows already on the job, for hand-edited price carry-over */
    { "sync_id": "…", "fence_run_sync_id": "…", "role": "LINE_POST", "description": "…",
      "quantity": 12, "unit": "EA", "unit_price": 12.5, "supplier_unit_price": null,
      "taxable": true, "auto_generated": true, "sort_order": 3 }
  ]
}
```

Rules: every value that is a Kotlin `Float` is a JSON number that
round-trips through `Math.fround` exactly (write it after fround). Nulls are
`null`, never omitted, for the fields above. Arrays keep list order; order is
part of the contract (sums iterate in order).

## PricingOutput

```jsonc
{
  "engine_version": "2026.09.1",
  "linear_feet": 143.5,                  // EstimateEngine.linearFeet(job, runs)
  "teardown_linear_feet": 0,             // EstimateEngine.teardownLinearFeet
  "billable_linear_feet": 143.5,         // what labour is charged on (computeTotals)
  "runs": [
    { "run_sync_id": "…",
      "gross_feet": 150, "gate_feet": 6.5, "net_feet": 143.5,
      "geometry": { "corner_count": 2, "end_count": 2, "line_vertex_count": 0 },
      "posts": { "line": 22, "corner": 2, "end": 2, "gate": 2, "terminal": 6, "total": 28 },
      "entries": [ { "role": "PANEL", "quantity": 24, "prefer_covers_ft": 6, "covers_linear_ft": 143.5 } ]
    }
  ],
  "items": [ /* the estimate_line_items rows the engine would write, in sort order */
    { "sync_id": "…", "fence_run_sync_id": "…", "sort_order": 0, "description": "…",
      "quantity": 24, "unit": "EA", "unit_price": 52.35, "supplier_unit_price": null,
      "taxable": true, "role": "PANEL", "auto_generated": true, "category": "…" }
  ],
  "unmatched_roles": [ { "run_sync_id": "…", "role": "HOLE_PLUG" } ],
  "zero_priced": [ "sync_id", "…" ],
  "totals": {
    "materials_subtotal": 0, "taxable_subtotal": 0, "tax": 0,
    "labor_cost": 0, "teardown_cost": 0, "trash_haul_fee": 0,
    "gate_feet": 0, "gate_charge": 0,
    "change_order_cost": 0, "change_order_feet": 0,
    "markup_amount": 0, "discount_amount": 0,
    "pre_markup_total": 0, "grand_total": 0
  }
}
```

`items[].sync_id` is Java `UUID.nameUUIDFromBytes` (MD5, not RFC v5) of
`'fenceflow-line:<runSyncId>:<ROLE>'` plus `':<coversFt ?: 0f>'` rendered
with Kotlin `Float.toString` — reproduce that string byte for byte.

If Kotlin's `Totals` (or any intermediate) carries a value not listed
here, add it to this file under the same snake_case rule and emit it on
both sides. Do not drop it.

## Fixtures

`fixtures/pricing/<case>.json`:

```jsonc
{ "schema": 1,
  "engine": { "version": "2026.09.1", "generated_at": "…" },
  "case": "vinyl-open-two-gates",
  "input": PricingInput,
  "expected": PricingOutput }
```

`fixtures/pricing/manifest.json`: `{ "version": "2026.09.1", "generated_at": "…", "case_count": N }`.

Kotlin writes them (`ParityFixtureWriter`, active only with env
`FENCEFLOW_PARITY_OUT=<dir>`); Kotlin (`ParityFixtureCheck`) and the
TypeScript test both assert EXACT equality against them, stage by stage,
naming the first divergent stage. No tolerances. Never regenerate expected
from the TypeScript side.

## Commands

- Kotlin: `export JAVA_HOME=/c/Users/march/.jdks/jdk-17.0.20+8 && ./gradlew testDebugUnitTest --tests "*Parity*"`;
  regenerate with `FENCEFLOW_PARITY_OUT=fixtures/pricing ./gradlew testDebugUnitTest --tests "*ParityFixtureWriter*"`.
- TypeScript: `npx -y tsx supabase/functions/_shared/pricing/parity.ts` (a plain script that exits non-zero on the
  first divergence; no test framework, so the same file also runs under `deno run -A`).
- Both: `node scripts/check-parity.mjs`.
