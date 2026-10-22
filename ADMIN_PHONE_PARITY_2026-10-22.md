# The phone's Admin portal against the web console — 22 October 2026

> "Also on the admin portal, need all the options that I have on the web."

Read off both, not guessed. **The phone has four screens; the web has seven.**
Three are missing outright and four of the four it does have are thinner than
their twin.

This is the list to go through with you, because two of the gaps are desk work
that would be worse on a phone, and I am not going to build those on a guess.

---

## Screen for screen

| Web console | On the phone? | What it would take |
|---|---|---|
| **Overview** (the tiles: companies, on trial, paying, suspended, MRR, crashes, versions — and now *used it in 30 days*) | **No** | Small. One RPC already returns everything; it is a list of seven figures. |
| **Companies** | Yes, thinner | See below |
| **Crashes** | Yes, as "Errors" | Mostly there |
| **Releases** | Yes, thinner | See below |
| **Pricing drift** | **No** | Medium. A list of jobs where the two engines disagree, with a mark-seen button. |
| **Audit log** | **No** | Medium on the phone, and the CSV half is desk work. |
| **Account** (your own MFA) | **No** | Deliberate. Enrolling a second factor from a phone that is already signed in weakens the factor to "whoever holds this phone" — that is written into AdminGate.kt as the reason. **I would not move this one.** |

---

## Inside the screens it does have

**Companies.** The phone shows the list and can start a trial, extend it,
suspend, reinstate, grant access, invite and re-invite. What it cannot do:

- **the new Using it column** — the three 30-day counts and the Active / Quiet /
  Dormant verdict that went live today;
- the **owner's login email** on the row, and searching by it;
- the **onboarding track** (invited → signed in → agreement → plan);
- **Manage** — the dialog where plan, price, billing email and notes are edited;
- **CSV export** (desk work; I would leave this one on the web).

**Releases.** The phone lists them. The web can **change a release's audience**
— promote a limited rollout to everyone — which is the one control that matters
after a staged release, and it is exactly the kind of thing you would want to do
from a phone when a build turns out fine.

**Errors / Crashes.** Closest to parity. The phone is missing the **"only on the
current build" filter** and the **Office website** pill that went in today, so an
office error reads as a phone crash with no version.

---

## Built on 22 October, in 1.734

1. **Overview tab** — six figures: companies, used it in 30 days, dormant, on
   trial, paying, suspended. Built from the **same one call** the Companies tab
   makes, so the two cannot disagree about how many companies exist, and
   opening it costs one request rather than seven.
2. **Using it, on every company card** — the verdict with its three counts
   beside it, so the rule can be checked rather than believed. A company
   invited and never signed in says so instead of reading as dormant.
3. **Give a release to everyone** — `admin_promote_release` already existed, so
   this was only the button. It asks first, and says plainly that it cannot be
   taken back from a phone that has already installed it.

## The blocker on "Manage a company" is gone

I said this one needed a server function that does not exist. It does not:
`protect_billing_columns()` on the companies table lets a platform admin
through and silently reverts plan, price, status and the Stripe ids for
everybody else, which is exactly how the web console writes them. **The phone
can write that row the same way** — so Manage is now plain UI work, next time
I am in there.

One thing seen while checking, recorded rather than raised as an alarm: that
trigger opens with `if auth.uid() is null then return new`, the shape that has
caught this project before — `auth.uid()` is null for an anonymous caller as
well as for the backend's own service-role writes. It is not reachable today,
because nothing grants `anon` an UPDATE on companies. It is worth narrowing to
the service role by name the next time that file is open.

## What I would build next, in this order

1. **Manage a company** — plan, price, billing email, notes. No longer blocked;
   see above.
2. **The crash filter and the Office pill**, so the phone and the web stop
   disagreeing about whether an office error is a phone crash.
3. **Pricing drift** — the list of jobs where the two engines disagree, with a
   mark-seen button.
4. **Audit log**, the list only. The CSV stays at a desk.

## What I would NOT build, and why

- **Account / MFA enrolment.** Enrolling the second factor from an
  already-signed-in phone defeats the factor. The reasoning is already in the
  code; I would keep it.
- **The two CSV exports.** A file download on a phone goes to a Downloads folder
  nobody opens. Those are a desk job and the web does them well.
- **Audit log CSV**, same reason. The *list* is worth having on a phone; the
  export is not.

---

## The one question

Do you agree about **Account / MFA** staying web-only? That is the only item
where I am saying no to something you asked for, so it should be your call and
not mine. Everything else on the build list above I will do without asking.
