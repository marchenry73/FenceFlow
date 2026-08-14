package com.fenceestimator.app.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * COMPLETED is distinct from ACCEPTED: accepted means the customer said yes,
 * completed means the fence is in the ground. Without it, "Mark Job Complete"
 * had nowhere to move a job that was already accepted, so the button appeared
 * to do nothing.
 */
enum class JobStatus { DRAFT, SENT, ACCEPTED, COMPLETED, DECLINED }

/** Work the customer agreed to -- accepted and completed both count as won. */
val JobStatus.isWon: Boolean
    get() = this == JobStatus.ACCEPTED || this == JobStatus.COMPLETED

enum class FenceType {
    VINYL, WOOD, CHAIN_LINK, ALUMINUM, ORNAMENTAL_IRON, SPLIT_RAIL, COMPOSITE, UNIVERSAL
}

enum class WoodStyle { PRIVACY, SPACED_PICKET }

enum class AluminumStyle { RACKABLE, FLAT_TOP }

enum class MaterialCategory { PANEL, POST, CAP, CONCRETE, HARDWARE, GATE, TRIM, FABRIC, RAIL, PICKET, MISC }

enum class MaterialRole {
    PANEL, GATE_PANEL,
    LINE_POST, END_POST, CORNER_POST, GATE_POST,
    POST_CAP, CONCRETE_BAG, HOLE_PLUG,
    HINGE_SET, LATCH, HANDLE, BRACE, STIFFENER, TRIM,
    WOOD_PICKET, WOOD_RAIL, GATE_FRAME_KIT,
    CHAIN_FABRIC, TOP_RAIL, TENSION_WIRE, TENSION_BAND, BRACE_BAND, RAIL_END,
    BARBED_WIRE_ARM, PRIVACY_SLAT,
    NONE
}

enum class PhotoKind { BEFORE, AFTER, JOBSITE }

enum class InventoryKind { TOOL, MATERIAL }

enum class PaymentStatus { UNPAID, DEPOSIT_PAID, PAID_IN_FULL }

enum class HoaApprovalStatus { NOT_REQUIRED, PENDING, APPROVED, DENIED }

enum class PermitStatus { NOT_REQUIRED, PENDING, APPROVED }

enum class ExpenseCategory { FUEL, EQUIPMENT_RENTAL, PERMIT_FEE, OTHER }

/**
 * How a crew member is paid. Per-foot crews are paid on what they install
 * regardless of hours, so their clock is a record of time worked rather than
 * the basis for their pay.
 */
enum class PayType { HOURLY, PER_FOOT }

/**
 * A customer/property. Holds the shared survey image + calibration (one
 * scale for the whole property) plus job-level pricing. The actual fence
 * line(s) live in [FenceRun] rows so one job can mix fence types.
 */
@Entity(tableName = "jobs")
data class Job(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val customerName: String = "",
    val address: String = "",
    val phone: String = "",
    val email: String = "",
    val notes: String = "",
    val status: JobStatus = JobStatus.DRAFT,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),

    // Survey + calibration (shared across all fence runs on this property)
    val surveyImagePath: String? = null,
    val calibrationPixelsPerFoot: Float? = null,
    val calibrationKnownFeet: Float? = null,
    /** Feet represented by one grid square when drawing with no survey photo. */
    val gridFeetPerSquare: Float = 5f,

    // Pricing
    val taxRatePercent: Double = 7.0,
    val markupPercent: Double = 0.0,
    val laborRatePerFt: Double = 0.0,
    val laborFlatFee: Double = 0.0,
    val pricingTierName: String = "",
    val discountPercent: Double = 0.0,
    val minimumJobCharge: Double = 0.0,

    // Teardown of an existing fence
    val teardownEnabled: Boolean = false,
    val teardownFlatFee: Double = 0.0,
    val teardownRatePerFt: Double = 0.0,

    // Ordering & approvals
    val preferredManufacturerId: Long? = null,
    val hoaName: String = "",
    val hoaEmail: String = "",

    // Scheduling
    val scheduledDate: Long? = null,
    val estimatedDurationHours: Double = 4.0,

    // Payment / invoice
    val depositAmount: Double = 0.0,
    val amountPaid: Double = 0.0,
    val paymentStatus: PaymentStatus = PaymentStatus.UNPAID,
    val isInvoiced: Boolean = false,
    /**
     * Stable identity for cloud sync, generated on the device that created the job.
     * Room's auto-increment id is only unique per phone -- two crew phones would
     * both call their first job id 1 and overwrite each other in the shared cloud.
     */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    /** Set when this job was last pushed, so we only upload what actually changed. */
    val lastSyncedAt: Long? = null,
    /**
     * Your own payment link (Square, Stripe, PayPal, Venmo -- whatever you already use).
     * Pasted in per job or defaulted from Settings, then sent to the customer. The app
     * never touches the money itself, so there's no processor account or fee here.
     */
    val paymentLinkUrl: String = "",
    /** Tips are tracked separately from the contract so they can go 100% to the installer. */
    val tipAmount: Double = 0.0,
    val signatureImagePath: String? = null,
    val signedAt: Long? = null,

    // Referral & compliance
    val referralSource: String = "",
    val hoaApprovalStatus: HoaApprovalStatus = HoaApprovalStatus.NOT_REQUIRED,
    val permitNumber: String = "",
    val permitStatus: PermitStatus = PermitStatus.NOT_REQUIRED,

    // Crew
    val assignedEmployeeId: Long? = null
)

/**
 * One drawn fence line on the job's survey, with its own type and spec.
 * A job can have several runs (e.g. "Back Yard - Vinyl", "Front - Aluminum").
 */
@Entity(
    tableName = "fence_runs",
    foreignKeys = [
        ForeignKey(
            entity = Job::class,
            parentColumns = ["id"],
            childColumns = ["jobId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("jobId")]
)
data class FenceRun(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    val label: String = "",
    val fenceType: FenceType = FenceType.VINYL,
    val sortOrder: Int = 0,

    // Geometry, drawn on the job's shared survey image (or grid, if no photo)
    val pointsEncoded: String = "",
    val gatesEncoded: String = "",
    val closedLoop: Boolean = false,

    /** Preferred color/finish, matched against the catalog when picking priced items. Blank = no preference. */
    val colorOrFinish: String = "",

    // Panel-based spec (vinyl / aluminum / ornamental iron)
    val panelWidthFt: Float = 6f,
    val panelHeightFt: Float = 6f,
    val aluminumStyle: AluminumStyle = AluminumStyle.RACKABLE,

    // Wood / composite spec
    val woodStyle: WoodStyle = WoodStyle.PRIVACY,
    val woodRailCount: Int = 3,
    val picketWidthIn: Float = 5.5f,
    val picketGapIn: Float = 0f,

    // Chain link spec
    val fabricHeightFt: Float = 4f,
    val includeTopRail: Boolean = true,
    val includeTensionWire: Boolean = false,
    val includeBarbedWireArms: Boolean = false,
    val includePrivacySlats: Boolean = false,

    // Split-rail spec
    val splitRailCount: Int = 2,

    // Post spacing / concrete. For VINYL, ALUMINUM and ORNAMENTAL_IRON this is
    // kept equal to panelWidthFt by the UI (a post at every panel edge); the
    // other types carry their own independent spacing default.
    val postSpacingFt: Float = 6f,
    val concreteBagsPerPost: Float = 1f
)

@Entity(tableName = "manufacturers")
data class Manufacturer(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val name: String = "",
    val email: String = "",
    val phone: String = "",
    val address: String = "",
    /** Free text, e.g. "Mon-Fri 7am-4pm, Sat 8am-12pm". Manually kept up to date -- no live data source. */
    val hours: String = "",
    val notes: String = ""
)

@Entity(tableName = "pricing_tiers")
data class PricingTier(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val name: String = "",
    val laborRatePerFt: Double = 0.0,
    val laborFlatFee: Double = 0.0,
    val markupPercent: Double = 0.0,
    val discountPercent: Double = 0.0,
    val sortOrder: Int = 0
)

@Entity(tableName = "material_items")
data class MaterialItem(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val category: MaterialCategory,
    val role: MaterialRole = MaterialRole.NONE,
    /** Which fence type this price applies to, or UNIVERSAL if shared (e.g. concrete). */
    val fenceType: FenceType = FenceType.UNIVERSAL,
    val name: String,
    val unit: String = "EA",
    val unitPrice: Double,
    val taxable: Boolean = true,
    /**
     * For PANEL/GATE_PANEL: width in feet this unit covers.
     * For CHAIN_FABRIC: the fabric height in feet this row represents.
     */
    val coversFt: Float? = null,
    val colorOrFinish: String = "",
    /** Null = generic/no specific manufacturer. */
    val manufacturerId: Long? = null,
    val isActive: Boolean = true,
    val lastUpdated: Long = System.currentTimeMillis(),
    val sourceDoc: String = ""
)

@Entity(
    tableName = "estimate_line_items",
    foreignKeys = [
        ForeignKey(
            entity = Job::class,
            parentColumns = ["id"],
            childColumns = ["jobId"],
            onDelete = ForeignKey.CASCADE
        ),
        ForeignKey(
            entity = FenceRun::class,
            parentColumns = ["id"],
            childColumns = ["fenceRunId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("jobId"), Index("fenceRunId")]
)
data class EstimateLineItem(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    /** Null for job-level items not tied to a specific fence run. */
    val fenceRunId: Long? = null,
    val sortOrder: Int = 0,
    val description: String,
    val quantity: Double,
    val unit: String = "EA",
    val unitPrice: Double,
    val taxable: Boolean = true,
    val role: MaterialRole = MaterialRole.NONE,
    val isAutoGenerated: Boolean = true
)

@Entity(
    tableName = "job_photos",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId")]
)
data class JobPhoto(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val jobId: Long,
    val kind: PhotoKind,
    val filePath: String,
    val caption: String = "",
    val takenAt: Long = System.currentTimeMillis()
)

@Entity(
    tableName = "inventory_items",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId")]
)
data class InventoryChecklistItem(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val jobId: Long,
    val kind: InventoryKind,
    val description: String,
    val checked: Boolean = false,
    val photoPath: String? = null,
    val sortOrder: Int = 0
)

/**
 * Things on the property that aren't fence but change how the job runs:
 * the house, a pool, an easement you can't build in, a tree in the way.
 */
enum class SiteMarkerKind {
    EXISTING_FENCE, HOUSE, POOL, DRIVEWAY, EASEMENT, UTILITY, TREE, SLOPE, OBSTACLE
}

@Entity(
    tableName = "site_markers",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId")]
)
data class SiteMarker(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    val kind: SiteMarkerKind = SiteMarkerKind.OBSTACLE,
    val x: Float = 0f,
    val y: Float = 0f,
    val label: String = ""
)

/**
 * Extra work agreed after the original estimate ("add another 30 ft").
 * Kept as its own dated, separately-signed record rather than just editing
 * the estimate, so there's proof of what changed and when the customer
 * agreed to it.
 */
@Entity(
    tableName = "change_orders",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId")]
)
data class ChangeOrder(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    val description: String = "",
    val additionalFeet: Double = 0.0,
    val additionalCost: Double = 0.0,
    val signatureImagePath: String? = null,
    val signedAt: Long? = null,
    val createdAt: Long = System.currentTimeMillis()
) {
    val isSigned: Boolean get() = signatureImagePath != null
}

/**
 * Two checklists per job: the pre-start walkthrough done with the customer,
 * and the install steps the crew works through on site.
 */
enum class JobStepKind { WALKTHROUGH, INSTALL }

@Entity(
    tableName = "job_steps",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId")]
)
data class JobStep(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    val kind: JobStepKind,
    val description: String,
    val checked: Boolean = false,
    val sortOrder: Int = 0,
    val completedAt: Long? = null,
    /** Set when the customer confirms this item during the walkthrough. */
    val verifiedWithCustomer: Boolean = false
)

/**
 * One clock-in/clock-out span on a job.
 *
 * [endedAt] is null while the clock is still running, which is also how the
 * app finds an open shift after the phone has been closed and reopened.
 */
@Entity(
    tableName = "time_entries",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId"), Index("employeeId")]
)
data class TimeEntry(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    val employeeId: Long? = null,
    val startedAt: Long = System.currentTimeMillis(),
    val endedAt: Long? = null,
    /** Snapshot of the rate when worked, so later raises don't rewrite past job costs. */
    val hourlyRate: Double = 0.0,
    val notes: String = ""
) {
    val isRunning: Boolean get() = endedAt == null
    val hours: Double
        get() = ((endedAt ?: System.currentTimeMillis()) - startedAt)
            .coerceAtLeast(0L) / 3_600_000.0
    val laborCost: Double get() = hours * hourlyRate
}

@Entity(tableName = "employees")
data class Employee(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val name: String = "",
    val role: String = "",
    val payType: PayType = PayType.HOURLY,
    val hourlyRate: Double = 0.0,
    /** Paid per linear foot installed, used when [payType] is PER_FOOT. */
    val perFootRate: Double = 0.0,
    val phone: String = "",
    val email: String = "",
    val notes: String = ""
)

@Entity(
    tableName = "expenses",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId")]
)
data class Expense(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    val category: ExpenseCategory = ExpenseCategory.OTHER,
    val description: String = "",
    val amount: Double = 0.0,
    val date: Long = System.currentTimeMillis()
)

@Entity(
    tableName = "punch_list_items",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId")]
)
data class PunchListItem(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** Device-generated identity for cloud sync; Room ids are only unique per phone. */
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    val description: String = "",
    val resolved: Boolean = false,
    val createdAt: Long = System.currentTimeMillis(),
    val resolvedAt: Long? = null,
    val photoPath: String? = null
)
