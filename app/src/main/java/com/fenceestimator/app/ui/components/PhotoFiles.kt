package com.fenceestimator.app.ui.components

import android.content.Context
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

data class NewPhotoTarget(val uri: Uri, val absolutePath: String)

/** Creates a fresh file (under app-private storage) and a FileProvider URI to hand to a camera intent. */
object PhotoFiles {
    fun newTarget(context: Context, subdir: String): NewPhotoTarget {
        val dir = File(context.filesDir, subdir).apply { mkdirs() }
        val file = File(dir, "photo_${System.currentTimeMillis()}_${UUID.randomUUID()}.jpg")
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        return NewPhotoTarget(uri, file.absolutePath)
    }

    fun copyFrom(context: Context, source: Uri, subdir: String): String {
        val dir = File(context.filesDir, subdir).apply { mkdirs() }
        val file = File(dir, "photo_${System.currentTimeMillis()}_${UUID.randomUUID()}.jpg")
        context.contentResolver.openInputStream(source)?.use { input ->
            file.outputStream().use { output -> input.copyTo(output) }
        }
        return file.absolutePath
    }
}
