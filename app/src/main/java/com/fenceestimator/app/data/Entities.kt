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
 * A takeoff line this phone has just written under a sync id the cloud may
 * hold tombstoned, which the next sync must bring back to life there rather
 * than reap here. See [LineItemResurrections] for the bug.
 *
 * A table, not a list in memory, because the gap it covers is exactly when
 * the process is most likely to die: a Suggest pressed at a job site with no
 * signal, then the phone swiped away or left overnight. With the list gone,
 * the reaper on reconnect saw the ids tombstoned, deleted the regenerated
 * lines -- and any quantity typed on them since -- and nothing said so.
 */
@Entity(tableName = "pending_resurrections")
data class PendingResurrection(
    @PrimaryKey val syncId: String,
    val queuedAt: Long = System.currentTimeMillis()
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
    /**
     * Where a SOLD job sits between approval and invoice, in the owner's own
     * words: "Materials, dig, set, build, punch, done." One of MATERIALS,
     * DIG, SET, BUILD, PUNCH, DONE, or null before production has started --
     * a quote is not "waiting on materials".
     *
     * The phone never writes this column itself. `set_production_stage` on
     * the server is the only door; this field only ever holds what that RPC
     * just confirmed, or what a later pull brought down. See
     * [com.fenceestimator.app.estimate.ProductionStage] and
     * CrewJobViewModel.moveStage.
     */
    val productionStage: String? = null,

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
    /**
     * Where this property actually is, so the satellite tool (and anything
     * else that needs a map) doesn't have to ask the geocoder again every
     * time it opens -- an address doesn't move, so this is looked up once
     * and kept. Null until either the office (website/dashboard.html) or
     * this phone has geocoded the job's address at least once.
     */
    val siteLat: Double? = null,
    val siteLon: Double? = null,

    // Pricing
    val taxRatePercent: Double = 7.0,
    val markupPercent: Double = 0.0,
    val laborRatePerFt: Double = 0.0,
    val laborFlatFee: Double = 0.0,
    val pricingTierName: String = "",
    val discountPercent: Double = 0.0,
    val minimumJobCharge: Double = 0.0,
    /**
     * Floor under the labour figure alone, applied before markup/tax/discount
     * so markup earns on the floored labour exactly as it would on real labour.
     * 0 is off -- with 0 the arithmetic is byte-for-byte what it was before this
     * field existed, which is what keeps every other company on this database
     * priced exactly as they are now.
     */
    val minimumLaborCharge: Double = 0.0,
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
    /**
     * When this phone and the cloud last agreed on this job: stamped after a
     * push succeeds (device clock), and by a pull that writes the cloud's copy
     * onto the phone (the cloud's updated_at, which is then also [updatedAt]).
     * Null means this phone has never been in step with a cloud copy -- a job
     * made here and not yet pushed. See [jobHoldsUnpushedEdit], which is the
     * only reader, and why the pull half exists.
     */
    val lastSyncedAt: Long? = null,
    /**
     * This row as it serialized the last time this phone took the cloud's copy
     * of it -- a pull that merged the cloud row on, or the row a push handed
     * back (JobSync.jobSyncSnapshot, JSON, money keys left out). Null until
     * the first such moment on a build that records it.
     *
     * What it is for: telling which columns THIS phone changed since then. A
     * crew phone sends crew_save_job only those (JobSync.crewChangedKeys).
     * Sending every allowlisted column instead meant a crew phone holding an
     * older copy -- it pushes before it pulls -- put its stale calibration,
     * grid size, teardown feet and locate ticket back over what the office
     * had just set, and the first three move the footage price-job bills.
     * It also names the columns a crew phone changed that the server will not
     * take from crew, so they go to the office as a note instead of vanishing.
     *
     * Bookkeeping, never sent: not on CloudJob, and writing it never touches
     * [updatedAt].
     */
    val crewBase: String? = null,
    /**
     * When this phone stopped receiving the job because its person is no
     * longer on it -- a crew member taken off, or an access that ended
     * (supabase_crew_job_scope.sql). Null for every job this phone may see.
     *
     * A job that stops arriving is HIDDEN, never deleted. Deleting it here
     * would take its shifts with it (TimeEntry cascades on the job row) and
     * any walkthrough tick or marker that has not gone up yet, and nothing
     * on a job's children says which of them the cloud already has. So the
     * row stays, with everything hanging off it: out of the job list and the
     * schedule (JobDao.observeAll, getScheduledBetween), listed as kept on
     * this phone (JobDao.observeHeld), still openable by id so a running
     * shift can be clocked out, and its shifts still upload. The moment the
     * job arrives again -- access granted, put back on the crew -- it comes
     * back, and anything held back goes up with it.
     *
     * Set and cleared only by JobSync (planJobHolds), from what the crew door
     * actually returned. Local bookkeeping: not on CloudJob, never sent, and
     * writing it never touches [updatedAt].
     */
    val accessEndedAt: Long? = null,
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
     * Set by the server when a material drawing change invalidates an
     * existing approval (see docs/REAPPROVAL_RULE.md). Pull-only: the phone
     * must never write these three columns back up. Non-null
     * [reapprovalRequiredAt] means the job needs the customer to approve
     * again before more money can be asked for.
     */
    val reapprovalRequiredAt: Long? = null,
    val reapprovalReason: String = "",
    val reapprovalCount: Int = 0,
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
     * The price the customer accepted, frozen at the moment they accepted it.
     * Two writers, one per way of accepting:
     *  - a drawn signature ([signedAt]): EstimateViewModel.captureSignature
     *    freezes it here, and the server's `stamp_accepted_total` trigger
     *    copies signed_contract_total into jobs.accepted_total when the
     *    signature reaches it;
     *  - an online approval ([quoteApprovedAt]): quote-view writes the total
     *    the quote page showed, in the same UPDATE as quote_approved_at.
     * The trigger never stamps an approval -- an approval through a quote-view
     * older than that change leaves it null, on purpose (see
     * supabase_r6_price_stability.sql PART 4 for why a fallback from
     * contract_total would have anchored job 4598 at the wrong figure).
     * Null means nothing anchors the price yet, so the live estimate stands.
     *
     * Why it exists: after acceptance the phone kept pushing its fresh recompute
     * as contract_total, so the figure the quote page, the payment link and
     * the deposit cap all read moved on its own. Woody was signed at $3,620 and
     * showed $200; job 4598 was signed at $9,710 and showed $13,410. Once set,
     * the only price a phone may assert is this plus signed extra work since
     * (see JobMoney.anchoredTotal); anything else goes through re-approval.
     *
     * Pull-only on the wire, like the re-approval columns: Job.toCloud never
     * sends it (it is in MONEY_KEYS, and the server is its only writer). Null
     * by default and with no backfill here, so a job accepted before this
     * existed keeps behaving exactly as it did -- rewriting a customer-facing
     * figure on those is the owner's call, not an upgrade's.
     */
    val acceptedTotal: Double? = null,
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
     * This run IS the old fence coming out, not the new one going in.
     *
     * Read in four places: EstimateEngine.linearFeet excludes a teardown run
     * from the billable and labour footage (you don't pay to install a fence
     * that is leaving), EstimateEngine.teardownLinearFeet sums it for the
     * teardown charge instead, TakeoffRefresher clears any auto-generated
     * material lines on it (nobody buys panels for a fence coming out), and
     * SurveyDrawScreen draws it in PlanColors.teardownLine rather than
     * PlanColors.fenceLine so it reads differently on the plan.
     *
     * [Job.teardownFeet] is the typed alternative and wins over this run's own
     * drawn footage whenever it is greater than zero -- an owner who already
     * knows the old fence is 80 ft can skip drawing it. Either way, none of
     * this charges anything by itself: [Job.teardownEnabled] is the one
     * switch that turns the teardown charge on at all.
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
    val buildTemplateSyncId: String? = null,

    /**
     * This phone's last-edit-wins clock for sync, same idea as [Job.updatedAt].
     * Bumped on every user edit (see Repository.saveFenceRun); a pull
     * stores the cloud's own clock here instead of bumping it, so the next
     * push doesn't mistake a just-downloaded row for a fresh local edit.
     */
    val updatedAt: Long = System.currentTimeMillis()
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
    val supplierUnitPrice: Double? = null,
    /**
     * True when this phone changed the line and the cloud has not taken the
     * change yet. Set by every local write (Repository.saveLineItem,
     * updateLineItem, a takeoff regenerate); left false by a pull; cleared
     * once an upsert has carried exactly these values up.
     *
     * Line items carry no clock of their own, so the push used to send every
     * line of every job on every pass and the pull then wrote the cloud's copy
     * back unconditionally: two phones allowed to see prices re-asserted their
     * own copies at each other for ever, the price moving with every sync
     * (the owner's phone and a crew login flipped Woody's concrete 3 <-> 85
     * twenty-odd times in four days). Only a line somebody changed goes up
     * now, and the pull never writes over one still waiting to.
     */
    val pendingPush: Boolean = false
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
    val createdAt: Long = System.currentTimeMillis(),
    /**
     * True once this order was part of a price the customer accepted: it
     * existed when they signed on this phone (EstimateViewModel.captureSignature
     * marks every order then) or when the quote page approval landed (the
     * server marks every order it holds then, change_orders.in_accepted_total).
     * Latches: once true it never goes back, on either side.
     *
     * Why: the engine counts every change order in the grand total, signed or
     * not, so the accepted figure already contains an order that was unsigned
     * at acceptance. JobMoney.extraWorkSinceAcceptance adds orders signed AFTER
     * acceptance on top of that figure -- so an order added while the quote was
     * out and signed the day after the contract was billed twice ($9,710
     * accepted with a $900 order inside it became $10,610). An order carrying
     * this flag is never added again.
     */
    val inAcceptedTotal: Boolean = false,
    /**
     * This phone changed the order and the cloud has not taken the change yet.
     * The same mark [EstimateLineItem.pendingPush] carries, for the same
     * reason and with the same two rules: only a marked order goes up, and the
     * pull writes the cloud's copy over an order that is NOT marked.
     *
     * Without it every order went up on every pass and the pull applied
     * whatever the cloud held, so two writers each re-sent their own copy for
     * ever -- the 198 quantity flip-flops in the audit log are what that looks
     * like on line items. No change order has ever been edited on this
     * company's data (0 rows in audit_log, checked 2026-09-22), so it never
     * bit here; the order sheet is the money evidence for extra work and it
     * should not be waiting to.
     *
     * It is also what makes "editing the terms clears the signature" hold.
     * Clearing is a write of NULL, and a push leaves a null field out of the
     * body entirely (explicitNulls = false), so the server kept the old
     * signed_at and the next pull put it straight back on the edited terms --
     * a signature for $1,200 shown against $3,400. See
     * [signatureClearedAt], which is the half that says so out loud.
     */
    val pendingPush: Boolean = false,
    /**
     * When THIS phone cleared the customer's signature off this order, because
     * its terms were edited (JobDetailViewModel.updateChangeOrder). Null means
     * "this phone is not claiming anything about the signature".
     *
     * Its own field rather than an inference, because the inference is wrong.
     * Clearing has to be sent as an explicit null -- a push leaves a null field
     * out of the body (explicitNulls = false) and the server keeps what it has
     * -- and "send explicit nulls for any marked order that reads unsigned
     * here" would erase a real signature: [pendingPush] is also set by
     * ChangeOrderDao.markAllInAcceptedTotal at an acceptance, which marks every
     * order on the job including one a crew phone signed and this phone has not
     * pulled yet. That is the same erasure that
     * [changeOrdersInSameColumnBatches] was written to stop, and it must not
     * come back through this door.
     *
     * Set only where the signature is actually cleared; cleared only once the
     * server has taken the nulls.
     */
    val signatureClearedAt: Long? = null
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
    val verifiedWithCustomer: Boolean = false,
    /**
     * Which shipped step this is, so the UI can show it translated.
     *
     * [description] stays the source of truth -- it is what a live job already
     * has recorded, in whatever language it was seeded in, and it is what a
     * hand-typed step will ever have. Null here means exactly that: this row
     * came from a crew member typing their own words (or from a phone that
     * seeded before this column existed), and there is no key to look up, so
     * it is never translated -- only shown as written. Set only at seed time
     * from [DefaultJobSteps], never edited afterward, so a foreman's own wording
     * for a shipped step never quietly gets replaced by the canned text.
     */
    val stepKey: String? = null
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
    val reviewNote: String = "",
    /**
     * What the clock actually recorded, before the office corrected it.
     *
     * Written by the server, never by this phone. A correction is an
     * addition rather than a replacement: startedAt and endedAt hold the
     * corrected times that pay is computed from, and these hold what the
     * clock said, so a pay dispute has something to be settled from.
     *
     * Null on every shift nobody has corrected, which is almost all of them.
     */
    val originalStartedAt: Long? = null,
    val originalEndedAt: Long? = null,
    /** When the office changed it, and the reason they gave. */
    val correctedAt: Long? = null,
    val correctionReason: String = "",
    /**
     * The unpaid break the office already subtracts from pay and job cost.
     *
     * Null means nobody has recorded a break on this shift -- not the same
     * claim as a recorded break of zero minutes, which is why this has no
     * default. A default of 0 would make every shift ever worked, including
     * every one already sitting in the database before this column existed,
     * assert that no break was taken; only a crew member actually starting
     * and stopping one may set this.
     *
     * [breakStartedAt] and [breakEndedAt] are the record of when; this is the
     * number the office's timesheet and pay math actually read, computed once
     * from the two clocks when the break ends and never touched again.
     */
    val breakMinutes: Int? = null,
    /** Set when the crew member taps Start Break on a running shift. */
    val breakStartedAt: Long? = null,
    /** Set when the crew member taps End Break; this is what freezes [breakMinutes]. */
    val breakEndedAt: Long? = null,
    /**
     * Set when [com.fenceestimator.app.cloud.EntitySync.pushTimeEntries] learns
     * this shift can never go up as it stands -- "NEEDS_WORKER" (see
     * [com.fenceestimator.app.cloud.needsWorkerAssignment], known without ever
     * asking the server) or "SERVER_REJECTED" (a permanent 4xx the server sent
     * back for some other reason). Null means nothing is wrong; retried every
     * sync like any other row. A row marked here is left OUT of the next push
     * -- retrying a rejection the row itself cannot fix, on every sync, is the
     * trap this column exists to close.
     *
     * But a SERVER_REJECTED mark is not for ever. The phone cannot always tell
     * a refusal of the ROW from a server that was briefly unable to take it
     * (see [com.fenceestimator.app.cloud.isDueForPush]), and a mark nobody but
     * a person could clear once tattooed good shifts as broken. So it expires:
     * after [com.fenceestimator.app.cloud.SERVER_REJECTED_RETRY_AFTER_MS] the
     * row is tried once more, and either goes up (mark cleared) or is refused
     * again (mark re-stamped, and the clock starts over). NEEDS_WORKER does not
     * expire -- it is known locally and clears itself the moment the worker
     * resolves.
     */
    val syncBlockedReason: String? = null,
    /**
     * When the server last refused this row, for a SERVER_REJECTED mark -- the
     * clock [com.fenceestimator.app.cloud.isDueForPush] measures the retry
     * window from, so it is re-stamped each time a retry is refused again. For
     * NEEDS_WORKER, when the mark was first set. Also the Time screen's sort
     * order (newest first).
     */
    val syncBlockedAt: Long? = null,
    /**
     * What the server actually said, in its own words, for the Time screen's
     * Fix flow to show verbatim rather than a re-derived guess.
     */
    val syncBlockedDetail: String? = null,
    /**
     * When a person on THIS phone changed who worked the shift (the Time
     * screen's Fix), and the cloud has not yet confirmed holding that change.
     *
     * The only edit a phone can make to a shift after clocking out, and the
     * only reason a shift the cloud already holds is ever written again by
     * [com.fenceestimator.app.cloud.EntitySync.pushTimeEntries]: a non-null
     * value is what earns the row its one PATCH of employee_sync_id, and the
     * PATCH clears it only if it still holds the same value (a second Fix made
     * while the first was in flight is not lost). Null on every other shift,
     * which is why the push no longer rewrites every shift on every sync.
     */
    val workerChangedAt: Long? = null
) {
    val isRunning: Boolean get() = endedAt == null

    /** True once a permanent rejection has been recorded and not yet cleared. */
    val isSyncBlocked: Boolean get() = syncBlockedReason != null

    /** A break has been started on this shift and not yet ended. */
    val isOnBreak: Boolean get() = breakStartedAt != null && breakEndedAt == null

    /** A break was taken (started and stopped) on this shift, whatever its length. */
    val hasRecordedBreak: Boolean get() = breakMinutes != null

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

/**
 * How many PER_FOOT workers share a job's footage, as last answered by the
 * server's per_foot_crew_count(). Cached so a crew phone out of signal still
 * splits per-foot pay the way it did the last time it could ask.
 *
 * A head count, not money: no rate or amount is ever stored here. Keyed by the
 * job's syncId so it survives a local id change on re-download.
 */
@Entity(tableName = "job_pay_shares")
data class JobPayShare(
    @PrimaryKey val jobSyncId: String,
    val perFootCrewCount: Int,
    val fetchedAt: Long = System.currentTimeMillis()
)
