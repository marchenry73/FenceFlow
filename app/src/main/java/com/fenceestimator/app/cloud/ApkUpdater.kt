package com.fenceestimator.app.cloud

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads an update and hands it to Android to install.
 *
 * The prompt used to send people to a Google Drive page in a browser, where
 * they had to find the file, download it, find it again in notifications, and
 * open it. Four steps, each of which somebody gives up at -- which matters
 * most for the update that fixes something about their money.
 *
 * This is the whole way Android allows: download, then the system's own
 * "install an update to this app?" dialog. **A silent self-update is not
 * possible** for an ordinary app, and should not be -- an app that can replace
 * itself without being asked is an app that can be replaced by anything that
 * gets control of it. The system dialog is the user's protection, not an
 * obstacle to route around.
 */
object ApkUpdater {

    sealed interface Progress {
        data class Downloading(val percent: Int) : Progress
        data object Installing : Progress
        data class Failed(val reason: String) : Progress
    }

    /**
     * Turns a Google Drive share link into one that returns the file itself.
     *
     * A share link -- .../file/d/ID/view -- serves an HTML preview page, not
     * the APK. Downloading it verbatim produces a 90KB file that is a web page
     * and fails to install with an error naming nothing useful.
     *
     * Any other host is returned unchanged: this is a fix for one specific and
     * very common way of sharing a build, not a general rewriter.
     */
    fun directDownloadUrl(url: String): String {
        val id = Regex("drive\\.google\\.com/file/d/([A-Za-z0-9_-]+)").find(url)?.groupValues?.get(1)
            ?: Regex("drive\\.google\\.com/open\\?id=([A-Za-z0-9_-]+)").find(url)?.groupValues?.get(1)
        return if (id != null) "https://drive.google.com/uc?export=download&id=$id" else url
    }

    /**
     * @return the downloaded file, or null with [onProgress] told why.
     *
     * Verifies the result is really an APK before returning it. Drive answers
     * an unexpected request with an HTML page rather than an error, so without
     * this check the failure surfaces as Android refusing to install a file it
     * will not explain -- and the person is left believing the update is
     * broken rather than the link.
     */
    suspend fun download(
        context: Context,
        url: String,
        onProgress: (Progress) -> Unit
    ): File? = withContext(Dispatchers.IO) {
        val target = File(context.cacheDir, "updates").apply { mkdirs() }
            .resolve("fenceflow-update.apk")

        runCatching {
            val connection = (URL(directDownloadUrl(url)).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = true
                connectTimeout = 20_000
                readTimeout = 60_000
            }
            connection.connect()

            if (connection.responseCode !in 200..299) {
                onProgress(Progress.Failed("The download link returned an error (${connection.responseCode})."))
                return@withContext null
            }

            val total = connection.contentLength.toLong()
            target.outputStream().use { out ->
                connection.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var written = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        out.write(buffer, 0, read)
                        written += read
                        if (total > 0) {
                            onProgress(Progress.Downloading(((written * 100) / total).toInt().coerceIn(0, 100)))
                        }
                    }
                }
            }

            // When the server said how big the file is, anything short is a
            // cut connection -- fail here with words rather than letting the
            // installer reject a half-file after the app has closed.
            if (total > 0 && target.length() != total) {
                target.delete()
                onProgress(Progress.Failed("The download was interrupted. Try again on a better connection."))
                return@withContext null
            }

            // An APK is a zip: it must start "PK" AND end like a zip. An HTML
            // page fails the first; a truncated download fails the second.
            if (!looksLikeApk(target)) {
                target.delete()
                onProgress(
                    Progress.Failed(
                        "The download didn't come through whole. Try again, or open " +
                            "the link in a browser and install from there."
                    )
                )
                return@withContext null
            }

            target
        }.getOrElse { error ->
            target.delete()
            onProgress(Progress.Failed(error.message ?: "The download did not finish."))
            null
        }
    }

    private fun looksLikeApk(file: File): Boolean {
        if (file.length() < 1_000_000) return false
        return runCatching {
            file.inputStream().use { stream ->
                val header = ByteArray(2)
                stream.read(header) == 2 && header[0] == 'P'.code.toByte() && header[1] == 'K'.code.toByte()
            } && hasZipEnd(file)
        }.getOrDefault(false)
    }

    /**
     * Whether the file ENDS like a zip, not just starts like one.
     *
     * A download cut mid-stream still opens with 'PK' and passes the header
     * check, and Android's installer then rejects it after the app has already
     * closed for the install -- which a person can only read as "I tapped
     * update and it crashed", with nothing in any log. A zip's end-of-central-
     * directory marker sits in the last kilobytes; a truncated file has lost
     * it, so this catches the cut before the installer is ever bothered.
     */
    private fun hasZipEnd(file: File): Boolean = runCatching {
        val tail = ByteArray(minOf(file.length(), 66_000L).toInt())
        java.io.RandomAccessFile(file, "r").use { raf ->
            raf.seek(file.length() - tail.size)
            raf.readFully(tail)
        }
        // 0x06054b50, little-endian on disk: PK
        for (i in tail.size - 22 downTo 0) {
            if (tail[i] == 0x50.toByte() && tail[i + 1] == 0x4B.toByte() &&
                tail[i + 2] == 0x05.toByte() && tail[i + 3] == 0x06.toByte()
            ) return@runCatching true
        }
        false
    }.getOrDefault(false)

    /**
     * Hands the file to Android's installer.
     *
     * The system shows its own confirmation, and the first time will send the
     * person to enable installing from this app. That is Android's decision,
     * not something to work around.
     */
    fun install(context: Context, apk: File) {
        val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
