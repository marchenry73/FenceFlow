package com.fenceestimator.app.cloud

import android.content.Context
import io.github.jan.supabase.postgrest.postgrest
import io.github.jan.supabase.storage.storage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.File

/**
 * THE COMPANY'S LOGO, ON THE PHONE, FOR THE PDF.
 *
 * Every PDF quote and contract this phone makes is headed with the business
 * name, the phone number and the licence number and then carries no mark of
 * whose business it is. This is the logo, so it looks like the company's own
 * paperwork.
 *
 * WHY IT IS A LOCAL FILE AND NOT A URL. PdfExporter runs in the yard, with no
 * signal, on a job the crew opened an hour ago -- a document that needed a
 * network request to be headed correctly would be headed correctly only
 * sometimes, which is worse than never. The bytes are cached on the phone the
 * first time they are seen and the PDF reads the file.
 *
 * WHERE THE PATH COMES FROM. companies.logo_path, read directly, and NOT the
 * company_settings blob the rest of BusinessProfile travels in. Two reasons,
 * both in supabase_r18_company_logo.sql: the blob is hidden from anyone
 * without SEE_MONEY, so a crew phone would never see the logo, and a second
 * store for a brand-new field is how the business name came to disagree with
 * itself for months.
 *
 * NOTHING HERE EVER THROWS AT A CALLER. A logo is decoration on a document
 * whose figures are what matter; a quote that would not open because a picture
 * could not be fetched is a job that stops.
 */
object CompanyLogo {

    const val BUCKET = "company-logos"

    /**
     * One folder, holding at most one file, named exactly as the object is.
     *
     * The object name carries a uuid -- the office uploads a NEW name every
     * time rather than overwriting one -- so "the file is already here" is a
     * safe answer for ever, and a replaced logo is a different name that
     * downloads once. [sync] deletes whatever else is in the folder, which is
     * what makes `the single file in it` a usable way to find it offline with
     * nothing to read the current path from.
     */
    private const val SUBDIR = "company-logo"

    /**
     * Bumped every time the cached file changes -- downloaded, replaced or
     * cleared.
     *
     * WHY A SCREEN CANNOT JUST READ THE FOLDER. [cachedFile] is a directory
     * listing, so a composable has to decide WHEN to look again, and the only
     * honest answer from inside the screen is "whenever something else it
     * happens to be keyed on changes". The app's own header was keyed on the
     * business NAME, which meant a logo uploaded on this phone did not appear
     * up there until something renamed the company or the app was restarted.
     *
     * A counter is the smallest thing that says "look again" truthfully: every
     * writer here bumps it, and a screen keyed on it re-reads exactly when
     * there is something new to read.
     */
    val generation = kotlinx.coroutines.flow.MutableStateFlow(0)

    private fun bump() {
        generation.value = generation.value + 1
    }

    /**
     * The cached logo, or null. Safe to call from the PDF thread: it is a
     * directory listing and nothing more.
     */
    fun cachedFile(context: Context): File? {
        val dir = File(context.filesDir, SUBDIR)
        if (!dir.isDirectory) return null
        return dir.listFiles()?.firstOrNull { it.isFile && it.length() > 0L }
    }

    /**
     * Brings this phone's copy in line with the company's.
     *
     * Downloads the logo if it is not here, and removes the old one when it
     * has been replaced or taken off. Called beside SettingsSync.pull on
     * sign-in and on every session refresh, so a logo uploaded at the office
     * reaches the phones without anyone doing anything.
     *
     * A failure leaves whatever is already cached exactly as it is. That is
     * the deliberate choice over clearing it: a phone that cannot reach the
     * cloud should keep printing the letterhead it had, not fall back to a
     * plain header because the network was down for a minute.
     */
    suspend fun sync(context: Context, companyId: String) = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) return@withContext
        val row = runCatching {
            SupabaseModule.client.postgrest.from("companies")
                .select(io.github.jan.supabase.postgrest.query.Columns.list("logo_path")) {
                    filter { eq("id", companyId) }
                }
                .decodeSingleOrNull<LogoRow>()
        }.getOrElse { e ->
            if (e is CancellationException) throw e
            // Could not ask. Keep what is cached; say nothing.
            return@withContext
        }
        // A read that came back with no row is NOT "the company has no logo":
        // it is a company this phone could not read, and clearing the cache on
        // it would quietly strip the letterhead off every document. Only an
        // answered read with a blank path means the logo was taken off.
        if (row == null) return@withContext

        val path = row.logoPath.trim()
        val dir = File(context.filesDir, SUBDIR)
        val wanted = path.substringAfterLast('/')

        if (path.isEmpty()) {
            // Answered, and the answer is that there is no logo.
            val had = dir.listFiles()?.any { it.isFile } == true
            dir.listFiles()?.forEach { runCatching { it.delete() } }
            if (had) bump()
            return@withContext
        }

        val local = File(dir, wanted)
        if (local.exists() && local.length() > 0L) {
            // Here already. Still prune anything else, so a replaced logo
            // leaves one file behind rather than two and cachedFile() cannot
            // pick the wrong one.
            dir.listFiles()?.forEach { if (it.name != wanted) runCatching { it.delete() } }
            return@withContext
        }

        val bytes = runCatching {
            SupabaseModule.client.storage.from(BUCKET).downloadAuthenticated(path)
        }.getOrElse { e ->
            if (e is CancellationException) throw e
            return@withContext
        }
        if (bytes.isEmpty()) return@withContext

        runCatching {
            dir.mkdirs()
            local.writeBytes(bytes)
        }.onFailure { return@withContext }

        // Only once the new one is written: a prune that ran first would leave
        // the phone with no logo at all if the write then failed.
        dir.listFiles()?.forEach { if (it.name != wanted) runCatching { it.delete() } }
        bump()
        Unit
    }

    /** What [upload] can answer. */
    sealed interface Upload {
        data object Saved : Upload
        /** Not saved, and this is why, as a string resource id. */
        data class Failed(val reasonRes: Int) : Upload
        /** Not saved, and this is the server's own words. */
        data class FailedWith(val why: String) : Upload
    }

    /** 2 MB, matching the bucket's own file_size_limit exactly. */
    const val MAX_BYTES = 2 * 1024 * 1024

    /**
     * The three types the bucket accepts, mapped to the extension the object
     * name gets. Not SVG: an SVG is a document that can carry script, and a
     * signed URL opened directly would run it on the Supabase domain. See
     * supabase_r18_company_logo.sql.
     */
    private val EXTENSIONS = mapOf(
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/webp" to "webp",
    )

    /**
     * Puts a picked image up as this company's logo.
     *
     * THE ORDER IS THE POINT: upload the new object, THEN move
     * companies.logo_path, THEN delete the old object. Any other order has a
     * window in which the column names something that is not there -- and the
     * customer's quote page and every email read that column. If the column
     * write fails, the object just uploaded is removed again and the company
     * is left exactly as it was.
     *
     * A NEW NAME each time, never a fixed logo.png: overwriting one path
     * leaves every browser, inbox and CDN holding the previous image with
     * nothing able to tell them it changed.
     *
     * OWNER ONLY, enforced by policy on both halves (company_logos_insert and
     * companies_update). The caller disables the control for anyone else, but
     * the real answer comes from the server -- and a policy-filtered UPDATE is
     * zero rows with no error, which is why the rows affected are read back.
     */
    suspend fun upload(
        context: Context,
        companyId: String,
        bytes: ByteArray,
        mimeType: String?,
    ): Upload = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) {
            return@withContext Upload.Failed(com.fenceestimator.app.R.string.set_logo_no_cloud)
        }
        val ext = EXTENSIONS[mimeType?.lowercase()?.trim()]
            ?: return@withContext Upload.Failed(com.fenceestimator.app.R.string.set_logo_wrong_type)
        if (bytes.isEmpty()) {
            return@withContext Upload.Failed(com.fenceestimator.app.R.string.set_logo_unreadable)
        }
        if (bytes.size > MAX_BYTES) {
            return@withContext Upload.Failed(com.fenceestimator.app.R.string.set_logo_too_big)
        }

        val previous = runCatching {
            SupabaseModule.client.postgrest.from("companies")
                .select(io.github.jan.supabase.postgrest.query.Columns.list("logo_path")) {
                    filter { eq("id", companyId) }
                }
                .decodeSingleOrNull<LogoRow>()?.logoPath?.trim()
        }.getOrNull().orEmpty()

        val path = "$companyId/logo-${java.util.UUID.randomUUID()}.$ext"
        val put = runCatching {
            SupabaseModule.client.storage.from(BUCKET).upload(path, bytes) { upsert = false }
        }
        if (put.isFailure) {
            val e = put.exceptionOrNull()
            if (e is CancellationException) throw e
            return@withContext Upload.FailedWith(shownError(e, "upload failed"))
        }

        val rows = runCatching {
            SupabaseModule.client.postgrest.from("companies")
                .update({ set("logo_path", path) }) {
                    select(io.github.jan.supabase.postgrest.query.Columns.list("id"))
                    filter { eq("id", companyId) }
                }
                .decodeList<IdRow>()
        }.getOrElse { e ->
            if (e is CancellationException) throw e
            // The column still names the OLD object, which is still there, so
            // nothing the customer sees has changed. Clear up the orphan.
            runCatching { SupabaseModule.client.storage.from(BUCKET).delete(path) }
            return@withContext Upload.FailedWith(shownError(e, "could not save"))
        }
        if (rows.isEmpty()) {
            // Zero rows with no error is what a policy-filtered UPDATE looks
            // like: this account is not the company's OWNER (any more).
            runCatching { SupabaseModule.client.storage.from(BUCKET).delete(path) }
            return@withContext Upload.Failed(com.fenceestimator.app.R.string.set_logo_owner_only)
        }

        // Only now, and a failure here is not worth reporting: the logo is
        // live and correct, and the worst case is one stale file in a bucket
        // only this company can read.
        if (previous.isNotEmpty() && previous != path) {
            runCatching { SupabaseModule.client.storage.from(BUCKET).delete(previous) }
        }
        // Cache it on this phone immediately, rather than waiting for the next
        // session refresh: he has just uploaded it and the next PDF he makes
        // should carry it.
        runCatching { sync(context, companyId) }
        Upload.Saved
    }

    /**
     * Takes the logo off the documents.
     *
     * The column is cleared FIRST and the object deleted after, which is the
     * opposite order to [upload] and right for the same reason: a deleted
     * object with the path still recorded is a broken image on a customer's
     * quote, which is worse than a logo that is gone on purpose.
     */
    suspend fun remove(context: Context, companyId: String): Upload = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) {
            return@withContext Upload.Failed(com.fenceestimator.app.R.string.set_logo_no_cloud)
        }
        val gone = runCatching {
            SupabaseModule.client.postgrest.from("companies")
                .select(io.github.jan.supabase.postgrest.query.Columns.list("logo_path")) {
                    filter { eq("id", companyId) }
                }
                .decodeSingleOrNull<LogoRow>()?.logoPath?.trim()
        }.getOrNull().orEmpty()

        val rows = runCatching {
            SupabaseModule.client.postgrest.from("companies")
                .update({ set("logo_path", "") }) {
                    select(io.github.jan.supabase.postgrest.query.Columns.list("id"))
                    filter { eq("id", companyId) }
                }
                .decodeList<IdRow>()
        }.getOrElse { e ->
            if (e is CancellationException) throw e
            return@withContext Upload.FailedWith(shownError(e, "could not save"))
        }
        if (rows.isEmpty()) {
            return@withContext Upload.Failed(com.fenceestimator.app.R.string.set_logo_owner_only)
        }
        if (gone.isNotEmpty()) {
            runCatching { SupabaseModule.client.storage.from(BUCKET).delete(gone) }
        }
        clearCache(context)
        Upload.Saved
    }

    /**
     * Forgets the cached logo. Called when this phone stops belonging to the
     * company -- signing out, or being wiped for a different account -- for
     * the same reason every other cached company file is cleared: the next
     * person to use this phone is not necessarily the same company.
     */
    fun clearCache(context: Context) {
        val dir = File(context.filesDir, SUBDIR)
        val had = dir.listFiles()?.any { it.isFile } == true
        dir.listFiles()?.forEach { runCatching { it.delete() } }
        if (had) bump()
    }

    @Serializable
    private data class LogoRow(
        @SerialName("logo_path") val logoPath: String = ""
    )

    /** Rows an UPDATE actually changed -- see [upload] for why that is read. */
    @Serializable
    private data class IdRow(val id: String = "")
}
