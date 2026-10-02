# Materials audit: the 6 ft and 4 ft arithmetic

Measured 2 October 2026, 00:20 to 00:52 EDT, against the pricing engine as it stood then (both
`EstimateEngine.kt` and `supabase/functions/_shared/pricing` read version `2026.10.9` until about 00:47 and
`2026.10.8` at 00:51; the label moved under me, and the numbers below re-ran identically on both), the owner's REAL live
catalog (123 rows, read-only), and the two supplier quotes in `SUPPLIER_QUOTES_2026-10-01.md`.

**Nothing was changed, applied, deployed, staged or sent.** No source file was edited. The live reads were
six `SELECT`s through `supabase db query` (one was rejected for naming a column that does not exist and
was rerun without it): the catalog, jobs and runs, drawn-run coordinates, a column list, and estimate
lines. Each carried a synthetic canary row that had to come back (it did, every time) and was checked for
the word `ERROR` in the raw output before parsing. No customer name, address or email appears here; jobs
are numbered 1 to 11 in creation order. Gradle was not run. Every figure below was produced by importing
the repo's own TypeScript engine into node and pricing a snapshot of the live catalog. The Kotlin engine's
matching functions were read side by side and are the same logic; finding 1 exists only on the
TypeScript side.

The engines were being edited while this ran (the version label above; `price-job/index.ts` and `load.ts`
touched at 00:27; `index.ts` and `EstimateEngine.kt` at 00:46). `takeoff.ts` last changed at 00:05 and
`line-items.ts` at 20:44 the day before, and every behaviour cited below lives in those two. At 00:51
`CATALOG_COLUMNS` in `price-job` still did not name `height_ft`. Re-run section 8 before acting on anything
here.

## 0. The short version

The post and panel counting is right for a straight run and slightly optimistic everywhere else. The two
things most likely behind "calculations that are not right" and "deposits that do not match" are not
arithmetic at all. They are two surfaces pricing the same job from different information:

1. **The office price-job function never reads `height_ft`, so the office prices a 4 ft fence exactly like a
   6 ft one.** Same job, same catalog: the phone says $2,555.20 for the 100 ft, one-gate, 4 ft run; the
   office says $2,393.63, which is also exactly what it says for the 6 ft run. On his real job 11 the office
   is $166.16 of materials ($177.79 with tax) below the phone.
2. **The one real job that holds priced lines (job 11) was priced before the post-height and blank-post
   fixes and is stale:** 22 line posts on its two 6 ft runs are billed at the 4 ft fence's $13.18 post, and
   its wall gate has no blank post. The current engine says $91.30 more materials ($97.69 with tax). The
   office's re-price would put the $13.18 posts straight back (finding 1).

### What I checked and found clean

- Every Flori and Hartford figure in the quotes file is in his live catalog to the cent. The two Hartford
  sub-cent prices (54.99875, 18.99929) are the PDF's own, put there deliberately (`a45`).
- Concrete is always a whole number of bags (15 mounting and bags-per-post combinations tried).
- A sliver bay buys a whole panel and a whole post. No fraction of either is ever billed.
- 689 exact-multiple lengths (6 ft to 400 ft, six gate widths, 6 and 8 ft spacing) all count exactly
  `net / spacing` bays. No float dust at exact multiples.
- A WALL gate's blank post takes no concrete. A LINE gate's hinge post takes 1.5 bags and its latch post 1.0.
  Every part of a vinyl gate has a catalog row, and nothing a supplier quoted for the gate is missing from
  the app (section 5).
- The TypeScript engine, handed the heights, makes the 6 ft and 4 ft choices the Kotlin source specifies (read side by side, not run).
- The blank-post fallback works at both heights ($16.56 at 6 ft, $16.75 at 4 ft).

### Findings ranked

Cost is per the 100 ft run with one 5 ft gate unless stated, before tax unless stated.

| # | Severity | Finding | Direction | Cost |
|---|---|---|---|---|
| 1 | HIGH | Office `price-job` selects no `height_ft`; the office prices every height as the cheapest row | under | -$58.03 (6 ft), -$161.57 (4 ft) grand total; job 11 -$177.79 |
| 2 | HIGH | Job 11's stored lines predate the post and blank-post fixes | under | -$91.30 materials |
| 3 | MED-HIGH | Any height other than exactly 4 or 6 falls through to cheapest: a 6' post and a 4 ft gate on a 5, 7 or 8 ft fence | under, and unsafe | $3.38 a post, $6.91 a gate; a 6' post under an 8 ft fence |
| 4 | MED | Bays and panels are rounded on the WHOLE run, not per section; every corner and gate adds a sliver bay the engine does not buy | under | $22.05 a missing post (with cap and bag); 1 to 5 on his real runs |
| 5 | MED | When the catalog's panel is not the run's width, panels are recomputed but posts, caps, concrete and the waste allowance are not | under | 4 posts, 4 caps, 4 bags short per 100 ft ($88.20) |
| 6 | MED | Office "Measured from satellite" saves vinyl, aluminium and iron runs with 6 ft panels on 8 ft post spacing | under | $88.20 per 100 ft |
| 7 | MED | U-channel: the app bills 4 a gate; both quotes carry 2 (Flori proved to the cent) | over | +$4.00 Flori, +$5.98 Hartford; 5 a gate once waste is above 0 |
| 8 | MED | Hartford's 6 ft gate is a kit that already holds a brace; the app adds Hartford's $19.99 V-brace | over | +$19.99 a gate, only when a Hartford gate is chosen |
| 9 | MED | 4 ft end, gate and corner posts come from the wrong row (no Flori 4 ft End, Blank or Corner rows exist) | over | +$13.52 to $14.28 on a gated run (4 posts) |
| 10 | MED | Cheapest-wins picks seed rows that undercut both suppliers' real prices; with no preferred supplier his quote is below Flori's own | under | -$28.67 (6 ft), -$41.84 (4 ft) against Flori's quote |
| 11 | LOW-MED | A 10 or 12 ft gate is priced as one 5 ft walk gate, with no warning | under | in no live job (all gates are 5.0 ft) |
| 12 | LOW | A run that is only a gate bills two phantom end posts | over | $44.10 |
| 13 | LOW | Gate concrete is hard-coded 1.5 and 1.0, not scaled by bags-per-post; the default of 1 bag a post may be light | under, latent | $4.75 a bag; needs his answer |
| 14 | LOW | Waste allowance has float dust at 8, 9, 10, 11, 12 and 14 percent: one extra unit at certain counts | over | one unit |
| 15 | LOW | `LINE_TO_WALL` bills one post, cap and bag more than `LINE`; I cannot tell whether that is right | over? | $22.05 |
| 16 | LOW | 4 ft Tan or Gray vinyl is priced from the 6 ft privacy panel; 4 ft aluminium gets 6'H parts; 6 ft iron gets a 4'H gate | under | $7.24 to $17.00 a panel |

## 1. The post rule

### 1.1 Restated

`computePostCounts` (`takeoff.ts`, `EstimateEngine.kt`; identical):

```
net        = max(0, gross - sum(gate widths))                 gate openings come out first
bays       = ceil(net / postSpacing)                          0 if spacing is 0
estimate   = bays == 0 ? 0
           : ends == 0 ? max(0, bays - gates)                 closed loop
           :             max(0, bays + 1 - gates)             open run, two ends
linePosts  = max(0, estimate - corners - ends)                corners and ends are CARVED OUT of the pool
gatePosts  = 2 per gate, 3 for LINE_TO_WALL
totalPosts = linePosts + corners + ends + gatePosts
caps       = totalPosts                                       panel fences
```

For an open run with no corners and `g` LINE gates this is `totalPosts = bays + 1 + g`. For a closed loop
with `g` gates it is `bays + g`.

### 1.2 By hand against the engine (spacing 6 ft, vinyl, typed footage)

| Case | Hand | Engine posts | Engine panels | Verdict |
|---|---|---|---|---|
| Open 100 ft, one 5 ft LINE gate | net 95, bays 16, est 16, line 14, total 14+2+2 = 18 | 18 (14/0/2/2) | 16 | Right as an aggregate count; see 1.3 for the section split |
| Open 100 ft, no gate | bays 17, est 18, total 18 | 18 | 17 | **Exactly right**; a 4 ft sliver gets a whole panel |
| Closed loop 120 ft, 4 corners | bays 20, est 20, line 16, total 20 | 20 (16/4/0/0) | 20 | Right only if each side is a multiple of 6 ft (1.3) |
| Closed loop 120 ft, 4 corners, one 5 ft gate | net 115, bays 20, est 19, line 15, total 21 | 21 | 20 | Right: a gate turns the loop into a chain, bays + 1 |
| Open 100 ft, TWO 5 ft LINE gates | net 90, bays 15, est 14, line 12, total 12+2+4 = 18 | 18 | 15 | Right when all three sections are multiples of 6; short by up to 2 otherwise |
| Open 4 ft (shorter than one bay) | bays 1, est 2, line 0, total 2 | 2 | 1 | **Right**: one bay, two posts, one cut panel |
| Open 0.5 ft | same | 2 | 1 | Right |
| Open exactly 6.0 ft | bays 1, total 2 | 2 | 1 | **Right** |
| Open 6.1 ft | bays 2, est 3, total 3 | 3 | 2 | **Right**: the sliver bay needs its own post |
| Open 96 ft (exact multiple) | bays 16, total 17 | 17 | 16 | **Right**, no off-by-one at the boundary |
| Open 101 ft, no gate | bays 17, total 18 | 18 | 17 | Right |
| Open 100 ft, one 5 ft WALL gate | est 16, line 14, +2 ends, +2 gate = 18 | 18 (END 3, BLANK 1, LINE 14) | 16 | Total right; the split has one END where one LINE belongs (no money at 6 ft, $3.57 at 4 ft) |
| Open 100 ft, one 5 ft LINE_TO_WALL gate | est 16, line 14, +2, +3 = 19 | 19 | 16 | One more than LINE; topology unclear (finding 15) |
| Open 100 ft, 2 corners | est 18, line 14, +2, +2 = 18 | 18 | 17 | Right |
| A run that is only a 5 ft gate | physical: 2 posts | **4** (0/0/2/2) | 0 | **Two phantom end posts** (finding 12) |

The reference 100 ft, one-gate job is also what Flori priced. Their two totals ($1,518.64 and $1,635.72 at
6.5% tax) fit exactly one set of quantities: **16 panels, 18 posts, 18 caps, 1 gate, 1 stiffener, 1 brace,
2 U-channels, 1 hinge set, 1 latch, 1 handle**. That is a brute-force solve over 5 to 45 of each, one
solution, to the cent on both totals. 16, 18 and 18 are what the app computes, so the quote is not an
independent check on the post rule (the file does not say who chose the counts); it shows only that the
suppliers priced the app's own numbers. **The 2 U-channels is the one number in it that is not the app's**
(finding 7).

### 1.3 Where it is off by one: the whole-run rounding

`bays` is `ceil` of the run's total net length. A gate or a corner splits the fence into separate
sections, and each section ends in its own sliver bay with its own post. The engine buys one sliver for the
whole run. Posts cannot be shared across sections, so this is a real shortfall of posts. Panels can partly
be saved because a vinyl panel's rails and boards can be cut and an offcut reused, so read the panel figure
as an upper bound.

Mean shortfall for `n` sections is `(n - 1) / 2` posts (simulated, 200,000 trials per column):

| Sections | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Mean posts short | 0.0 | 0.5 | 1.0 | 1.5 | 2.0 | 2.5 |
| Share of jobs short | 0% | 50% | 83% | 96% | 99% | 100% |

For the reference run (one gate at a random spot, so two sections) the engine's 16 panels and 18 posts are
one short of what two separately cut sections need **84% of the time**. Each missing post is a $16.56 post,
a $0.74 cap and a $4.75 bag: **$22.05, $23.59 with tax**.

On his own drawn runs (my per-section model: sections cut at corner and end vertices, gates placed by their
nearest segment, so the gate rows carry plus or minus one; the no-gate row is exact):

| Real job (creation order) | Shape | Engine panels / posts | Per-section panels / posts | Short |
|---|---|---|---|---|
| 3 | closed, 5 corners, no gate | 46 / 46 | 47 / 47 | 1 panel, 1 post ($74.40) |
| 5 | open, 2 corners, 2 gates | 12 / 15 | 14 / 17 | up to 2 and 2 ($148.80) |
| 4 (open run) | open, 2 corners, 2 gates | 98 / 101 | 101 / 104 | up to 3 and 3 ($223.20) |
| 8 | closed, 9 corners, 3 gates, 1,673 ft | 277 / 280 | 282 / 285 | up to 5 and 5 ($372.00) |
| 10, 11 | straight, no corner, no gate | 9 / 10, 13 / 14 | same | none |

Drawn lengths are never exact multiples (job 4's closed run draws as two sides of 60.05 ft, so a 0.05 ft
"bay" appears on each side), which is why a clean-looking rectangle still lands on the high side. Typed
footage cannot be fixed this way (it carries a corner count but no section lengths). Drawn runs can,
because `FenceGeometryResult.segments` already holds every side's length and `computePostCounts` never
reads it.

### 1.4 Other post observations

- **Phantom posts on a run that is only a gate.** `bays == 0` makes `estimate` 0, but `ends` (2) and
  `gatePosts` (2) are still added: 4 posts, 4 caps, 5 bags (LINE) for an opening that needs 2 posts and 3
  bags. $44.10. Rare, but a gate replacement is a job that exists.
- **`LINE_TO_WALL` is one post dearer than `LINE`.** The code says "the run terminates twice". The drawn run
  already counts both of its ends, so if one of them is the wall, the third post is the same post counted
  twice ($22.05); if the wall is a separate stop beyond the run, it is right. The enum's own comment does
  not settle it. His live job 2 has one of these.
- **No float dust at exact multiples** (689 cases above). The corner and end carve-out cannot go negative
  (`coerceAtLeast`).

## 2. Panels

`panelCount = ceil(net / panelWidth)`, so a 4 ft sliver of a 6 ft panel buys one whole panel. Integer
always. **Right.**

When the catalog row chosen is not the run's width (`|coversFt - panelWidth| > 0.01`), `buildLineItems`
recomputes `quantity = ceil(netFt / chosen.coversFt)`. Only the PANEL quantity moves. Against the real
catalog (6 ft and 8 ft vinyl rows; 6 ft only for Gray, Flori and Hartford), 100 ft, no gate:

| Run spec | Row chosen | Panels asked | Panels billed | Posts billed | Posts the panels need |
|---|---|---|---|---|---|
| 8 ft, White, no supplier | 8 ft White $71.40 | 13 | 13 | 14 | 14 |
| 8 ft, **Gray** | 6 ft Gray $54.50 | 13 | **17** | **14** | **18** |
| 8 ft, White, **Flori preferred** | 6 ft Flori $54.15 | 13 | **17** | **14** | **18** |
| 8 ft **Aluminum White** | 6 ft White $99 | 13 | **17** | **14** | **18** |
| 6 ft spec, a catalog holding only 8 ft rows (synthetic) | 8 ft White $71.40 | 17 | 13 | 18 | 14 |

Three faults in one place:

- **Posts, caps and concrete keep the run's spacing** while panels follow the chosen row. Four posts, four
  caps and four bags short per 100 ft on the middle three rows ($66.24 + $2.96 + $19.00 = $88.20); the same
  number too many in the last row.
- **The waste allowance is dropped.** The recompute divides the raw `netFt`, not the wasted quantity. Gray 8
  ft with 10% waste asks for 15 and bills 17; Gray 6 ft with 10% waste bills 19.
- **A preferred supplier beats width.** The manufacturer filter runs before the width choice, so "Flori
  preferred" turns an exact-width generic 8 ft panel into a 6 ft Flori one.

Separately, the office's "Measured from satellite" form (`website/dashboard.html`, `saveSatelliteRun`)
writes `panel_width_ft: 6` always and `post_spacing_ft` from a box that defaults to 8. Pick Vinyl, Aluminum
or Iron without retyping "Posts every" and the run is 6 ft panels on 8 ft posts: 17 panels and 14 posts per
100 ft (finding 6). The wizard path locks spacing to width (`wizLockedSpacing`); this path does not. The
phone's `SurveyViewModel.createBlankRun` copies the company's default panel width and default post spacing
independently, so a company that changes one default gets the same mismatch on every new run. His live
defaults are 6 and 6, and every live run has them equal.

## 3. 6 ft versus 4 ft against his real catalog

### 3.1 How his jobs are set up

All eight real jobs have `color_or_finish = ''` and no preferred supplier. So the colour and manufacturer
filters do nothing, and every line is "the cheapest row of that role that survives the height filter",
chosen across Flori's rows, Hartford's rows and the starting list's rows together.

### 3.2 The 100 ft run with one 5 ft LINE gate, line by line

Labour $8/ft, gate $20/ft, tax 7%, no markup, colour blank. "None" is his setup.

**6 ft**

| Role | Qty | Row chosen, no preferred supplier | Price | Flori pref | Hartford pref | Quote (Flori / Hartford) |
|---|---|---|---|---|---|---|
| PANEL | 16 | Panel T&G Vinyl Privacy 6'H x 6'W - White (starting list) | 52.35 | 54.15 | 54.99875 | 54.15 / 55.00 |
| LINE_POST | 14 | 5"x5" Co-Ex Line Post, White (starting list) | 16.56 | 16.56 | 18.99929 | 16.56 / 19.00 |
| END_POST | 2 | 5"x5" Co-Ex Utility Post White 8.5' - End (Flori) | 16.56 | 16.56 | 19.00 | one post price |
| GATE_POST | 2 | 5"x5" Co-Ex Utility Post White 8.5' - Blank (Flori) | 16.56 | 16.56 | 19.00 | one post price |
| POST_CAP | 18 | 5" External Pyramid PVC Post Cap, White (starting list) | 0.74 | 0.78 | 1.65 | 0.78 / 1.65 |
| GATE_PANEL | 1 | Regular White PVC Gate 6'H x 5'W (Flori) | 120.66 | 120.66 | 149.99 (kit) | 120.66 / 149.99 |
| STIFFENER | 1 | 5"x5"x96" Econo Stiffener H-Frame (HFS) | 50.00 | 52.75 | 50.00 | 52.75 / 50.00 |
| BRACE | 1 | Gate Support Brace, 8' (starting list) | 6.50 | 6.90 | **19.99** | 6.90 / **none (in the kit)** |
| TRIM | **4** | 7/8 x 1-1/2 x 62-1/4 Trim U-Channel White (Flori) | 2.00 | 2.00 | 2.99 | qty **2** |
| HINGE_SET | 1 | Self-Closing Hinge Set (starting list) | 32.25 | 32.25 | 37.45 | 32.25 / 37.45 |
| LATCH | 1 | Two-Way Latch (box of 20), Black-tagged | 25.87 | 25.87 | 26.75 | 25.87 / 26.75 |
| HANDLE | 1 | 7" SS Gate Handle (box of 50), Black-tagged | 5.00 | 5.00 | 6.50 | 5.00 / 6.50 |
| CONCRETE_BAG | 19 | Concrete Mix 60lb Bag | 4.75 | 4.75 | 4.75 | not quoted |

Materials $1,487.53 / $1,520.20 / $1,644.56; grand total **$2,451.66 / $2,486.61 / $2,619.68** (none, Flori
preferred, Hartford preferred).

**4 ft**

| Role | Qty | Row chosen, no preferred supplier | Price | Flori pref | Hartford pref | Quote (Flori / Hartford) |
|---|---|---|---|---|---|---|
| PANEL | 16 | Panel Melrose Flat Top 2-Rail 4'H x 6'W White (Flori) | 61.74 | 61.74 | 71.50 | 61.74 / 71.50 |
| LINE_POST | 14 | 5"x5" Utility Post White 6' (Flori, 4ft run) | 13.18 | 13.18 | 16.75 | 13.18 / 16.75 |
| END_POST | 2 | 5x5x72 HFS End Post White 4' Closed Top | **16.75** | **16.56 (8.5' post)** | 16.75 | 13.18 / 16.75 |
| GATE_POST | 2 | 5x5x72 HFS Blank Post White 4' Closed Top | **16.75** | **16.56 (8.5' post)** | 16.75 | 13.18 / 16.75 |
| POST_CAP | 18 | starting list | 0.74 | 0.78 | 1.65 | 0.78 / 1.65 |
| GATE_PANEL | 1 | Clearwater 4'H x 5'W Closed Top Gate White (HFS) | 113.75 | 170.00 | 113.75 | 170.00 / 113.75 |
| STIFFENER, BRACE, HINGE, LATCH, HANDLE | | as for 6 ft | | | | |
| TRIM | 4 | as for 6 ft | | | | qty 2 |
| CONCRETE_BAG | 19 | | 4.75 | | | |

Materials $1,584.30 / $1,643.66 / $1,831.85; grand total **$2,555.20 / $2,618.72 / $2,820.08**. The 4 ft job
is $103.54 dearer than the 6 ft one on his setup, $132.11 on Flori and $200.40 on Hartford, which is the
direction the suppliers' own prices say it should go.

### 3.3 Against the quotes

Materials before tax; concrete left out because neither supplier quotes it.

| Configuration | App | Supplier for the same quantities | Difference |
|---|---|---|---|
| 6 ft, Flori preferred | 1,429.95 | Flori 1,425.95 | **+4.00** (two extra U-channels) |
| 4 ft, Flori preferred | 1,553.41 | Flori 1,535.89 | **+17.52** (U-channels 4.00, four posts on the 8.5' price 13.52) |
| 6 ft, Hartford preferred | 1,554.31 | Hartford 1,528.37 | **+25.94** (V-brace 19.99, U-channels 5.98, less 0.03 of sub-cent rounding) |
| 4 ft, Hartford preferred | 1,741.60 | Hartford 1,735.62 | **+5.98** (U-channels) |
| 6 ft, no supplier (his setup) | 1,397.28 | Flori 1,425.95 | **-28.67** |
| 4 ft, no supplier (his setup) | 1,494.05 | Flori 1,535.89 | **-41.84** |

Hartford's figures assume Flori's quantities and 2 U-channels; the file gives Hartford no job total. The two
bottom rows are finding 10.

### 3.4 Wrong-height parts

**A 6 ft job gets a 4 ft part:**

- On the office path (finding 1): the 4 ft Clearwater gate ($113.75) in place of the 6 ft gate, and the
  Flori 6' utility post ($13.18) as every line post.
- On the phone path at any height other than exactly 6 (finding 3).
- In stored data: job 11's two 6 ft runs (finding 2).

**A 4 ft job gets a 6 ft part:**

- On the office path: the 6 ft privacy panel ($52.35) for every panel. A 4 ft run costs the same as a 6 ft
  one there.
- `CORNER_POST` on every 4 ft corner. Neither supplier has a CORNER row, and the only candidate is the
  starting list's "5"x5" Co-Ex Corner Post, White" at $16.56, a 6 ft fence's post: $3.38 a corner over
  Flori's 6' post. (The same gap on a 6 ft corner under Hartford is $2.44 under.)
- `END_POST` and `GATE_POST` on a Flori-preferred 4 ft run: 8.5' posts at $16.56, because Flori has no 4 ft
  End or Blank row (finding 9).
- 4 ft Tan or Gray: the 6 ft privacy panel at $54.50 and a 6 ft Co-Ex line post at $17.25, with the white
  4 ft gate. Neither supplier quoted a 4 ft Tan or Gray and no such row exists, so the engine prices the 6
  ft product, $7.24 (Flori) to $17.00 (Hartford) a panel under the real 4 ft one.
- Aluminium 4 ft: only 6'H panels and 6'H gates exist ($95, $175). Iron 6 ft gets the 4'H gate ($210). Iron
  and aluminium posts are 6' long for both heights.

**Still height-blind** (`GATE_FRAME_KIT`, `HINGE_SET`, `STIFFENER`, `BRACE`, `WOOD_PICKET`): inert on his
vinyl catalog because the quotes carry the same hardware at both heights. A 4 ft wood fence would still be
priced 6' pickets ($3.25), because there is one picket row.

### 3.5 Finding 1 in numbers: the office cannot tell 4 ft from 6 ft

`supabase/functions/price-job/index.ts` builds its catalog read from one string:

```
const CATALOG_COLUMNS = "sync_id, name, category, role, fence_type, color_or_finish, unit, " +
  "unit_price, taxable, covers_ft, manufacturer_sync_id, is_active";
```

`height_ft` is not in it, and both catalog reads (a job, and a sample) use it, so the engine receives every
row with no height and falls back to price-only choice. `tests/a46-catalog-height-office-chain.test.mjs`
carries this as a `todo`, not a failure. The column exists on the live project (I selected it). This is the
repo source. I did not download the deployed function, so whether the deployed copy matches is unverified.

Priced with the live catalog and heights stripped, which is exactly what that read hands the engine:

| | Phone path (heights present) | Office path (as written) | Office minus phone |
|---|---|---|---|
| 100 ft, one gate, 6 ft | $2,451.66 | $2,393.63 | -$58.03 |
| 100 ft, one gate, 4 ft | $2,555.20 | **$2,393.63** | -$161.57 |
| Live job 11 (3 runs: 6 ft, 6 ft with wall gate, 4 ft) | $4,752.16 | $4,574.37 | **-$177.79** |

The 6 ft and 4 ft office totals are identical to the cent. Rates in these totals are the harness's, not his
job's, but the difference is materials only ($166.16 on job 11). On job 11 the office swaps the 4 ft run's
nine Melrose panels for 6 ft privacy panels (-$84.51 before tax), the 6 ft run's gate for the 4 ft
Clearwater gate, and every 6 ft line post for the 4 ft post. The office re-prices whenever a tax, markup,
discount or labour rate is saved, so on an unsigned job the next rate edit moves the price down by that
amount. A signed or sent total is anchored and does not move, so the damage is to drafts and to what gets
sent next.

### 3.6 Finding 2 in numbers: job 11's stored lines

Job 11 is the only real job with estimate lines on the server (jobs 2, 3, 4, 5, 8, 9 and 10 hold none; job
7, the other job with lines, is a test fixture). It was priced on the phone ("APP", engine `2026.10.2`). Same
three runs, same calibration, current engine, same catalog:

| Role | Stored | Current engine | Diff |
|---|---|---|---|
| LINE_POST | 395.40 | 469.76 | **+74.36** (22 posts on the two 6 ft runs: $13.18 stored, $16.56 now) |
| BLANK_POST | 0.00 | 16.56 | **+16.56** (the wall gate's blank post was never billed) |
| END_POST | 115.92 | 116.30 | +0.38 (the 4 ft run's ends are now the 4 ft HFS post) |
| every other role | | | 0.00 |
| **Materials** | **2,828.48** | **2,919.78** | **+91.30** ($97.69 with 7% tax) |

The 4 ft run's 9 panels are already right in the stored lines (Melrose $61.74) because the panel height fix
came earlier and the heights went in with `a45`. The stored posts are the cheapest-row choice the post
height fix was written to remove. Stored lines do not move until something regenerates them, and the one
server-side regenerate (the office's) reinstates the old posts (finding 1).

## 4. Concrete

`nonGatePosts x concreteBagsPerPost`, plus a fixed amount per gate by mounting, summed across the whole run,
then `ceil`. Whole bags always. Waste is applied before the sum and rounded once after it.

| Mounting | Gate concrete | What it covers | Verdict |
|---|---|---|---|
| WALL | 1.0 | the latch post; the blank post is bolted and takes none | right |
| LINE | 2.5 | hinge post 1.5, latch post 1.0 | right |
| LINE_TO_WALL | 3.5 | hinge 1.5, latch 1.0, wall end post 1.0 | right if the third post is real (1.4) |

100 ft, one 5 ft gate (16 non-gate posts):

| Bags per post | WALL | LINE | LINE_TO_WALL |
|---|---|---|---|
| 0.5 | 9 | 11 | 12 |
| 1 | 17 | 19 | 20 |
| 1.5 | 25 | 27 | 28 |
| 2 | 33 | 35 | 36 |
| 3 | 49 | 51 | 52 |

**The gate amounts do not scale.** `GATE_HINGE_BAGS = 1.5` and `GATE_LATCH_BAGS = 1.0` are constants. At
`concreteBagsPerPost = 2` a line post gets 2 bags, the gate's hinge post (the one holding a swinging gate)
gets 1.5 and its latch post 1.0. Every live run has 1 today, where the three are consistent, so no job is
wrong now. It becomes wrong the day he sets 2.

**One bag a post may be light.** My own arithmetic, for him to overrule: a 60 lb bag yields about 0.45 cu ft;
a 5x5 vinyl post in a 10" hole 30" deep needs about 0.9 cu ft (about 2 bags), and in a 12" hole 3 ft deep
about 1.8 cu ft (about 4 bags). If he really sets vinyl posts on one bag, the default is right. If he sets
them on two, every run is short by a bag a post ($4.75 each: $76 on the reference job's 16 non-gate posts,
$86 if the gate posts scaled too). It is his
`concrete_bags_per_post` to set on every run, and nothing in the app tells him the number matters.

Rounding is per run, so a job of several runs rounds up once per run: job 11 holds three bag lines (14, 13
and 10), each rounded alone. Under a bag a run is lost to it. Not worth a change.

## 5. The gate

One 5 ft vinyl LINE gate on the 100 ft run. "Quote" is both suppliers.

| Part | App bills | Flori quote | Hartford quote | Verdict |
|---|---|---|---|---|
| Leaf | 1 GATE_PANEL, nearest-width row | 6Hx5W $120.66; 4Hx5W $170.00 | kit $149.99 (6 ft); Clearwater 4Hx5W $113.75 | matches, once the right height row is read (findings 1, 3) |
| Posts | 2 GATE_POST (LINE); WALL: 1 BLANK + 1 END; LINE_TO_WALL: 2 GATE + 1 END | inside the 18 posts, one price | inside the posts | counts match; the 4 ft row is wrong for Flori (finding 9) |
| Post caps | inside the POST_CAP total, a cap per post | inside the 18 caps | same | matches. The Hartford kit's own two caps are for the leaf's uprights, not post caps |
| Stiffener | 1 (vinyl only) | 52.75 | 50.00 | matches |
| Brace | 1 (vinyl only; 2 on a gate 8 ft or wider) | 6.90 | 4 ft: V-brace 19.99; **6 ft: none, the kit has one** | **Hartford 6 ft is billed a brace it already holds** (finding 8) |
| U-channel | **4** | **2** | 2.99 each, count not on the file | **the app bills double** (finding 7) |
| Hinge | 1 set (2 on a gate 8 ft or wider) | 32.25 | 37.45 | matches |
| Latch | 1 | 25.87 | 26.75 | matches |
| Handle | 1 | 5.00 | 6.50 | matches |
| Concrete | 2.5 bags | not quoted | not quoted | bought elsewhere; fine |
| Hole plugs | 4 at $0.15, WALL gate only | not quoted | not quoted | billed by the app, not quoted by either supplier; $0.60 |

Charged by a supplier and **not** billed by the app: none of the ten quoted lines is missing. Not modelled
anywhere: Hartford's 3% card fee, Flori's 15% restock, and their sales-tax rates (6.5% and 7.5% against the
job's 7%). Those are costs of buying, not parts, and the app has no field for them.

Billed by the app and not quoted by either supplier: concrete and, on wall gates, the plugs. Both are
sensible; neither is on a supplier invoice.

**The blank post, again.** On his catalog a wall gate now bills the blank post ($16.56 at 6 ft, $16.75 at
4 ft; the fix works at both heights, verified). It is not in job 11's stored lines (3.6).

**Wide gates.** `qty(GATE_PANEL, 1, gate.widthFt)` picks the nearest-width row and bills one. The only vinyl
gate rows are 5 ft, so:

| Gate | Leaf billed | Braces | Hinge sets | Gate labour |
|---|---|---|---|---|
| 3 ft | one 5 ft walk gate, $120.66 | 1 | 1 | $60 |
| 5 ft | one 5 ft walk gate | 1 | 1 | $100 |
| 8 ft | one 5 ft walk gate | 2 | 2 | $160 |
| 12 ft | **one 5 ft walk gate** | 2 | 2 | $240 |

A 12 ft double gate is labour for 12 ft and materials for a 5 ft walk gate, and nothing on screen says the
leaf is narrower than the opening. All eleven live gates are 5.0 ft, so this is latent.

## 6. Findings in detail

**1. Office price-job ignores height.** Section 3.5. The fix is one word in `CATALOG_COLUMNS`, but it
changes office totals for every job on a catalog that has heights, so it belongs in the same release as
whatever re-prices job 11, and the a46 `todo` becomes a real test.

**2. Job 11 is stale.** Section 3.6. Re-price it on the phone and confirm the totals match the office once
finding 1 is closed.

**3. Only exactly 4 and exactly 6 are known heights.** `panel_height_ft` is a free-typed number. A PANEL,
GATE_PANEL or post row is set aside only if another row of its width declares the run's height. At 3, 4.5,
5, 7 or 8 ft nothing declares it, nothing is set aside, and the cheapest row wins:

| Height | PANEL | LINE_POST | GATE_PANEL |
|---|---|---|---|
| 3, 4.5, 5, 7, 8 | 6 ft privacy $52.35 | **6' post $13.18** | **4 ft Clearwater $113.75** |
| 4 | Melrose 4 ft $61.74 | 13.18 | 113.75 |
| 6 | 6 ft privacy $52.35 | 16.56 | 120.66 |

A 5 ft pool fence on a 6' post has a foot in the ground; a 7 or 8 ft fence on one falls over. This is the
fault the post fix was written to remove, still reachable at every height but two. A 4 ft gate on a 7 ft
fence is a 4 ft gate in a 7 ft fence. All live runs are 4 or 6 ft, so none is hit today.

**4. Rounding on the whole run.** Section 1.3.

**5, 6. Width fallback and the satellite form.** Section 2.

**7. U-channel.** `gateEntries` pushes `qty("TRIM", 4.0)` for every vinyl gate; the comment explains the brace
and the stiffener and says nothing about this. Flori's totals fit 2, and the quotes file counts 2 for both
suppliers, but it does not say who chose 2, so the supplier's own spec should settle it. TRIM is also a
waste role, so any waste above zero makes it `ceil(4 x 1.05) = 5` a gate (10 for two gates, against a need
of 4). $4.00 to $5.98 a gate, five times that on a gate-heavy job.

**8. Hartford kit.** The kit holds a brace, the app bills a BRACE role on every vinyl gate, and BRACE has no
"included in the leaf" notion. It bites only when Hartford is preferred or the Hartford leaf is the
cheapest, which today it never is (Flori's $120.66 wins at 6 ft), so it is latent and wakes when Flori's
price rises.

**9. 4 ft post rows.** Flori's one post SKU serves every post type; the catalog gives Flori a 4 ft LINE_POST
only. END, GATE (Blank) and CORNER roles therefore take either Hartford's 4 ft post ($16.75) or an 8.5'
post ($16.56) when the job is Flori's, against Flori's $13.18.

**10. Stale seed rows undercut the suppliers.** The starting-list panel ($52.35), cap ($0.74) and brace
($6.50) are below the real quotes (Flori $54.15 / $0.78 / $6.90; Hartford $54.99875 / $1.65 / $19.99), and
cheapest-wins takes them: 16 panels at $1.80 under is $28.80. And with no preferred supplier the engine
assembles a basket nobody sells: Flori's leaf and trim, Hartford's stiffener and (at 4 ft) gate and posts,
the seed's panel and brace. That basket is $28.67 under Flori's real 6 ft price and $41.84 under at 4 ft.
Part of that is real saving ($56 on Hartford's 4 ft gate); part is a $52.35 panel he cannot buy anywhere on
file. Hartford is in-stock only and prepay, so the cheapest basket is not always orderable.

**14. Waste float dust.** `ceil(q x (1 + w/100))` rounds one unit high where `q` times the factor should be a
whole number and lands a hair above it. Overbuys one at: 8% 225; 9% 100, 200; 10% 50, 90, 100, 110, 170,
180, 190, 200, 210, 220, 230; 11% 100, 200, 300; 12% 25, 50, 75, 100, 150, 175, 200, 225, 275, 300; 14% 50,
100 and every 50 after (counts to 300 tried). Clean at 5% and 15%, the two settings on his jobs. Panels are
rarely that high; wood pickets are.

**12, 13, 15, 16.** Sections 1.4, 4, 5 and 3.4.

## 7. Not verified

- **That his phone holds the heights.** Read from the sync tests (`a46`), and job 11's 4 ft run was written by
  the phone at Melrose $61.74, which a height-blind engine would not choose, so the phone did have them.
- **The deployed `price-job`.** Source only. Downloading the function was outside what I was told to do.
- **The Kotlin engine was not run.** No Gradle. The Kotlin functions cited were read against the TypeScript
  ones and match; parity of the new behaviour (finding 3's fallback, finding 5's recompute) is by reading,
  not by running.
- **Hartford's job total** is not in the quotes file, so Hartford rows use Flori's quantities.
- **The origin of the 16/18/18 counts and of the 2 U-channels** in Flori's quote. The 198 ft table's 34
  panels, 38 posts and 38 caps could not be reproduced from the file alone: one 5 ft gate on a typed 198 ft
  run is 33 panels (34 at 3% waste) and 35 posts at any corner count, so that table was not used.
- **My per-section model** for drawn runs (1.3) is a reconstruction. The no-gate row is exact; the gate rows
  are plus or minus one.
- **The real concrete need.** My bag arithmetic is arithmetic, not his practice.
- **`LINE_TO_WALL` topology**, section 1.4.
- Nine of his eleven jobs holding no priced lines (listed as unexplained) is not explained here. What this
  adds: all eight real jobs carry a phone engine stamp, seven of them have no lines on the server, and the
  one real job that does have lines is stale.

## 8. Reproduce

`materials_audit_lens2/` in the session scratchpad holds the harness (`h.mjs`), a consolidated re-check of
the headline numbers (`audit.mjs`, run it with `node audit.mjs`), the quote fit (`fit.mjs`), the four live
read `SELECT`s and their JSON output. The other scratch scripts (`t1` to `t20`) sit in a folder several
agents share and some were overwritten mid-session, so do not trust files of those names. The harness is
the engine imported as-is:

```js
import * as idx  from ".../supabase/functions/_shared/pricing/index.ts";
import * as load from ".../supabase/functions/_shared/pricing/load.ts";
// catalog: the live material_items snapshot (height_ft included; strip it to see the office path)
idx.priceJob(load.buildPricingInput({ job, runs, catalog, manufacturers, changeOrders: [], existingItems: [],
                                      engineVersion: idx.PRICING_ENGINE_VERSION }))
```

Node 24 runs the `.ts` directly. The live probes are `SELECT`s with a `UNION ALL` canary row.
