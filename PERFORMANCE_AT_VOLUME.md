# What FenceFlow actually does at 1,500 jobs

**First time this has been measured.** Every previous statement about
performance in this project, including several of mine, was reasoning rather
than observation. These numbers come from a real company's worth of data
generated inside a database transaction that was rolled back, so nothing was
left behind and no detector was tripped.

## The headline

**The database is not the bottleneck.** Every read the office makes is
single-digit milliseconds at this size. What costs is the amount of data sent
to the browser before anything is drawn.

| What the office reads | Rows | Sent to the browser |
|---|---|---|
| Line items, as it used to (everything) | 15,000 | 7.8 MB |
| Line items, as it does now (recent window) | 6,000 | 3.1 MB |
| Every job (deliberately not bounded) | 1,505 | 3.8 MB |

Bounding the line items on 12 September removes **4.7 MB** and nine thousand
objects the browser would otherwise have to build.

## A correction I owe you

I described that bounding work as making the reads faster. That was wrong. The
query times barely moved, and the bounded read is in fact marginally *slower*
than the unbounded one at this size, because filtering on a date costs a little
and excludes nothing the database struggles with.

It was still the right change — but for the transfer and the rendering, not for
the database.

I also got the first measurement wrong and caught it: I spread the test data
over ten days, so an eighteen-month window excluded nothing and I was measuring
the filter's cost with none of its benefit. Spread properly over three years, it
excludes 60% of the rows.

## Where the remaining cost is

About **7 MB crosses the wire before the office paints anything** at this size.
Roughly half of that is the jobs table, which is deliberately not bounded
because the office genuinely uses every job.

I looked for a cheap win there and did not find one. A job row is about 2.5 KB
spread across many columns; no single column dominates, so there is nothing to
drop that would matter. Trimming it means listing the columns each screen needs,
per table.

## The options, and what each costs

**1. Leave it.** At 1,500 jobs the office loads about 7 MB once, then works from
memory. On a laptop that is a slow first paint, not a broken product. No company
on the system is near this size.

**2. Ask for only the columns each screen uses.** The largest saving available,
and the riskiest change in the list: a column somebody forgets shows up as a
blank figure or a missing name, silently, on one screen, possibly months later.
If this is done it needs a test that compares the requested columns against the
ones the page actually reads.

**3. Load the jobs list in pages as it is scrolled.** Helps first paint without
touching what any screen can see. More work than it sounds, because several
panels count and total across all jobs, and those totals must not quietly start
counting only the page on screen — that is the bounded-slice-as-a-total mistake
this project has already had to fix twice.

**4. Give the phone a delta sync.** Separate from the office, and probably
worth more: the phone currently re-downloads every table in full on a
sixty-second heartbeat. This measurement did not cover the phone.

## Recommendation

**Leave it until a real company approaches this size**, and do option 4 first
when the time comes, because the phone is on a mobile connection and pays for
every byte twice. Option 2 is the biggest office win and the easiest one to get
quietly wrong; it should not be done without the test that keeps it honest.

Confidence: high on the numbers, which are measured. Moderate on the
recommendation, because I have not measured the browser's own render time or a
phone's cold sync — only what the database does and what it sends.
