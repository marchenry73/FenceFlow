# Office-complete setup: one pricing truth, build templates, a wizard

Written 2026-09-04 from three independent designs and three code maps
(workflow `wf_cfe88682-6a5`; full maps and designs in that run's journal).
This is the plan a fresh session executes. Read it top to bottom before
touching anything.

## The ask, in the owner's words

> On the website, when setting a new client, I need to be able to set up
> everything all together. I should not have to go on the phone and finish it.
> Also I want a default template for business and I want them to be able to
> add their own too. I want memory to save some. When setting up things, it
> should show me next and next till everything is done, also some default
> things like the spacing of the post, the height, bags per post etc.

## Why it is not just a form

Today only the phone prices a job. `EstimateEngine.kt` turns fence runs +
catalog + rates into line items and `contract_total`; the office never
computes a price on purpose ("two formulas is how the office and the phone
once disagreed"). The office's satellite tracer writes a run with hardcoded
spec (panel 6, spacing 8, bags 1, no gates) and never sets
`jobs.calibration_pixels_per_foot`, so the phone counts that run as 0 ft
until somebody opens the Estimate screen. Nothing on the server can price.

So the office needs the same engine on the server, provably equal to the
phone's, and the phone must keep pricing offline in yards.

## Decisions (made; do not re-litigate)

1. **Two copies of the engine, never three.** Kotlin stays on the phone,
   unchanged in its formulas. A line-for-line TypeScript port lives at
   `supabase/functions/_shared/pricing/` and is used ONLY by a new edge
   function `price-job`. The office calls `price-job`; `dashboard.html`
   never gains a formula. (Rejected: an in-browser JS copy — a third copy;
   and "phone calls the server when online" — one phone, two answers.)
2. **Parity is a test, a gate and a beacon.** Golden fixtures are generated
   BY KOTLIN (a JUnit writer in `app/src/test`), committed under
   `pricing-fixtures/cases/*.json` with every intermediate stage (geometry,
   net feet, entries, line items with sync ids, totals). A Kotlin reader
   test and a Deno test both assert against them; both engines carry a
   `PRICING_ENGINE_VERSION` that must equal the fixture set's. A pricing
   change is one commit touching both engines, both constants, and the
   regenerated fixtures. `scripts/check-parity.mjs` runs both suites;
   `publish-release.mjs` and `deploy-functions.mjs` refuse to run when red.
   At runtime a `pricing_drift` row (+ office banner) records any
   disagreement; the phone still wins the row (it is the field truth).
3. **Float discipline.** Everywhere Kotlin holds a `Float`, the TS port wraps
   the value and every operation in `Math.fround`. Both sides use
   `sqrt(dx*dx+dy*dy)` (not `hypot`). Catalog tie-breaks use `syncId`, not
   the device-local Room id. Line-item sync ids are the same deterministic
   UUID v3 (MD5) on both sides so office lines and phone lines are the SAME
   rows and `TakeoffRefresher`'s fingerprint no-op check leaves them alone.
   These are the only Kotlin edits (two one-liners + the version constant +
   the fixture writer/reader tests).
4. **Build templates are spec, never money.** Table `build_templates`,
   columns named exactly like `fence_runs` (fence_type, color_or_finish,
   panel_width_ft, panel_height_ft, post_spacing_ft, concrete_bags_per_post,
   aluminum_style, wood_style, wood_rail_count, picket_width_in,
   picket_gap_in, fabric_height_ft, include_top_rail, include_tension_wire,
   include_barbed_wire_arms, include_privacy_slats, split_rail_count,
   suppressed_roles) plus gate defaults (gate_width_ft, gate_mounting,
   gate_swing), `company_id NULL` = shipped by FenceFlow (visible to all,
   editable by none), `derived_from_sync_id`, `is_default`, tombstone
   columns, CHECK post_spacing_ft = panel_width_ft for VINYL/ALUMINUM/
   ORNAMENTAL_IRON. A run inherits BY COPY at creation and keeps
   `fence_runs.build_template_sync_id` for provenance only — editing a
   template never moves a signed quote.
5. **Memory.** Append-only `build_template_uses` (company, template,
   fence_type, run, used_by, used_at) — "recent" and use counts come from it;
   the company default is `is_default`; `company_settings.settings.wizard_last`
   remembers the rest of the wizard's last choices (tier, gate defaults,
   teardown, waste, referral source). Resolution order: this person's most
   recent for the fence type → company default → shipped row for the type.
6. **Shipped set** = the phone's own defaults, so a template-started run
   prices exactly like a phone-started run of the same type: 6 ft Vinyl
   Privacy (6×6, spacing 6), 6 ft Vinyl on 8 ft panels, 6 ft Wood Privacy
   (spacing 8, 3 rails, 5.5/0), 4 ft Wood Spaced Picket (gap 2.5), 4 ft Chain
   Link (fabric 4, spacing 10, top rail), 6 ft Chain Link, 4 ft Aluminum
   pool (6×4, spacing 6, RACKABLE), 6 ft Ornamental Iron, 2-Rail Split Rail
   (spacing 8), 6 ft Composite Privacy. Fixed sync_ids
   `00000000-0000-4000-8000-0000000000NN` so dev and prod agree.
7. **The wizard saves as it goes.** `jobs.wizard_step` (text, '' = done)
   so an interrupted call resumes from the Jobs list. Step 1's Next
   inserts the job row; every later step patches it. On saving any typed
   or satellite run the wizard writes `calibration_pixels_per_foot = 20`
   when null and no survey photo exists (the phone's own side effect).
8. **Quiet clock.** New bookkeeping columns (wizard_step, priced_by,
   priced_at, pricing_engine_version, build_template_sync_id) join
   `touch_updated_at()`'s quiet list.
9. **Crew never receive a priced payload.** `price-job` runs under the
   caller's JWT, requires OWNER/MANAGER + `has_permission('SEE_MONEY')`,
   and `company_allowed`.

## The wizard (New client, office)

1. **Who** — customer_name, phone, email, address (+Verify → site_lat/lon
   via quote-map), referral_source (last used preselected), notes. Next
   creates the job (DRAFT, wizard_step='build', rates from company
   settings).
2. **What we're building** — template picker (Recent / Your default / Your
   templates / FenceFlow templates), then the spec prefilled and editable:
   type, height, panel width, post spacing (locked = panel width for panel
   types), bags per post, colour, type-specific block (wood: style, rails,
   picket width/gap; chain link: fabric height, top rail, tension wire,
   barbed arms, slats; split rail: rails; aluminum: style). Checkboxes
   "Save as my template" and "Make this my default".
3. **Fence line and gates** — per run: label; footage typed
   (manual_linear_feet, manual_corner_count, closed_loop) OR "Measure from
   satellite" (existing tool, now writing the template's spec); gates: width
   (default from template), mounting LINE / WALL / LINE_TO_WALL, swing;
   "Add another run". Next writes calibration=20 when needed.
4. **Old fence and extras** — teardown (enabled, feet, flat fee, rate/ft),
   trash haul fee, waste %.
5. **Pricing** — tier picker (copies tier fields onto the job exactly like
   the app's applyTier), then tax %, markup %, discount %, labor $/ft, flat
   fee, minimum charge, gate $/ft, preferred manufacturer. Next saves, then
   calls `price-job?mode=preview`.
6. **Estimate** — server-priced takeoff grouped as the phone prints it;
   line items with quantity and unit price editable (an edited price flips
   that line to auto_generated=false so both engines preserve it by role);
   unmatched roles listed with an inline "add catalog item"; zero-priced
   items flagged; totals block; "Looks right" = `price-job?mode=commit`
   (upsert lines by deterministic sync id, tombstone stale auto lines, write
   contract_total + priced_by='OFFICE' + engine version).
7. **Schedule and crew** — date, hours, assigned crew, status.
8. **Paperwork and send** — deposit, HOA, permit; quote link, Copy /
   Preview, "Mark as sent" (quote_sent_at, status SENT); done screen with
   "Change" links back into any step; wizard_step cleared.

Plus a **Business setup wizard** (Settings → "Run setup"): Business →
Rates → Your standard build (pick a shipped template, edit, save as
default) → Supplier prices (import or FenceFlow starter catalog) → Pricing
tiers (office gains create/edit; tombstone only) → Crew (skipped on Solo)
→ Done (mirror of `my_setup_progress()`).

## Phases and order

**Phase A — foundation (no user-visible change).**
1. `supabase_build_templates_patch.sql`: tables, RLS (select shipped ∪ own;
   insert/update own for OWNER/MANAGER; no delete policy),
   `enforce_delete_permission` trigger, shipped rows, `fence_runs`/`jobs`
   columns, quiet-list additions, RPCs `my_build_templates()`,
   `save_build_template(jsonb)`, `retire_build_template(uuid)`,
   `create_run_from_template(job, template, overrides)`; `pricing_drift`
   table. Additive; apply after explaining; verify with read-only queries
   and RLS impersonation (`set local role authenticated` + claims).
2. Kotlin: `PRICING_ENGINE_VERSION`, syncId tie-break, sqrt, DTO adapters,
   `PricingFixtureWriter` (JUnit, `-DwriteFixtures=true`) and
   `PricingFixtureTest` reader. Generate ~40 fixtures: every fence type ×
   open/closed; manual vs drawn vs uncalibrated (=0 ft); each gate mounting;
   ≥8 ft gate; vinyl TRIM; multi-gate wholeBags rounding; waste on/off;
   colour and manufacturer narrowing; price tie by sync_id; $0 placeholder;
   PANEL width reconciliation; suppressed roles; hand-edited price
   carry-over; change orders; teardown chain; minimum charge; markup-on-tax;
   discount-after-markup; $10 rounding; one case per shipped template.
3. TS port `supabase/functions/_shared/pricing/` (geometry.ts, takeoff.ts,
   line-items.ts, totals.ts, uuid3.ts, f32.ts, index.ts) + `pricing_test.ts`
   replaying the fixtures; `scripts/check-parity.mjs`; gates in
   `publish-release.mjs` and `deploy-functions.mjs`.
   **Phase A is done when both suites are green on the same fixtures.**

**Phase B — the owner's ask.**
4. `supabase/functions/price-job/index.ts` (verify_jwt=true; preview /
   commit as above; the commit also stamps calibration=20 when needed).
5. Office: a ~120-line step-runner (Back/Next/Finish, progress rail,
   save-on-Next, resume from wizard_step), the New client wizard (8 steps),
   template picker, gates editor, inline catalog add, estimate table,
   drift banner. Extend `tests/*.test.mjs` for the step-runner and the
   template resolution order.
6. Satellite tool writes through `create_run_from_template`.

**Phase C — completeness.**
7. Business setup wizard; office create/edit for pricing tiers and
   material_items (insert/update policies for OWNER/MANAGER, tombstone
   only); `seed_starter_catalog()` with deterministic uuid5 ids and the
   phone's SeedData switched to the same ids.
8. Phone: pull `build_templates` into Room (shipped pull-only, company
   push+pull), Add Fence Run dialog gets the same picker,
   `FenceRun.fromTemplate()` replaces `defaultSpacingFor()`'s hardcoded
   8/10/8; the Kotlin parity edits ship in this build.

## Rules while building

- Never delete; tombstones only. Crew never see money. Comments explain WHY.
- Every SQL patch is a file in the repo root, idempotent, additive. Show
  destructive SQL first and wait; there should be none here.
- Verify from artifacts: run the fixture suites, impersonate roles for RLS,
  curl the edge function, read the built APK.
- The dev Supabase project still does not exist; until it does, rehearse
  each SQL file on prod inside `begin; … ; rollback;` before applying.
- Commit small, push, and keep [[fenceflow-state]] / [[fenceflow-prelaunch-audit]] memory current.
- Stop and report (do not guess) if a fixture disagrees between engines and
  the cause is a genuine Kotlin bug — the owner decides which side is right.
