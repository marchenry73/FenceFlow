package com.fenceestimator.app.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Database(
    entities = [
        Job::class, FenceRun::class, MaterialItem::class, EstimateLineItem::class,
        Manufacturer::class, PricingTier::class, JobPhoto::class, InventoryChecklistItem::class,
        Employee::class, Expense::class, PunchListItem::class, JobStep::class, ChangeOrder::class,
        SiteMarker::class, TimeEntry::class, PendingDeletion::class
    ],
    version = 10,
    exportSchema = false
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {
    abstract fun jobDao(): JobDao
    abstract fun fenceRunDao(): FenceRunDao
    abstract fun materialItemDao(): MaterialItemDao
    abstract fun estimateLineItemDao(): EstimateLineItemDao
    abstract fun manufacturerDao(): ManufacturerDao
    abstract fun pricingTierDao(): PricingTierDao
    abstract fun jobPhotoDao(): JobPhotoDao
    abstract fun inventoryItemDao(): InventoryItemDao
    abstract fun employeeDao(): EmployeeDao
    abstract fun expenseDao(): ExpenseDao
    abstract fun punchListDao(): PunchListDao
    abstract fun jobStepDao(): JobStepDao
    abstract fun changeOrderDao(): ChangeOrderDao
    abstract fun siteMarkerDao(): SiteMarkerDao
    abstract fun timeEntryDao(): TimeEntryDao
    abstract fun pendingDeletionDao(): PendingDeletionDao

    /** Flushes the write-ahead log into the main .db file so a raw file copy is complete and consistent. */
    suspend fun checkpoint() = withContext(Dispatchers.IO) {
        openHelper.writableDatabase.query("PRAGMA wal_checkpoint(FULL)").close()
    }

    companion object {
        const val DB_NAME = "fence_estimator.db"

        /**
         * Real migration rather than a destructive one -- by v5 there is live job
         * data on people's phones, and wiping it on every schema change is not
         * acceptable any more. Adds the site_markers table only.
         */
        private val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `site_markers` (" +
                        "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "`jobId` INTEGER NOT NULL, " +
                        "`kind` TEXT NOT NULL, " +
                        "`x` REAL NOT NULL, " +
                        "`y` REAL NOT NULL, " +
                        "`label` TEXT NOT NULL, " +
                        "FOREIGN KEY(`jobId`) REFERENCES `jobs`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )"
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_site_markers_jobId` ON `site_markers` (`jobId`)")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `paymentLinkUrl` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `tipAmount` REAL NOT NULL DEFAULT 0")
            }
        }

        /**
         * Adds the cloud sync identity. Existing rows get a random UUID via
         * SQLite's randomblob(), so jobs already on the phone keep syncing
         * correctly instead of being treated as brand new.
         */
        private val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `syncId` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `lastSyncedAt` INTEGER")
                db.execSQL(
                    "UPDATE `jobs` SET `syncId` = " +
                        "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
                        "substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || " +
                        "'-' || lower(hex(randomblob(6))) " +
                        "WHERE `syncId` = ''"
                )
            }
        }

        @Volatile private var INSTANCE: AppDatabase? = null

        /** Closes and drops the cached instance so a restored file is picked up fresh on next access. */
        fun closeForRestore() {
            synchronized(this) {
                INSTANCE?.close()
                INSTANCE = null
            }
        }

        /** Adds crew time tracking and the hourly rate that turns it into real labor cost. */
        private val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `time_entries` (" +
                        "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "`jobId` INTEGER NOT NULL, " +
                        "`employeeId` INTEGER, " +
                        "`startedAt` INTEGER NOT NULL, " +
                        "`endedAt` INTEGER, " +
                        "`hourlyRate` REAL NOT NULL DEFAULT 0, " +
                        "`notes` TEXT NOT NULL DEFAULT '', " +
                        "FOREIGN KEY(`jobId`) REFERENCES `jobs`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )"
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_time_entries_jobId` ON `time_entries` (`jobId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_time_entries_employeeId` ON `time_entries` (`employeeId`)")
                db.execSQL("ALTER TABLE `employees` ADD COLUMN `hourlyRate` REAL NOT NULL DEFAULT 0")
            }
        }

        /**
         * Gives every syncable record a device-generated id so it can be matched
         * across phones. Existing rows are backfilled with UUIDs built from
         * randomblob(), since SQLite has no uuid function of its own.
         */
        private val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                val tables = listOf(
                    "fence_runs", "estimate_line_items", "employees", "manufacturers",
                    "pricing_tiers", "material_items", "expenses", "punch_list_items",
                    "change_orders", "time_entries", "job_steps", "site_markers"
                )
                db.execSQL("ALTER TABLE `employees` ADD COLUMN `payType` TEXT NOT NULL DEFAULT 'HOURLY'")
                db.execSQL("ALTER TABLE `employees` ADD COLUMN `perFootRate` REAL NOT NULL DEFAULT 0")

                tables.forEach { table ->
                    db.execSQL("ALTER TABLE `$table` ADD COLUMN `syncId` TEXT NOT NULL DEFAULT ''")
                    db.execSQL(
                        "UPDATE `$table` SET `syncId` = " +
                            "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
                            "substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || " +
                            "'-' || lower(hex(randomblob(6))) " +
                            "WHERE `syncId` = ''"
                    )
                }
            }
        }

        /** Queue of records deleted locally that still need deleting in the cloud. */
        private val MIGRATION_8_9 = object : Migration(8, 9) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pending_deletions` (" +
                        "`syncId` TEXT PRIMARY KEY NOT NULL, " +
                        "`tableName` TEXT NOT NULL, " +
                        "`queuedAt` INTEGER NOT NULL )"
                )
            }
        }

        /**
         * Lets a run be quoted from typed-in footage instead of a drawing, lets
         * the user permanently remove auto-added items, and adds the job-level
         * waste allowance.
         */
        private val MIGRATION_9_10 = object : Migration(9, 10) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `fence_runs` ADD COLUMN `manualLinearFeet` REAL")
                db.execSQL("ALTER TABLE `fence_runs` ADD COLUMN `manualCornerCount` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `fence_runs` ADD COLUMN `suppressedRolesCsv` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `wastePercent` REAL NOT NULL DEFAULT 0")
            }
        }

        fun getInstance(context: Context, scope: CoroutineScope): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    DB_NAME
                ).addMigrations(MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8, MIGRATION_8_9, MIGRATION_9_10)
                .fallbackToDestructiveMigration()
                // Seeding deliberately lives ONLY in Repository.ensureSeedDataPresent().
                // There used to also be an onCreate callback doing the same inserts;
                // on a fresh install both ran concurrently and neither saw the other's
                // rows yet, so every catalog item and pricing tier was created twice.
                .build().also { INSTANCE = it }
            }
        }
    }
}
