# Room (on-phone database) migrations for both defects -- written, NOT applied

Neither of these was run. Both are for whoever eventually makes the code
change; this file exists so the exact statements are recorded once,
matching the style already used in `AppDatabase.kt`'s existing
`MIGRATION_37_38` and its predecessors (currently `version = 38`).

## Defect 1 -- bumps the schema to version 39

Adds the same `edit_version` counter described in
`supabase_conflict_version_patch.sql` to the four local tables whose
`updatedAt`/`lastUpdated` is currently compared straight against the
server's clock: `jobs`, `fence_runs`, `pricing_tiers`, `material_items`.

```kotlin
private val MIGRATION_38_39 = object : Migration(38, 39) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE `jobs` ADD COLUMN `editVersion` INTEGER NOT NULL DEFAULT 1")
        db.execSQL("ALTER TABLE `fence_runs` ADD COLUMN `editVersion` INTEGER NOT NULL DEFAULT 1")
        db.execSQL("ALTER TABLE `pricing_tiers` ADD COLUMN `editVersion` INTEGER NOT NULL DEFAULT 1")
        db.execSQL("ALTER TABLE `material_items` ADD COLUMN `editVersion` INTEGER NOT NULL DEFAULT 1")
    }
}
```

Additive, no table rebuild -- SQLite's `ADD COLUMN` with a constant default
is cheap and safe on a table of any size a fence contractor's phone will
ever hold. Nothing is lost if a phone crashes mid-migration and retries:
`ADD COLUMN` is not idempotent by itself (a retry would error on "duplicate
column"), so Room's own migration-version bookkeeping is what prevents a
double-run, the same as it already does for every migration before this
one -- no different risk profile than `MIGRATION_37_38` already shipped.

This column is inert on its own. The actual fix is the code that reads and
writes it -- `Repository.kt`'s `updateJob`/`createFenceRun`/`savePricingTier`/
`saveMaterialItem` would need to increment it locally on a real edit (and
leave it alone on a bookkeeping write, mirroring the existing "must not
bump updatedAt" comments already in that file), and `JobSync.kt`/
`EntitySync.kt`'s conflict comparisons would need to compare `editVersion`
instead of (or as a tie-breaker alongside) `updatedAt`. None of that is
touched here -- it is Kotlin logic, not a schema change, and out of scope
for this preparation pass.

## Defect 2 -- bumps the schema to version 40

Changes `time_entries.jobId` from `NOT NULL, ON DELETE CASCADE` to
`nullable, ON DELETE SET NULL`, so deleting a job detaches its time entries
(they survive, orphaned) instead of destroying them. Room does not support
altering a foreign key's `onDelete` behavior or a column's nullability with
`ALTER TABLE` -- both require rebuilding the table: create a new table with
the desired schema, copy every row across, drop the old table, rename the
new one into place, then recreate the indices Room expects.

```kotlin
private val MIGRATION_39_40 = object : Migration(39, 40) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE `time_entries_new` (
                `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                `syncId` TEXT NOT NULL,
                `jobId` INTEGER,
                `employeeId` INTEGER,
                `startedAt` INTEGER NOT NULL,
                `endedAt` INTEGER,
                `hourlyRate` REAL NOT NULL,
                `notes` TEXT NOT NULL,
                `approvedAt` INTEGER,
                `approvedBy` TEXT NOT NULL,
                `rejectedAt` INTEGER,
                `reviewNote` TEXT NOT NULL,
                `originalStartedAt` INTEGER,
                `originalEndedAt` INTEGER,
                `correctedAt` INTEGER,
                `correctionReason` TEXT NOT NULL,
                FOREIGN KEY(`jobId`) REFERENCES `jobs`(`id`) ON DELETE SET NULL
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            INSERT INTO `time_entries_new`
            SELECT id, syncId, jobId, employeeId, startedAt, endedAt, hourlyRate, notes,
                   approvedAt, approvedBy, rejectedAt, reviewNote,
                   originalStartedAt, originalEndedAt, correctedAt, correctionReason
            FROM `time_entries`
            """.trimIndent()
        )
        db.execSQL("DROP TABLE `time_entries`")
        db.execSQL("ALTER TABLE `time_entries_new` RENAME TO `time_entries`")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_time_entries_jobId` ON `time_entries` (`jobId`)")
        db.execSQL("CREATE INDEX IF NOT EXISTS `index_time_entries_employeeId` ON `time_entries` (`employeeId`)")
    }
}
```

(Column list must be re-verified against the live `TimeEntry` entity at
implementation time -- copied here from `Entities.kt` as read on 2026-09-12;
if any column was added or renamed since, this statement needs updating
before it is ever run, or the `INSERT ... SELECT` will fail outright rather
than corrupt anything, which is the safe direction for it to fail in.)

### What this costs, and what could go wrong mid-upgrade

- **A table rebuild on every phone, not a cheap column add.** For a
  contractor's phone this is realistically hundreds to low thousands of
  time-entry rows -- not a performance concern -- but it is a bigger
  surface for something to go wrong than Defect 1's migration. If the
  device loses power or the app is killed between the `CREATE TABLE` and
  the `RENAME`, Room's migration runs inside a single transaction by
  default, so SQLite will roll the whole thing back on next open and retry
  from scratch -- the risk is a slow migration on a huge, fragmented
  database taking a visible pause on first launch after the update, not a
  half-migrated table left behind.
- **`jobId` becomes optional everywhere it is read.** Any code that assumes
  a time entry always has a job -- reports, the timesheet screen, CSV
  export, `recordedHoursForJob` itself -- would need a "no job (job was
  deleted)" branch instead of crashing or silently mis-grouping a null as
  job id 0. That is a real, non-trivial application change riding along
  with what looks like "just a migration." This migration does not on its
  own make the app handle orphaned hours gracefully -- it only stops them
  from being destroyed. Someone still has to decide what the timesheet
  screen shows for "8.5 hours, job: (deleted)."
- **A phone that is offline through the exact version 39->40 boundary** is
  not at special risk here -- Room migrations are local and run entirely
  against that phone's own file the next time the app opens, independent
  of network or sync state. The upgrade itself cannot lose data because it
  is copy-then-drop, not delete-then-recreate; a crash mid-copy loses
  nothing since the original table is untouched until the very last step.
- **The already-shipped warning** (told the user before this destruction
  happens) stays true and unaffected either way -- it fires before the
  delete regardless of what onDelete does afterward. This migration removes
  the thing the warning is warning about, but does not touch the warning
  itself, and the warning should very likely stay even after the fix: an
  orphaned time entry with no job to bill against is still worth a person
  being told about before it happens.

### Argument against making this change at all

The instructions asked for an honest case that a "leave it" answer might be
correct. Here it plausibly is not, but the counter-argument is real: the
warning already shipped covers the common case where the person deleting
the job reads it. The scenario this migration protects against is narrower
than it first sounds -- crew hours recorded **offline, on a job that gets
deleted before the next sync**. That requires the deletion to happen from a
phone or from the office before that phone's own pending hours ever reach
the cloud. If jobs are rarely deleted (most fence contractors cancel or
mark a job dead rather than delete it -- deleting destroys the estimate,
the address, the whole history, not just the hours), this may be a
low-frequency event that the existing warning already catches often enough
in practice. Weighed against a table-rebuild migration and new "job:
(deleted)" UI work, "leave it, keep the warning, tell people to archive
instead of delete when hours are in question" is a defensible cheaper
answer -- see the main writeup (`DEFECTS_clock_and_deleted_hours.md`) for
the recommendation and confidence level.
