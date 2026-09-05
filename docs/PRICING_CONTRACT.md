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

### Input rules (what the phone does around the engine; the port mirrors them)

- **Float-valued fields** (written after fround; the Kotlin reader refuses a
  value that is not already a float): `pixels_per_foot`,
  `job.calibration_pixels_per_foot`, and on runs `manual_linear_feet`,
  `panel_width_ft`, `panel_height_ft`, `post_spacing_ft`,
  `concrete_bags_per_post`, `picket_width_in`, `picket_gap_in`,
  `fabric_height_ft`; on catalog rows `covers_ft`. Everything else that is a
  number is a Double. Points and gates travel as the phone's own strings and
  are decoded with `FenceCodec` (Float parsing, malformed pairs dropped,
  3-/4-/5-part gates, unknown mounting -> LINE, unknown swing -> IN).
- **`pixels_per_foot`** is the scale the TAKEOFF measures by:
  `job.calibration_pixels_per_foot ?? 20` (the grid's `PIXELS_PER_FOOT_GRID`,
  the fallback EstimateViewModel and TakeoffRefresher both use).
  `linear_feet` / `teardown_linear_feet` do NOT share the fallback: they use
  `job.calibration_pixels_per_foot` as stored and count an uncalibrated drawn
  run as 0 ft. So an uncalibrated job gets materials and no labour feet. That
  is the phone's behaviour; reproduce it.
- **Manufacturers**: the engine narrows on the phone's Long ids. A
  `preferred_manufacturer_sync_id` or `manufacturer_sync_id` that is not in
  `manufacturers[]` resolves to null (= no preference / no manufacturer),
  exactly as JobSync does. `material_items.manufacturer_sync_id` exists as a
  cloud column but the phone never pushes it (CloudMaterialItem has no such
  field), so until the office writes it every row arrives null.
- **`catalog[].supplier_unit_price`** is accepted for the column's sake and
  read by neither engine: `MaterialItem` has no supplier price. Supplier
  prices live on line items (`existing_items[].supplier_unit_price`).
- **Enum fallbacks**, as the phone's pull does them: a catalog `role` the
  engine does not know is `NONE`, `category` -> `MISC`, `fence_type` ->
  `UNIVERSAL`; an `existing_items[].role` that is null or unknown is `NONE`.
  A run's `fence_type` is strict (an unknown one is an error, not a guess).
- **`existing_items`** are every non-deleted `estimate_line_items` row of the
  job. Carry-over is per run: only rows whose `fence_run_sync_id` is that run
  feed `TakeoffRefresher`'s `editedPrices` (rows with `auto_generated=false`
  and a role other than NONE, keyed by role, last row wins) and
  `quotedPrices` (rows with a `supplier_unit_price` and a role other than
  NONE). A row whose `fence_run_sync_id` names no run in `runs[]` is treated
  as job-level.
- **`is_teardown` runs** get their geometry and takeoff computed (the engine
  is pure) but NO line items -- TakeoffRefresher clears a teardown run's
  bill of materials. Their footage feeds `teardown_linear_feet` only.

## PricingOutput

```jsonc
{
  "engine_version": "2026.09.1",
  "linear_feet": 143.5,                  // EstimateEngine.linearFeet(job, runs)
  "teardown_linear_feet": 0,             // EstimateEngine.teardownLinearFeet
  "billable_linear_feet": 143.5,         // what labour is charged on (computeTotals)
  "runs": [ /* every run in runs[] order, teardown runs included */
    { "run_sync_id": "…", "is_teardown": false, "gate_count": 1,
      "gross_feet": 150, "gate_feet": 6.5, "net_feet": 143.5,
      "geometry": { "corner_count": 2, "end_count": 2, "line_vertex_count": 0,
                    "segments": [ { "from_index": 0, "to_index": 1, "length_ft": 100 } ],
                    "vertices": [ { "index": 0, "kind": "END", "turn_degrees": 0 } ] },
      "posts": { "line": 22, "corner": 2, "end": 2, "gate": 2, "terminal": 6, "total": 28 },
      "entries": [ { "role": "PANEL", "quantity": 24, "prefer_covers_ft": 6, "covers_linear_ft": 143.5 } ],
      "takeoff": [ { "label": "Fence length", "quantity": 150, "unit": "ft", "group": "SITE" } ]
    }
  ],
  "items": [ /* the estimate_line_items rows the engine would write, in sort order */
    { "sync_id": "…", "fence_run_sync_id": "…", "sort_order": 0, "description": "…",
      "quantity": 24, "unit": "EA", "unit_price": 52.35, "supplier_unit_price": null,
      "taxable": true, "role": "PANEL", "auto_generated": true, "category": null }
  ],
  "unmatched_roles": [ { "run_sync_id": "…", "role": "HOLE_PLUG" } ],
  "zero_priced": [ "sync_id", "…" ],
  "zero_priced_names": [ { "run_sync_id": "…", "name": "Placeholder blank post" } ],
  "totals_items": [ "sync_id", "…" ],
  "totals": {
    "materials_subtotal": 0, "taxable_subtotal": 0, "tax": 0,
    "labor_cost": 0, "teardown_cost": 0, "trash_haul_fee": 0,
    "gate_feet": 0, "gate_charge": 0,
    "change_order_cost": 0, "change_order_feet": 0,
    "markup_amount": 0, "discount_amount": 0,
    "pre_markup_total": 0, "grand_total": 0,
    "billable_linear_feet": 143.5
  }
}
```

### Output rules

- **Stages, in the order the check names them**: per run `geometry`
  (`gross_feet` + `geometry`), `net_feet` (`gate_count`, `gate_feet`,
  `net_feet`), `posts`, `entries`, `takeoff`; then `items`,
  `unmatched_roles`, `zero_priced`, `zero_priced_names`, `feet`
  (`linear_feet`, `teardown_linear_feet`, `billable_linear_feet`),
  `totals_items`, `totals`. The first that differs is the one reported.
- **`geometry`** is `FenceGeometryResult` in full. For a typed run it is the
  synthetic result (`segments`/`vertices` empty, `corner_count` =
  `manual_corner_count` clamped at 0, `end_count` = 0 closed / 2 open).
  `vertices[].turn_degrees` is `Math.toDegrees(|turn|)` as a Float; the port
  uses `x * (180 / Math.PI)` and fdlibm `atan2`, which V8 and the JVM share.
  Corners exactly at 15.000° are documented, not asserted.
- **`gate_feet`** (per run) is `sum(gate.widthFt as Double)` cast to Float --
  the engine's own `gateWidthTotal`. `net_feet` = `max(gross - gate_feet, 0)`
  in Float.
- **`posts`** are the engine's private `PostCounts`, read back off the takeoff
  lines ("Line posts", "Corner posts", "End posts", "Gate posts (end posts +
  stiffener)", "Total posts"; an absent line is 0). `terminal` = corner + end
  + gate. These are the raw counts: suppression and waste do not touch them.
- **`entries`** are `suggestions.entries` after waste, `wholeBags` and
  `suppressed_roles`, zero quantities included (only `buildLineItems` drops
  them). **`takeoff`** is `suggestions.takeoff` verbatim (`group` is the
  `TakeoffGroup` name) -- this is what the office prints.
- **`items`** are the rows for every non-teardown run, in run order, AFTER
  the carry-over: `supplier_unit_price` from `quotedPrices[role]`; then, if
  `editedPrices[role]` exists and differs from the row's `unit_price`, that
  price with `auto_generated=false`. `sort_order` restarts at 0 per run.
  `category` is always null (EstimateLineItem has no category; the office
  looks it up from the catalog by description if it wants one).
- **`zero_priced`** are the sync ids of written rows whose catalog
  `unit_price <= 0` (before carry-over); **`zero_priced_names`** is the
  engine's own `zeroPricedNames` per run.
- **`totals_items`** is the order `computeTotals` summed in: the written
  rows plus the SURVIVING existing rows, sorted by (`sort_order`, `sync_id`)
  -- the phone's DAO order (`ORDER BY sortOrder ASC, syncId ASC`).
  Floating-point sums depend on order, so the port must add the same rows in
  the same order. A row survives a regenerate iff its role is `NONE` or it
  has no `fence_run_sync_id` (`replaceGeneratedForRun` deletes every roled
  row of the run, edited ones included).
- **`totals`** is `EstimateEngine.Totals` field for field, plus
  `pre_markup_total` = materials_subtotal + tax + labor_cost + teardown_cost
  + change_order_cost + gate_charge in that order (the engine's `preMarkup`;
  not exposed on Totals, so it is rebuilt from the six it IS built from) and
  `billable_linear_feet` (Float on Totals; also mirrored at top level).
- **Sync ids**: the width suffix is appended only when a role appears more
  than once among the run's merged entries; it is `coversFt ?: 0f` rendered
  by `Float.toString`, so a repeated role with a null width would read
  `:0.0`. Today's engine never produces that, but the rule stands.

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
  "note": "why this case exists and what it pins",
  "input": PricingInput,
  "expected": PricingOutput }
```

Cases are invented (no customer, no address). Sync ids are fixed per case:
`<case number as 8 hex digits>-0000-4000-8000-<slot as 12 hex digits>`, so a
tie broken on sync id breaks the same way everywhere. Shipped catalog rows
use `UUID.nameUUIDFromBytes("fenceflow-parity-seed:<fence_type>:<role>:<name>:<color>")`
so the same SeedData row keeps its id across regenerates. The Kotlin check
also refuses a fixture whose `input` no longer equals the case that produced
it, and a case set that does not match the files on disk -- either means
"regenerate", never "edit the JSON".

`fixtures/pricing/manifest.json`: `{ "version": "2026.09.1", "generated_at": "…", "case_count": N }`.

Kotlin writes them (`ParityFixtureWriter`, active only with env
`FENCEFLOW_PARITY_OUT=<dir>`); Kotlin (`ParityFixtureCheck`) and the
TypeScript test both assert EXACT equality against them, stage by stage,
naming the first divergent stage. No tolerances. Never regenerate expected
from the TypeScript side.

## Commands

All from the repo root in Git Bash, with JDK 17 exported first (the
bundled JBR is Java 25 and fails):

```sh
export JAVA_HOME=/c/Users/march/.jdks/jdk-17.0.20+8

# Regenerate the fixtures (deliberate; same commit as the engine change).
# $(pwd) is a /c/... path in Git Bash; the writer turns it back into C:/...
# The test JVM does see the variable through the Gradle daemon.
FENCEFLOW_PARITY_OUT=$(pwd)/fixtures/pricing ./gradlew testDebugUnitTest --tests "*ParityFixtureWriter*" -q

# Check the committed fixtures against the engine (fails the build on drift).
./gradlew testDebugUnitTest --tests "*Parity*" -q

# Everything, once, after touching the engine.
./gradlew testDebugUnitTest -q
```

The Kotlin side lives in `app/src/test/java/com/fenceestimator/app/estimate/parity/`:
`PricingContract.kt` (the shapes), `PricingAdapters.kt` (`PricingRunner.price`,
the one place every around-the-engine rule is written down), `ParityCases.kt`
(the cases), `ParityFixtureWriter.kt`, `ParityFixtureCheck.kt`.
- TypeScript: `npx -y tsx supabase/functions/_shared/pricing/parity.ts` (a plain script that exits non-zero on the
  first divergence; no test framework, so the same file also runs under `deno run -A`).
- Both: `node scripts/check-parity.mjs`.
