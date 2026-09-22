package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.RestException
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.postgrest.query.Order
import io.github.jan.supabase.postgrest.query.filter.FilterOperator
import io.github.jan.supabase.postgrest.query.filter.PostgrestFilterBuilder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add

/**
 * Which jobs this signed-in person may see, as the server answers it
 * (`my_job_scope()`, supabase_crew_job_scope.sql).
 *
 * Four states, for the same reason [MoneyScope] has three: a question that
 * could not be asked is not an answer, and nothing may be decided on it --
 * least of all hiding a crew member's jobs. And "the server does not have
 * this yet" is its own answer, not a failure: until that SQL is applied
 * everyone sees every job, exactly as before, and the phone must behave as
 * it always has.
 */
sealed class JobScope {
    /** Could not ask this time -- no signal, no session, no company. Nothing changes on it. */
    object Unknown : JobScope()

    /**
     * The server has no crew scope yet (`my_job_scope` does not exist). Every
     * job is visible to everyone, as it was; the request screens have
     * nothing to talk to.
     */
    object NotDeployed : JobScope()

    /**
     * Sees every job: SEE_MONEY, EDIT_JOBS or SCHEDULE_AND_ASSIGN -- a
     * capability test, never a role name, so a per-person override moves
     * someone either way (see sees_all_jobs()).
     */
    object SeesAll : JobScope()

    /**
     * Sees only the jobs they are on: the lead, extra crew, or let in.
     *
     * @param linked false when this login is not linked to any crew record,
     *   so the server correctly shows it nothing. Say "Your login is not
     *   linked to a crew member yet -- ask the office", never "no jobs", and
     *   never anything that reads as a sync failure.
     * @param visible how many live jobs the server says this person is on.
     * @param pendingRequests their own access requests still waiting.
     */
    data class Scoped(val linked: Boolean, val visible: Int, val pendingRequests: Int) : JobScope()

    /** Every job is on the table -- by capability, or because the server has no scope yet. */
    val seesEverything: Boolean get() = this === SeesAll || this === NotDeployed

    /** The server has the crew-scope tables and RPCs, so the request screens can work. */
    val isDeployed: Boolean get() = this === SeesAll || this is Scoped
}

/**
 * Why the server would not do what was asked. The access RPCs answer in
 * SQLSTATEs (see PART 3 of supabase_crew_job_scope.sql) so each screen can
 * say its own translated sentence rather than the server's English.
 */
enum class AccessRefusal {
    /** 42501: not allowed -- no permission, company suspended, or deciding your own request. */
    NOT_ALLOWED,

    /** 23514: this login is not linked to a crew member yet. Only the office can fix it. */
    NOT_LINKED,

    /** 22023: nothing to ask for -- you already see every job, or already have this one. */
    NOTHING_TO_ASK,

    /** 23503: no such job or request in this company (a job that is not won work answers the same). */
    NOT_FOUND,

    /** 54000: 20 requests already waiting, or 10 asked in the last hour. */
    LIMIT_REACHED,

    /** Not signed in, or the sign-in has expired. Signing in again fixes it; waiting does not. */
    SIGNED_OUT,

    /** The server has no crew scope yet (the RPC or table is missing). Hide the feature, say nothing. */
    NOT_AVAILABLE,

    /** Could not reach the server. "Needs a connection." */
    NO_CONNECTION,

    /** Anything else. The work, if any, is still on the phone. */
    FAILED
}

/** What an access call came back with: the answer, or why not. */
sealed class AccessResult<out T> {
    data class Ok<out T>(val value: T) : AccessResult<T>()

    /**
     * @param serverMessage the server's own sentence, for the log -- never
     *   for the screen, which says its own words for [reason].
     */
    data class Refused(val reason: AccessRefusal, val serverMessage: String? = null) : AccessResult<Nothing>()

    fun getOrNull(): T? = (this as? Ok<T>)?.value
}

enum class AccessRequestStatus { PENDING, APPROVED, DENIED, WITHDRAWN }

/** An extra person on a job (kind CREW, put there by the office) or an approved ask (kind ACCESS). */
enum class AssignmentKind { CREW, ACCESS }

/** A row of `job_access_requests` the caller may read: their own, or every one for someone who answers them. */
data class JobAccessRequest(
    val id: String,
    val jobSyncId: String,
    /** Profile id of whoever asked. */
    val requestedBy: String?,
    /** The crew record the ask was made as -- match it to Employee.syncId for a name. */
    val employeeSyncId: String,
    val reason: String,
    val status: AccessRequestStatus,
    val createdAt: Long?,
    val decidedBy: String?,
    val decidedAt: Long?,
    val decisionNote: String
)

/** A row of `job_assignments`. Never deleted: an ended one carries [endedAt]. */
data class JobAssignment(
    val id: String,
    val jobSyncId: String,
    val employeeSyncId: String,
    val kind: AssignmentKind,
    val assignedBy: String?,
    val assignedAt: Long?,
    val endedAt: Long?
)

/**
 * Won work a scoped crew member is not on and may ask for. A name and a
 * place, enough to know which job it is -- no money, no phone, no email.
 */
data class RequestableJob(
    val jobSyncId: String,
    val customerName: String,
    val address: String,
    val scheduledDate: Long?,
    /** ACCEPTED or COMPLETED. */
    val status: String,
    val productionStage: String?,
    /** The latest thing this person asked about this job, as the list itself reports it. */
    val myRequestStatus: AccessRequestStatus?,
    val myRequestAt: Long?,
    /**
     * That latest request in full -- its id (to withdraw it) and the office's
     * note (to show beside "Declined"). Null when there is none, or when the
     * requests table could not be read this time.
     */
    val myRequest: JobAccessRequest?
)

/**
 * The phone's side of "crew see the jobs they are on, and ask for the rest"
 * (supabase_crew_job_scope.sql): the scope question the sync asks every
 * pass, and a typed wrapper for every access RPC and for the two tables the
 * caller may read.
 *
 * Nothing here writes a table directly -- the server gives clients no write
 * privilege on either; every change is a permission-checked RPC. And nothing
 * here throws: every call answers [AccessResult], with a missing RPC or table
 * reported as [AccessRefusal.NOT_AVAILABLE] so a screen can simply hide
 * itself on a database the change has not reached.
 */
object JobAccess {

    /** The longest reason the server keeps (job_access_requests.reason, char_length <= 500). */
    const val MAX_REASON_LENGTH = 500

    /** The longest decision note the server keeps (decision_note, char_length <= 500). */
    const val MAX_NOTE_LENGTH = 500

    /** How many ids deleted_job_sync_ids() reads a call; it ignores any past 500. */
    const val MAX_IDS_PER_ASK = 500

    private val _scope = MutableStateFlow<JobScope>(JobScope.Unknown)

    /**
     * The last definite answer to [askJobScope] for the signed-in person,
     * refreshed by every sync pass. A failed question keeps the previous
     * answer on screen rather than flickering to [JobScope.Unknown] in a dead
     * spot; a different person signing in starts again from Unknown.
     */
    val scope: StateFlow<JobScope> = _scope

    /** Whose answer [scope] holds, so one person's scope never outlives their sign-in. */
    private var scopeOwner: String? = null

    private val _changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /**
     * Fires when someone's assignments or requests changed -- the change feed
     * on job_assignments / job_access_requests, or a write made here. A
     * screen listing requests or crew re-reads on it; the sync is triggered
     * separately (RealtimeWatcher).
     */
    val changes: SharedFlow<Unit> = _changes

    /** Called by the change feed. The payload is not trusted; this only says "look again". */
    fun noteRemoteChange() {
        _changes.tryEmit(Unit)
    }

    /** Forgets the remembered scope -- the person signed out. */
    @Synchronized
    fun forget() {
        _scope.value = JobScope.Unknown
        scopeOwner = null
    }

    @Synchronized
    private fun publish(uid: String?, answer: JobScope) {
        if (answer !== JobScope.Unknown || uid != scopeOwner) {
            _scope.value = answer
            scopeOwner = uid
        }
    }

    /**
     * Asks `my_job_scope()`, once. A thrown call is [JobScope.Unknown], unless
     * the function simply does not exist yet, which is
     * [JobScope.NotDeployed] -- see [foldJobScopeAnswer]. The answer is also
     * published on [scope].
     */
    suspend fun askJobScope(): JobScope {
        if (!SupabaseModule.isConfigured) return JobScope.Unknown
        val uid = runCatching { SupabaseModule.currentUserId() }.getOrNull()
        val answer = withContext(Dispatchers.IO) {
            foldJobScopeAnswer(
                try {
                    Result.success(SupabaseModule.client.postgrest.rpc("my_job_scope").decodeAs<JsonElement>())
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Result.failure(e)
                }
            )
        }
        publish(uid, answer)
        return answer
    }

    /** [askJobScope], for a screen coming back into view. */
    suspend fun refreshScope(): JobScope = askJobScope()

    /**
     * Won work this scoped person is not on, with their latest ask about each
     * (`list_requestable_jobs()`, then their own requests for the ids and
     * notes the list does not carry). Empty for anyone who sees every job.
     */
    suspend fun listRequestableJobs(companyId: String): AccessResult<List<RequestableJob>> {
        val listed = call {
            val page = 1000L
            val all = ArrayList<CloudRequestableJob>()
            var from = 0L
            while (true) {
                val batch = SupabaseModule.client.postgrest.rpc("list_requestable_jobs") {
                    range(from, from + page - 1)
                }.decodeList<CloudRequestableJob>()
                all += batch
                if (batch.size < page) break
                from += page
                if (all.size >= page * 20) break
            }
            all.distinctBy { it.jobSyncId }
        }
        val rows = when (listed) {
            is AccessResult.Ok -> listed.value
            is AccessResult.Refused -> return listed
        }
        // Best effort: without it the list still shows each status, only
        // not the request id (so no Withdraw) or the office's note.
        val latestMine = readRequests(companyId, mineOnly = true).getOrNull()
            .orEmpty()
            .groupBy { it.jobSyncId }
            .mapValues { (_, asks) -> asks.maxByOrNull { it.createdAt ?: 0L } }
        return AccessResult.Ok(rows.map { it.toRequestable(latestMine[it.jobSyncId]) })
    }

    /**
     * Asks for access to one job. Answers the request id -- the same one on a
     * double tap, never a second request. [reason] is optional, trimmed, and
     * cut to [MAX_REASON_LENGTH].
     */
    suspend fun requestAccess(jobSyncId: String, reason: String = ""): AccessResult<String> =
        call {
            SupabaseModule.client.postgrest.rpc(
                "request_job_access",
                buildJsonObject {
                    put("p_job_sync_id", jobSyncId)
                    put("p_reason", reason.trim().take(MAX_REASON_LENGTH))
                }
            ).decodeAs<String>()
        }.also { if (it is AccessResult.Ok) afterWrite(refreshScope = true) }

    /** Withdraws one of this person's own waiting requests. False: it was no longer waiting. */
    suspend fun withdrawRequest(requestId: String): AccessResult<Boolean> =
        call {
            SupabaseModule.client.postgrest.rpc(
                "withdraw_job_access_request",
                buildJsonObject { put("p_request_id", requestId) }
            ).decodeAs<Boolean>()
        }.also { if (it is AccessResult.Ok) afterWrite(refreshScope = true) }

    /**
     * Approves or declines a request. Needs SCHEDULE_AND_ASSIGN, and never
     * your own request. False: it had already been answered. Approving puts
     * the person on the job (a job_assignments row of kind ACCESS), and their
     * phone hears it through the change feed.
     */
    suspend fun decideRequest(requestId: String, approve: Boolean, note: String = ""): AccessResult<Boolean> =
        call {
            SupabaseModule.client.postgrest.rpc(
                "decide_job_access",
                buildJsonObject {
                    put("p_request_id", requestId)
                    put("p_approve", approve)
                    put("p_note", note.trim().take(MAX_NOTE_LENGTH))
                }
            ).decodeAs<Boolean>()
        }.also { if (it is AccessResult.Ok) afterWrite(refreshScope = false) }

    /**
     * Sets the full list of extra crew on a job ("Also on this job"). People
     * left off are ended (their rows stay), people added get a new row; the
     * lead is still the job's own assignee, saved the way it always was.
     * Needs SCHEDULE_AND_ASSIGN. Answers how many were newly added.
     *
     * The list REPLACES what is there, so read [readAssignments] first and
     * send the whole intended set, not just the one being added.
     */
    suspend fun setJobCrew(jobSyncId: String, employeeSyncIds: Collection<String>): AccessResult<Int> =
        call {
            SupabaseModule.client.postgrest.rpc(
                "set_job_crew",
                buildJsonObject {
                    put("p_job_sync_id", jobSyncId)
                    putJsonArray("p_employee_sync_ids") { employeeSyncIds.distinct().forEach { add(it) } }
                }
            ).decodeAs<Int>()
        }.also { if (it is AccessResult.Ok) afterWrite(refreshScope = false) }

    /** Takes someone off a job -- extra crew or granted access. The row stays. False: already ended. */
    suspend fun endAssignment(assignmentId: String): AccessResult<Boolean> =
        call {
            SupabaseModule.client.postgrest.rpc(
                "end_job_assignment",
                buildJsonObject { put("p_assignment_id", assignmentId) }
            ).decodeAs<Boolean>()
        }.also { if (it is AccessResult.Ok) afterWrite(refreshScope = false) }

    /**
     * The access requests this person may read -- their own, or every one in
     * the company for someone holding SCHEDULE_AND_ASSIGN -- newest first.
     *
     * @param jobSyncId only this job's.
     * @param status only this status (PENDING for "N crew asked for access").
     * @param mineOnly only this person's own, even for someone who sees all.
     */
    suspend fun readRequests(
        companyId: String,
        jobSyncId: String? = null,
        status: AccessRequestStatus? = null,
        mineOnly: Boolean = false
    ): AccessResult<List<JobAccessRequest>> {
        val uid = if (mineOnly) runCatching { SupabaseModule.currentUserId() }.getOrNull()
            ?: return AccessResult.Refused(AccessRefusal.SIGNED_OUT) else null
        return call {
            pagedById<CloudAccessRequest>("job_access_requests") {
                eq("company_id", companyId)
                jobSyncId?.let { eq("job_sync_id", it) }
                status?.let { eq("status", it.name) }
                uid?.let { eq("requested_by", it) }
            }.mapNotNull { it.toDomain() }.sortedByDescending { it.createdAt ?: 0L }
        }
    }

    /**
     * The assignment rows this person may read -- their own, or every one for
     * someone who sees every job -- open ones only unless [includeEnded].
     */
    suspend fun readAssignments(
        companyId: String,
        jobSyncId: String? = null,
        includeEnded: Boolean = false
    ): AccessResult<List<JobAssignment>> = call {
        pagedById<CloudJobAssignment>("job_assignments") {
            eq("company_id", companyId)
            jobSyncId?.let { eq("job_sync_id", it) }
            if (!includeEnded) filter("ended_at", FilterOperator.IS, "null")
        }.mapNotNull { it.toDomain() }.sortedByDescending { it.assignedAt ?: 0L }
    }

    /**
     * Which of [jobSyncIds] -- jobs this phone keeps after its person was
     * taken off them -- the office has since deleted
     * (`deleted_job_sync_ids()`). The crew door sends a tombstone only for a
     * job its caller can still see, so a kept job deleted later never reached
     * the ordinary delete path and stayed under "Kept on this phone" for good.
     *
     * Null when the question could not be asked or answered -- no signal, or
     * a server without the function -- and nothing may be forgotten on that:
     * a failed question is not "none of them were deleted" and not "all of
     * them were" either.
     */
    suspend fun deletedAmong(jobSyncIds: Collection<String>): Set<String>? {
        val ids = jobSyncIds.filter { it.isNotBlank() }.distinct()
        if (ids.isEmpty()) return emptySet()
        return call {
            ids.chunked(MAX_IDS_PER_ASK).flatMapTo(HashSet()) { chunk ->
                parseSyncIdSet(
                    SupabaseModule.client.postgrest.rpc(
                        "deleted_job_sync_ids",
                        buildJsonObject { putJsonArray("p_job_sync_ids") { chunk.forEach { add(it) } } }
                    ).decodeAs<JsonElement>()
                ) ?: throw IllegalStateException("deleted_job_sync_ids answered a shape this build cannot read")
            }
        }.getOrNull()
    }

    /** After a write the server took: screens re-read, and the pending count on [scope] moves. */
    private suspend fun afterWrite(refreshScope: Boolean) {
        _changes.tryEmit(Unit)
        if (refreshScope) runCatching { askJobScope() }
    }

    /** Runs one call off the main thread and folds any failure into a typed refusal. */
    private suspend fun <T> call(block: suspend () -> T): AccessResult<T> {
        if (!SupabaseModule.isConfigured) return AccessResult.Refused(AccessRefusal.NOT_AVAILABLE)
        return withContext(Dispatchers.IO) {
            try {
                AccessResult.Ok(block())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val reason = classifyAccessFailure(e)
                android.util.Log.i("JobAccess", "refused: $reason (${serverSentence(e)})")
                AccessResult.Refused(reason, serverSentence(e))
            }
        }
    }

    /**
     * A whole table a page at a time, ordered by id -- neither table has the
     * sync_id that pagedList orders by. PostgREST answers at most 1000 rows
     * and does not say it stopped (see pagedList).
     */
    private suspend inline fun <reified T : Any> pagedById(
        table: String,
        crossinline filters: PostgrestFilterBuilder.() -> Unit
    ): List<T> {
        val page = 1000
        val all = ArrayList<T>()
        var from = 0L
        while (true) {
            val batch = SupabaseModule.client.postgrest.from(table)
                .select {
                    filter { filters() }
                    order("id", Order.ASCENDING)
                    range(from, from + page - 1)
                }
                .decodeList<T>()
            all += batch
            if (batch.size < page) break
            from += page
            if (all.size >= page * 20) break
        }
        return all
    }
}

/* ---------------- wire shapes ---------------- */

@Serializable
internal data class CloudRequestableJob(
    @SerialName("job_sync_id") val jobSyncId: String,
    @SerialName("customer_name") val customerName: String? = null,
    val address: String? = null,
    @SerialName("scheduled_date") val scheduledDate: String? = null,
    val status: String? = null,
    @SerialName("production_stage") val productionStage: String? = null,
    @SerialName("my_request_status") val myRequestStatus: String? = null,
    @SerialName("my_request_at") val myRequestAt: String? = null
) {
    fun toRequestable(latest: JobAccessRequest?) = RequestableJob(
        jobSyncId = jobSyncId,
        customerName = customerName.orEmpty(),
        address = address.orEmpty(),
        scheduledDate = CloudTime.parseMillis(scheduledDate),
        status = status.orEmpty(),
        productionStage = productionStage,
        myRequestStatus = requestStatusOf(myRequestStatus) ?: latest?.status,
        myRequestAt = CloudTime.parseMillis(myRequestAt) ?: latest?.let { it.decidedAt ?: it.createdAt },
        myRequest = latest
    )
}

@Serializable
internal data class CloudAccessRequest(
    val id: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    @SerialName("requested_by") val requestedBy: String? = null,
    @SerialName("employee_sync_id") val employeeSyncId: String? = null,
    val reason: String? = null,
    val status: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("decided_by") val decidedBy: String? = null,
    @SerialName("decided_at") val decidedAt: String? = null,
    @SerialName("decision_note") val decisionNote: String? = null
) {
    /** Null for a status this build does not know -- skipped rather than guessed at. */
    fun toDomain(): JobAccessRequest? {
        val known = requestStatusOf(status) ?: return null
        return JobAccessRequest(
            id = id,
            jobSyncId = jobSyncId,
            requestedBy = requestedBy,
            employeeSyncId = employeeSyncId.orEmpty(),
            reason = reason.orEmpty(),
            status = known,
            createdAt = CloudTime.parseMillis(createdAt),
            decidedBy = decidedBy,
            decidedAt = CloudTime.parseMillis(decidedAt),
            decisionNote = decisionNote.orEmpty()
        )
    }
}

@Serializable
internal data class CloudJobAssignment(
    val id: String,
    @SerialName("job_sync_id") val jobSyncId: String,
    @SerialName("employee_sync_id") val employeeSyncId: String,
    val kind: String? = null,
    @SerialName("assigned_by") val assignedBy: String? = null,
    @SerialName("assigned_at") val assignedAt: String? = null,
    @SerialName("ended_at") val endedAt: String? = null
) {
    /** Null for a kind this build does not know -- skipped rather than guessed at. */
    fun toDomain(): JobAssignment? {
        val known = runCatching { AssignmentKind.valueOf(kind.orEmpty()) }.getOrNull() ?: return null
        return JobAssignment(
            id = id,
            jobSyncId = jobSyncId,
            employeeSyncId = employeeSyncId,
            kind = known,
            assignedBy = assignedBy,
            assignedAt = CloudTime.parseMillis(assignedAt),
            endedAt = CloudTime.parseMillis(endedAt)
        )
    }
}

private fun requestStatusOf(raw: String?): AccessRequestStatus? =
    raw?.let { runCatching { AccessRequestStatus.valueOf(it) }.getOrNull() }

/* ---------------- the pure rules, held to tests ---------------- */

/**
 * `my_job_scope()`'s answer, or the failure to get one, as a [JobScope].
 *
 * The same rule as [foldPayAnswer]: a real answer is trusted as given, and a
 * thrown call is [JobScope.Unknown] -- never "sees everything", which would
 * un-hide nothing harmful but would also tell the screens the feature is
 * off, and never "scoped", which would hide a crew member's work over a dead
 * spot. The one failure that IS an answer is the function not existing: the
 * server has no crew scope yet, so everyone sees everything, as before.
 *
 * A null answer (the function returns null when the caller has no company)
 * and a shape this build cannot read are Unknown too.
 */
internal fun foldJobScopeAnswer(result: Result<JsonElement>): JobScope = result.fold(
    onSuccess = { parseJobScope(it) },
    onFailure = { e -> if (isNotDeployedYet(e)) JobScope.NotDeployed else JobScope.Unknown }
)

internal fun parseJobScope(answer: JsonElement): JobScope {
    val o = answer as? JsonObject ?: return JobScope.Unknown
    val seesAll = (o["sees_all"] as? JsonPrimitive)?.booleanOrNull ?: return JobScope.Unknown
    if (seesAll) return JobScope.SeesAll
    // All three or nothing: `visible` is what stops a crew phone hiding every
    // job over a crew door that answered empty for another reason (see
    // planJobHolds), so a missing one is not quietly read as zero.
    val linked = (o["linked"] as? JsonPrimitive)?.booleanOrNull ?: return JobScope.Unknown
    val visible = (o["visible"] as? JsonPrimitive)?.intOrNull ?: return JobScope.Unknown
    val pending = (o["pending_requests"] as? JsonPrimitive)?.intOrNull ?: return JobScope.Unknown
    return JobScope.Scoped(linked = linked, visible = visible, pendingRequests = pending)
}

/**
 * The ids a `returns setof uuid` RPC answered, or null for a shape this build
 * cannot read. PostgREST answers a set of scalars as a bare JSON array of
 * them; an array of one-key objects (the column named after the function) is
 * taken too, so a server that ever answers that way is read rather than
 * mistaken for "nothing". Anything else is null -- never an empty set, which
 * would read as a real "none".
 */
internal fun parseSyncIdSet(answer: JsonElement): Set<String>? {
    val rows = answer as? JsonArray ?: return null
    val out = HashSet<String>()
    for (row in rows) {
        val value = when (row) {
            is JsonPrimitive -> row
            is JsonObject -> row.values.singleOrNull() as? JsonPrimitive
            else -> null
        } ?: return null
        if (!value.isString) return null
        value.content.takeIf { it.isNotBlank() }?.let { out += it }
    }
    return out
}

/**
 * Whether [error] is the server not having the crew-scope change at all: an
 * RPC or table PostgREST cannot find. Measured against production before the
 * SQL was applied (2026-09-22): `rpc/my_job_scope` answers HTTP 404, code
 * PGRST202, "Could not find the function public.my_job_scope without
 * parameters in the schema cache"; a missing table answers 404, PGRST205,
 * "Could not find the table 'public.job_assignments' in the schema cache".
 * postgrest-kt keeps the status and the sentence but drops the code, so both
 * of those are what is tested; the older Postgres wording (42P01, "relation
 * ... does not exist") is taken too.
 */
internal fun isNotDeployedYet(error: Throwable): Boolean {
    val chain = generateSequence(error) { it.cause }.toList()
    if (chain.any { (it as? RestException)?.statusCode == 404 }) return true
    val text = chain.mapNotNull { serverText(it) }.joinToString(" ").lowercase()
    return "could not find the function" in text ||
        "could not find the table" in text ||
        ("relation" in text && "does not exist" in text)
}

/**
 * The server's sentences, lower-cased, that decide each [AccessRefusal],
 * copied from the `raise exception` lines in PART 3 of
 * supabase_crew_job_scope.sql. postgrest-kt 3.0.2 keeps the sentence and the
 * HTTP status but not the SQLSTATE, so the sentence is the precise signal
 * and the status the fallback. JobAccessRefusalTest reads the SQL file and
 * fails if any of these stops appearing under its SQLSTATE, or if an RPC
 * gains a refusal these do not recognise -- change the two together.
 *
 * Order matters: "You already have 20 requests waiting" is a limit, not
 * "already have this job".
 */
internal val ACCESS_REFUSAL_PHRASES: List<Pair<String, AccessRefusal>> = listOf(
    "not linked to a crew member" to AccessRefusal.NOT_LINKED,
    "requests waiting" to AccessRefusal.LIMIT_REACHED,
    "in the last hour" to AccessRefusal.LIMIT_REACHED,
    "already see every job" to AccessRefusal.NOTHING_TO_ASK,
    "already have this job" to AccessRefusal.NOTHING_TO_ASK,
    "is not on this company" to AccessRefusal.NOT_FOUND,
    "request not found" to AccessRefusal.NOT_FOUND,
    "sign in first" to AccessRefusal.SIGNED_OUT,
    "company suspended" to AccessRefusal.NOT_ALLOWED,
    "cannot request jobs" to AccessRefusal.NOT_ALLOWED,
    "needs schedule_and_assign" to AccessRefusal.NOT_ALLOWED,
    "cannot decide your own request" to AccessRefusal.NOT_ALLOWED
)

/**
 * The HTTP status PostgREST gives each SQLSTATE the access RPCs raise, for a
 * refusal whose sentence is not one of [ACCESS_REFUSAL_PHRASES]: 42501 is 403
 * (401 when the caller is anonymous), 23503 is 409, class 54 is 413. 22023
 * and 23514 are both a plain 400 and cannot be told apart by status, which
 * is why the sentences come first.
 */
private val ACCESS_REFUSAL_BY_STATUS: Map<Int, AccessRefusal> = mapOf(
    401 to AccessRefusal.SIGNED_OUT,
    403 to AccessRefusal.NOT_ALLOWED,
    404 to AccessRefusal.NOT_AVAILABLE,
    409 to AccessRefusal.NOT_FOUND,
    413 to AccessRefusal.LIMIT_REACHED
)

/** Why an access call failed, from what postgrest-kt hands back. */
internal fun classifyAccessFailure(error: Throwable): AccessRefusal {
    if (isNotDeployedYet(error)) return AccessRefusal.NOT_AVAILABLE
    val chain = generateSequence(error) { it.cause }.toList()
    val text = chain.mapNotNull { serverText(it) }.joinToString(" ").lowercase()
    ACCESS_REFUSAL_PHRASES.firstOrNull { (phrase, _) -> phrase in text }?.let { return it.second }
    chain.firstNotNullOfOrNull { (it as? RestException)?.statusCode?.let(ACCESS_REFUSAL_BY_STATUS::get) }
        ?.let { return it }
    if (chain.any { it is RestException }) return AccessRefusal.FAILED
    return if (looksLikeNoConnection(chain)) AccessRefusal.NO_CONNECTION else AccessRefusal.FAILED
}

/**
 * What the server said, without the URL and headers postgrest-kt appends to
 * a RestException's message -- the URL of every access call names the RPC,
 * and a phrase test must never match on the request instead of the answer.
 */
private fun serverText(error: Throwable): String? =
    if (error is RestException) listOfNotNull(error.error, error.description).joinToString(" ")
    else error.message

internal fun serverSentence(error: Throwable): String? =
    generateSequence(error) { it.cause }.firstNotNullOfOrNull { (it as? RestException)?.error }
        ?: error.message

/** The same test AutoSync uses for "no signal", on the exception chain alone. */
private fun looksLikeNoConnection(chain: List<Throwable>): Boolean {
    val text = chain.joinToString(" ") { "${it::class.simpleName} ${it.message}" }.lowercase()
    return listOf(
        "unable to resolve host", "failed to connect", "timeout", "timed out",
        "no address associated", "network is unreachable", "unknownhost",
        "connectexception", "sockettimeout", "connect timeout", "software caused connection abort"
    ).any { it in text }
}
