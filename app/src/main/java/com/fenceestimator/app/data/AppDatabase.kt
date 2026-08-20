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
        SiteMarker::class, TimeEntry::class, PendingDeletion::class, FieldChange::class,
        PaymentRecord::class
    ],
    version = 26,
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
    abstract fun fieldChangeDao(): FieldChangeDao
    abstract fun syncMaintenanceDao(): SyncMaintenanceDao
    abstract fun paymentRecordDao(): PaymentRecordDao

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

        /** Remembers what a payment link bills, so a price change can flag it as stale. */
        private val MIGRATION_10_11 = object : Migration(10, 11) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `paymentLinkAmount` REAL NOT NULL DEFAULT 0")
            }
        }

        /** Splits out the material half of a change order so deposits can cover it. */
        private val MIGRATION_11_12 = object : Migration(11, 12) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `change_orders` ADD COLUMN `materialCost` REAL NOT NULL DEFAULT 0")
            }
        }

        /** Lets the estimated duration follow the footage until someone overrides it. */
        private val MIGRATION_12_13 = object : Migration(12, 13) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `durationManuallySet` INTEGER NOT NULL DEFAULT 0")
            }
        }

        /** Records why a job stalled and what the customer has to clear. */
        private val MIGRATION_13_14 = object : Migration(13, 14) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `blockedReason` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `customerMustClear` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `blockedAt` INTEGER")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `customerNotifiedAt` INTEGER")
            }
        }

        /** Records changes the crew makes on site so a manager can see them. */
        private val MIGRATION_14_15 = object : Migration(14, 15) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `field_changes` (" +
                        "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "`syncId` TEXT NOT NULL, " +
                        "`jobId` INTEGER NOT NULL, " +
                        "`summary` TEXT NOT NULL, " +
                        "`detail` TEXT NOT NULL, " +
                        "`changedBy` TEXT NOT NULL, " +
                        "`changedByRole` TEXT NOT NULL, " +
                        "`at` INTEGER NOT NULL, " +
                        "`acknowledgedAt` INTEGER, " +
                        "FOREIGN KEY(`jobId`) REFERENCES `jobs`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )"
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_field_changes_jobId` ON `field_changes` (`jobId`)")
            }
        }

        /** Gate pricing by the foot, and a haul-away fee for the old fence. */
        private val MIGRATION_15_16 = object : Migration(15, 16) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `gateRatePerFt` REAL NOT NULL DEFAULT 20")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `trashHaulFee` REAL NOT NULL DEFAULT 0")
            }
        }

        /** Cloud storage paths for signatures, survey images and job photos. */
        private val MIGRATION_16_17 = object : Migration(16, 17) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `surveyStoragePath` TEXT")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `signatureStoragePath` TEXT")
                db.execSQL("ALTER TABLE `change_orders` ADD COLUMN `signatureStoragePath` TEXT")
                db.execSQL("ALTER TABLE `job_photos` ADD COLUMN `storagePath` TEXT")
                db.execSQL("ALTER TABLE `job_photos` ADD COLUMN `syncId` TEXT NOT NULL DEFAULT ''")
                db.execSQL(
                    "UPDATE `job_photos` SET `syncId` = " +
                        "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
                        "substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || " +
                        "'-' || lower(hex(randomblob(6))) " +
                        "WHERE `syncId` = ''"
                )
            }
        }

        /**
         * Refunds, processor-locked payment figures, and the terms a signature
         * was actually given for.
         *
         * All additive with defaults that match the old behaviour: existing
         * jobs have refunded nothing, have no processor payments recorded, and
         * carry signed terms of zero -- which the staleness check reads as
         * "signed before we tracked this" and leaves alone rather than
         * pestering about every historical job.
         */
        private val MIGRATION_17_18 = object : Migration(17, 18) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `refundedAmount` REAL NOT NULL DEFAULT 0.0")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `refundedAt` INTEGER")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `refundReason` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `paymentsFromProcessor` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `signedContractTotal` REAL NOT NULL DEFAULT 0.0")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `signedLinearFeet` REAL NOT NULL DEFAULT 0.0")
            }
        }

        /** The customer's sign-off on the finished work, kept apart from estimate acceptance. */
        private val MIGRATION_18_19 = object : Migration(18, 19) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `finalSignOffImagePath` TEXT")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `finalSignOffStoragePath` TEXT")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `finalSignOffAt` INTEGER")
            }
        }

        /**
         * Clock-outs wait for approval before they count.
         *
         * Existing entries are approved in place. Retroactively marking every
         * shift already worked as "pending" would bury a manager under months
         * of history and make the queue useless on the day it appears.
         */
        private val MIGRATION_19_20 = object : Migration(19, 20) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `time_entries` ADD COLUMN `approvedAt` INTEGER")
                db.execSQL("ALTER TABLE `time_entries` ADD COLUMN `approvedBy` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `time_entries` ADD COLUMN `rejectedAt` INTEGER")
                db.execSQL("ALTER TABLE `time_entries` ADD COLUMN `reviewNote` TEXT NOT NULL DEFAULT ''")
                db.execSQL(
                    "UPDATE `time_entries` SET `approvedAt` = `endedAt`, " +
                        "`approvedBy` = 'Recorded before approval existed' WHERE `endedAt` IS NOT NULL"
                )
            }
        }

        /** Records who deleted something, so the trash can say who to ask about it. */
        private val MIGRATION_20_21 = object : Migration(20, 21) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `pending_deletions` ADD COLUMN `deletedBy` TEXT NOT NULL DEFAULT ''")
            }
        }

        /**
         * The payments ledger, plus a row for every payment already recorded.
         *
         * The backfill matters as much as the table. Without it the ledger
         * starts empty while jobs still carry an amountPaid, so every report
         * built on the ledger would read zero against jobs that are visibly
         * paid -- which looks exactly like the app having lost the money.
         *
         * Backfilled rows are dated to the job's scheduled date where there is
         * one, falling back to when the job was created. Neither is certain to
         * be the day the money arrived, but both are stable and identical on
         * every device, which is the property that was missing before.
         */
        private val MIGRATION_21_22 = object : Migration(21, 22) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `payment_records` (" +
                        "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "`syncId` TEXT NOT NULL, " +
                        "`jobId` INTEGER NOT NULL, " +
                        "`amount` REAL NOT NULL, " +
                        "`method` TEXT NOT NULL, " +
                        "`receivedAt` INTEGER NOT NULL, " +
                        "`reference` TEXT NOT NULL DEFAULT '', " +
                        "`note` TEXT NOT NULL DEFAULT '', " +
                        "`recordedBy` TEXT NOT NULL DEFAULT '', " +
                        "FOREIGN KEY(`jobId`) REFERENCES `jobs`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE )"
                )
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_payment_records_jobId` ON `payment_records` (`jobId`)")
                db.execSQL("CREATE INDEX IF NOT EXISTS `index_payment_records_receivedAt` ON `payment_records` (`receivedAt`)")

                // One opening row per job that has taken money. The syncId is
                // derived from the job's own syncId rather than random, so two
                // devices running this migration produce the SAME id and the
                // cloud upsert merges them instead of double-counting every
                // historical payment.
                db.execSQL(
                    "INSERT INTO `payment_records` " +
                        "(`syncId`, `jobId`, `amount`, `method`, `receivedAt`, `reference`, `note`, `recordedBy`) " +
                        "SELECT 'opening-' || `syncId`, `id`, `amountPaid`, 'OTHER', " +
                        "COALESCE(`scheduledDate`, `createdAt`), '', " +
                        "'Recorded before the payments ledger existed', '' " +
                        "FROM `jobs` WHERE `amountPaid` > 0"
                )
                // Refunds already recorded become their own negative row.
                db.execSQL(
                    "INSERT INTO `payment_records` " +
                        "(`syncId`, `jobId`, `amount`, `method`, `receivedAt`, `reference`, `note`, `recordedBy`) " +
                        "SELECT 'opening-refund-' || `syncId`, `id`, -`refundedAmount`, 'OTHER', " +
                        "COALESCE(`refundedAt`, `scheduledDate`, `createdAt`), '', " +
                        "`refundReason`, '' " +
                        "FROM `jobs` WHERE `refundedAmount` > 0"
                )
            }
        }

        /**
         * Supplier prices, kept apart from the catalog guess they replace.
         *
         * supplierUnitPrice is nullable on purpose: null means nobody has
         * quoted it yet, which is different from a quote of zero, and the
         * estimate needs to be able to say which it is.
         */
        private val MIGRATION_22_23 = object : Migration(22, 23) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `estimate_line_items` ADD COLUMN `supplierUnitPrice` REAL")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `materialPricesConfirmedAt` INTEGER")
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `supplierQuoteReference` TEXT NOT NULL DEFAULT ''")
            }
        }

        /**
         * Crew change REQUESTS, told apart from changes they simply made.
         *
         * Existing rows default to isRequest = 0, which is right: everything
         * recorded before this was a report of something already done, not a
         * question waiting on an answer.
         */
        private val MIGRATION_23_24 = object : Migration(23, 24) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `field_changes` ADD COLUMN `isRequest` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `field_changes` ADD COLUMN `approvedAt` INTEGER")
                db.execSQL("ALTER TABLE `field_changes` ADD COLUMN `rejectedAt` INTEGER")
                db.execSQL("ALTER TABLE `field_changes` ADD COLUMN `decidedBy` TEXT NOT NULL DEFAULT ''")
                db.execSQL("ALTER TABLE `field_changes` ADD COLUMN `decisionNote` TEXT NOT NULL DEFAULT ''")
            }
        }

        /**
         * Leaving the crew without leaving the books.
         *
         * Everyone existing stays active with no linked account, which is what
         * they already are today -- so nothing changes for anybody until
         * somebody is actually deactivated.
         */
        private val MIGRATION_24_25 = object : Migration(24, 25) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `employees` ADD COLUMN `isActive` INTEGER NOT NULL DEFAULT 1")
                db.execSQL("ALTER TABLE `employees` ADD COLUMN `deactivatedAt` INTEGER")
                db.execSQL("ALTER TABLE `employees` ADD COLUMN `profileId` TEXT NOT NULL DEFAULT ''")
            }
        }

        /** How much ground the no-photo grid covers. Everything existing keeps 400ft. */
        private val MIGRATION_25_26 = object : Migration(25, 26) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `jobs` ADD COLUMN `gridExtentFt` REAL NOT NULL DEFAULT 400")
            }
        }

        fun getInstance(context: Context, scope: CoroutineScope): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    DB_NAME
                ).addMigrations(MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8, MIGRATION_8_9, MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12, MIGRATION_12_13, MIGRATION_13_14, MIGRATION_14_15, MIGRATION_15_16, MIGRATION_16_17, MIGRATION_17_18, MIGRATION_18_19, MIGRATION_19_20, MIGRATION_20_21, MIGRATION_21_22, MIGRATION_22_23, MIGRATION_23_24, MIGRATION_24_25, MIGRATION_25_26)
                // Destructive ONLY from the pre-release versions that predate the
                // migration chain (it starts at 4). Blanket
                // fallbackToDestructiveMigration() was a standing offer to wipe a
                // customer's entire business -- jobs, estimates, signed change
                // orders, photos -- silently, on an ordinary update, if anyone
                // ever forgot a migration. It never bit here only because this
                // phone gets uninstalled and reinstalled; a paying customer
                // updating from the Play Store would have found it first.
                //
                // Now a missing migration throws instead, which is loud in
                // testing and impossible to ship past.
                .fallbackToDestructiveMigrationFrom(1, 2, 3)
                // Seeding deliberately lives ONLY in Repository.ensureSeedDataPresent().
                // There used to also be an onCreate callback doing the same inserts;
                // on a fresh install both ran concurrently and neither saw the other's
                // rows yet, so every catalog item and pricing tier was created twice.
                .build().also { INSTANCE = it }
            }
        }
    }
}
