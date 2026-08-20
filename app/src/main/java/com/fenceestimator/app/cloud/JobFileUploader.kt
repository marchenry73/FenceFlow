package com.fenceestimator.app.cloud

import android.content.Context
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Gets the files that matter off the phone and into the cloud.
 *
 * Runs as part of the normal sync rather than at capture time, for the same
 * reason everything else here does: a signature taken in a yard with no signal
 * still has to be captured, and still has to survive. Anything without a
 * storage path yet gets uploaded the next time there is a connection.
 *
 * Order matters -- signatures first. They are the evidence a signed change
 * order exists at all, and the only item on this list you cannot recreate.
 */
class JobFileUploader(
    private val scope: CoroutineScope,
    private val repository: Repository,
    private val context: Context
) {

    fun uploadPending(companyId: String) {
        scope.launch { runCatching { uploadAll(companyId) } }
    }

    private suspend fun uploadAll(companyId: String) {
        repository.getAllJobs().forEach { job ->
            // 1. Acceptance signature -- the customer agreeing to the price.
            if (job.signatureStoragePath == null && job.signatureImagePath != null) {
                FileSync.upload(companyId, job.syncId, "signature", job.signatureImagePath)?.let { remote ->
                    repository.updateJobFromCloud(job.copy(signatureStoragePath = remote))
                }
            }

            // 2. The survey the fence line was traced on. Without it the
            //    drawing still measures correctly but sits on a blank grid,
            //    and nobody can check it against the property.
            if (job.surveyStoragePath == null && job.surveyImagePath != null) {
                FileSync.upload(companyId, job.syncId, "survey", job.surveyImagePath)?.let { remote ->
                    repository.updateJobFromCloud(job.copy(surveyStoragePath = remote))
                }
            }

            // 3. Change order signatures -- the evidence for extra work billed.
            repository.getChangeOrders(job.id).forEach { order ->
                if (order.signatureStoragePath == null && order.signatureImagePath != null) {
                    FileSync.upload(companyId, job.syncId, "change-order", order.signatureImagePath)?.let { remote ->
                        repository.updateChangeOrder(order.copy(signatureStoragePath = remote))
                    }
                }
            }

            // 4. Before and after photos. Last because they are the largest and
            //    the least likely to be needed in a dispute -- on a phone plan
            //    the order these go up in is a real cost.
            repository.getPhotos(job.id).forEach { photo ->
                if (photo.storagePath == null) {
                    // Shrunk before it goes up. A phone photo is four to eight
                    // megabytes and a crew takes a dozen a job -- untouched,
                    // they fill storage and spend the crew's data in a yard
                    // where the signal is already poor.
                    //
                    // The compressed copy is a temporary file, uploaded and
                    // then deleted. The original on the phone is never touched:
                    // it is the user's own photo, and the full-quality version
                    // is the one they zoom into on the device that took it.
                    //
                    // Deliberately photos only. Survey images carry the pixel
                    // space the fence line and its scale are measured in, and
                    // signatures are line art that JPEG smears -- see the note
                    // in ImageCompressor.
                    val toUpload = ImageCompressor.compressForUpload(photo.filePath, context.cacheDir)
                    FileSync.upload(companyId, job.syncId, "photo", toUpload)?.let { remote ->
                        repository.updatePhoto(photo.copy(storagePath = remote))
                    }
                    if (toUpload != photo.filePath) {
                        runCatching { java.io.File(toUpload).delete() }
                    }
                }
            }
        }
    }

    /**
     * Fetches files this phone is missing. Called after a pull, so a new device
     * ends up with the signatures and surveys as well as the rows.
     */
    suspend fun downloadMissing() {
        repository.getAllJobs().forEach { job ->
            job.signatureStoragePath?.let { remote ->
                if (job.signatureImagePath == null || !java.io.File(job.signatureImagePath).exists()) {
                    FileSync.ensureLocal(context, remote, "signatures")?.let { local ->
                        repository.updateJobFromCloud(job.copy(signatureImagePath = local))
                    }
                }
            }
            job.surveyStoragePath?.let { remote ->
                if (job.surveyImagePath == null || !java.io.File(job.surveyImagePath).exists()) {
                    FileSync.ensureLocal(context, remote, "surveys")?.let { local ->
                        repository.updateJobFromCloud(job.copy(surveyImagePath = local))
                    }
                }
            }
            repository.getChangeOrders(job.id).forEach { order ->
                order.signatureStoragePath?.let { remote ->
                    if (order.signatureImagePath == null || !java.io.File(order.signatureImagePath).exists()) {
                        FileSync.ensureLocal(context, remote, "signatures")?.let { local ->
                            repository.updateChangeOrder(order.copy(signatureImagePath = local))
                        }
                    }
                }
            }
            repository.getPhotos(job.id).forEach { photo ->
                photo.storagePath?.let { remote ->
                    if (!java.io.File(photo.filePath).exists()) {
                        FileSync.ensureLocal(context, remote, "photos")?.let { local ->
                            repository.updatePhoto(photo.copy(filePath = local))
                        }
                    }
                }
            }
        }
    }
}
