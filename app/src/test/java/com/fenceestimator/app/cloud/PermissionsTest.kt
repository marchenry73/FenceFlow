package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * These cases are mirrored by the has_permission() function in Postgres.
 *
 * They have to agree. If the app and the server disagree about who may do
 * something, the app is either blocking work the server would allow -- which
 * looks like a bug -- or offering work the server will reject, which looks
 * worse. The SQL was run against the live database with the same table of
 * cases and produced the same answers.
 */
class PermissionsTest {

    @Test
    fun `a role with no adjustments gets exactly its defaults`() {
        assertEquals(
            UserRole.CREW.defaultPermissions,
            PermissionOverrides.resolve(UserRole.CREW, "")
        )
        assertEquals(
            UserRole.MANAGER.defaultPermissions,
            PermissionOverrides.resolve(UserRole.MANAGER, null)
        )
    }

    @Test
    fun `a grant adds one thing and nothing else`() {
        val crew = PermissionOverrides.resolve(UserRole.CREW, "+SEE_MONEY")
        assertTrue(Permission.SEE_MONEY in crew)
        assertFalse("granting one permission must not drag others in", Permission.EDIT_JOBS in crew)
    }

    @Test
    fun `a revocation takes one thing away`() {
        val manager = PermissionOverrides.resolve(UserRole.MANAGER, "-SEE_MONEY")
        assertFalse(Permission.SEE_MONEY in manager)
        assertTrue(Permission.EDIT_JOBS in manager)
    }

    @Test
    fun `revocation beats a grant for the same permission`() {
        // A contradictory override should take access away rather than give it.
        val resolved = PermissionOverrides.resolve(UserRole.MANAGER, "+SEE_MONEY,-SEE_MONEY")
        assertFalse(Permission.SEE_MONEY in resolved)
    }

    @Test
    fun `nobody gets deletion by job title`() {
        // Not even a manager. A mistaken delete on a signed change order or a
        // paid invoice destroys the evidence, and there is no undo.
        UserRole.values().filter { it != UserRole.OWNER }.forEach { role ->
            assertFalse(
                "$role must not inherit deletion",
                Permission.DELETE_RECORDS in role.defaultPermissions
            )
        }
    }

    @Test
    fun `deletion can be granted to a named person`() {
        val foreman = PermissionOverrides.resolve(UserRole.FOREMAN, "+DELETE_RECORDS")
        assertTrue(Permission.DELETE_RECORDS in foreman)
    }

    @Test
    fun `even an owner can have something taken away`() {
        val owner = PermissionOverrides.resolve(UserRole.OWNER, "-DELETE_RECORDS")
        assertFalse(Permission.DELETE_RECORDS in owner)
    }

    @Test
    fun `overrides survive a round trip`() {
        val role = UserRole.FOREMAN
        val wanted = role.defaultPermissions + Permission.SEE_MONEY - Permission.RECORD_FIELD_WORK
        val encoded = PermissionOverrides.encode(role, wanted)
        assertEquals(wanted, PermissionOverrides.resolve(role, encoded))
    }

    @Test
    fun `an unadjusted person stores nothing`() {
        // Storing the resolved set would freeze people at the day they were
        // added; storing differences means a role change reaches them.
        assertEquals("", PermissionOverrides.encode(UserRole.SALES, UserRole.SALES.defaultPermissions))
    }

    @Test
    fun `junk in the override string is ignored, not obeyed`() {
        val resolved = PermissionOverrides.resolve(UserRole.CREW, "banana,+NOT_A_PERMISSION,,+SEE_MONEY,x")
        assertTrue(Permission.SEE_MONEY in resolved)
        assertEquals(UserRole.CREW.defaultPermissions + Permission.SEE_MONEY, resolved)
    }

    @Test
    fun `signed out means working alone, so everything is allowed`() {
        val local = SessionState(signedIn = false, role = UserRole.CREW)
        assertEquals(Permission.ALL, local.permissions)
        assertTrue(local.canDelete)
    }

    @Test
    fun `signing in applies the role`() {
        val crew = SessionState(signedIn = true, role = UserRole.CREW)
        assertFalse(crew.canSeeMoney)
        assertFalse(crew.canDelete)
        assertTrue(crew.canRecordFieldWork)
    }

    @Test
    fun `a per-person adjustment reaches the screens that ask`() {
        val trustedForeman = SessionState(
            signedIn = true,
            role = UserRole.FOREMAN,
            permissionOverrides = "+SEE_MONEY"
        )
        assertTrue(trustedForeman.canSeeMoney)

        val restrictedManager = SessionState(
            signedIn = true,
            role = UserRole.MANAGER,
            permissionOverrides = "-EDIT_CATALOG_AND_SETTINGS"
        )
        assertFalse(restrictedManager.canEditCatalogAndSettings)
        assertTrue(restrictedManager.canEditJobs)
    }
}
