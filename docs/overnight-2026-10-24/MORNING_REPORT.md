# FENCEFLOW & LEGACY SOLUTIONS — OVERNIGHT DEVELOPMENT REPORT

**Night of 2026-10-23 → 2026-10-24.**
**Nothing was deployed, published or pushed.** 13 commits sit on local `main`,
ahead of `origin/main`. Rollback is one command: `git reset --hard origin/main`.
A checkpoint branch `overnight-2026-10-24-checkpoint` marks the same commit.

---

## 1. Executive summary

Two features were finished end to end, one long-standing drawing bug was
explained and fixed, the pricing gate was found to be broken in a way that
would have let a release ship unchecked, and three research deliverables were
produced.

The single most important finding is not a feature: **the pricing parity gate
had not been comparing anything.** `--tests "*Parity*"` was being expanded into
the filename `ADMIN_PHONE_PARITY_2026-10-22.md`, so Gradle ran zero tests while
the gate reported that both engines agreed. A documentation filename had
disabled the check that stands between the office and the phone quoting
different prices. It is fixed, it now counts the tests that actually ran, and
it no longer accepts a cached verdict.

The second is that two things this project believes about itself are not true
(see §7), and the third is that a money worry you have been carrying is not
real: **every payment link on the database is test-mode** (§6).

**Honest limits.** I cannot run unattended for six hours; this environment is
turn-based and continues only while background work keeps re-invoking it. I did
not deploy, publish or push, because you asked for production actions to be
deferred. Edge-function TypeScript has no local type-check here (Deno is not
installable), so the scheduled sweep is committed but **unexercised** — that is
stated plainly below rather than dressed up.

---

## 2. Completed work

Verification column says how I know, not what I hope.

| # | Commit | Work | Verification |
|---|---|---|---|
| 1 | `0d5529c` | **Pricing gate: 3 defects.** Glob expanded into a filename; an empty test set read as success; a changed fixture did not invalidate a cached pass (`fixtures/pricing/*.json` is not a declared Gradle input). | Gate run green, reporting "4 Kotlin parity tests ran". Watched it correctly refuse a run where 0 executed. |
| 2 | `0ddcd27` | **Undo timeline, pure core.** One ordered timeline for the whole drawing, replacing a per-run stack whose answer to "undo the last thing" depended on which side was selected. | `DrawTimelineTest` 11/11, incl. a canary reproducing the old design and failing the cross-side case. |
| 3 | `6424bda` | **"Things vanish and come back" — cause found.** The whole canvas renders inside `if (activeRun != null && job2 != null)`; the camera was `remember(selectedRunId)`, so erasing a side reselected an arbitrary one and reset zoom/pan at the same instant. | Fixed; ruled out the alarming causes with data (§6). |
| 4 | `72e0331` `a696afe` `4c292cc` `d093955` | **"Pay here" button, phone + office.** Link minted at send time for the amount owed; one shared `PaymentLinkGate` asked by both minting sites. | a72 three-way 24/24; office-vs-app money parity 30/30; `PaymentLinkGateTest` 5/5. |
| 5 | `2b2b73d` `637a24a` `40e6688` `5561f9f` | **Scheduled email, phone + office.** r38 schema, sweep inside `mail-send`, office "Send later" + queue in drafts, phone three-choice schedule. | r38 read back from the live DB; `a111` 47/47; office page boots in a browser with zero console errors; phone compiles. |
| 6 | `0803c99` | **Undo timeline persistence.** Survives closing the drawing; legacy per-run files dropped, not migrated. | `DrawTimelineStoreTest` 8/8 on a real directory; old `DrawingHistoryStoreTest` still 8/8. |
| 7 | `b38fcf9` | **Three stale guards follow their rules.** | a24 47→51 checks, a26 15 pass, mail-mime 33 pass. |
| 8 | `f27705b` | **Research deliverables** (see §7, §8) and the Legacy Solutions site. | Form verified unable to submit; forbidden-claim scan clean. |

**Regression sweep:** all 240 `tests/*.mjs` run. **234 pass, 3 need live
credentials** (`company-crew-golden-path`, `live-rules-guard`,
`money-report-guard`), **3 failed and are now fixed and green**.

---

## 3. Outstanding issues

- **The scheduled sweep has never executed.** Committed, source-guarded by 47
  checks, but no Deno locally and no staging. First real run will be the first
  time the code path runs at all.
- **The undo timeline is not wired.** Core and persistence exist and pass;
  `SurveyViewModel` still uses the old per-run history. `canUndo` does not
  exist today, and `clearDrawingHistory()` has seven call sites each needing a
  decision. I stopped rather than rush edits to the drawing you use daily.
- **A scheduled reply cannot keep its threading** — `mail_drafts` stores
  `thread_id` but not the message being answered. Pre-existing gap in drafts;
  the sweep refuses replies rather than sending them out of conversation.
- **One security gap I could not close**, stated in the code: `has_permission()`
  has no form taking a user id, so a `SEE_MONEY` revocation between scheduling
  and sending is not caught. Closing it means editing a function many RLS
  policies depend on — not an unattended change.
- Not started: move-scope chooser, floating tool button, gates (all four
  options), fence type/supplier on a run.

---

## 4. Website status

- **`website/dashboard.html`** — "Send later" beside Send; the queue appears in
  the drafts list showing when each goes out, cancelled by the discard button
  already there. Verified in a real browser: page boots, **zero console
  errors**, all 37 resources resolved (so the module executed and the listener
  attached).
- **`website/legacy/`** — new Legacy Solutions site, noindex, house style taken
  from `fence-solutions/index.html`. Renders correctly in dark mode at 375px.
  **The contact form cannot submit** — no `action`, no `method`, button is
  `type="button"`, submit cancelled, example `fetch` left inside a comment. I
  verified this rather than trusting it.
- **Mobile audit:** `index`, `welcome`, `quote`, `lead`, `legacy`,
  `fence-solutions` — **0px horizontal overflow at 375px** on all six.
- Nothing is deployed. Pushing to `main` auto-deploys Pages, so I did not push.

---

## 5. Mobile application status

- **Compiles clean** (`BUILD SUCCESSFUL`) with everything below in it.
- **Improved:** the drawing keeps its place when selection changes; the quote
  email can carry a Pay here button; the quote can be scheduled for later;
  fence type on an estimate reads in plain words.
- **Shipped earlier tonight as 1.767** (before the overnight brief): the
  dragged-corner fix. Everything since is committed but **not in any APK**.
- **Needs your testing on a real phone:** schedule a quote and confirm the
  toast; open a drawing, erase the selected side, confirm the view no longer
  jumps; send a quote and confirm the Pay here button appears when you are
  Owner/Manager with a payment connection.

---

## 6. Security report

My own findings, each verified. (A dedicated read-only audit agent was still
running when this was written; its output, if it completed, is
`SECURITY_AUDIT.md` in this folder — read it before trusting any "clean" here.)

- **Privilege escalation prevented before it shipped.** A scheduled draft names
  an `account_id`, but `mail_drafts`' insert policy checks only author and
  company — *not* that the account belongs to that company. With no user
  session the sweep would look that account up as service role, and
  `caller.ts`'s own comment says "never look an account up by id with the admin
  client alone". The sweep therefore **refuses any draft naming a mailbox
  account** and sends only via FenceFlow.
- **Cron cannot become an open relay.** `anon` holds INSERT on `mail_drafts`,
  but RLS requires `author_id = auth.uid()`, and `auth.uid()` is null for anon,
  so the comparison is never true. Verified against the live policy.
- **New columns inherited their grants.** `authenticated` SELECT went 14 → 21
  columns after r38 — checked because a per-column grant once took all company
  email down.
- **All 23 payment links are `livemode: false`.** 16 disagree with their stored
  deposit, but none can charge a real card and `already_paid` is 0.00 even on
  ones marked paid. **The "five pending links don't match their deposits" worry
  is not a live money risk.**
- **No drawing data is corrupt and nothing is phantom-deleting it:** 0 of 266
  coordinate pairs unreadable (with a planted control proving the check fires);
  22 tombstoned sides, all signed by your account, **0 blank-signed**.
- No secrets were printed anywhere in this report or in the committed docs.

---

## 7. Competitor comparison

Full matrix with per-claim sourcing: `COMPETITORS.md`. Two corrections to
things this project has been telling itself:

- **Takeoff is not unique.** ArcSite sells post/panel/picket/concrete takeoff;
  Fence Cloud generates material breakdowns. The defensible claim is narrower:
  nothing found combines takeoff, crew time, payments, an offline app and a
  published price under ~$350/month.
- **Offline is not unique.** ArcSite and ServiceTitan both work offline;
  Housecall Pro is read-only offline; Jobber has essentially none. FenceFlow's
  real edge is offline **editing** inside a small-shop product.
- **QuickBooks is a CSV export, not a sync** — `dashboard.html`'s own comment
  says "Not a sync" — against six rivals with real sync. Probably the biggest
  commercial gap.
- Most-named missing features across rivals: consumer financing, automated
  quote follow-up, two-way SMS.
- **Evidence limits:** Capterra, G2 and Reddit were unreachable (403/blocked),
  so every complaint cited is a search summary, not a review page. FenceFlow's
  own prices came from project notes, not live Stripe.

---

## 8. Business growth findings

`LEADS.md` — **63 fencing companies**, 25 rated in Tampa Bay, each with the
source URL its details came from. Top-scoring: Smith & Sons Fence (Riverview)
and AJ Fence (Lakeland), neither showing an online quoting tool.

- **No "hot" leads found.** No Florida job posting named estimating or
  field-service software, and owner forums could not be read. Said plainly
  rather than padded.
- Three outreach emails are included, **marked DRAFTS**. Nobody was contacted,
  no form was submitted, nothing was sent.
- Reminder carried forward: **fenceflow.com is a live rival** ("FenceFlow LLC")
  with a Riverview branch. USPTO still unchecked.

---

## 9. Decisions and tradeoffs

- **Sweep inside `mail-send`, not a new function.** Alternative was a separate
  scheduler calling it. Rejected: a72 requires one sender, and a function
  calling another server-to-server is refused at the gateway before it runs.
- **Mint the payment link at send time** (your choice). Alternative was reusing
  an existing link — rejected because it would mostly be absent or stale.
- **No payment link is ever queued.** I built the office "Send later" and then
  found I had reintroduced the staleness problem through the back door: the
  office mints at *compose* time, so scheduling would queue a link that could
  be wrong by morning. Now stripped, with the reason shown to you.
- **Presets, not a date picker, on the phone.** The reason to schedule is "not
  at this hour"; three taps beat six in a truck.
- **One `PaymentLinkGate` rather than a copied condition.** Copying a three-part
  money gate is how one copy quietly loses a check.
- **I edited four test files.** Each followed a rule to where it moved; none
  was relaxed. a24 grew 47→51 checks. I would rather you scrutinise this than
  find it in a diff.

---

## 10. What to check tomorrow

1. **Office → Mail → compose → "Send later".** Pick a time, confirm the row
   appears in Drafts showing when it sends, and that Discard cancels it.
2. **Schedule a quote from a job compose** and confirm the message says the pay
   button was removed — then confirm the body in the row really has no
   `buy.stripe.com` line.
3. **Phone → a job with an email → "Send later"** → pick tomorrow 8am, confirm
   the toast and that the office's Drafts list shows it.
4. **Open a drawing, select a side, zoom in, erase that side.** The view should
   stay where you left it.
5. **Send a quote normally** and confirm the Pay here button appears and goes
   to Stripe for the right amount.
6. **`website/legacy/index.html`** in a browser — judge the words, and decide
   the naming question in §11.
7. Skim `COMPETITORS.md` §"what FenceFlow does better" and tell me which of the
   five recommendations you actually want.

---

## 11. What needs your approval

1. **Set `MAIL_SCHEDULED_TRIGGER_SECRET`** — same value as a Supabase function
   secret *and* a GitHub Actions secret. **Scheduled email does nothing until
   this exists.** Anything queued simply waits; nothing is lost.
2. **Deploy the edge functions** — `mail-send` carries the sweep and the
   two-button mail change. Not live until deployed.
3. **Publish an app build** — everything in §5 is committed, in no APK.
4. **Push to `main`** — this auto-deploys the website, including `legacy/`.
5. **Overtime policy.** `CrewPay.kt` pays hours × rate; the office applies
   40h/1.5×. "Pay" has two answers across the two halves. Business decision.
6. **Business naming.** Your fence business already appears under four
   different names in the app's own output; "Legacy Solutions" would be a
   fifth. Also worth checking the name is free in Florida.
7. **1.750's release notes begin with the literal text `--notes`** — showing in
   the update prompt for anyone still on that version. One-row fix, on your word.

---

## 12. Next development priorities

1. Wire the undo timeline to the screen (6 edit sites, 7 `clearDrawingHistory`
   decisions) — the feature you asked to "work flawlessly".
2. Move-scope chooser ("ask me what to move"), which depends on it.
3. Switch on scheduled email and watch the first real sweep.
4. One floating drawing-tools button, to free canvas space.
5. Gates: all four options you asked for.
6. Fence type / supplier on a run, with an unmissable substitution flag.
7. Live QuickBooks sync — the clearest competitive gap.
8. Quote follow-up, using the scheduled-email machinery now in place.
9. Give `has_permission` a uid form, closing the §3 security gap.
10. A staging target, so edge functions stop being verifiable only in production.

---

## 13. Evidence

- **Commits:** `0d5529c`, `0ddcd27`, `6424bda`, `72e0331`, `a696afe`,
  `4c292cc`, `d093955`, `2b2b73d`, `637a24a`, `40e6688`, `0803c99`, `b38fcf9`,
  `f27705b`, `5561f9f` — all on local `main`, unpushed.
- **Research:** `COMPETITORS.md`, `LEADS.md`, `LEGACY_SOLUTIONS.md`,
  `MASTER_BACKLOG.md`, and `SECURITY_AUDIT.md` if the audit completed.
- **Test evidence:** 234/240 node suites; `a111` 47/47; a72 24/24; a110 30/30;
  a24 51/51; `PaymentLinkGateTest` 5/5; `DrawTimelineTest` 11/11;
  `DrawTimelineStoreTest` 8/8; `WholeDrawingMoveTest` 15/15.
- **Migration:** `supabase_r38_scheduled_email.sql`, applied and read back.
- **Not evidence of anything:** the scheduled sweep has not run; the phone
  changes are in no APK; nothing is deployed.
