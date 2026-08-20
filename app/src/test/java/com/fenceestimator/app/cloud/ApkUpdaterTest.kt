package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Getting the download link right.
 *
 * A Google Drive share link serves an HTML preview page, not the file. Fetching
 * it verbatim produces a small file that is a web page, and Android then
 * refuses to install it with an error that names nothing useful -- so the
 * person concludes the update is broken rather than the link.
 */
class ApkUpdaterTest {

    @Test
    fun `a drive share link becomes a real download`() {
        assertEquals(
            "https://drive.google.com/uc?export=download&id=1VrDmjk_bIeS2w",
            ApkUpdater.directDownloadUrl(
                "https://drive.google.com/file/d/1VrDmjk_bIeS2w/view?usp=drivesdk"
            )
        )
    }

    @Test
    fun `the older drive open form works too`() {
        assertEquals(
            "https://drive.google.com/uc?export=download&id=abc123",
            ApkUpdater.directDownloadUrl("https://drive.google.com/open?id=abc123")
        )
    }

    @Test
    fun `ids with dashes and underscores survive intact`() {
        // Drive ids routinely contain both, and a regex that drops them
        // produces a link to somebody else's file or to nothing.
        val id = "1a-B_c2D3e-F4g_H5"
        assertEquals(
            "https://drive.google.com/uc?export=download&id=$id",
            ApkUpdater.directDownloadUrl("https://drive.google.com/file/d/$id/view")
        )
    }

    @Test
    fun `any other host is left completely alone`() {
        // This fixes one very common way of sharing a build. It is not a
        // general URL rewriter, and quietly mangling somebody's own hosting
        // would be worse than not helping.
        val direct = "https://releases.example.com/fenceflow/app-release.apk"
        assertEquals(direct, ApkUpdater.directDownloadUrl(direct))

        val supabase = "https://newcrgafcptspmapacrx.supabase.co/storage/v1/object/public/x.apk"
        assertEquals(supabase, ApkUpdater.directDownloadUrl(supabase))
    }

    @Test
    fun `an already-direct drive link is not rewritten twice`() {
        val alreadyDirect = "https://drive.google.com/uc?export=download&id=xyz"
        assertEquals(alreadyDirect, ApkUpdater.directDownloadUrl(alreadyDirect))
    }

    @Test
    fun `nonsense in gives the same nonsense back rather than an exception`() {
        assertEquals("", ApkUpdater.directDownloadUrl(""))
        assertEquals("not a url", ApkUpdater.directDownloadUrl("not a url"))
    }
}
