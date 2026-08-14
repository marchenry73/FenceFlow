package com.fenceestimator.app.data

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Local backup/restore of the app's SQLite database file -- no accounts, no
 * cloud service. "Back up" copies the current data to wherever the user
 * picks via the system file/storage picker (Google Drive, Dropbox, local
 * storage -- whatever they already have); "Restore" copies a previously
 * saved file back in place of the current database.
 */
object BackupManager {
    suspend fun backup(context: Context, repository: Repository, destination: Uri): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            repository.checkpointForBackup()
            val dbFile = context.getDatabasePath(AppDatabase.DB_NAME)
            context.contentResolver.openOutputStream(destination)?.use { output ->
                dbFile.inputStream().use { input -> input.copyTo(output) }
            } ?: throw IllegalStateException("Could not open destination for writing")
            Unit
        }
    }

    /**
     * Replaces the live database file with [source]. The app must be fully
     * restarted afterward (not just navigated) -- the existing in-memory
     * Repository/AppDatabase instances keep pointing at the old, now-closed
     * connection, and Android has no clean API to hot-swap that mid-process.
     */
    suspend fun restore(context: Context, source: Uri): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            AppDatabase.closeForRestore()
            val dbFile = context.getDatabasePath(AppDatabase.DB_NAME)
            dbFile.parentFile?.mkdirs()
            context.contentResolver.openInputStream(source)?.use { input ->
                dbFile.outputStream().use { output -> input.copyTo(output) }
            } ?: throw IllegalStateException("Could not open backup file for reading")

            // Stale WAL/SHM sidecars from the previous database would be inconsistent
            // with the freshly restored main file -- clear them so Room starts clean.
            File(dbFile.path + "-wal").delete()
            File(dbFile.path + "-shm").delete()
            Unit
        }
    }
}
