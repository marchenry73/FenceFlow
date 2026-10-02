# Save failures: what was silently not saving (1 October 2026)

He reported two things: "I added information about the manufacturer and I tried to save it and it
did not", and "there has been some data not saving issue". This is the diagnosis. The fixes are in
`EntitySync.kt`; the test is `tests/a48-saves-supplier-link-and-manufacturer-edits.test.mjs`.

**Read this first.**

- **Not compiled, not run on a phone.** A release publish was running its Gradle gates, so the
  Kotlin was written and read line by line but never built. The test reads the Kotlin as text,
  translates the small decision functions from it and runs them, and models the orchestration; it
  proves the decision table the Kotlin encodes, not that the app compiles. Build before shipping.
- **A supplier's own six fields (name, email, phone, address, hours, notes) appear to save.** I could
  not reproduce a failure there (live evidence below) and I did not change how those reach the
  cloud; I changed when a supplier is sent and when the pull may overwrite it (F2).
- **Tests.** The new file is green on this change (13 of 13) and red on the committed `EntitySync.kt`
  (12 of 13 fail; the one that passes is the model of the old rules losing an edit, which is
  deliberate; run it with `A48_ENTITYSYNC=<path to an old copy>`). The sync pins in a40 and a46 still pass.
  The suite has other red tests that belong to other waves' work in flight (the engine's height
  step, a33's migration chain, a25's starting list, a40's one-SQL-owner check); none fails on a line
  this change touched.
- **Two real silent non-saves were found and are fixed:** the supplier chosen on a catalog row
  never left the phone, and a supplier edit could be undone by the sync pass meant to carry it.
- **One of the two is only partly fixed.** The second needs a column on `Manufacturer` and a Room
  migration. That is not this wave's to make, and it is described exactly in section "Blocked".
- The web quote's deposit is not in this wave (see `tests/a47-deposit-truth.test.mjs`).

## What was ruled out, with evidence

All reads were SELECT-only against the live project. Every probe had its raw output checked for an
error. Several calls failed (a wrong table name, a wrong column name, a regex, an aggregate passed to
`pg_get_functiondef`, one transient login failure) and were redone; none was read as "no rows".

| Suspect | Verdict | Evidence |
|---|---|---|
| Suspension | ruled out already, not redone | `company_allowed()` read from `pg_proc` earlier: active, not suspended |
| A dead sync | ruled out | his `fence_runs` and `estimate_line_items` were pushed at 21:43 and 21:44 UTC, `jobs` at 22:00 |
| RLS or a trigger blocking a supplier upsert | ruled out | `manufacturers`: INSERT check `company_id = current_company_id()`, UPDATE using the same, a RESTRICTIVE not-suspended policy, and only two triggers (`touch_updated_at`, `enforce_delete_permission`, which only acts when `deleted_at` is being set). Bodies read from `pg_proc`. |
| NOT NULL columns the app does not send | ruled out for suppliers | every column has a default (`phone`, `address` default `''`), the unique index `(company_id, sync_id)` exists, and `cloudJson` has `encodeDefaults = true`, so all six fields are always sent as strings |
| Server-inserted rows the phone cannot update | ruled out | the pull creates a local row under the cloud's own `sync_id` (`pullManufacturers`, new-row branch); an edit updates that Room row by id; the push upserts on `(company_id, sync_id)`, which is the unique index. Nothing assumes the phone created the row. |
| The supplier fields not reaching the cloud | not reproduced | the two supplier rows loaded by SQL earlier that day were updated again at 21:40:27 and 21:41:05 UTC (no SQL file in the repo updates `manufacturers`): phone, address and hours went from empty to filled on one, hours filled on the other. `updated_at` did not move again by 22:07, after the phone had pushed other tables at 21:43, 21:44 and 22:00 (a stale phone copy pushed first would have put the blanks back). That is consistent with the edits having been made on the phone and having stayed. I cannot tell who made them. |
| The table ever holding a supplier | context | the table holds only the two rows loaded that day; no other company has one, and his had none before them (the header of `supabase_a43_add_two_suppliers.sql` says so). So no supplier is known to have reached the cloud from a phone or the website before today. |

## Findings

### F1. The supplier chosen on a catalog row never synced, in either direction. FIXED

`CloudMaterialItem` had no `manufacturer_sync_id`. The phone's "Priced from" picker writes
`MaterialItem.manufacturerId` (a Room id, meaningful on one phone) and `pushCatalog` never sent it.
A supplier set on the website, and the 32 supplier rows loaded by SQL on 1 Oct, were never read:
`pullCatalog` copies a row and keeps whatever `manufacturerId` the phone had, which for a row it
has never seen is null. Consequences, all silent:

- "Priced from" saved on the phone and was on that phone only.
- The engine's supplier preference (`EstimateEngine`: `candidates.filter { it.manufacturerId == preferredManufacturerId }`)
  matched nothing for rows that arrived from the cloud, and falls back to every candidate when
  nothing matches, so a job's chosen supplier changed no price on a phone while the office's
  server-side pricing, which reads `manufacturer_sync_id`, honoured it. Two prices for one job.
- A catalog row's identity (`name|role|fenceType|colour`) ignored the supplier. "Duplicate for
  supplier" (same name, role, type and colour, a different supplier) read as the original's cloud
  row under another sync id: `pushCatalog` filtered it out (`claimed.syncId == item.syncId` false)
  with nothing logged and nothing on screen, and `pullCatalog` skipped the same pair
  (`ident in knownIdentities`). The Flori rows loaded on 1 Oct carry "(Flori)" in their names, which
  is what kept them distinct from the same products under another supplier; nothing in the code did.

What changed (`EntitySync.kt`): the field travels both ways; identity includes the supplier
(`catalogIdentity`); a row the cloud holds under its own id is gated by the clocks before identity
is asked (`catalogRowIsOwed`; a rename used to skip the gate and could send a stale copy); the pull
resolves the supplier to a local Room id only when the cloud names one this phone holds
(`supplierFromCloud`) and otherwise keeps what the phone has; the pull of the catalog waits for the
pull of suppliers; rows are sent in same-column batches (`catalogPushBatches`), which also stops a
row without a height or supplier being sent as NULL beside a row that has one; a supplier removed on
the phone ("no particular supplier") says null out loud, but only when the cloud names a supplier
the phone also holds (`catalogSupplierSay`).

Deliberate limits, so nothing is lost silently by the fix itself: a cloud row with NO supplier does
not erase a supplier the phone has (a choice made before the phone could upload one cannot be told
apart from "the office cleared it"), so a supplier cleared on the website does not reach a phone,
and a supplier the phone chose before this build uploads the next time that item is saved there.

### F2. A supplier edit could be undone by the pass meant to carry it. PARTLY FIXED

`Manufacturer` carries no edit clock and no "changed here, not yet taken" mark, and both halves
were unconditional: `pushManufacturers` sent every supplier on every pass, and `pullManufacturers`
wrote the cloud's copy over every supplier it held. `AutoSync.runSync` runs the pull whether or not
the push worked. So:

1. A push that failed (a weak signal is enough) was followed by a pull that put the cloud's older
   copy over the edit, on the same pass. The edit was gone from the phone and was never sent.
2. An edit saved while a pass was in flight (after the push read the table, before the pull read it)
   was overwritten by the pull. Every edit anywhere starts a pass, so this is not rare.
3. A supplier changed on the website was put back by the phone's next push, because the phone's
   copy was older and the push never asked which was newer.

The test models all three against the old rules and shows each loses the edit.

Fix: an in-memory ledger (`ManufacturerSyncLedger`). A supplier goes up only if the cloud has none
or this phone changed it since they last agreed; the pull never writes over one the phone changed
and the cloud has not taken, nor over one a failed push tried to send. A refused push (not a fault)
forgets its mark so a crew phone keeps receiving the office's changes.

**What it does not cover, and the test pins it as a KNOWN LIMIT:** it lives in memory. After the app
is killed it knows nothing, and a phone whose copy differs from the cloud's sends its own, as every
pass did before. So a supplier edited on the website while the app was closed is still put back by
the first sync after launch, and an offline edit made before a restart is still at the mercy of
that first pull. The lasting fix is persisted (Blocked, B1).

### F3. The same shape elsewhere. NOT CHANGED

Looked for after F2, as asked. The same "no mark, cloud overwrites" pull exists in:

- **employees**: unconditional push, and the pull overwrites every row (`pullEmployees`). A crew
  record edited on the website is undone by a phone that has not pulled it; an edit on the phone
  while a pass runs is overwritten. Not changed: the pay fields, the roster rows and the
  promotion pass (which deliberately pulls before it pushes) make the in-memory approach riskier
  here than for suppliers, and nothing was reported against employees.
- **expenses, punch list, job steps, site markers**: the pull overwrites existing rows; the push is
  gated by the job clock (`mayPushJobChildren`: held back when the cloud's job row is newer than the
  phone's). A job the office touches between the job sync and the children's clock read holds that
  job's children back for a pass, and the pull of the same pass then overwrites the phone's
  unsent ticks with the cloud's copy. A narrow window, not reproduced, not changed.
- Fine, and why: fence runs, pricing tiers and catalog rows (per-row clock compared with the cloud's
  `updated_at`), line items and change orders (a `pendingPush` mark), payments (insert-only), field
  changes (insert, then an update only for phones allowed to answer).

### F4. Where a failed save goes, and where it goes nowhere

- A push that throws: `step()` keeps the first real fault, `AutoSync` shows FAILED with a plain
  sentence on the jobs list and the Account screen, and `CrashReporter` uploads it. Visible, but
  generic and nowhere near the Manufacturers screen.
- A refusal (403 / RLS): `step()` logs it at Info and counts it; the jobs list says "Some records on
  this phone, other than jobs, are not in the cloud yet". Visible, vague.
- A per-row rejection: `upsert()` retries the rows one by one and throws `PartialUpsertFailure`
  naming how many. Visible.
- **Silent, and now fixed for suppliers: an edit overwritten by a pull.** Nothing is raised, nothing
  is logged. Still true for employees and the job children (F3).
- **Silent, fixed: a catalog row dropped by identity** (F1).
- **Silent, not fixed:** pull-side refusals (`pullAll` discards `isNotOursToSync` failures, which is
  right for permissions and invisible for everything else); `AutoSync`'s `runCatching` around the
  file uploader; and `Repository.saveManufacturer`, whose `@Update` on a row that no longer exists
  (retired on the web while a dialog was open, reaped on the next pass) updates zero rows and says
  nothing. `ManufacturersViewModel.save` has no failure handling at all (`CatalogViewModel.saveItem`
  does, with a `UiMessage`).

### F5. Shifts: noisy, not lossy. NOT CHANGED

The field log shows `push time_entries: N of N rows rejected` many times (v1.501 to 1.562, last
today at 21:23 UTC from a 1.562 phone). In the recent ones (v1.532 and v1.562) the cause is the
server's sentence "Approving or rejecting hours needs APPROVE_TIME"; the 30 reports from v1.501 and
v1.502 were not read to that depth. Read from `pg_proc`: `guard_time_entry_approval` raises 42501 on an
INSERT that carries `approved_at` or `approved_by` unless the caller holds APPROVE_TIME, and it runs
BEFORE the `ON CONFLICT DO NOTHING` check. `pushTimeEntries` re-sends every finished shift on every
pass, insert-only, including shifts the office approved and the phone pulled down. A crew phone
therefore has every approved shift refused every pass: one failed chunk, then a request per row.
No shift appears to be lost (a decision only exists on a shift the office has already signed off in
the cloud, and the unapproved ones go up row by row), but the phone says "not in the cloud yet" for
work that is.

Suggested fix, not made because it is noise rather than loss and this code has Kotlin tests: do not
send a shift that carries a decision from a phone the server has refused one. Learn it from the
first refusal, as `fieldChangesInsertOnly` does, but per signed-in user so a different login in the
same process is not held to it.

### F6. A fatal Room schema error in today's field log. OUTSIDE THIS WAVE

Six `app_errors` rows from his company's 1.562 build, 16:06 to 16:18 UTC today: "Migration didn't
properly handle: time_entries(com.fenceestimator.app.data.TimeEntry)". The reporter cut the message
before the "Found" half, so which column is missing is not knowable from it. Version codes come
from the commit count, so two builds of different working trees can both read 1.562; the same
version number was running at 18:59. If a build in that state is installed, nothing on it saves.
`tests/a33-join-model-storage.test.mjs` is red right now on the schema chain (48 to 49), which is
where to look.

## Every place checked

Phone: `ManufacturersScreen` and `ManufacturersViewModel` (save path, dialog state),
`Repository.saveManufacturer / saveMaterialItem / updateMaterialItem / the *FromCloud writers /
deleteSynced / guardWrite / ensureSeedDataPresent`, `MaterialItemDao.deleteDuplicates` (groups by
supplier id, so it keeps per-supplier copies), `CatalogViewModel`, `EditItemDialog`,
`SyncTables`, `AutoSync.runSync` (order, what is done with a push result), `RealtimeWatcher`
(every trigger runs a whole pass), `EntitySync.pushAll / pullAll / step / upsert / pagedList /
isNotOursToSync` and the 78 sites in the file that match `runCatching`, `getOrDefault`,
`getOrNull`, `onFailure` or `catch` (the ones that discard a failure are the numbered items above;
the rest are enum parses with defaults, results that are rethrown, or reads whose failure is handled).
Website (read only): the Suppliers panel's `saveSupplierDialog` and `retireSupplierDialog`
(an upsert whose error is shown; see B3), and every write of `manufacturer_sync_id`.
Server (SELECT only): `manufacturers` columns, defaults, constraints, indexes, policies,
triggers and the bodies of `touch_updated_at`, `enforce_delete_permission`, `current_company_id`,
`guard_time_entry_approval`, `approve_time_entry`, `guard_expense_amount`; `material_items`
columns; the two supplier rows' timestamps and field lengths (no contents); catalog rows by
supplier; `app_errors` for his company, 14 days.

## Blocked: what needs files this wave does not own

- **B1. A persisted mark on suppliers (and employees).** Add to `Manufacturer` (Entities.kt) a
  `pendingPush: Boolean = false` stamped true by `Repository.saveManufacturer` and cleared by a
  `markManufacturersPushed` that, like `markLineItemsPushed`, clears it only where the row still
  holds what was sent; a Room migration to the next schema version; then `pushManufacturers` sends only marked rows and
  `pullManufacturers` skips marked ones (`pullMayWriteOrder` is the shape). That replaces the
  in-memory ledger and closes the restart gap. Same for `Employee`. `Entities.kt` and
  `AppDatabase.kt` are not this wave's, and a migration cannot be tested without compiling.
- **B2. `ManufacturersScreen` / `ManufacturersViewModel`.** The edit dialog writes all six fields
  from a snapshot taken when the card was tapped, so a pull that lands while it is open is
  overwritten by the stale untouched fields on Save. It should write only the fields the person
  changed onto the current row (re-read by id). `save` should report a failure the way
  `CatalogViewModel.saveItem` does, and a Save on a row that no longer exists should say so.
- **B3. `website/dashboard.html` (held).** `saveSupplierDialog` upserts a whole row built from the
  `manufacturers` array loaded when the page opened; a phone change since then is overwritten. It
  needs to compare `updated_at` (or re-read the row) before writing, and say so when it differs.
- **B4. `CatalogFields.kt` and `CatalogScreen.kt` (held).** The doc on `supplierOf` says
  `CloudMaterialItem` has no `manufacturer_sync_id`; it now has. And
  `tests/a46-catalog-height-phone-editor.test.mjs` has a `todo` for exactly this fix, which now
  passes: delete its `todo` flag.
- **B5. The shifts noise (F5)** and **the Room schema error (F6)**, as described.

## How to check it after it ships (SELECT only)

1. On a phone: open a catalog item, set "Priced from" to a supplier, save, wait one sync. Then
   `select name, manufacturer_sync_id from material_items where company_id = '<his>' and name = '<item>'`
   should show the supplier's sync id. Before the fix it never did.
2. "Duplicate for supplier" on the same item, save, wait. The cloud should hold two rows with the
   same name, role, fence type and colour and different `manufacturer_sync_id`.
3. Edit a supplier on the website, leave the phone open, let it sync twice. `updated_at` on that
   row should stay where the website put it and the phone should show the new value. (After a
   restart of the app the first sync can still undo it: F2's limit.)
4. A positive control for every probe: count the rows you expect first, and check the raw output
   for an error, not for an empty result.
