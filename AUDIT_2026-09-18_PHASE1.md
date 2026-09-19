# FenceFlow Phase 1 audit — baseline, 18 September 2026

Eighteen inspectors read the product (code, live database, live site, published
artifact). Every launch-blocker claim was then attacked twice by independent
agents: one trying to disprove it, one checking the proposed fix wouldn't break
something. 62 agents, 44 verification verdicts.

**Result: 9 P0, 31 P1, 48 P2, 22 P3.** Every P0 survived verification. Nine
verdicts came back "refuted" — in eight of those the *finding* was real and the
*proposed fix* was wrong, which is exactly what that pass is for.

Full per-area notes: `scratchpad/audit3/*.md` (auth, money, isolation, sync,
release, estimating, office-ux, homeowner, crew, time-pay, production,
reporting, performance, automation, onboarding, i18n-a11y, competitive,
marketing-truth).

---

## A. What FenceFlow does extremely well

Not flattery — these are the things the inspectors tried to break and couldn't.

- **Company isolation holds.** Every cross-company probe failed. The eight
  security fixes from 17 Sep were re-proved and still hold.
- **Server-authoritative pricing with phone/office parity**, guarded by tests
  that genuinely fail when broken (planted canaries with teeth).
- **Money maths is right where it counts.** Deposits, balances, refunds and the
  ledger survived adversarial checking; the ledger is webhook-written.
- **Offline-first field work** that refuses to lose unsynced work — the phone
  will not wipe itself while it holds work nobody has seen.
- **Crew financial privacy**, enforced in the database (separate crew views) not
  just hidden in the UI.
- **No invented numbers.** A new company starts empty and a quote is blocked on
  unconfirmed prices — rare discipline, and it now extends to cloud settings.
- **Release gates that refuse to ship** on a red pricing, security or money test.
- **Genuinely trilingual**, including the customer-facing pages.

## B. Biggest problems right now

### P0 — must fix before a paying company

1. **The published app is a debug build** (proved from the artifact). Anyone with
   the file and a cable can read a phone's database. *Confirmed still open.*
2. **Signing it properly breaks every phone in the field.** A release keystore
   makes the update uninstallable — recovery is uninstall + reinstall, which
   wipes anything not yet synced. Needs a decision: planned reinstall, or key
   rotation with a signature lineage.
3. **The release build silently turns self-update OFF** — so the first properly
   signed build kills the only update channel, permanently, and the publish
   script still reports success.
4. **Customer deposits land in FenceFlow's own Stripe account.** A contractor who
   connects their own account is refused outright; one who doesn't gets a link
   that pays the wrong bank while the job reads paid.
5. **The live site sells subscriptions with Stripe TEST keys** — a real card is
   declined, and six links already read "Paid" with nothing in the books.
6. **Password reset is non-functional in the office.** It sends the mail, but
   there is nowhere to set a new password; the contractor gets one silent entry
   and the phone stays locked out. (The staff console has all three pieces —
   they were never ported.)
7. **Test jobs still reach every crew and foreman phone.** 10 of 19 production
   jobs are ZZ TEST rows; the 17 Sep fix was client-side only.
8. **Shift corrections made on a phone are silently discarded** — a foreman fixes
   a 14-hour overnight clock to 8, sees "Approved", and payroll pays 14.
9. **"No card to start" is not true** — signup always collects a card.

### P1 — 31 items, the clusters that matter

- **Auth:** no address has ever been verified (autoconfirm is on); an invite to an
  existing account is a dead end; sessions never expire and staff MFA is asked
  once per session, ever (a 36-day-old session can suspend any company); no auth
  audit trail survives.
- **Sync:** conflict resolution still trusts the device clock; a crew phone wipes
  the re-approval state so "do not build yet" never appears; deleting a job
  elsewhere destroys unsynced hours; every pulled job counts as unsynced work
  for ever, which cries wolf over the one warning that protects real work.
- **Permissions:** crew can forge a signed contract by planting a file and
  repointing the job; an accountant can clear `signed_at`; the customer-identity
  guard misses `email`, so a job's quote link can be redirected.
- **Release/ops:** the signing key exists in exactly one place and is excluded
  from the repo (the Ledger incident, again); the website deploys on every push
  with no gate though the gate tests exist; no way to withdraw a release; nothing
  watches a release after it ships (1.501 shipped with 5 fatal crashes, unseen).
- **Automation:** `send-follow-ups` is built, correct and **scheduled by nothing**
  — one config step from working. The 4 legacy rules only run while a dashboard
  tab is open, and production alerts reach nobody unless that tab is open.
- **Pay:** the phone's "Your Pay" card sums *everyone's* hours on a multi-worker
  job.
- **Office gaps:** change orders and punch lists are phone-only — the office
  cannot create or edit either.

## C. UX problems

Office: the six-part briefing is right in shape but everything shouts equally;
severity is not visually ranked, so a permit gap reads like a stale draft. The
sign-in page is the weakest screen in the product. Tables dominate where a
summary should lead.

Job screen: answers "what is this job" but not "what is blocking it and whose
move is it" at a glance — readiness exists but sits too low.

Estimating: the property is not visually dominant enough; typed exact length,
angle lock and snapping are the three things a professional estimator will miss
first. Undo now explains itself; redo does not exist.

Homeowner: no contract terms shown before approval (the PDF has them, the web
page doesn't); no confirmation of what happens next after paying.

Crew: close to right already — simple, offline-clear, no money anywhere.

## D. Business workflow problems

The stall points a fence owner would feel: a quote nobody follows up (the engine
exists but nothing runs it); a job that becomes ready and nobody notices; a
permit or HOA gap that only surfaces if someone opens the office tab; change
orders that can't be raised from the office when the customer phones in; and
payroll that can silently pay the wrong hours (P0 #8).

## E. Automation opportunities, by time saved

1. **Schedule `send-follow-ups`** — the whole feature is built and off. Highest
   ratio of value to work in the product right now.
2. **Server-side sweep for the exception detectors** so alerts reach people
   without a browser tab open.
3. End-of-day nudge for a clock left running.
4. Deposit received → production checklist created.
5. Job ready → suggest scheduling; materials received → recompute readiness.
6. Customer: appointment confirmation, install reminder, completion + review
   request. All off by default, opt-out respected.

## F. Missing capabilities worth building

Typed exact length and angle lock while drawing; office-side change orders and
punch list; a lightweight homeowner hub (status, documents, pay balance —
*not* a full portal); quote-opened alert to the salesperson; fence-type
profitability.

## G. Simplify (28 candidates)

`payment_status` is decided in three places with three rules; `stripe-webhook`
duplicates the shared ledger writer; a dead card-fee path hardcoded to 0; four
invite send-paths each dropping redirects differently; `deploy-functions.cmd`
deploys 3 of 16 functions against a hardcoded production ref; `billing-setup` is
marked "delete after go-live"; eleven test files each carry their own copy of
the same constants.

## H. Competitive gaps

Automated follow-up cadence and a quote-viewed alert are table stakes at Jobber,
Housecall Pro and JobNimbus — FenceFlow has the engine and hasn't switched it on.
A customer-facing project view is common; a full portal is not worth copying.
Where FenceFlow is ahead: fence takeoff from a drawing, per-foot crew pay,
offline-first field work, and trilingual operation. Also worth a look: a product
at `fence-flow.com` shares the name and overlaps the roadmap.

## I. Technical debt

`dashboard.html` is ~16,600 lines with one module extracted; `JobSync.sync()` is
~330 lines with a duplicated decision block; the crew views drift from the base
tables (three columns missing caused a P0 and a P1); `supabase/config.toml` has
drifted from the deployed function set; nothing proves the deployed edge
functions are the code that passed the gates.

## J. Production readiness

Unsigned build, test Stripe keys, no environment separation (11 files hardcode
the production ref), no release rollback, no post-release watch, no auth audit
trail, sessions that never expire, and a website that deploys ungated on every
push. Each has a named fix; none is large.

## K. Recommended order

1. **Decide the signature transition** (blocks 1, 2, 3 — they must ship together
   as one planned release).
2. **Stripe: live keys + where deposits land** (blocks 4, 5; #4 is a money-
   direction bug, not a config swap).
3. **Password reset panel** (self-contained, port from the staff console).
4. **Two one-migration fixes**: test jobs out of `jobs_crew`, and the three
   re-approval columns in — closes a P0 and a P1 together.
5. **Phone shift-correction** (P0 #8) — remove the fields or route through a
   proper correction RPC.
6. **Truth in marketing** (#9) — change the copy or the checkout.
7. Then P1 clusters in this order: permissions (signature forging), auth
   hardening, release ops (backup the key, gate the site deploy, rollback,
   post-release watch), schedule the follow-ups, sync clock strategy.
8. Then UX and performance.
