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

## Still open, by choice

- AI features: deliberately not built. Decision page: `AI_DECISION.md`.
- Office console is still one large file; the split has started (`docs/OFFICE_SPLIT_PLAN.md`).
- Payroll: FenceFlow estimates pay. It does not process payroll, and should not
  claim to.
