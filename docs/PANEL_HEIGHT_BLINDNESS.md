# Panel height blindness

Measured 1 October 2026 against the real engine, the real starting catalog and (read only) the live
database. Nothing here was fixed, applied or deployed. The numbers below are reproduced by
`tests/a34-height-blindness.test.mjs`, the live section by `A34_LIVE=1` (see the end). Two things were measured
another way and say so where they appear: the fixture count under a scratch copy of the engine (5.4), and the
console's `taxable:false` rows (7).

## The short version

- **The engine never reads height when it chooses a catalog row.** A panel or a gate panel is chosen by
  nearest width, then cheapest. Every other role (posts, caps, rails, pickets, hardware) is chosen by
  price alone. The one role that reads a height is chain-link fabric, because its `covers_ft` *is* a height.
  The run's `panel_height_ft` changes no quote for any fence type: proved for all seven, 3 ft to 8 ft.
- **One collision ships in the starting list: ornamental steel 4'H and 6'H, both 6 ft wide.** A 6 ft high
  iron run is priced with the 4 ft high panel. **UNDERCHARGE**, $40 a panel before tax, **$727.60 on
  100 ft and $1,455.20 on 200 ft** (about 15% of the right price). Twelve other width groups and seventy
  price-only groups were checked and are clean (section 2).
- **In the live data it is latent, not realised.** One real company holds the pair (a copy of the starting
  list). No iron run exists. All 14 panel/gate lines on real jobs carry the height of their run.
  Dollars exposed today: 0. The new-company seed (`supabase_r20_seed_new_company_catalog.sql`, not
  applied) would give every future company the same pair, so that is where it grows.
- **The owner's decision removes the transition product and simplifies the fix.** A 6 ft fence that steps
  down to 4 ft is priced as 6 ft: no catalog item, no role, no engine rule.
- **The fix is small in the engines and large around them.** A height term between width and price in both
  selectors, a formula change (engine version bumped on both sides, the 85 parity fixtures regenerated in
  the same commit). Of the 85, **2 change in content** (both iron, +$856.00 and +$836.74). Of the live
  jobs, 0 change.
- **The only place a catalog row's height exists is its NAME.** There is no height column, field or
  migration anywhere. Section 5.2 is the part to read twice.

## 1. What the engine does

`buildLineItems` (TypeScript `line-items.ts`, Kotlin `EstimateEngine.kt`) takes each thing the takeoff asks
for, narrows the candidate rows (active, the run's fence type or UNIVERSAL, then the run's colour if any
row has it, then the preferred manufacturer if any row has it), and chooses:

| The takeoff asks with | Roles | Chosen by | Reads height? |
|---|---|---|---|
| a width (`preferCoversFt`) | `PANEL` (run's panel width), `GATE_PANEL` / `GATE_FRAME_KIT` (the gate's width) | nearest `covers_ft`, then cheapest priced, then sync id | **No** |
| a height | `CHAIN_FABRIC` (the run's `fabric_height_ft`) | nearest `covers_ft` **which is the fabric height**, then cheapest, then sync id | Yes, by overloading `covers_ft` |
| nothing | every other role the takeoff builds (posts, caps, rails, pickets, concrete, hardware, trim, tension, slats) | cheapest priced, then sync id | **No** |

`GATE_POST` is never asked for (gate posts are `END_POST`), so the seed's seven `GATE_POST` rows can never
reach a quote. Neither side's takeoff nor selector references `panelHeightFt`: the TypeScript adapter maps
the column into the run and nothing reads it back; on the phone the other readers are screens that show or
edit it, the PDF, and sync. None is in the estimate engine.

## 2. Every collision, and every group checked

A *collision* is two rows of one fence type and role that share a `covers_ft` and name different heights.
Heights were read from the row names; the name's width equals `covers_ft` on all fifteen panel and gate rows,
so the reading is sound for the starting list.

| Group (fence type, role, width) | Rows | Heights named | Result |
|---|---|---|---|
| **ORNAMENTAL_IRON PANEL 6 ft** | 2 | **4'H $135.00, 6'H $175.00** | **COLLISION** |
| ORNAMENTAL_IRON PANEL 8 ft | 1 | 4'H | clean (no 6'H x 8'W exists, see 3) |
| ORNAMENTAL_IRON GATE_PANEL 4 ft | 1 | 4'H | clean (the only iron gate) |
| VINYL PANEL 6 ft | 3 (White, Tan, Gray) | 6'H | clean |
| VINYL PANEL 8 ft | 2 (White, Tan) | 6'H | clean |
| VINYL GATE_PANEL 5 ft | 1 | 6'H | clean |
| ALUMINUM PANEL 6 ft | 3 (Black, White, Bronze) | 6'H | clean |
| ALUMINUM PANEL 8 ft | 1 | 6'H | clean |
| ALUMINUM GATE_PANEL 4 ft | 1 | 6'H | clean |
| WOOD / CHAIN_LINK / COMPOSITE GATE_FRAME_KIT 4 ft, SPLIT_RAIL 10 ft | 1 each | none named | clean (no panels, no height in the name) |
| CHAIN_LINK CHAIN_FABRIC 4, 6, 8 | 1 each | height *is* `covers_ft` | clean (no two rows share a height) |
| 70 price-only groups (fence type, role, colour) | exactly 1 row each | n/a | clean |

Thirteen width-keyed groups, one collision. The same list also ships in `website/dashboard.html` (the office
console's "start from FenceFlow's catalog") and twice in `supabase_r20_seed_new_company_catalog.sql`; all
three copies carry the same nineteen panel, gate and gate-frame rows and the same pair (pinned by the test).

Clean does not mean right. Three things the seed cannot choose between because only one row exists:
a 6 ft high iron run at 8 ft panels is priced with the **4'H** x 8'W panel (no 6'H x 8'W row);
the iron gate is 4'H only, so a 6 ft iron fence gets a 4 ft gate; the aluminium gate is 6'H only, so a
4 ft aluminium fence gets a 6 ft gate. Those are catalog gaps. No selector can fix them.

## 3. What the collision costs, from the real engine

6 ft high ornamental iron, black, 6 ft panels, no gate, 7% tax, labour $8/ft. "Correct" is the same quote
with the 4'H x 6'W row removed from the catalog and nothing else changed.

| Job | Row the engine picks | Row it should pick | Engine today | Correct | Short | % of correct |
|---|---|---|---|---|---|---|
| 100 ft, 0% markup (17 panels) | 4'H x 6'W $135 | 6'H x 6'W $175 | $4,079.02 | $4,806.62 | **$727.60** | 15.1% |
| 200 ft, 0% markup (34 panels) | 4'H x 6'W $135 | 6'H x 6'W $175 | $8,112.29 | $9,567.49 | **$1,455.20** | 15.2% |
| 100 ft, 15% markup | same | same | $4,690.87 | $5,527.61 | **$836.74** | 15.1% |
| 200 ft, 15% markup | same | same | $9,329.13 | $11,002.61 | **$1,673.48** | 15.2% |
| fixture: drawn run, wall gate | same | same | $5,147.36 | $6,003.36 | **$856.00** | 14.3% |

Per panel: $40.00 before tax, $42.80 with tax, $49.22 with the 15% markup. The shortfall is exactly
panels x $40 x tax x markup: the panel row is the only thing that differs.

**Direction: UNDERCHARGE.** The shorter panel is the cheaper one, so the engine always takes it. That is the
owner's own margin on every 6 ft iron job, quietly. There is no refund exposure from this one. The reverse
(an OVERCHARGE that loses bids, or a refund) needs a taller row that is the *cheaper* of a pair, which the
starting list does not contain. The 4 ft run is not affected: for it the 4'H panel is correct (a control in
the test). One more visible effect: the line on the quote reads "Ornamental Steel Panel 4'H x 6'W" while the
run says 6 ft (`quote-view` reads both the line description and the run's height).

Same family, smaller: chain-link fabric height between two rows ties on distance and the cheaper, shorter
row wins. A 5 ft run is priced with 4 ft fabric, a 7 ft run with 6 ft fabric: $125 short per 100 LF against
the next size up.

## 4. Is anything else height-blind?

Yes: everything except chain-link fabric, but only the panel case can be hit by the starting list.

Proof used throughout: plant a 1 cent decoy, in the same fence type and role, whose name claims a different
(shorter) height. It won in all 71 (fence type, role) pairs the takeoff asks for, across seven fence types and
three gate mountings: at the width the run asks for where the role is width-keyed, outright where it is not.

- **Panels and gate panels**: section 3.
- **Posts, caps, rails, pickets and the rest** are chosen by price alone.
  **The consequence is worse than for panels: a shorter, cheaper post wins every quote of its fence type,
  whatever the fence height.** The fence is built on it. The seed ships exactly one row per fence type,
  role and colour (70 groups checked), so this cannot happen from the seed; it is real the day a company
  adds a second length. In the live catalog it has not happened (zero such groups). A post's number in its
  name is its *length*, not a fence height, and the run carries no embed depth, so the panel fix below does
  not extend to posts. The safe rule for now: one post row per fence type, role and colour.
- **Gates**: width-keyed like panels. A gate has no height of its own (`GateMarker` carries a width, a
  mounting and a swing), so any height rule can only use the run's.
- **Wood, composite and split rail** have no panel rows, so height never enters the price. The editor sets
  the rail count from the height; the engine reads the rail count, not the height.
- **Chain-link fabric** reads height correctly, through `covers_ft`.

## 5. What the fix has to do

Stated to be implemented; not implemented here (both engines are held).

### 5.1 Where height is available at selection time: on both sides, already

- TypeScript: `buildLineItems(run: FenceRun, ...)` in `line-items.ts`; `FenceRun.panelHeightFt` is filled by
  the adapter in `index.ts` from `panel_height_ft`, which `price-job` selects (`RUN_COLUMNS`).
- Kotlin: `buildLineItems(jobId, fenceRunId, run: FenceRun, ...)` in `EstimateEngine.kt`;
  `FenceRun.panelHeightFt` is in `Entities.kt` (default 6). Both phone call sites
  (`TakeoffRefresher.kt`, `EstimateViewModel.kt`) pass the run. One Kotlin change covers both.
- `QtyEntry` carries only the width. No change to the takeoff is needed for panels: the run is in scope
  where the choice is made.

### 5.2 How a row's height can be known: only from its NAME. Read this twice.

`MaterialItem` has **no height field** in Kotlin or TypeScript; `material_items` has **no height column**
and no migration ever added one; `price-job`'s `CATALOG_COLUMNS` has none; the catalog editor has **one**
number labelled "Width/height it covers, ft (panels & fabric only)", which is the width for a panel.
(All pinned by the test, with controls.) So a panel's height exists only inside its display name:
`Ornamental Steel Panel 6'H x 6'W, Black`.

**Parsing a product name to price a job is fragile, and the project has a standing rule against comparing
display text.** The grammar the starting list uses (`6'H`, `6 ft high`, `6 foot tall`) parses on all 15 of
its panel and gate rows and on 15 of 19 width-keyed rows in the live catalog (the other four are gate frame
kits, which name no height). What a person types instead is **not** parsed, silently: a curly apostrophe
(`6’H`, which phone keyboards insert), `72"H`, `6 ft. tall`, `6-ft H`, `six foot`, `6′H`. A row whose name is
edited that way becomes an unknown height, the fix falls back to today's behaviour for it, and the
undercharge returns with no error anywhere. Both runtimes would also need the identical pattern (Kotlin
`Regex` and JavaScript `RegExp`), parsed to a Float and compared as one, or the phone and the office
disagree.

The alternative is a **real height column** on the catalog row. That is the right design and a schema change:

- Room: `MaterialItem.heightFt` and a migration (`Entities.kt`, `AppDatabase.kt`, both held).
- Cloud: `material_items.height_ft`, the sync DTOs (`EntitySync.kt`, held), `price-job`'s `CATALOG_COLUMNS`,
  `load.ts`, the `PricingInput` contract (`docs/PRICING_CONTRACT.md`: "never invent a name on one side only"),
  the Kotlin parity adapters.
- A catalog editor field on the phone (new string x 3 languages: `strings.xml` held) and on the office console.
- Every copy of the starting list gets the value: `SeedData.kt`, `dashboard.html`, `supabase_r20_*.sql`.
- A one-time backfill of existing rows. That is a write to live data and the owner's call; it could be
  derived from the same name parse, once, with the result reviewed.

### 5.3 The rule, and what a catalog with no matching height does

The reference model in the test (an executable spec, not the engine) is a **tie-break**: between rows at the
same distance from the width asked for, prefer the one whose height fits the run, *before* price.

| Row's height h, run's height H | Fit (lower wins) |
|---|---|
| unknown (nothing parsed / column empty) | 0, a wildcard: never dropped, never penalised |
| h at least H | h - H (exact is 0; a taller panel is allowed, the closest taller wins: it is cut on site) |
| h below H | 1000 + H - h (too short is worse than any taller panel) |

Only `PANEL` and `GATE_PANEL`, only the run's height, comparator `distance, fit, price, sync id`.

**The fallback.** The rule can never remove a candidate, so a company cannot be left with nothing to price
from and cannot be priced at zero. A catalog holding only 6 ft panels, quoting a 4 ft fence, falls through to
price exactly as today. This decides whether the fix can break an existing customer's quote, so it is tested
rather than argued, over 864 runs (three fence types, four colours, four widths, six heights, three gate
setups):

- With the tie-break **off**, the model reproduces the real engine's choice of every row (about 6,000 rows
  compared): so the model is faithful.
- A catalog with one height per fence type, and a catalog whose names carry no height at all: the fix moves
  **no** quote, and no panel goes to zero.
- On the starting list the fix moves 144 of the 864 runs, **every one iron**, only the panel line: runs of 5, 6,
  7 and 8 ft high go to the 6'H panel; 3 and 4 ft stay on the 4'H.
- A row with no height in its name that is the cheapest still wins, as today.
- It does not fix the gaps in section 2: a 6 ft iron run at 8 ft panels keeps the only 8 ft row.

Why a tie-break and not "drop the rows of the wrong height first" (measured on the same 864 runs): dropping
changes 48 of them and fixes only the exact-height case. Heights between or above the sizes stocked (5, 7 and
8 ft iron) match nothing exactly, fall back to everything, and stay on the 4'H panel. Worse, it lets height
override width: 12 of the 48 are an 8 ft-panel iron run that jumps to 6 ft panels and is re-counted. The
tie-break changes 144, every one of them a genuine collision, and moves a quote only where two rows are
equally near in width.

With the fix, the owner's 4 ft request is safe to add: a 4'H x 6'W vinyl panel priced under the 6'H one stops
taking over 6 ft white quotes (today it would, which is why it was never added), and a 6 ft run whose last
bay is cut to 4 ft is just a 6 ft run.

### 5.4 It changes existing prices: a formula change

The iron case is wrong today and the fix makes it right, so it moves quotes. Therefore:

- Bump `PRICING_ENGINE_VERSION` on **both** sides in the same change. Both read `2026.10.1` today; the fixture
  manifest still reads `2026.09.3` (the rounding change's regeneration has not landed), so sequence this after
  that one or fold it into the same regeneration.
- Regenerate the 85 fixtures in the same commit (`fixtures/pricing/`, written by the Kotlin side; every file
  takes the new version stamp). **Two change in content**: the test's model says so, and so does a scratch
  copy of the engine with the tie-break applied, run over all 85 (measured outside the test; the project's
  engine was not touched): `ornamental-iron-drawn-open-wall-gate` and `template-08-ornamental-iron-6ft`, both
  height 6, the 4'H panel becoming the 6'H. New fixture cases are needed for the 4, 5 and 8 ft cases, a row
  with no height, and a mangled name.
- Until a phone updates, it and the office price a 6 ft iron job differently. That path already exists: when the
  office priced a job under a newer engine version the phone backs off and files a parity report rather than
  overwriting (see the version comment in `index.ts`).
  A signed or sent total is anchored and does not move. An unsigned iron draft re-priced after the fix goes up.
- `tests/a34-height-blindness.test.mjs` and `tests/a32-panel-choice-ignores-height.test.mjs` go red when the
  fix lands. That is intended: rewrite them for the new rule, do not loosen them.

### 5.5 Decisions that are the owner's

1. **Name tie-break now, or a height column.** The tie-break is two engine files plus fixtures and fails soft;
   the column is the right design and touches about a dozen files including held ones. They are not exclusive:
   the column's backfill can come from the same parse.
2. **Taller is allowed.** A 5 ft pool fence with only 4'H and 6'H rows is priced with the 6'H. That follows his
   own rule for the step-down (price the taller panel as the bay, he cuts it); say so if he wants the opposite
   for runs between sizes.
3. **`supabase_r20_seed_new_company_catalog.sql` (not applied) seeds every new company with the pair.** Hold it
   until the selector reads height. Taking the 4'H iron 6 ft row out of its list instead would price every new
   company's 4 ft iron as 6 ft.
4. **The owner's own catalog holds the pair now.** Until the fix, a 6 ft iron quote from the starting list is
   short by the table in section 3. An interim, if he sells no 4 ft iron, is to set the 4'H x 6'W row inactive
   in his catalog. That is a data change and was not made.

## 6. The real data (read only)

One `SELECT` through `supabase db query`, no writes, no secrets. A **synthetic canary company** (ordinal -1,
built from `VALUES` inside the same statement) carries a known collision, a known mispriced line (17 panels x
($175 - $135) = $680) and a known two-row post group. The probe is invalid unless it reports all of them; it did,
with exactly those numbers. The raw output is checked for the word `ERROR` before anything is parsed, a failed
call is retried and never read as an empty result (the CLI is known to fail about one call in four). The
statement is guarded to contain no write keyword. Companies are arbitrary ordinals:
no names, no contact data, no catalog names or prices, no customer data in this document.

| Question | Answer |
|---|---|
| Companies, of which test fixtures | 10, of which 4 |
| Non-fixture companies holding an active catalog | **1** (the other 5 hold none) |
| Of those, holding a colliding pair | **1**: ornamental iron PANEL, 6 ft, heights 4 and 6, the shorter the cheaper (the starting list, copied) |
| Width-keyed rows in it / with a height in the name / name width differing from `covers_ft` | 19 / 15 / 0 |
| Price-only groups with two rows of one colour (real) | 0 |
| Panel and gate lines on real (non-test) jobs | 14: 2 accepted, 3 completed, 9 draft |
| ...whose height matches their run | **14 of 14** |
| ...priced off a wrong-height row where a right one existed | **0**; shortfall $0 |
| Real runs by height | vinyl 6 ft: 13, wood 6 ft: 2, vinyl 4 ft: 1; no iron, aluminium or chain link |

So no real job has been priced off the collision, because no real job is iron. The one 4 ft vinyl run has no
line that differs from it. The fix would change no live quote today. The risk is forward-looking: the pair sits
in the live catalog, in the console's list and in the unapplied new-company seed.

## 7. Not done, and found on the way

- The transition row and its one-company SQL are already gone (`SeedData.kt` reads 92 rows; the a32 transition
  test and SQL no longer exist). This wave touched no existing file.
- `website/dashboard.html`'s copy of the starting list still marks four panel/gate rows `taxable:false`
  (the 6'W White, Tan and Gray vinyl panels and the vinyl gate), the bug `tests/a31-seed-panels-are-taxable`
  fixed in `SeedData.kt`. The console's "start from FenceFlow's catalog" would hand a new company untaxed panels.
  Not investigated further; the file is held.
- The aluminium and iron posts in the starting list are 6' long and are billed identically for a 4 ft and a 6 ft
  fence. Whether that suits the fence is catalog content, not selection.

## Reproduce

```
node --test tests/a34-height-blindness.test.mjs                  no network, no writes
A34_TABLE=1 node --test tests/a34-height-blindness.test.mjs      also prints the tables above
A34_LIVE=1  node --test tests/a34-height-blindness.test.mjs      also runs the read-only live probe (about 1.5 minutes)
```

The tripwires were checked against a scratch copy of the tree in which `line-items.ts` has the tie-break applied
(the project itself was not touched): 12 of the engine, source and model tests go red there, while the census,
the three-copies check, the name-grammar and migration scans and the version check stay green.
