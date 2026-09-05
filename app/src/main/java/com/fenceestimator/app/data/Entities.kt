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
    /** Undrilled post a wall-hung gate bolts through; it is not set in concrete. */
    BLANK_POST,
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
 * A record of something deleted locally that still needs deleting in the cloud.
 *
 * Without this, deleting was local-only: the row stayed in Supabase, and the
 * next sync saw a record "this phone is missing" and recreated it. Queuing the
 * deletion means it still works when the delete happens with no signal --
 * the next successful sync clears the queue.
 */
/**
 * Something the field changed after the office planned it.
 *
 * The crew standing at the fence line usually knows better than the drawing --
 * the yard is longer, a gate has to move, there's a tree nobody saw. Stopping
 * them from correcting it just means they build something the plan doesn't
 * match. So they can change it, and this records what moved, who moved it and
 * when, and stays unacknowledged until a manager has actually looked.
 *
 * That matters for money: footage drives the estimate, the post count and the
 * material order, so a change the office never sees is a job that quietly
 * stops matching what the customer agreed to pay.
 */
@Entity(
    tableName = "field_changes",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId")]
)
data class FieldChange(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    /** Short line a manager can read at a glance: "Fence line: 120 ft -> 138 ft". */
    val summary: String = "",
    /** Anything extra worth keeping, e.g. which run, or a note the crew typed. */
    val detail: String = "",
    val changedBy: String = "",
    val changedByRole: String = "",
    val at: Long = System.currentTimeMillis(),
    val acknowledgedAt: Long? = null,
    /**
     * True when the crew are ASKING rather than reporting.
     *
     * The two need telling apart. A report says the fence line already moved
     * and the office needs to know; a request says the crew think it should
     * move and are waiting to be told. Treating a request as a report means
     * work stops while nobody realises a decision is owed.
     */
    val isRequest: Boolean = false,
    val approvedAt: Long? = null,
    val rejectedAt: Long? = null,
    val decidedBy: String = "",
    /** The reason given when a request is turned down, so the crew know why. */
    val decisionNote: String = ""
) {
    val isAcknowledged: Boolean get() = acknowledgedAt != null

    /** A request nobody has answered yet. */
    val isAwaitingDecision: Boolean
        get() = isRequest && approvedAt == null && rejectedAt == null

    val isApproved: Boolean get() = approvedAt != null
    val isRejected: Boolean get() = rejectedAt != null && approvedAt == null
}

@Entity(tableName = "pending_deletions")
data class PendingDeletion(
    @PrimaryKey val syncId: String,
    val tableName: String,
    val queuedAt: Long = System.currentTimeMillis(),
    /** Who deleted it, so the trash can say who to ask about it. */
    val deletedBy: String = ""
)

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
    /** Where the survey image lives in cloud storage, so another phone can fetch it. */
    val surveyStoragePath: String? = null,
    val calibrationPixelsPerFoot: Float? = null,
    val calibrationKnownFeet: Float? = null,
    /** Feet represented by one grid square when drawing with no survey photo. */
    val gridFeetPerSquare: Float = 5f,
    /**
     * How much ground the no-photo grid covers, corner to corner.
     *
     * The grid used to be a fixed 400ft square fitted to the screen, so on a
     * phone one foot was about two and a half pixels: a 20ft gate section was a
     * 50-pixel line nobody could draw accurately, and a small drag measured
     * forty feet. Right for a property boundary, useless for a side gate.
     *
     * Changing this rescales anything already drawn, so the fence stays the
     * length it was and simply fills more or less of the screen.
     */
    val gridExtentFt: Float = 400f,

    // Pricing
    val taxRatePercent: Double = 7.0,
    val markupPercent: Double = 0.0,
    val laborRatePerFt: Double = 0.0,
    val laborFlatFee: Double = 0.0,
    val pricingTierName: String = "",
    val discountPercent: Double = 0.0,
    val minimumJobCharge: Double = 0.0,
    /**
     * Extra cut-and-waste allowance on materials you buy by length or count --
     * panels, pickets, rails, fabric, concrete. Never applied to posts, caps, or
     * hardware, because you can't buy 10% of a hinge.
     */
    val wastePercent: Double = 0.0,
    /**
     * Charged per foot of gate opening, not per gate. A 5 ft gate at $20/ft is
     * $100. Gates are the slowest part of a fence per foot -- hanging, squaring,
     * hardware -- so pricing them at the fence rate loses money on every one.
     */
    val gateRatePerFt: Double = 20.0,
    /** Hauling the old fence away, on top of the per-foot teardown labour. */
    val trashHaulFee: Double = 0.0,

    // Teardown of an existing fence
    val teardownEnabled: Boolean = false,
    val teardownFlatFee: Double = 0.0,
    val teardownRatePerFt: Double = 0.0,
    /**
     * How many feet of old fence come out. Zero means "the same as the new
     * fence", which is the common case and what every existing job assumed.
     * Typed, not drawn: an owner knows the old fence is 80 ft without
     * tracing it, and a second drawing layer was more ceremony than the
     * answer deserves.
     */
    val teardownFeet: Double = 0.0,

    // Ordering & approvals
    val preferredManufacturerId: Long? = null,
    val hoaName: String = "",
    val hoaEmail: String = "",

    // Scheduling
    val scheduledDate: Long? = null,
    val estimatedDurationHours: Double = 4.0,
    /**
     * True once someone types their own duration. Until then the estimate
     * tracks the footage automatically -- changing the length and watching the
     * hours stay put is indistinguishable from the calculation being broken.
     */
    val durationManuallySet: Boolean = false,

    /**
     * Why the crew couldn't finish, and what the customer has to do about it.
     * Recorded on the job rather than left in someone's head, because the
     * common causes -- a locked gate, a bush nobody cleared, an unmarked
     * sprinkler line -- all need the customer told and all get disputed later.
     */
    val blockedReason: String = "",
    /**
     * Why the job ran past its finish date -- weather, extra rock, a short
     * crew. Separate from [blockedReason] on purpose: blocked means the
     * customer must act and starts the tell-the-customer flow, while an
     * overrun is the business's own record for the day the customer asks
     * why it took longer. Sharing one field made typing an overrun reason
     * announce "customer has NOT been told yet" about nothing.
     */
    val overrunReason: String = "",
    /** What the customer must move or clear before the crew can come back. */
    val customerMustClear: String = "",
    val blockedAt: Long? = null,
    /** Set once the customer has actually been told, so nobody assumes someone else called. */
    val customerNotifiedAt: Long? = null,

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
    /**
     * The figure [paymentLinkUrl] actually bills. A link is fixed at the amount
     * it was created for, so once the price moves the old link would quietly
     * charge the customer the wrong total -- this is what lets the app notice
     * and say so instead.
     */
    val paymentLinkAmount: Double = 0.0,
    /** Tips are tracked separately from the contract so they can go 100% to the installer. */
    val tipAmount: Double = 0.0,
    /**
     * Money given back, and the reason.
     *
     * Kept as its own running total rather than by subtracting from
     * [amountPaid], because a cleared payment is a fact that sync refuses to
     * let go backwards -- the merge rule keeps the larger figure precisely so a
     * race can't erase money. A refund is a second fact rather than an edit to
     * the first, so it can be recorded without fighting that rule. Both totals
     * only ever grow, and what the customer actually owes is the difference.
     */
    val refundedAmount: Double = 0.0,
    val refundedAt: Long? = null,
    val refundReason: String = "",
    /**
     * True once money has arrived through a processor rather than being typed
     * in. What Stripe says was paid is the record, so the app stops letting the
     * figure be edited by hand -- an accidental keystroke over a real payment
     * is not a correction, it is a discrepancy nobody will spot until the
     * customer disputes the bill.
     */
    val paymentsFromProcessor: Boolean = false,
    val signatureImagePath: String? = null,
    /** The acceptance signature in cloud storage. Local files do not survive a new phone. */
    val signatureStoragePath: String? = null,
    val signedAt: Long? = null,
    /** When the customer approved the quote page, and who typed their name. */
    val quoteApprovedAt: Long? = null,
    val quoteApprovedName: String = "",
    /**
     * What the customer was actually looking at when they signed.
     *
     * A signature means "I agree to this", and "this" was a price and a length
     * of fence. Redraw the layout afterwards and the old signature silently
     * becomes a customer's agreement to a job that no longer exists. Recording
     * the terms at signing is what lets the app notice and ask for a new one,
     * rather than everyone forgetting until it is disputed.
     */
    val signedContractTotal: Double = 0.0,
    val signedLinearFeet: Float = 0f,
    /**
     * The customer signing off the finished work at the closing walkthrough.
     *
     * Separate from the acceptance signature on purpose: one says "I agree to
     * this price", the other says "this was built right". Three months later
     * when someone says a gate never latched, this is the record that answers
     * it, and it is worthless if it is the same field as the estimate.
     */
    val finalSignOffImagePath: String? = null,
    val finalSignOffStoragePath: String? = null,
    val finalSignOffAt: Long? = null,
    /**
     * When the supplier prices were entered and the estimate stopped being a
     * guess.
     *
     * Until this is set the totals are built on catalog prices -- close enough
     * to quote from, not close enough to bank on. The customer-facing documents
     * say so, because a contractor who signs a customer to a figure and then
     * discovers the material costs more has no way back.
     */
    val materialPricesConfirmedAt: Long? = null,
    /** Who quoted it, so the figures can be chased back to a supplier. */
    val supplierQuoteReference: String = "",

    // Referral & compliance
    val referralSource: String = "",
    val hoaApprovalStatus: HoaApprovalStatus = HoaApprovalStatus.NOT_REQUIRED,
    val permitNumber: String = "",

    // ---- Utility locate ----------------------------------------------------
    //
    // A locate has a ticket number, a legally required wait before anyone may
    // dig, and an expiry after which it is void. Digging outside that window is
    // the most expensive mistake available in fencing -- a struck gas line is
    // an evacuation, a struck fibre is a five-figure invoice, and both land on
    // the contractor.
    val locateTicketNo: String = "",
    val locateCalledAt: Long? = null,
    /**
     * The earliest anyone may dig.
     *
     * Recorded rather than calculated: the wait differs by state and by
     * utility, and a number this app invented would be worse than none.
     */
    val locateDigAfter: Long? = null,
    /** After this the ticket is void and has to be called again. */
    val locateExpiresAt: Long? = null,
    val locateNotes: String = "",
    val permitStatus: PermitStatus = PermitStatus.NOT_REQUIRED,

    // Crew
    val assignedEmployeeId: Long? = null,

    // ---- Office pricing parity ----------------------------------------------
    //
    // The office can now price a job too (price-job, the New Client wizard).
    // These four columns say whose number is on the job and how it got there,
    // so the phone knows when to defer instead of quietly overwriting a
    // number a customer has already been quoted. See JobSync's contract_total
    // push block for the decision table. All four are on touch_updated_at's
    // quiet list server-side -- writing them must never bump updatedAt, or
    // the office pricing a job would look like an edit and steal every
    // phone's offline work on the next sync (offline-sync-edit-clock).
    /** Which template (if any) the job's build came from. Provenance only. */
    val buildTemplateSyncId: String? = null,
    /** Which engine wrote [Job.signedContractTotal]'s sibling, contractTotal, last: '' | 'APP' | 'OFFICE'. */
    val pricedBy: String = "",
    val pricedAt: Long? = null,
    val pricingEngineVersion: String = "",
    /**
     * When the office sent this quote to the customer via the quote link.
     *
     * Once this is set, the office's number is what the customer saw and
     * agreed to price against -- the phone stops overwriting contractTotal
     * from here and only ever records a pricing_drift row if its own
     * recompute disagrees. Before this is set, the phone still wins as it
     * always has: nobody has been shown a number yet to contradict.
     */
    val quoteSentAt: Long? = null
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
    /**
     * Unused. Briefly marked a run as the old fence coming out; the teardown
     * length is typed on the job instead (Job.teardownFeet). The column stays
     * because a migration cannot be un-run, and it is simply never set.
     */
    val isTeardown: Boolean = false,

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
    val concreteBagsPerPost: Float = 1f,

    /**
     * Typed-in footage. When set, this is the truth and the drawing is ignored,
     * so a contractor who already knows the length can quote without drawing or
     * calibrating anything. Null means "measure it from the drawing".
     */
    val manualLinearFeet: Float? = null,
    /** Corners to assume when working from [manualLinearFeet] -- there's no drawing to count them from. */
    val manualCornerCount: Int = 0,
    /**
     * Roles the user deleted off this run's estimate, comma-separated. Suggest
     * Quantities skips them, so removing the auto-added handle (or anything
     * else) sticks instead of coming back on the next regenerate.
     */
    val suppressedRolesCsv: String = "",

    /**
     * Which build template this run's spec was copied from, if any.
     *
     * Provenance only -- a run COPIES the template's columns at creation and
     * keeps them from then on, so editing the template later never moves a
     * quote somebody has already signed. Null means the run was started from
     * [com.fenceestimator.app.ui.runs.FenceRunListViewModel.defaultSpacingFor]'s
     * hardcoded defaults instead, which stays the fallback for a fence type
     * with no template chosen or none synced down yet.
     */
    val buildTemplateSyncId: String? = null
) {
    val suppressedRoles: Set<MaterialRole>
        get() = suppressedRolesCsv.split(",")
            .mapNotNull { name -> runCatching { MaterialRole.valueOf(name.trim()) }.getOrNull() }
            .toSet()

    /** True when this run is quoted from typed-in footage rather than a drawing. */
    val usesManualFeet: Boolean get() = (manualLinearFeet ?: 0f) > 0f

    companion object {
        /**
         * Starts a run from a saved build template: fence type and every
         * spec column, copied by name so the run prices exactly like a fresh
         * run of the template's own type. Only jobId, label and sortOrder
         * come from the caller -- everything else here is either the
         * template's spec or this run's own drawing/gate state, which a
         * template never carries (a template is a spec, not a drawing).
         *
         * The columns copied here have to be exactly the spec columns on
         * [BuildTemplate] -- see FenceRunFromTemplateTest, which fails on
         * its own if one is ever added to only one side.
         */
        fun fromTemplate(
            template: BuildTemplate,
            jobId: Long,
            label: String,
            sortOrder: Int = 0
        ): FenceRun = FenceRun(
            jobId = jobId,
            label = label,
            sortOrder = sortOrder,
            fenceType = template.fenceType,
            colorOrFinish = template.colorOrFinish,
            panelWidthFt = template.panelWidthFt,
            panelHeightFt = template.panelHeightFt,
            postSpacingFt = template.postSpacingFt,
            concreteBagsPerPost = template.concreteBagsPerPost,
            aluminumStyle = template.aluminumStyle,
            woodStyle = template.woodStyle,
            woodRailCount = template.woodRailCount,
            picketWidthIn = template.picketWidthIn,
            picketGapIn = template.picketGapIn,
            fabricHeightFt = template.fabricHeightFt,
            includeTopRail = template.includeTopRail,
            includeTensionWire = template.includeTensionWire,
            includeBarbedWireArms = template.includeBarbedWireArms,
            includePrivacySlats = template.includePrivacySlats,
            splitRailCount = template.splitRailCount,
            buildTemplateSyncId = template.syncId
        )
    }
}

/**
 * The fence a company usually builds, as data -- post spacing, panel height,
 * bags of concrete per post, rail count, picket width, all of it, instead of
 * the constants [com.fenceestimator.app.ui.runs.FenceRunListViewModel] used
 * to bury in [com.fenceestimator.app.ui.runs.FenceRunListViewModel.defaultSpacingFor].
 *
 * A template is a SPEC, not a link: [FenceRun.fromTemplate] copies these
 * columns onto a run at creation, and the run keeps them from then on, so
 * editing a template later never moves a quote somebody has already signed.
 *
 * [companyId] null means this row is one of the ten FenceFlow ships --
 * readable by every company, editable by none (the office RPCs that write
 * these enforce that; nothing on the phone ever writes to this table at all,
 * it only pulls). The spec columns carry the exact names and types of the
 * matching [FenceRun] columns on purpose, so copying is by column name and
 * nobody ever retypes a literal 6 or 8. See supabase_build_templates_patch.sql
 * for the authoritative column list.
 */
@Entity(tableName = "build_templates")
data class BuildTemplate(
    /** The cloud row's own identity. Used as the Room primary key too: this
     *  table is pull-only, so there is no device-local id to keep separate
     *  from it, and every place a run refers back to a template already
     *  does so by this string (see [FenceRun.buildTemplateSyncId]). */
    @PrimaryKey val syncId: String,
    /** Null = shipped by FenceFlow, visible to every company, editable by none. */
    val companyId: String? = null,
    val name: String = "",
    val description: String = "",
    val isDefault: Boolean = false,
    val derivedFromSyncId: String? = null,
    val sortOrder: Int = 0,

    // Spec columns: same names and types as FenceRun, copied by FenceRun.fromTemplate.
    val fenceType: FenceType = FenceType.VINYL,
    val colorOrFinish: String = "",
    val panelWidthFt: Float = 6f,
    val panelHeightFt: Float = 6f,
    val postSpacingFt: Float = 6f,
    val concreteBagsPerPost: Float = 1f,
    val aluminumStyle: AluminumStyle = AluminumStyle.RACKABLE,
    val woodStyle: WoodStyle = WoodStyle.PRIVACY,
    val woodRailCount: Int = 3,
    val picketWidthIn: Float = 5.5f,
    val picketGapIn: Float = 0f,
    val fabricHeightFt: Float = 4f,
    val includeTopRail: Boolean = true,
    val includeTensionWire: Boolean = false,
    val includeBarbedWireArms: Boolean = false,
    val includePrivacySlats: Boolean = false,
    val splitRailCount: Int = 2,

    // Gate defaults the wizard offers on a new run -- not FenceRun columns,
    // since a run's actual gates live in gatesEncoded once drawn or typed.
    val gateWidthFt: Float = 4f,
    val gateMounting: String = "LINE",

    /** The cloud's own last-edit-wins clock; never bumped locally, since this table is pull-only. */
    val updatedAt: Long = 0L,
    /** Set once a template is retired. Filtered out before it ever reaches this table by the pull. */
    val deletedAt: Long? = null
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
    val sortOrder: Int = 0,
    /**
     * This phone's last-edit-wins clock for sync, same idea as [Job.updatedAt].
     * Bumped on every user edit (see Repository.savePricingTier); a pull
     * stores the cloud's own clock here instead of bumping it, so the next
     * push doesn't mistake a just-downloaded row for a fresh local edit.
     */
    val updatedAt: Long = System.currentTimeMillis()
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
    val isAutoGenerated: Boolean = true,
    /**
     * What the supplier actually quoted, once they have come back.
     *
     * Null until then, and that distinction is the point. [unitPrice] is the
     * catalog figure -- a good guess from what these things usually cost, which
     * is all you have when the customer is standing in the yard wanting a
     * number. It is not what you will pay. Keeping the two apart means the
     * estimate can say plainly that it is provisional, and the moment real
     * prices arrive the job re-prices off them without anyone retyping a
     * catalog.
     */
    val supplierUnitPrice: Double? = null
) {
    /** What this line actually costs: the supplier quote if it exists, the catalog guess if not. */
    val effectiveUnitPrice: Double get() = supplierUnitPrice ?: unitPrice

    val lineTotal: Double get() = quantity * effectiveUnitPrice

    /** True once a real price has replaced the estimate. */
    val isSupplierPriced: Boolean get() = supplierUnitPrice != null
}

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
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val kind: PhotoKind,
    val filePath: String,
    /** Where this photo lives in cloud storage. */
    val storagePath: String? = null,
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
    /** What the customer is charged for this change, materials included. */
    val additionalCost: Double = 0.0,
    /**
     * How much of [additionalCost] is materials you have to buy up front.
     * Tracked separately so the suggested deposit covers extra work too --
     * otherwise agreeing to another 40 ft means fronting its material yourself.
     */
    val materialCost: Double = 0.0,
    val signatureImagePath: String? = null,
    /** The signature in cloud storage. Without it a signed order loses its proof on a new phone. */
    val signatureStoragePath: String? = null,
    val signedAt: Long? = null,
    val createdAt: Long = System.currentTimeMillis()
) {
    val isSigned: Boolean get() = signatureImagePath != null
}

/**
 * Three checklists per job: the walkthrough done with the customer before
 * anything is dug, the install steps the crew works through, and the closing
 * walkthrough the customer signs off.
 *
 * Two walkthroughs and no more. Ticking an item and then separately marking it
 * "confirmed" was two confirmations for one fact, so people did one or the
 * other and the record meant nothing either way. One tick per item now, and the
 * customer signature at the end is what makes the whole thing binding.
 */
enum class JobStepKind { WALKTHROUGH, INSTALL, FINAL_WALKTHROUGH }

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
    val notes: String = "",
    /**
     * A finished shift is a claim until somebody signs off on it.
     *
     * Hours become pay and become job cost, and both are wrong if the clock ran
     * through a two-hour lunch or somebody forgot to clock out until the next
     * morning. Neither of those is dishonesty -- they are what happens on a
     * site -- but they are why a shift is reviewed before it counts.
     */
    val approvedAt: Long? = null,
    val approvedBy: String = "",
    /** Set when a shift is sent back, with the reason the crew needs to see. */
    val rejectedAt: Long? = null,
    val reviewNote: String = ""
) {
    val isRunning: Boolean get() = endedAt == null

    /** Finished, and neither approved nor sent back yet. */
    val isAwaitingApproval: Boolean
        get() = endedAt != null && approvedAt == null && rejectedAt == null

    val isApproved: Boolean get() = approvedAt != null
    val isRejected: Boolean get() = rejectedAt != null && approvedAt == null

    val hours: Double
        get() = ((endedAt ?: System.currentTimeMillis()) - startedAt)
            .coerceAtLeast(0L) / 3_600_000.0

    /**
     * Hours that actually count -- towards pay and towards what this job cost.
     *
     * Unapproved time is deliberately zero rather than provisional. A job cost
     * built on hours nobody has checked reads as fact on the reports screen,
     * and the whole point of the review is that it might be wrong.
     */
    val payableHours: Double get() = if (isApproved) hours else 0.0

    val laborCost: Double get() = payableHours * hourlyRate

    /** What the shift is worth if approved as it stands -- shown to the reviewer. */
    val claimedCost: Double get() = hours * hourlyRate
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
    val notes: String = "",
    /**
     * Still on the crew.
     *
     * Somebody who leaves is marked inactive rather than deleted: they vanish
     * from crew lists and assignment pickers and can no longer sign in, but
     * every hour they worked and every job they cost stays intact and still
     * counts in reports. Deleting them would take the payroll record with them,
     * which is the one thing you cannot afford to lose about a former employee.
     */
    val isActive: Boolean = true,
    val deactivatedAt: Long? = null,
    /**
     * The account that signs in as this person, when there is one.
     *
     * Without it the app cannot tell whose shift it is looking at: clocking in
     * records against the job's ASSIGNED employee rather than whoever is
     * holding the phone. That is why "nobody approves their own hours" has to
     * fall back to matching email addresses, and why it cannot be enforced in
     * the database. With this filled in, it is a fact instead of a guess.
     */
    val profileId: String = ""
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

/** How money arrived. Card payments post themselves; the rest are recorded by hand. */
enum class PaymentMethod(val label: String) {
    CARD("Card"),
    CASH("Cash"),
    CHECK("Check"),
    BANK_TRANSFER("Bank transfer"),
    OTHER("Other")
}

/**
 * One movement of money on a job, with the date it actually happened.
 *
 * Built because "Collected this month" could not be answered without it. The
 * report used to sum each job's lifetime `amountPaid` and attribute the whole
 * figure to a single job timestamp -- so a job edited today dragged every
 * payment it had ever taken into this month, and because that timestamp is a
 * sync artifact it differed between devices. Two phones showed two numbers for
 * the same company and both were wrong.
 *
 * A payment is an event with a date. Totals are sums of events, and a period
 * total is the events inside it. That is the only arrangement where every
 * device agrees and the figure means what it says.
 *
 * Refunds are rows too, with a negative [amount], so the ledger reads as a
 * statement rather than needing a second table to reconcile against.
 */
@Entity(
    tableName = "payment_records",
    foreignKeys = [
        ForeignKey(entity = Job::class, parentColumns = ["id"], childColumns = ["jobId"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index("jobId"), Index("receivedAt")]
)
data class PaymentRecord(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val syncId: String = java.util.UUID.randomUUID().toString(),
    val jobId: Long,
    /** Negative for a refund. */
    val amount: Double,
    val method: PaymentMethod = PaymentMethod.OTHER,
    /** When the money moved -- not when the row was written. This is what reports bucket on. */
    val receivedAt: Long = System.currentTimeMillis(),
    /** Check number, Stripe payment id, whatever identifies it on a statement. */
    val reference: String = "",
    val note: String = "",
    val recordedBy: String = ""
) {
    val isRefund: Boolean get() = amount < 0.0
}
