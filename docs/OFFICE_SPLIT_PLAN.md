# Splitting `website/dashboard.html` into ES modules

No bundler exists (no `package.json`, no vite/webpack). This is a static
GitHub-Pages site: any split has to work as plain
`<script type="module" src="...">` with zero build step, forever.

## The trap this plan avoids

The test suite lifts functions straight out of `dashboard.html`'s source text
(`grab()`/`new Function()`) rather than importing them. Move a function into
an external file without telling the harness, and the harness's regex simply
stops seeing it -- the test still passes, just against nothing. That is worse
than a broken test: it looks green.

**Rule: update every harness that scans dashboard.html BEFORE moving the code
it scans, prove it still passes against the unmodified page (zero behaviour
change), then move code, then prove the moved code is still covered by
temporarily breaking it and watching the relevant test fail.**

## What may move (first slice, done)

`website/js/lib/pay.mjs` -- `decodeRunPoints`, `runLengthFt`, `runBuiltFeet`,
`jobBuiltFeet`, `shiftCountsForPay`, `perFootShareFeet`, `perFootPayForJob`,
`perFootCredits`. Chosen because:
- Pure: no DOM, no Supabase, no closed-over page globals.
- Self-contained: the only things they call are each other.
- Already covered by dedicated tests (`tests/per-foot-pay.test.mjs`,
  `tests/downstream-pay-overtime.test.mjs`, `tests/catalog-run-viewer.test.mjs`,
  `tests/perfoot-phone-office-parity.test.mjs`), so the "still covered" check
  had real tests to run rather than needing new ones written from scratch.

Imported back into the page via one `import { ... } from './js/lib/pay.mjs';`
at the top of the existing `<script type="module">` -- no second script tag,
no globals reintroduced.

Harnesses updated to search both `website/dashboard.html` and
`website/js/lib/pay.mjs`: `tests/per-foot-pay.test.mjs`,
`tests/downstream-pay-overtime.test.mjs`, `tests/catalog-run-viewer.test.mjs`,
`tests/perfoot-phone-office-parity.test.mjs`. `tests/dashboard-syntax.test.mjs`
and `tests/dashboard-undefined-calls.test.mjs` were extended to discover
`<script type="module" src="...">` tags generically, concatenate that file's
source into their existing sweeps (id lookups, undefined-call sweep), and
`node --check` it on its own -- so the NEXT module extracted needs no further
harness surgery for those two files, only for whichever function-specific
test grabs it by name.

Proof coverage didn't drop: broke `perFootShareFeet` in `pay.mjs` (made it
always return 0), watched `tests/per-foot-pay.test.mjs` fail with a real
assertion diff, restored it, watched it pass again.

## Ordered list of future slices

1. **Translation table (`TL`) and `tr()`/`applyStaticText()`/`setLang()`.**
   Large, self-contained, and every later module will want to
   `import { tr } from './js/i18n.js'` instead of relying on the global --
   doing this early avoids re-touching every module afterward. Several
   existing tests already `eval()` the `TL` object out of the page source
   (e.g. `tests/catalog-run-viewer.test.mjs`'s `TL_EN` shim) -- those need to
   read `js/i18n.js` instead once this moves.
2. **Readiness/reports pure maths** (`jobReadiness`, the report aggregate
   functions `tests/reports-math.test.mjs` and `tests/job-readiness.test.mjs`
   lift). Same shape as this slice: pure, already tested standalone with
   injected stand-ins for `money`/`d`/`netPaid`.
3. **`visibleJobs()` and the `q()` paging helper** (`tests/test-fixture-filter.test.mjs`
   covers `visibleJobs`). `q()` closes over the `db` client today; it needs
   `db` passed as a parameter to be pure enough to move.
4. **Catalog / materials / manufacturers and pricing tiers.** Their own
   `ensure*`/CRUD functions, relatively low cross-tab coupling.
5. **`loadAll()` and the app shell (tab switching, global state, `db` init)
   move last**, once every module it calls has already been extracted --
   at that point it becomes a thin orchestrator.

## The rule for what may move

- Pure only: no DOM, no Supabase call, no reference to a page-level global
  that isn't passed in as a parameter or imported.
- Already covered by a standalone test, or gets one in the same change --
  never move code and lose the only test that exercised it.
- One module's worth at a time. Land the harness update with zero behavior
  change first, run the full suite, THEN move code, THEN run the full suite
  again and deliberately break the moved code once to prove the tests still
  see it.
