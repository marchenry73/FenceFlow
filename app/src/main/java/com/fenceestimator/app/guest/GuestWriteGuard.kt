package com.fenceestimator.app.guest

/**
 * The one place a guest demo session is refused a write, so that closing the
 * gap stops depending on every screen remembering to check first.
 *
 * Three waves closed guest-writable controls one screen at a time and a new
 * screen kept turning up -- the word "guest" was zero occurrences in the
 * estimate, materials and crew folders while all three could write. Per-screen
 * gating does not converge because the DEFAULT for a screen that never thinks
 * about guests at all is "allowed" -- nothing stops it. This file inverts that
 * default. [Repository] calls [check] before every write it performs, so the
 * default for a NEW write added to Repository tomorrow is "refused for a
 * guest" the moment it is wired through the same gate every other write
 * already goes through -- not "allowed until somebody remembers," which is
 * the failure mode that regressed three times.
 *
 * Deliberately NOT the permission system. [SEE_MONEY], crew/foreman/manager
 * roles and the rest answer "what may this real, signed-in person do." This
 * answers a single, unrelated question: "is the CURRENT session an ephemeral
 * guest demo, full stop." A real user -- crew, foreman, manager or owner --
 * is never refused by this file no matter what they may or may not be
 * permitted to do; that permission question is answered elsewhere, on its own
 * axis, and this guard does not know it exists. If a change here could ever
 * refuse a write for a signed-in user, that change is wrong.
 *
 * [Repository.isGuestSession] is what supplies [guestActive] to [check] --
 * see that property's doc for why it is a plain settable flag rather than a
 * suspend read of SettingsStore on every write, and for the one piece of
 * external wiring this file cannot supply on its own.
 *
 * THE CONTRACT ON REFUSAL. A refused write throws [Refused] rather than:
 *  - quietly succeeding (the fake feature the owner's rules name outright: a
 *    control that looks live while its write is swallowed corrupts whatever
 *    local state the caller assumed had just been written -- an id that was
 *    never inserted, a total that never moved);
 *  - quietly logging and returning as if it had (same corruption, with a
 *    paper trail nobody reads at the moment it matters);
 *  - changing what a write method returns (a Result/Boolean wrapper would
 *    have to change the return type of every write in Repository, which
 *    means changing every call site in every screen and view model this wave
 *    does not own -- CustomersViewModel, JobsViewModel, EstimateViewModel,
 *    CrewJobViewModel and the rest belong to other tracks).
 * Throwing costs no signature anywhere: every write keeps returning exactly
 * what it always returned, on the one path where it is actually allowed to
 * run. On the refused path, the caller's own coroutine sees a real, typed,
 * catchable exception the instant it calls a write function -- which is
 * exactly the shape a screen needs to react (a `runCatching` around the call,
 * or a catch for this one type) whenever the OTHER track wires a screen to
 * show the control as inert. That reaction is that track's job, not this
 * file's; this file's job is only to make the failure real, observable and
 * specific enough that the reaction is possible instead of silently absent.
 */
object GuestWriteGuard {

    /**
     * Thrown by [Repository] instead of performing a write, when the current
     * session is a guest demo and the write named [operation] carries no
     * bypass for it.
     *
     * A distinct type on purpose, not a bare `IllegalStateException` --
     * `catch (e: GuestWriteGuard.Refused)` lets a screen respond to exactly
     * this one condition without also swallowing an unrelated Room or
     * coroutine failure it has no business treating the same way.
     */
    class Refused(val operation: String) :
        IllegalStateException(
            "guest demo session refused write: $operation " +
                "(see com.fenceestimator.app.guest.GuestWriteGuard)"
        )

    /**
     * The whole decision, kept pure (two booleans in, nothing else) so a test
     * can state it without constructing a Repository or a database -- see
     * GuestWriteChokeTest.
     *
     * @param operation a short, stable name for what was being attempted
     *   (e.g. "createJob"), carried onto [Refused] for logs and for any
     *   screen that wants to tell operations apart.
     * @param guestActive [Repository.isGuestSession] at the moment of the
     *   call -- never re-derived here, never cached here.
     * @param bypass true only for the two named exceptions Repository grants
     *   by construction: [GuestSeeder]'s own inserts (which in the app's own
     *   startup order run BEFORE the guest flag is set at all -- see
     *   Repository.createJob's doc for why that already suffices without a
     *   bypass, and why one is granted anyway) and [GuestWipe]'s own deletes
     *   of rows it can prove it seeded (Repository.deleteJobLocallyOnly).
     *   Nothing else should ever pass true here; a caller that needs a third
     *   bypass needs a third named, narrow reason, not this parameter turned
     *   into a general-purpose escape hatch.
     * @throws Refused when [guestActive] is true and [bypass] is false.
     */
    fun check(operation: String, guestActive: Boolean, bypass: Boolean = false) {
        if (guestActive && !bypass) throw Refused(operation)
    }
}
