# The 1 October price collapse — what happened and what to do

Written for you, 2 Oct 2026. Nothing has been applied. The repair is written and
switched off, waiting on you.

**Checked over again on 2 Oct by a second pass, and three things changed.** Every
number in the first version held up when re-measured against the live database.
But the repair was leaving 13 more lines dead, on four jobs, including one job it
never mentioned; it claimed it would leave an audit entry and it will not; and it
could be applied by accident. All three are fixed. The sections marked **added 2
Oct** are the new parts.

Jobs are numbered, not named, so this file can be shared without customer
details in it.

---

## The money, first

Three jobs you already signed now show a much smaller price than the one that
was agreed.

| Job | You agreed | It now says | Short by | Where the job is |
|---|---|---|---|---|
| Job 1 | $15,540.00 | $5,853.81 | **$9,686.19** | Work finished, in build |
| Job 3 | $35,240.00 | $13,266.87 | **$21,973.13** | Accepted, not started |
| Job 5 | $870.00 | $200.00 | **$670.00** | Signed |
| | | | **$32,329.32** | |

Two deposits were cut at the same moment and are still cut:

| Job | Deposit was | Deposit now | Short by |
|---|---|---|---|
| Job 1 | $5,896.82 | $2,158.45 | **$3,738.37** |
| Job 3 | $22,157.13 | $8,101.68 | **$14,055.45** |
| | | | **$17,793.82** |

Both deposit figures are confirmed from the audit trail, not guessed.

Three more jobs lost materials but no money moved on them. Job 2 and Job 6 are
drafts nobody ever agreed to. Job 4 is signed at $200 and still says $200.

**No real money has been lost yet.** Nothing has been overpaid or underpaid. Every
payment record on these jobs is a test-mode record, and the amount paid on all
six is zero. What is wrong is the prices, not your bank.

---

## What was lost

On 1 October at 5:26 pm, over 19 seconds, 64 priced material lines vanished from
six jobs. Panels, posts, caps, concrete, gates, hinges, latches, handles, braces,
trim.

Added up at the prices recorded on them, that is **$33,978.36 of materials**.

| Job | Lines lost | Materials |
|---|---|---|
| Job 1 | 18 | $9,475.34 |
| Job 2 | 5 | $691.65 |
| Job 3 | 13 | $21,510.71 |
| Job 4 | 4 | $154.29 |
| Job 5 | 10 | $652.54 |
| Job 6 | 14 | $1,493.83 |
| | **64** | **$33,978.36** |

**Nothing is actually destroyed.** The lines were marked deleted, not erased. Every
quantity and every price is still readable. That is the only reason this is
fixable.

Five of the six jobs then re-priced themselves one second later, to a figure made
of labour and gates with no materials in it. That is where the small numbers in
the first table come from.

## It was not you

You did nothing. It was the app.

Three things each say so on their own:

1. Every delete you have ever done in this table carries your email address — all
   20 of them. These 64 carry a blank. A blank is what the phone writes.
2. Not one of your hand-typed extra lines was touched. Only the ones the app
   generates went. A person tapping would not be that tidy.
3. 64 lines across 6 jobs in 19 seconds. Nobody taps that fast.

The phone has a cleaner that deletes material lines it thinks belong to no fence.
When a job comes down to a phone for the first time, the lines and the fences
arrive at the same time rather than fences first — so for a moment the lines look
like they belong to nothing, and the cleaner deletes them. It does not just
delete its own copy. It deletes them from the cloud, for every device and for the
office.

All 64 lines did name a fence in the cloud. The phone deleted rows that were
perfectly good on the server.

Someone else is fixing that code now. This file is only about your data.

---

## The 13 other lines (added 2 Oct)

The first version of this file restored 64 lines — the 1 October burst. But the
phone's cleaner did not only run on 1 October. It ran on nine other days in
August and September too, and it killed **13 more lines that are still sitting on
jobs you still have.**

$523.82 of materials, which is small. Here is why it matters anyway:

| Job | Lines | Materials | What's missing |
|---|---|---|---|
| Job 1 | 2 | $99.36 | 4 gate posts, 2 end posts |
| Job 3 | 1 | $33.12 | 2 gate posts |
| Job 4 | 9 | $325.10 | a complete gate: brace, end post, gate panel, handle, hinge set, latch, line post, stiffener, trim |
| Job 7 | 1 | $66.24 | 4 gate posts |

**Job 1 and Job 3 are two of the three you already signed.** If the repair only put
back the 64, then you would press re-price and the total would come out a little
under what you signed — by the cost of a few gate posts plus markup and tax —
and nothing would tell you why. You would be left wondering whether the repair
had worked. That is the whole reason to include them.

**Job 4 is the one to look at.** Its nine missing lines are a complete gate. Job 4
currently says $200.00, with a $160 deposit and a $336.82 balance request that
agrees with neither. The first version of this file listed those three numbers as
an unexplained mystery. The likely answer is now obvious: $200 is your minimum
job charge, which is what a job falls back to when its materials have been
deleted out from under it. I have **not proved** that — it's a guess with a good
reason behind it — but restore Job 4's nine lines before you judge that job.

**Job 7 is new, and it is a separate decision.** It is accepted at $19,810.00 and
has no material lines on it at all. The phone took one line, 4 gate posts. The
*other thirteen* — $10,847.64 of panels, posts, caps and concrete — **you deleted
yourself**, at 2:12 am on 11 September. Those stay deleted; they are your work and
the repair will not touch them. Putting back the one gate post line is honest
but leaves a $19,810 job holding a single $66.24 line, which is arguably stranger
than leaving it alone. So it has its own switch and is **off by default**.

> **Whatever you decide about Job 7, do not press re-price on it.** Its total of
> $19,810 is intact and matches what was accepted, but there are no materials
> behind it. A re-price would recompute it from labour and whatever lines exist
> and collapse it. That trap is there whether or not you run this repair — it is
> written down here because adding Job 7 to the repair is what will make you
> look at it.

Nothing about the 13 is riskier than the 64. Measured across all 77 together: no
two lines claim the same material on the same fence, no job has a live line that
any restored line would duplicate, every one is an app-generated line rather than
something you typed, and every one points at a fence that still exists.

## What your customers can see right now

This is the part that matters most, and it has one urgent piece.

**The repair does not touch the "needs approving again" flag, and cannot.** Checked
again on 2 Oct, function by function: nothing that fires when a line item changes
can either raise that flag or clear it, and the repair writes nothing to the jobs
themselves. The flag still reads 28 September on Jobs 1, 3 and 5 after it runs.
That matters because that re-approval is what collects the $1,522.22 of sales tax
those three quotes under-charged, and losing it would cost you real money.

**Nobody has been asked to re-sign because of this.** The "needs approving again"
flag on Jobs 1, 3 and 5 was raised on 28 September, four days before any of this,
and it was raised for a good reason: sales tax had been worked out on part of the
materials instead of all of them, so those three quotes were **short** by
$456.38, $1,045.53 and $20.31. That request is legitimate and you want it.

**The urgent piece.** While a job is waiting to be approved again, the quote page
shows the current price — which is now the wrecked one. Jobs 1 and 3 have had
their links opened before.

If one of those customers opens their link and taps Approve, the app records the
price the page showed as the agreed price. **That would replace $15,540 with
$5,853.81, or $35,240 with $13,266.87, permanently.** The real agreed figure is
still stored safely today. An approval on the wrong number is the one step here
that cannot be undone.

Nobody has approved yet. The door is open but nobody has walked through it.

---

## What the repair does

`supabase_a64_restore_tombstoned_line_items.sql`, in the project root. Marked DO
NOT APPLY at the top.

It un-deletes lines, named one by one. It changes nothing else — no price, no
quantity, no job, no deposit.

**It has three switches, all off (added 2 Oct).** As the file stands, running it
does nothing at all: it checks everything against the live database, writes
nothing, and stops with a message. That is deliberate — running it by accident,
in the wrong terminal, costs you nothing. To make it act you open the file and
change `NO` to `YES` near the top:

| Switch | What it restores | |
|---|---|---|
| `ARM_64` | the 64 lines of 1 October, 6 jobs | $33,978.36 |
| `ARM_12` | the 12 August lines on Jobs 1, 3 and 4 | $457.58 |
| `ARM_J7` | the 1 line on Job 7 | $66.24 |

**Set `ARM_64` and `ARM_12`.** That is 76 lines and $34,435.94, and it is the
combination that makes your re-priced totals actually reconcile. `ARM_J7` is
yours to think about — read the Job 7 paragraph above.

Anything other than exactly `YES` counts as `NO`, so a typo refuses instead of
guessing.

**Run it once before you arm it.** You will get an error that starts
`a64 DRY RUN` and lists every job. That error IS the success message for a dry
run — it means every safety check passed against your live data and nothing was
written. I ran exactly that on 2 Oct and all the checks passed.

**It will not make any job's price jump back up.** The headline total on a job is a
stored number, and putting the lines back does not recalculate it. After the
repair, each job has its full material list again but still shows the wrong total
until you press re-price.

That is on purpose. Putting the lines back is quiet, reversible, and invisible to
customers. Re-pricing is the step that changes what a customer sees. You should
be the one to take that step, knowing you took it.

Before it touches anything it checks, and refuses outright if anything is off:

- Exactly 64 lines, on exactly those 6 jobs, all still deleted.
- Every line still has the quantity and price I measured.
- **No job has already had replacement lines generated.** This is the dangerous
  one — restoring on top of regenerated lines would double the price. All six
  jobs hold zero lines today, so there is nothing to double. The check runs again
  when you apply it, in case you press Suggest first.
- Every line still points at a fence that exists.

It is one transaction. If any check fails, nothing is written at all. There is no
half-repaired state. I tested that specifically rather than assuming it: the
whole file goes to the database as one query, so an error anywhere in it throws
away everything before it.

**One correction (added 2 Oct): this will NOT appear in your audit trail.** The
first version of this file said it would. It was wrong. The audit trail only
records changes to a line's quantity or price, and this changes neither — it only
flips the "deleted" mark. So after you run it there will be no log entry saying
64 lines came back. **Keep the table the file prints at the end.** That table is
the only record of what happened, and it now includes a column showing how many
phone-deleted lines are *still* dead on each job — which should read 0 everywhere
if you armed both switches.

To undo it, re-mark those same lines deleted. It writes nothing else.

---

## What it costs you if it goes wrong

Honestly: not much, and this is the reassuring part.

- **If the restore misfires, it writes nothing.** Every check refuses instead of
  guessing, and the whole thing is one transaction.
- **If the restore is wrong anyway, it is reversible.** The lines go back to
  deleted and you are where you are now.
- **The thing that is genuinely one-way is a customer approving the wrong price.**
  That is a risk whether or not you run the repair — the repair reduces it,
  because once the lines are back and you re-price, the page shows the right
  figure again.

The worst realistic outcome of doing nothing is a customer approving $13,266.87
on a $35,240 job. The worst realistic outcome of the repair is that you have to
re-price six jobs by hand.

---

## The order to do it in

0. **Run the file as it is first**, with every switch still `NO`. You get the
   `a64 DRY RUN` error and nothing is written. If that comes back clean, the
   checks pass on today's data.
1. **Restore the lines** — set `ARM_64` and `ARM_12` to `YES` in
   `supabase_a64_restore_tombstoned_line_items.sql` and run it. Safe,
   reversible, invisible to customers. Save the table it prints.
2. **Re-price Jobs 1 to 6**, and check each total against what you signed. **Not
   Job 7** — see the Job 7 warning above.
3. **Put the two deposits back** to $5,896.82 and $22,157.13 if you still want
   those figures. The repair does not touch deposits.
4. Then the 28 September tax re-approval does what it was built for: it shows
   those three customers the corrected, slightly higher figure and asks them to
   agree.

If you want to shut the approval window **before** step 1, there is a separate
file, `supabase_a70_protect_exposed_quote_links.sql`, written by someone else. Its
Option B kills the three existing quote links so nothing can be opened or
approved. The cost is a phone call and a fresh link to each of those three
customers. It does not fix anything on its own.

Do not press Suggest or re-price on the six jobs before step 1. Doing that
generates replacement lines, and then the restore will correctly refuse to run.

---

## What I could not determine

- **Whether the deposit trigger will ever do this again.** The rule that rescaled
  the two deposits still exists in the database but is no longer attached to
  anything, so it cannot fire today. I did not establish why it was detached or
  whether something intends to put it back.
- **Why Job 4 has a $336.82 balance request and a $160 deposit against a $200
  total.** Those three numbers do not agree with each other and they predate this
  incident. **Probably explained now** — see "The 13 other lines": Job 4 lost a
  whole gate on 29 August and $200 looks like your minimum job charge. That is a
  reasoned guess, not a proof. Restore its nine lines, re-price it, and see.
- **Why Job 7 has no materials and a $19,810 total.** You deleted its 13 material
  lines yourself on 11 September. Why you did, and whether that $19,810 was ever
  backed by a material list, I could not tell. Nothing was written, nothing
  assumed — just do not re-price it until you know.
- **Job 1 says the deposit is paid, but the amount paid is zero.** Its status is
  "deposit paid", yet the amount recorded as received is $0.00 and every payment
  record on it is a test-mode one. Either a real payment was taken outside the
  app and never recorded, or the status was set by a test. This predates the
  incident and I could not tell which. Worth a look, because it is the only place
  in any of this where the app claims money arrived.
- **There is no record of the price collapse itself.** The deposit changes are in
  the audit trail. Total changes are not audited at all — zero records, ever. So
  the five re-prices are reconstructed from timestamps, not read off a log.
- **Whether the live quote page behaves exactly like the code I read.** I read the
  source in the repo. The deployed version was published on 1 October and looks
  current, but I cannot read deployed code directly, so treat the "customer taps
  Approve" description as very likely rather than proven.
- **The repair has not been executed.** Every one of its safety checks was run
  separately as a read-only query and each returned the number it needs, and I
  confirmed they are not toothless by feeding them bad data and watching them
  object. But the file as a whole has never been run, because running it is
  applying it. Expect to read its output rather than assume it.
- **This has happened before, in smaller bursts** — and that question is now
  answered. See "The 13 other lines" above. 13 of those 36 are on jobs you still
  have and are now in the repair; the other 23 are on jobs you have since deleted
  (or on no job at all) and are left alone.

  The arithmetic closes, which is how I know none of it is missed: 120 deleted
  lines in the table, 20 deleted by you, 100 by the phone — 64 on 1 October plus
  36 older. Of those 36: 13 on live jobs, 22 on deleted jobs, 1 with no job row.
  All of it re-counted on 2 Oct.

## The decisions only you can make

1. **Restore the lines, yes or no?** I think yes, and I think you want `ARM_64`
   and `ARM_12` together — 76 lines, $34,435.94. They are your materials, the
   prices are intact, and nothing on these jobs can be doubled by it.
2. **Job 7's one line — in or out?** Either answer is defensible. Out is simpler.
   Whichever you pick, don't re-price that job.
3. **Do you want to shut the three quote links first?** That depends on whether
   you think one of those customers might open their link and tap Approve in the
   next few hours. If yes, a70 Option B buys you time at the price of three phone
   calls. If no, go straight to the restore.

Everything else — re-pricing, the deposits, the tax re-approval — follows from
those two.
