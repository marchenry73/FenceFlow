package com.fenceestimator.app.cloud

import android.content.Context
import io.github.jan.supabase.storage.storage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Puts the files that matter into the cloud, not just the rows.
 *
 * Signatures, survey images and job photos were only ever on the phone that
 * created them. Change phones and a signed change order kept its date and its
 * amount but lost the signature -- exactly the part you would need in a
 * dispute. Same for the before-and-after photos and the survey the fence line
 * was traced on.
 *
 * Files are stored under {company}/{job}/{kind}/{name}, so the storage policy
 * can scope access by company the same way the database does.
 */
object FileSync {

    const val BUCKET = "job-files"

    /**
     * Uploads a local file and returns its storage path, or null if it can't.
     *
     * Never throws. A failed upload must not stop someone capturing a signature
     * or finishing a job -- the file stays on the phone and the next sync tries
     * again, which is the same promise the rest of the app makes offline.
     */
    suspend fun upload(
        companyId: String,
        jobSyncId: String,
        kind: String,
        localPath: String
    ): String? = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) return@withContext null
        val file = File(localPath)
        if (!file.exists() || file.length() == 0L) return@withContext null

        val remotePath = "$companyId/$jobSyncId/$kind/${file.name}"
        val writeOnce = kind in WRITE_ONCE_KINDS
        runCatching {
            SupabaseModule.client.storage.from(BUCKET)
                // Asking for an upsert makes Storage check UPDATE permission
                // BEFORE it writes anything. Signed-contract images are
                // write-once on the server (job_files_signatures_are_write_once),
                // so asking to overwrite one is refused even when the object
                // does not exist yet -- which silently stopped every signature
                // and final sign-off from ever uploading, on an OWNER's phone
                // as much as a crew member's. These two kinds are never
                // legitimately overwritten, so they are uploaded as a plain
                // create.
                .upload(remotePath, file.readBytes()) { upsert = !writeOnce }
            remotePath
        }.recoverCatching { e ->
            // A write-once file whose object is already there IS uploaded --
            // an earlier attempt got the bytes up and only the local
            // bookkeeping was lost. Reporting that as a failure is what leaves
            // a file "unsynced" for ever and blocks sign-out.
            if (writeOnce && looksLikeAlreadyThere(e)) remotePath else throw e
        }.getOrNull()
    }

    /**
     * Kinds the server treats as write-once: the customer's signature on the
     * quote and the final sign-off. Nothing in the product ever replaces one.
     */
    private val WRITE_ONCE_KINDS = setOf("signature", "final-sign-off")

    private fun looksLikeAlreadyThere(e: Throwable): Boolean {
        val text = generateSequence(e) { it.cause }
            .mapNotNull { it.message }
            .joinToString(" ")
            .lowercase()
        return "duplicate" in text || "already exists" in text || "resource_already_exists" in text ||
            "409" in text
    }

    /**
     * Downloads a stored file if this phone hasn't got it, and returns the
     * local path. Returns null rather than throwing when offline, so a missing
     * image degrades to "not shown yet" instead of a crash.
     */
    suspend fun ensureLocal(
        context: Context,
        remotePath: String,
        subdir: String
    ): String? = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) return@withContext null

        val dir = File(context.filesDir, subdir).apply { mkdirs() }
        val local = File(dir, remotePath.substringAfterLast('/'))
        // Already here. Files are content, not records -- once downloaded they
        // do not change, so re-fetching would only cost data on a phone plan.
        if (local.exists() && local.length() > 0L) return@withContext local.absolutePath

        runCatching {
            val bytes = SupabaseModule.client.storage.from(BUCKET).downloadAuthenticated(remotePath)
            local.writeBytes(bytes)
            local.absolutePath
        }.getOrNull()
    }

    /** Removes a stored file, used when its record is deleted. */
    suspend fun remove(remotePath: String) = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) return@withContext
        runCatching { SupabaseModule.client.storage.from(BUCKET).delete(remotePath) }
        Unit
    }
}
