# Two known problems in offline sync -- what they cost you, and what fixing them requires

Written so you can decide without needing to read code. Both problems are
real, both were left alone on purpose until you say go, and both need a
one-time update to how phones store data (called a "migration") to fix
properly.

## Problem 1: a phone with the wrong clock can silently overwrite good data

**What happens today.** When two phones (or a phone and the office) edit
the same job while one of them is offline, the app has to decide whose
version wins once they're both back online. Right now it decides using
each phone's own clock -- literally the time shown in the phone's clock
app at the moment of the edit. Whichever edit claims to be "later" wins,
and the other one is thrown away with no notice to anyone.

**What that costs you.** If a crew phone's clock is wrong -- an hour fast
from a timezone glitch, a dead battery that reset it, anything -- that
phone wins every disagreement it's ever in, even against edits made
afterward by someone with a correct clock. Worse, if that same phone's
clock is slow, it silently loses everything it does: a foreman corrects an
address in the field, drives back into signal, and the correction is gone,
overwritten by whatever the office had before, with nothing telling anyone
it happened. This already happened once with a different bug (a payment
webhook update was accidentally treated as an "edit" and stomped on real
office corrections) -- that one is fixed. This is the same shape of
problem, just triggered by a bad clock instead of a bad update.

**Proof it's real.** I checked the code path end to end. The server (your
Supabase database) does the responsible thing -- it stamps every real edit
with its own trustworthy clock, and I confirmed with a live, read-only,
change-nothing test that a client cannot fake that timestamp on the
server's own copy. The problem is entirely on the phone: the phone records
"when I made this edit" using its own possibly-wrong clock, and later
compares that self-reported time directly against the server's honest
time. I found the exact two lines doing this (`Repository.kt` where a job
is saved, and `JobSync.kt` where two copies are compared) and the exact
place a working system would need a different signal instead of a clock.
See `supabase_evidence_probe_clock_skew.sql` for the runnable proof (you'd
need to run it yourself -- I didn't have your database password in this
session, only read access to the code).

**The fix.** Instead of trusting either phone's clock, give every job (and
a few other records: fence run drawings, price lists, your material
catalog) an edit counter -- a number that goes up by exactly one every time
someone actually changes something, assigned by the server, never by the
phone. A phone can then say "I last saw version 7" and the server can say
"it's on version 9 now, someone else changed it since you last looked" --
no clocks involved anywhere in the decision. This is a well-understood,
low-risk pattern (it's how most systems that let multiple people edit
things offline actually work).

**What you have to accept.** The counter itself is a small, safe database
change -- I'd stake a lot on that part causing zero problems. What it does
NOT do by itself is decide what happens when two people really do edit the
exact same job while both offline at the same time -- it can only detect
that this happened. Today's system always picks a winner, silently, even
when it picks wrong. The fixed system would need to either pick a winner
in a smarter way, or actually tell somebody "these two edits collided,
which one do you want to keep" -- and building that "somebody has to
decide" screen is real, separate app work beyond just adding the counter.
I did not build that here; I only prepared the ground for it.

**My recommendation: fix this one. Confidence: high.** A wrong-clock phone
silently destroying real data is the kind of bug that erodes trust in the
whole app the one time someone notices an address reverted or a price
change vanished, and by then it's too late to explain. The groundwork
(the database migration) is safe and reversible; the follow-up work
(actually handling a detected collision) can be scoped and prioritized
separately once the counter exists.

## Problem 2: deleting a job can destroy crew hours nobody's seen yet

**What happens today.** Every clocked-in shift on a job is linked to that
job in the phone's local database. If you delete a job, the phone deletes
every time entry linked to it in the same instant -- including hours that
were recorded offline and have never reached the cloud. Hours that already
made it to the cloud are recoverable from the trash there. Hours that
only ever existed on that one phone are gone, permanently, the moment the
job is deleted, with nothing recorded anywhere that they ever existed.

**What that costs you.** A crew member's real, worked hours -- possibly
disputed pay, possibly a job-costing number you'd want later -- disappear
without a trace if the job they were logged under gets deleted before the
phone next syncs. **A warning already ships today** that tells you this is
about to happen before you delete the job, which covers the case where the
person deleting reads it. It does not cover a job deleted from the office
while a phone still has unsynced hours sitting on it in the field.

**Proof it's real.** This lives entirely inside the phone's own local
database (not your cloud database), specifically in how the "time
entries" table is linked to the "jobs" table -- a link configured to
auto-delete children when the parent is deleted. I confirmed this by
reading the exact configuration (`Entities.kt`) and the exact delete
function that triggers it (`Repository.kt`). I could not demonstrate this
running live without a phone or an emulator to install the app on, which
this task didn't have set up -- I've written the exact test that would
prove it on a device (`tests/DeletedJobCascadeEvidenceTest.kt`), ready to
run the moment someone has a device handy, with a built-in check that
catches the test lying to itself (confirming the hours really existed
before the delete, not just assuming it).

**The fix.** Change that link so deleting a job detaches its hours instead
of destroying them -- the hours become "orphaned" (no job attached) but
stay in the database, safe, exactly like the warning today implies should
already be happening.

**What you have to accept.**
- This is a bigger, riskier change on the phone than Problem 1's fix: it
  requires rebuilding that whole table on every phone the next time the
  app updates, rather than a simple, cheap addition. I've detailed exactly
  what that rebuild does and why it's still safe (nothing is deleted
  during the rebuild itself, and a crash partway through cannot corrupt
  anything -- it just retries) in the technical writeup.
- Once hours can exist with no job attached, every screen that shows
  hours -- timesheets, reports, exports -- needs to handle "8.5 hours,
  job: (deleted)" sensibly instead of assuming every entry has one. That's
  real app work beyond the database change itself, not included here.
- **Honest counter-argument for leaving this alone:** the warning that
  already shipped may cover the situation often enough in practice. This
  bug only bites when a job with real offline hours on some *other* phone
  gets deleted before that phone syncs -- narrower than it first sounds,
  and if you or your team rarely delete jobs outright (versus marking them
  cancelled), it may not be worth the table-rebuild risk and the follow-on
  UI work right now.

**My recommendation: worth fixing, but lower urgency than Problem 1.
Confidence: medium.** The failure mode is worse when it happens (permanent,
untraceable loss of a real person's pay record) but happens less often
(needs a specific timing coincidence, and there's already a warning in the
common path). If you'd rather hold off, a cheap partial mitigation exists:
train the team to archive/cancel jobs instead of hard-deleting them when
any hours might be at risk, until the real fix is scheduled.

## What I did NOT do

I did not touch any app code, any existing file, or your live database. I
did not run any SQL that writes. Everything above is backed by:
- `supabase_evidence_probe_clock_skew.sql` -- a read-only, self-rolling-back
  proof for Problem 1, for you (or whoever has the database password) to
  run.
- `supabase_conflict_version_patch.sql` -- the written, not-yet-run database
  migration for Problem 1's fix.
- `ROOM_MIGRATIONS_defects_1_and_2.md` -- the exact phone-database migration
  statements for both fixes, in the same style as every migration already
  shipped in this app.
- `tests/DeletedJobCascadeEvidenceTest.kt` -- the test that proves Problem 2
  on a real device, ready to run.
