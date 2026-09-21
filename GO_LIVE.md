# Go-live checklist

Written 2026-09-17, after the full production audit. Each line says who does it
and how you can tell it is really done — not "the code exists" but "I watched it
work".

## Blockers — do not sign a paying company up until these are done

| # | What | Who | Done when |
|---|---|---|---|
| 1 | **Release-signed app.** Every build shipped so far is a DEBUG build (`assembleDebug`). A debug APK is signed with Android's shared key and is marked debuggable: anyone with the file and a USB cable can read the app's database off the phone. `RELEASE_SETUP.md` has the steps. | March (needs a keystore password, which I must never hold) | `aapt2 dump badging` on the published APK shows no `application-debuggable`, and a phone updates from the old build without reinstalling |
| 2 | **Test environment.** Every test today runs against the live database. A free second Supabase organization fixes this at $0. | March creates the org, then me | `scripts/apply-schema.mjs <dev-ref>` matches the production fingerprint, and the test suites run with the dev ref |
| 3 | **Login recovery.** The staff console's two-factor is an authenticator app with no backup codes. Losing the phone locks you out of the admin console. | March + me | A second factor or recovery code exists and has been tested |
| 4 | **Password-reset email proven end to end.** Login mail now goes through Resend, and reset links point at fenceflowapp.com. | March | You request a reset from a non-team address and the link opens the office |
| 5 | **Live Stripe price ids on the website.** The subscription plans on both pages carry TEST-MODE price ids — the same three in each file: `website/dashboard.html` lines 7103/7105/7107 (`PLANS`) and `website/welcome.html` lines 456/458/460 (`PLANS`), Solo/Crew/Pro. Test-mode checkout accepts only Stripe's test cards, so a real customer's card is declined at the door. Create the three live-mode products in Stripe → Product catalog and paste the live ids over the test ones in **both** files. A price id is public, not a secret. | March (the ids come from his Stripe account) | The live-mode Stripe dashboard lists all three products; both files contain the same three ids and no id beginning `price_1U7mF`; and one real card on the $99 plan completes checkout and shows up as a live payment in Stripe |
| 6 | **Live Stripe secrets on the edge functions.** `STRIPE_SECRET_KEY` (set 2026-08-15) and `STRIPE_WEBHOOK_SECRET` (set 2026-08-16) are still the test-mode values (`AUDIT_2026-09-18_PHASE1.md`, P0 #5, which also found links already reading "Paid" with nothing behind them in the books). Both are used by `create-checkout-session`, `create-payment-link`, `stripe-connect`, `stripe-webhook` and `billing-setup`. Swap with `npx supabase secrets set --project-ref newcrgafcptspmapacrx STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=…`, then create the live-mode webhook endpoint in Stripe and use **its** signing secret — a live endpoint's secret is not the test one. | March only. These are secrets; I must never see or hold either value, and neither belongs in this repo, a commit, or a chat | `npx supabase secrets list --project-ref newcrgafcptspmapacrx` shows today's date against both names (it prints a digest, never the value); Stripe's live webhook delivery log shows a `200`, not a `400` signature failure; and the payment from item 5 lands in `payment_records` — the ledger is webhook-written, so a row there is proof the live signing secret verified |

## The signing key — back it up before anything else

`C:\Users\march\.android\debug.keystore` is the identity of every FenceFlow
phone in the field today. Not a spare, not a development convenience: that
file, and nothing else, is what Android checks before it will install an
update over the app your crews are already running.

This is proved from the artifact, not assumed. The published build in
`G:\My Drive\Professional Documents\Projects\APK Builds\fenceflow.apk`
(1.503, versionCode 503) reports `application-debuggable` and is signed by
`CN=Android Debug` with certificate SHA-256
`a02c181a9d08d310b806b7bcf5078b3ff1e6e40f0138e5d4e70d2392462f316d`. That is
byte-for-byte the certificate in the keystore above. Blocker 1 explains why
shipping a debuggable build is not acceptable long-term; this section is about
the separate fact that until blocker 1 is done, this one file is the app.

**It exists on exactly one machine, and it is in no backup this repo controls.**
It sits outside the repository, and a copy placed inside would be ignored
anyway — `.gitignore` line 10, `*.keystore`, which `git check-ignore` confirms
matches `app/debug.keystore` and `keystore/debug.keystore`. `git ls-files`
finds nothing keystore-shaped tracked. That exclusion is correct and should
stay: a signing key does not belong in a repository. The problem is that
"correctly excluded" and "backed up" are different things, and only the first
one is true.

If this file disappears — disk failure, a reinstalled Windows, a cleared user
profile — then:

- Every future build is a **different app** to Android. The update stops
  installing, with a signature-mismatch error and no useful explanation.
- The only way back onto a phone is **uninstall and reinstall**, which deletes
  that phone's local database: drawings, signatures, photos and any hours or
  job edits that had not synced yet. On a crew phone that is a real day of work.
- Nothing can regenerate it. The key is random; a new one with the same alias
  and password is still a new app.

March: copy it somewhere off this machine — a password manager's file
attachment, an encrypted archive in the Drive folder, a USB key in a drawer,
ideally two of those. **I have deliberately not copied or moved it.** Where a
signing key lives is the owner's decision, an agent that relocates one is how a
key ends up somewhere nobody remembers, and the copy will exist in whatever
place March chooses without any of it passing through a tool call.

Verify a copy is the right file before trusting it:

    keytool -list -v -keystore <the copy> -alias androiddebugkey

The SHA-256 it prints must equal the fingerprint above. A copy whose
fingerprint differs is not this key and will not update a single phone.

## Should be done before the first outside company

- Switch on the follow-up rules you want (they are all off by default) and watch the first one send.
- Enter your real catalog prices; a new company now starts empty by design.
- Set each crew member's pay type and rate.
- Walk one job end to end on real hardware: lead → measure → quote → approve → sign → deposit → schedule → clock in → correct hours → accept → complete → final payment → closed.
- Check the office in Spanish and French, in dark mode, on a phone-sized window.

## Release gates that already run on every publish

`scripts/publish-release.mjs` refuses to publish unless all of these pass:
pricing parity (phone vs server), website page syntax, live security smoke,
posts/concrete/waste/tax, deposit and balance, pay and overtime, job costing,
and the app's own unit tests. It also refuses if the APK was built before the
last commit, and it will not fall back to announcing an older build.

`--at "2026-09-20T07:00-04:00"` schedules a release; `--company <id>` limits it
to one company; `admin_promote_release` opens it to everyone afterwards.

The **website** is now gated too. `.github/workflows/pages.yml` runs
`tests/dashboard-syntax.test.mjs` and `tests/dashboard-undefined-calls.test.mjs`
before the Pages artifact is uploaded, so a broken office page fails the
workflow instead of reaching the live site. Both checks already existed; until
now every push to `main` deployed whatever it contained.

## After a release ships

    node scripts/post-release-watch.mjs            # newest release, watches an hour
    node scripts/post-release-watch.mjs --once     # one reading, no waiting

Reads `app_errors` for the new build over the hour after its release, prints
any fatal crash, and compares the error count against the previous build over
the same number of minutes from *its* release. Non-zero exit on a fatal or a
clear regression, so a scheduled task can act on it. It never prints an email
address (the `email` column is never selected, and every free-text field is
redacted). `scripts/whats-wrong.mjs` runs the same check as one of its
sections. Before this existed, nothing read that table automatically: 1.501
shipped at 02:24 UTC and crashed five times fatally eleven minutes later, and two more
releases went out on top of it before anyone looked.

**Withdrawing a release.** `admin_demote_release(<release id>)` — a platform
admin only — puts the build back to `audience = 'limited'` with nobody on the
list, so no further phone is offered it. `admin_promote_release` on the same id
puts it back out with no rebuild. What this does **not** do is uninstall
anything: Android refuses a lower versionCode and the app only ever looks for a
*higher* one, so a phone that already took a bad build keeps it, and the repair
is a fix rolled forward through the full gate run — budget half an hour. The
cheaper habit is to publish anything risky with `--company <id>` first and
promote it once it holds.

## Still open, by choice

- AI features: deliberately not built. Decision page: `AI_DECISION.md`.
- Office console is still one large file; the split has started (`docs/OFFICE_SPLIT_PLAN.md`).
- Payroll: FenceFlow estimates pay. It does not process payroll, and should not
  claim to.
