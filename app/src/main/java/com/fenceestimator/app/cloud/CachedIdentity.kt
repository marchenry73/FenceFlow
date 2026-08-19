package com.fenceestimator.app.cloud

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

/**
 * Who this phone belongs to, remembered between launches.
 *
 * Without this, the app asked the server "who am I?" at every start and could
 * not function until the answer arrived. Offline it never arrived, so the app
 * had no company id and no role -- and the visible result was a phone that
 * looked broken: the "working on this phone only" banner at every restart,
 * a blank screen in airplane mode, an owner intermittently demoted to crew,
 * and no sync at all, since sync needs a company id to start.
 *
 * A fencing crew works in places with no signal. An app that forgets who they
 * are the moment the bars drop is not usable on a job site.
 *
 * ## Why caching a role is not the security hole it sounds like
 *
 * The cached role decides what the *local UI* offers. It is not what protects
 * the data. Row Level Security does that, server-side, on every read and write,
 * against the account's real role at that moment. Somebody holding a stale
 * cached role cannot use it to touch the cloud -- their requests are refused by
 * Postgres regardless of what their phone believes.
 *
 * So the exposure is genuinely narrow: a person whose access was revoked, whose
 * phone has no signal, can look at records that were already on that phone
 * before the revocation. They cannot reach anything new, cannot change the
 * company's data, and [wipeOnRevocation] clears the local copy the moment that
 * phone reaches the network again.
 *
 * That residual gap cannot be closed by any client-side design: a device with
 * no connection cannot learn that something changed. Shortening the cache
 * lifetime only trades it for an app that stops working in a dead zone, which
 * is the problem this exists to solve.
 *
 * **Do not "simplify" this by trusting the cache server-side, and do not remove
 * it to make revocation feel tighter.** The first would be a real hole; the
 * second only breaks offline use without closing anything.
 */
private val Context.identityStore by preferencesDataStore(name = "cached_identity")

object CachedIdentity {

    private val EMAIL = stringPreferencesKey("email")
    private val COMPANY_ID = stringPreferencesKey("company_id")
    private val ROLE = stringPreferencesKey("role")
    private val OVERRIDES = stringPreferencesKey("permission_overrides")

    data class Snapshot(
        val email: String,
        val companyId: String,
        val role: UserRole,
        val permissionOverrides: String
    )

    /**
     * Stores a profile that was actually read from the server.
     *
     * Only ever called after a successful fetch. A failed fetch must leave the
     * previous answer alone rather than overwrite it with a guess -- writing
     * "no company" on a dropped connection is how the app forgot itself.
     */
    suspend fun save(
        context: Context,
        email: String,
        companyId: String,
        role: UserRole,
        permissionOverrides: String
    ) {
        context.identityStore.edit { prefs ->
            prefs[EMAIL] = email
            prefs[COMPANY_ID] = companyId
            prefs[ROLE] = role.name
            prefs[OVERRIDES] = permissionOverrides
        }
    }

    /**
     * @return what was last known about [email], or null when this phone has
     *   never successfully read a profile for that account. The email must match
     *   so that signing in as somebody else never inherits the last person's
     *   company or role.
     */
    suspend fun load(context: Context, email: String): Snapshot? {
        val prefs = context.identityStore.data.first()
        if (prefs[EMAIL] != email) return null
        val companyId = prefs[COMPANY_ID]?.takeIf { it.isNotBlank() } ?: return null
        val role = prefs[ROLE]?.let { name ->
            runCatching { UserRole.valueOf(name) }.getOrNull()
        } ?: return null
        return Snapshot(
            email = email,
            companyId = companyId,
            role = role,
            permissionOverrides = prefs[OVERRIDES].orEmpty()
        )
    }

    /** Forgets everything. Used on sign-out and on revocation. */
    suspend fun clear(context: Context) {
        context.identityStore.edit { it.clear() }
    }
}
