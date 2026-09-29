package com.fenceestimator.app.guest

/**
 * MEANT to be the one place a guest demo session is refused a write, so that
 * closing the gap stops depending on every screen remembering to check first.
 *
 * STATUS, STATED PLAINLY SO NOBODY HAS TO INFER IT: the machinery below is
 * complete and wired into [Repository] -- [check] runs, correctly, on both
 * sides of its own if -- but it is currently INERT in the shipped app, and
 * that is deliberate, not an oversight waiting to be finished. [check] is
 * only ever as good as the [guestActive] it is handed, and the value handed
 * to it, [Repository.isGuestSession], is a `var` that this codebase declares,
 * reads, and initializes to `false` -- and then never once assigns anywhere
 * else. Grep it: `isGuestSession =` matches only its own declaration. So
 * [guestActive] is `false` on every single call this file ever receives, in
 * production, today, for a guest exactly as for anyone else, and every
 * paragraph below describing what this file refuses is describing what it
 * WOULD refuse once wired, not what it refuses now. Compare
 * [Repository.deletingUser], declared two lines above [Repository.
 * isGuestSession] in that file and actually kept current: FenceEstimatorApp
 * reacts to `session.state` and assigns it live. [Repository.isGuestSession]
 * gets no such line.
 *
 * THE ONE LINE THAT WOULD ARM IT does not exist anywhere in the app:
 *
 *     repository.isGuestSession = it.isGuestDemo
 *
 * dropped into FenceEstimatorApp.startServices' existing
 * `session.state.collect { it -> ... }` block (the same block that already
 * sets `repository.deletingUser = it.email.orEmpty()`), reading
 * [com.fenceestimator.app.cloud.SessionManager.isGuestDemo] off the collected
 * state the same way that block already reads `it.email`. One line, one file
 * this guard does not own.
 *
 * WHY IT IS NOT ARMED, on purpose, left this way: every write this file would
 * start refusing is a write some screen's per-screen gate already failed to
 * hide from a guest -- that is the only case where [check] would ever see
 * `guestActive = true` reach a live call. Today that gap fails safe-ish: the
 * write just succeeds, same as for anyone else, writing to local state a demo
 * wipe will later delete. Add the line above with nothing else changed and
 * that same gap fails two different bad ways depending on which screen's
 * view model happens to own the call site:
 *  - a view model that already wraps the repository call in `runCatching` or
 *    a bare `try`/`catch` (EmployeesViewModel.saveEmployee,
 *    InventoryViewModel's checked/delete/photo updates, CustomersViewModel's
 *    save, among others) would swallow [Refused] exactly as it swallows a
 *    real Room failure -- the button the guest tapped would look like it did
 *    something, or silently did nothing, with no "guests can't do this"
 *    anywhere, because nothing downstream of `runCatching { ... }` currently
 *    asks whether the failure inside it WAS a [Refused];
 *  - a view model that calls straight into a write with no catch at all
 *    (JobsViewModel.createJob and JobsViewModel.deleteJob are two -- there
 *    may be others; this file does not own them and this comment does not
 *    claim to have found every one) would let [Refused] propagate out of an
 *    uncaught `viewModelScope.launch { ... }` coroutine, which crashes the
 *    app for the guest, on a build where the screen's own gate was the thing
 *    that was supposed to have stopped this before it reached Repository at
 *    all.
 * Deciding which of those two a given caller should show instead -- and
 * actually giving each one a real "guests can't do this" path instead of a
 * swallow or a crash -- is real work across files this guard does not own,
 * and it is the OWNER's call when and how to spend it, not a side effect of
 * whoever next touches this file. Flipping the one line above without that
 * work done first would not finish this guard; it would trade "silently
 * wrong" for "silently wrong OR crashes," at random, per screen.
 *
 * WHAT ACTUALLY PROTECTS A GUEST TODAY, then, is not this file. It is the
 * per-screen controls this file's own history (next paragraph) argues cannot
 * converge: `session.state`'s `isGuestDemo` (NOT the permission system --
 * see below -- a separate, narrower check some of these same screens also
 * make against `canDelete` or another named permission) read directly in a
 * screen or view model and used to disable a control or swap its copy for
 * one that is honest about what a guest cannot do --
 * ManufacturersScreen's `editable`, SettingsScreen's pricing-tier gate,
 * CrewFencePlanScreen's RequestChangeCard, and others like them. Every one of
 * those is a screen someone had to remember to gate, by hand, the exact
 * failure mode described below. That tension -- the mechanism built to make
 * per-screen gating unnecessary sits here, finished, unarmed, while the thing
 * actually holding the line today is the approach this file was written
 * because per-screen gating does not converge -- is KNOWN and named here on
 * purpose, not a gap nobody noticed.
 *
 * Three waves closed guest-writable controls one screen at a time and a new
 * screen kept turning up -- the word "guest" was zero occurrences in the
 * estimate, materials and crew folders while all three could write. Per-screen
 * gating does not converge because the DEFAULT for a screen that never thinks
 * about guests at all is "allowed" -- nothing stops it. This file exists to
 * invert that default -- see STATUS above for why it does not yet. [Repository]
 * calls [check] before every write it performs, so once armed, the default for
 * a NEW write added to Repository tomorrow would be "refused for a guest" the
 * moment it is wired through the same gate every other write already goes
 * through -- not "allowed until somebody remembers," which is the failure mode
 * that regressed three times and, while this file is unarmed, still stands.
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
 * suspend read of SettingsStore on every write, and for the wiring this file
 * cannot supply on its own and does not currently have.
 *
 * THE CONTRACT ON REFUSAL, once armed. A refused write throws [Refused] rather than:
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
     *   call -- never re-derived here, never cached here. Always `false` in
     *   the shipped app today, because nothing assigns that property; see the
     *   class doc's STATUS section before assuming this parameter is ever
     *   `true` in production.
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
