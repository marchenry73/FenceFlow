# Sync / data-integrity risks (from audit2/android.md section 8)

Reviewed 2026-09-17. Two P1 items flagged for "confirmation" were checked
against the current `EntitySync.kt` / `JobSync.kt` and are **not bugs**:

- **Un-paged table read risk:** every cloud table pull in `EntitySync.kt`
  (employees, manufacturers, fence runs, expenses, field_changes, job_steps,
  site_markers, punch_list_items, change_orders, time entries, payment
  records, pricing tiers, build templates, material items) goes through
  `pagedList<T>(...)`. No bare `.select()` call was found outside the
  `sync_id`-only existence check at line 2557, which is a lookup query, not a
  data pull. The 1000-row silent-truncation risk is mitigated everywhere.
- **Unchecked `runCatching` at `EntitySync.kt:1080`:** `pushFieldChanges`
  does check the result — `full.getOrNull()?.let { return it }` returns on
  success, otherwise the exception is inspected (`isNotOursToSync`) and either
  rethrown or turned into the `insertOnly` fallback. This is the same
  fail-loud pattern used elsewhere, not a silent drop.

One P1 item is **not fixed here on purpose**, because fixing it means
changing the conflict model, which was explicitly out of scope for this pass:

- **Device-clock-based last-edit-wins (`JobSync.kt:204,613,774`):** conflict
  resolution compares `Job.updatedAt` (`System.currentTimeMillis()` on each
  phone) with no server-side clock cross-check. A phone with a wrong system
  clock can silently win or lose a conflict it shouldn't. Fixing this properly
  needs either a server-assigned sequence/timestamp or a vector-clock/CRDT
  style merge, which is a data-model change, not a bug fix. Left for a
  dedicated sync-model task.

No other P1/P0 sync items were in scope for this pass (P0 test-fixture
leakage and the overtime-pay mismatch are unrelated to sync/data-integrity
and weren't part of this task's instructions).
