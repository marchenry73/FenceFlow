# FenceFlow — Master Backlog

**Compiled** 2026-10-24, from the working session of 2026-10-23/24.
**Method** Every "verified" line below was checked against source, a test run, a
database read, or a build artifact during this session. Nothing is marked
verified because an earlier summary said so. Where I could not verify, the line
says so.

**Repository state** branch `main`, 8 commits ahead of `origin/main`, none
pushed. Checkpoint branch `overnight-2026-10-24-checkpoint` points at the same
commit. Rollback: `git reset --hard origin/main`.

**Last production release** app 1.767, published 2026-10-23, mandatory.
Verified from the APK itself (`versionCode='767' versionName='1.767'`) and from
the `app_releases` row.

---

## Completed and verified

| Item | Evidence |
|---|---|
| Pricing parity gate fixed (3 defects) | `0d5529c`. Gate run green: "4 Kotlin parity tests ran". The `--tests "*Parity*"` glob was being expanded into `ADMIN_PHONE_PARITY_2026-10-22.md`, so Gradle ran **nothing** while the gate reported the engines agreed. |
| Gate can no longer pass having compared nothing | Counts executed tests from the result XML, subtracting skips; floor of 3. Proven by watching it correctly refuse a run where 0 tests executed. |
| Gate no longer trusts a cached verdict | `fixtures/pricing/*.json` is not a declared Gradle input, so a changed fixture did **not** make the suite out of date. `--rerun` forces the comparison every time. |
| 0.001 ft count tolerance, both engines | 0 of 91 fixtures and 0 of 31 live runs change; closest boundary approach 59× the tolerance. Canary replanted outside the tolerance. |
| "Things vanish and come back" — cause found and fixed | `6424bda`. Whole canvas renders inside `if (activeRun != null && job2 != null)`; camera was `remember(selectedRunId)` so it reset when selection changed by itself after an erase. |
| No live drawing data is corrupt | 0 of 266 coordinate pairs unreadable by `decodePoints`, with a planted control proving the check fires. |
| Nothing is phantom-deleting drawing rows | 22 tombstoned `fence_runs`, all signed `marchenry73@gmail.com`, 0 blank-signed. `site_markers`: 0 tombstones of 13 rows. |
| Undo timeline pure core | `0ddcd27`. `DrawTimelineTest` 11/11, `WholeDrawingMoveTest` 15/15, including a canary that reproduces the old per-run design and fails the cross-side case. |
| "Pay here" button, both surfaces | `72e0331`, `a696afe`, `4c292cc`, `d093955`. a72 three-way test 24/24; office-vs-app money parity 30/30. |
| One gate on minting a payment link | `PaymentLinkGate`, 5/5 tests. Both the payment card and the quote email ask it. Canary encodes the mistake to avoid (permission alone admits an Accountant). |
| Office now computes "what to ask for next" the app's way | `tests/a110-office-next-request.test.mjs` 30/30, lifting the real office functions out of `dashboard.html`. |
| Scheduled email — database foundation | `2b2b73d` + `supabase_r38_scheduled_email.sql`, **applied and read back**: 7 columns, state constraint, partial index. `authenticated` SELECT went 14 → 21 columns, proving table-level grants covered them. |

## Implemented but untested

| Item | Why it is not verified |
|---|---|
| Scheduled email sweep in `mail-send` | Committed in `2b2b73d`. `tests/mail-send.test.mjs` 41 pass / 0 fail proves the existing door still works and the file parses, but **nothing exercises the new scheduled path**. Deno is not installable here, so it has no type-check either. |
| `.github/workflows/mail-scheduled.yml` | YAML parses (js-yaml). Never run: it needs `MAIL_SCHEDULED_TRIGGER_SECRET` in two places (see "Requires your approval"). |
| `DrawTimelineStore` persistence | Written; first compile failed on a missing `kotlinx.serialization.encodeToString` import, fixed, recompile in flight at the time of writing. It has **no test** and is **not wired to anything**. |

## Partially completed

| Item | What is done, what is not |
|---|---|
| Undo timeline (the feature) | Pure core and persistence exist. **Not wired**: `SurveyViewModel` still uses the per-run `UndoHistory`/`RedoHistory`. Remaining: swap the state flows, apply logic per edit kind, recording at the edit sites, and a decision at each of the 7 `clearDrawingHistory()` call sites about whether it now records a move or still forgets everything. `canUndo` does not exist at all today. |
| Scheduled email | Backend committed. **No UI on either surface**, so nothing can create a scheduled row yet. Office needs "send later" + a queue view with cancel; phone needs it on the quote send. |
| Pay here | Works end to end. Limitation: a scheduled *reply* cannot carry threading because `mail_drafts` has `thread_id` but no `reply_to_message_id` — a pre-existing gap in drafts. |

## Not started

- Move-scope chooser ("ask me what to move" — a side, a connected side, or whatever was clicked, remembering the answer). Depends on the timeline.
- One floating tool button that opens all drawing tools, to free canvas space.
- Gates: edit from the side, drag snapped to the line, position by measurement, drawn to scale with swing. All four options were asked for.
- Fence type / supplier on a run, so a 4 ft run prices against the right supplier, with an unmissable flag when it falls back to the nearest height.

## Broken or defective

- **Nothing known broken in production.** 1.767 shipped with every gate green.
- `tests/mail-send.test.mjs` cannot run under `tsx` (a `data:` URL import it uses). It runs correctly under plain `node`. Pre-existing; harmless once you know which runner to use.

## Blocked by missing access

- Scheduled email cannot be switched on: the trigger secret must be set in the Supabase function secrets and in GitHub Actions secrets. Both are outside what I should do unattended.
- No staging environment exists, so edge functions can only be verified by deploying to production. Deferred tonight.

## Requires your approval

1. **Set `MAIL_SCHEDULED_TRIGGER_SECRET`** (same value) as a Supabase function secret and a GitHub Actions secret, to switch scheduled email on.
2. **Deploy the edge functions** — `mail-send` carries the committed scheduled door and the two-CTA-button mail change. Until deployed, neither is live.
3. **Publish an app build** — the camera fix, the Pay here plumbing and the timeline core are committed but not in any APK.
4. **Overtime policy.** `CrewPay.kt` pays hours × rate with no weekly threshold; the office's estimated-pay card applies 40h/1.5×. So "pay" has two different answers across the two halves. This is a business decision, not a bug I should pick a side on.
5. **Five pending payment links whose amounts do not match their deposits.** They predate this work and the new code will not send them, but they are still attached to those jobs.
6. **1.750's release notes begin with the literal text `--notes`** — a past publish swallowed the flag into the customer-visible note. It is showing in the update prompt for anyone still on that version. One-row fix to `app_releases`, on your word.
