# Overnight, 29–30 October 2026

What I did while you were asleep, what needs you, and what I deliberately
did not touch.

---

## The two things that need you

**1. "Multiple crew on a job" already exists, and has never been switched
on.** The office has carried the whole feature since September — the pickers,
the access-request queue, the calendar chips naming who is on each job, the
"nobody is booked on this day" alert. Its database half is
`supabase_crew_job_scope.sql`, 1112 lines written 22 September, **never
applied**. The office hides those sections when the table is missing, on
purpose, so nothing ever looked broken.

I found it by listing every table and function the office asks for and
comparing against the live database. Four things were missing and all four
belong to that one feature.

I did not apply it, because applying it narrows what a crew login can see to
the jobs they are on, and with 6 of your 13 jobs having nobody assigned, your
crew would open the app to a shorter list than they expect. Your numbers and
the exact command are in **`docs/CREW_ON_A_JOB_PENDING.md`** — about a minute
of reading.

**2. The review email is live but inert until you mark a job done.** It
counts from the moment a job's status becomes COMPLETED, and no job in your
account has ever had that status (5 ACCEPTED, 5 SENT, 2 DRAFT, 1 DECLINED).
Rather than leave the feature unable to fire, I made the **customer's final
sign-off** count as the job being done too (r55) — that is a thing your jobs
actually record. Mark a job complete, or have a customer sign off, and the
request goes out three days later. Nothing was backfilled, so no past
customer gets chased.

**3. Your contract may be printing an instruction meant for you.**

`ContractTemplate` still carries the block
`YOUR RIGHT TO CANCEL -- [REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]`,
followed by a paragraph telling *you* to ask your attorney for your state's
wording. If you have not replaced it in Settings, `PdfExporter` prints that
default block **on the contract the customer signs** — so the customer reads a
bracketed note addressed to the contractor.

The app does warn you: Settings shows "Cancellation notice still not replaced"
under the contract terms. I cannot tell from here whether you have replaced it,
because the terms live on your phone and are never synced to the cloud.

Two reasons this matters more than it looks:

- The template's own text says leaving it out "can make the contract
  unenforceable and can carry a penalty on its own".
- It bears directly on the cancellation fee. Florida gives a customer three
  business days to cancel a contract signed at their home (Fla. Stat.
  § 520.72, plus the federal Cooling-Off Rule), and r45 charges $1 a foot on
  **every** cancellation. Inside that window that fee is likely
  unenforceable — so the app may be telling a customer they owe something you
  could not collect.

I did not write any of that wording, and I did not change the cancellation
charge. Both are legal text and a money rule, and inventing either is exactly
what I should not do unattended. **Check Settings → contract terms, and ask
your attorney about the three-day notice and whether the per-foot fee should
be waived inside it.** Then tell me and I will build whatever you decide.

---

## Shipped

**App 1.832** went out earlier in the evening (the review email, job type).

**App 1.835** is built and its gate refused it once, correctly: a project
guard, `PullFiltersDeletedTest`, requires every cloud read to exclude
tombstoned rows, and my two new photo reads deliberately do not. That guard
exists because twelve pulls were once written without the filter and deleted
change orders kept reappearing. In this case seeing tombstones is the point --
a removal is exactly what the photo pull has to learn, and the push has to
compare against them or it un-removes a photo somebody deleted elsewhere. It
has a designed exception for that: a `sees-tombstones:` marker at the call
site with the reason, which is what the fence-runs push already uses. Added to
both reads (comments only, so the built APK's behaviour is unchanged) and
re-published: **1.835 is live**, 37/37, 7/7 and 9/9 gate checks passed. Every
phone prompts on next open.

Its release note is about photos only, deliberately: the locate box and the
Clock In switch are in this repo and compiled, but they are NOT in 1.835 --
they went in after the APK was built, so they ship with the next release. The
locate answer is still usable today from the office (below).

**Photos now reach every device.** The diagnosis was not what it looked like:
uploads, compression and downloads all already worked, and there are 5 photos
sitting in your bucket right now. What was missing was the *row* — the photo
table existed only on the phone, so a second device pulled the jobs, had no
photo rows, and looped over an empty list finding nothing to download. The
table went in last night (r51); the app half went in now.

Removing a photo is now a stamp rather than a deleted row, because a deleted
row would be put straight back by the next pull. The dialog no longer says
"deleted for good" — that stopped being true. A photo still arriving shows
"On its way" instead of an empty square.

Two bugs I caught while wiring it: the uploader would have handed the
compressor an empty path for a row whose file had not arrived, and a newly
uploaded photo's path would have stayed on one phone for ever.

**The HOA packet.** An **Email HOA details to the customer** button in the
office HOA panel, with a confirmation and a "Sent <date>" marker. It goes to
the customer to forward — an approval request has to come from the homeowner,
not the fence company. The scope of work is attached as a PDF, built from the
same lines as the email body so the sheet they keep cannot say something the
email did not.

**"No utility locate" is now something somebody said** (r57), and you can set
it **from the office today** — HOA & Permits has a "This job needs no utility
locate" box, so the feature does not have to wait for an app release. It used to mean
two things at once — nobody has called 811 yet, and this job needs no digging
— so neither could be chased, and the office's locate alert could never be
satisfied for a job that genuinely needs no locate. It fired every day such a
job sat on the schedule, which is how a safety alert ends up muted for every
job at once. There is now a "No locate needed on this job" box, and the alert
respects it.

On the two fields you doubted: **you can already ignore both.** A ticket
number with no dates reads as "Clear to dig" today, with no change. I kept
them because the expiry is the one thing a busy fortnight loses track of,
which is the whole reason that feature exists — but nothing forces you to
fill them in.

**Clock In is no longer in your way.** Hidden for the owner, with a switch in
Settings → Crew view to bring it back. It is a switch rather than a deletion
because there is one shared clock slot per job, and that is what lets you
clock a crew member in from your own phone — worth keeping available for
whoever works that way.

---

## Eight checks that had stopped checking

A full test run showed 20 red. **Not one was a product bug.** Eight were
checks that had quietly stopped verifying anything; the rest are deliberate
"SHOULD"/"GAP" markers for work not done yet.

| | What had happened |
|---|---|
| 3 money checks | the harness refused an import `quote-view` gained in a refactor, so "the page adds the lines up EXACTLY, to the cent" had been failing to *load* |
| 2 billing checks | the webhook now refuses to let a test-mode Stripe event change a real company — a guard added after a sandbox event stamped a live company active. Both tests still sent test-mode events and read the handler correctly doing nothing as the handler being broken |
| 2 scheduled-email checks | the queueing moved into another function, so the check that a queued email carries an **empty** pay link (a Stripe link is locked to its amount) was reading the date-picker dialog instead |
| 1 teeth check | its own mutation was deleting a different method's code and then asserting about this one |

Each is re-aimed with a canary, so an empty slice cannot pass instead of
checking. I also added the test the test-mode guard never had.

The two I reported last night as possible money bugs were in that set — both
are **stale tests, not bugs**. The product code is correct in both.

---

## Also fixed

- A source file was **invisible to `grep`**: `_shared/mail/errors.ts` held
  literal control bytes where `\x00`-style escapes were meant, so searches
  silently skipped it. That is how a search for the error contract came back
  empty. Behaviour proven identical before and after.
- I built the **wrong crew table** (r53) before finding the real feature, and
  it would have made the real file's `create table if not exists` skip the
  correct definition — a half-applied feature that reports success. Dropped
  (r56), and r53 now refuses to run.
- One disclosure from earlier: a deploy flag of mine may have relaxed the
  follow-ups function's gateway auth. It was not declared in the repo at all,
  so the value came from whatever flag the last deploy carried. It is now
  pinned to verification-**on** in `supabase/config.toml`.

---

## Written up for you, not acted on

- **`docs/CREW_ON_A_JOB_PENDING.md`** — the crew feature above, your numbers,
  the one command.
- **`docs/DRAWING_REVIEW.md`** — you asked what the drawing needs. Six things
  that are actually weak (read out of the code, not guessed) and seven worth
  adding, ordered. The biggest: a height change mid-side can be *made* in the
  side editor but is **invisible on the drawing** — so the 4 ft / 6 ft job you
  asked for last week does not show on the picture the crew works from.

---

## Where the repo is left

`main` is at commit 837 and pushed. The office and the database are fully
live; the app is one build behind.

| | |
|---|---|
| **1.835** | published — photos across devices |
| **Office** | deployed and verified on fenceflowapp.com: the HOA send button, the "no utility locate" box, the review-request settings, job type |
| **Database** | r51–r58 applied, every one with a self-test and a canary |
| **Committed, awaiting a build** | the locate box in the app, the Clock In switch. Compiled clean, `LocateTicketTest` 16/16, the tombstone guard 4/4 |

Nothing is half-applied: the two app-side features work from the office today,
so the next release only makes them reachable on the phone as well.

## Not touched, and why

- **The drawing itself.** Every change needs a 30-minute build and a real look
  on a phone to judge, and "it looks right" is not a judgement I can make for
  you from here. The list is ordered so you can pick one.
- **Fence Runs (the list of sides and the side editor)** and **the customer
  walkthrough.** Both are design work where you asked me to ask questions.
  Next session.
- **Anything that emails a real customer**, changes a price, or touches
  billing. The review email and the HOA letter are both wired and tested, and
  neither has sent anything to anybody.
