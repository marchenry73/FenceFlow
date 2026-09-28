package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import java.io.File
import org.junit.Test

/**
 * The rules the offline identity cache has to keep.
 *
 * DataStore needs an Android context, so the store itself is not exercised
 * here. What is pinned instead are the decisions in SessionManager that make
 * caching safe, because each one is easy to undo by accident while tidying:
 *
 *  - a failed profile read must never overwrite what is remembered
 *  - signing out must forget it
 *  - a remembered profile belongs to one email address only
 *
 * Get any of those wrong and the app either forgets itself the moment signal
 * drops -- the bug this cache exists to fix -- or hands one person's company to
 * the next person who signs in on the same handset.
 */
class CachedIdentityContractTest {

    private fun read(path: String): String {
        val file = File(path)
        assertTrue(
            "Could not find $path at ${file.absolutePath}. If it moved, move this test with it.",
            file.exists()
        )
        return file.readText()
    }

    private fun session() = read("src/main/java/com/fenceestimator/app/cloud/SessionManager.kt")
    private fun cache() = read("src/main/java/com/fenceestimator/app/cloud/CachedIdentity.kt")

    @Test
    fun `a remembered profile is only written after a successful read`() {
        // The guard that matters. Saving on a failed fetch would record "no
        // company" every time the network hiccuped, which is precisely the
        // forgetting this was built to stop.
        val src = session()
        val saveIndex = src.indexOf("CachedIdentity.save")
        assertTrue("CachedIdentity.save is not called at all", saveIndex > 0)

        val guard = src.lastIndexOf("fetched.isSuccess", saveIndex)
        assertTrue(
            "CachedIdentity.save must sit inside a branch that checked the fetch succeeded.",
            guard in 1 until saveIndex
        )
    }

    @Test
    fun `signing out forgets the remembered profile`() {
        // Anchored on how a signed-out session is actually detected (no email
        // back from the auth check), not on the exact syntax used to publish
        // the resulting state -- that syntax is free to change, as it already
        // has once, without the invariant this test cares about changing at
        // all. Every step below reports what it could not find instead of
        // failing on an unrelated substring error, so a rename says which
        // anchor moved rather than producing an opaque crash.
        val src = session()
        val branchStart = src.indexOf("if (email == null) {")
        assertTrue(
            "Could not find the branch that detects a signed-out session " +
                "(the check that email came back null). If that detection moved " +
                "or changed shape, point this test at whatever replaced it.",
            branchStart >= 0
        )

        val branchEnd = src.indexOf("return@launch", branchStart)
        assertTrue(
            "Found the signed-out branch but not the return that ends it, so " +
                "this test cannot bound what it inspects.",
            branchEnd > branchStart
        )

        val window = src.substring(branchStart, branchEnd)
        assertTrue(
            "Signing out must clear the cache, or the next account on this phone " +
                "inherits the last one's company and role.",
            window.contains("CachedIdentity.clear")
        )
    }

    @Test
    fun `a remembered profile is tied to one email address`() {
        assertTrue(
            "load() must refuse to return a profile saved under a different email, " +
                "otherwise signing in as somebody else inherits their company.",
            cache().contains("prefs[EMAIL] != email")
        )
    }

    @Test
    fun `an incomplete remembered profile is treated as nothing`() {
        // Half a cached identity is worse than none: it would look resolved
        // while carrying a null company, which is the state the app cannot work
        // in and cannot report honestly.
        val src = cache()
        assertTrue(
            "A blank company id must not be returned as a usable cache entry.",
            src.contains("takeIf { it.isNotBlank() } ?: return null")
        )
        assertTrue(
            "An unparseable role must not be returned as a usable cache entry.",
            src.contains("getOrNull()\n        } ?: return null") ||
                src.contains("?: return null")
        )
    }

    @Test
    fun `the reason this is safe is written down next to it`() {
        // The cache is only safe because RLS enforces the real role server-side.
        // Somebody removing that note is likely also about to trust the cached
        // role somewhere it cannot be trusted.
        val src = cache()
        assertTrue(
            "The note explaining that RLS is the real gate has gone. Without it, " +
                "the next person to read this may take the cached role as authoritative.",
            src.contains("Row Level Security") || src.contains("RLS")
        )
    }
}
