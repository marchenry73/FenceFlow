# Where AI would actually earn its place in FenceFlow

Two items on the launch list are really one decision: study the AI sales video
and decide what applies, and "AI where it earns its place". This is that
decision, written to be argued with.

**One thing I could not do.** I tried to read the video you linked
(`AjnWKYhq7-w`, "AI Sales Team In 10 Min"). YouTube returns only the page shell
to me: no description, no transcript. So everything below is graded against what
FenceFlow actually has and against how this category of tool generally works —
not against that specific video. If three lines from you on what struck you in
it would change the sort, send them and I will redo it.

---

## Start from what is already true

FenceFlow is not short of sales machinery. Live today:

- A single ranked list of who to chase, ordered by value times how long they
  have waited, with the ranking shown rather than hidden in a sort order.
- Speed to lead, recorded on the job itself.
- Fourteen exception detectors — a quote gone quiet, approved with no deposit,
  clocked in too long, priced on unconfirmed catalog rows, and more.
- Four automation rules that move a job forward on an event, off until switched
  on, none able to spend or delete.
- Pipeline by stage, conversion, lead sources, cycle times.

The gap is not that the system does not know what to do. It is that **nothing
ever reaches the customer.** A quote goes quiet and the product writes a note.

## The four buckets

**Already exists, and no model would improve it.** The chase ranking, the
detectors, the pipeline figures. These are arithmetic over your own data. A
model asked to do them would be slower, cost money per answer, and occasionally
be wrong in a way nobody could audit. Leave them exactly as they are.

**Exists but is half-built, and the fix is not AI.** The automation rules only
write notes and flags. Speed to lead is recorded by hand on four of nineteen
jobs, so the number it reports is not yet a measurement of anything. Both are
plumbing jobs. Doing them with a model would be using the most expensive
available tool for the least interesting part.

**Genuinely missing, and blocked on something duller than AI.** Automated
outreach, follow-up timing, task assignment. Every one of these needs a channel
that can reach a customer, and FenceFlow has none: the mail key is unset, so
nothing can send. That is the actual blocker, and no amount of model changes it.
Build the channel first; then decide whether the words in the message need a
model at all, which for "your quote is still open, shall we book you in?" they
almost certainly do not.

**Do not copy, whatever the video shows.** Anything that talks to your customer
without you seeing it first. That is not caution for its own sake — it is your
competitive position. You sell numbers a person can audit, against competitors
who front estimating with a model. An AI that emails a homeowner a price, or
negotiates, or promises a date, is the one feature that would make FenceFlow
the same as everything else it is better than.

## So where does a model actually earn its place?

Three candidates, in order of how confident I am.

**1. The forward half of the daily briefing.** Today it says what happened in
the last twenty-four hours, and it is deliberately built only from timestamps
that record something real. What it cannot say is what is *about* to go wrong:
which quotes look like they will close, which jobs are drifting. That is a
judgement over a small amount of your own data, shown to you and nobody else,
where being occasionally wrong costs a raised eyebrow. Best fit on the list.

**2. Questions asked in your own words.** "How much did I make on vinyl this
spring?" There is no query interface of any kind today. This is real work, and
it carries the one rule that matters: the model may choose which report to run,
and may never produce the number itself. Every figure comes from the pricing
engine and the reports that are already checked by fifty-eight arithmetic tests.
A model that does arithmetic here is a model that will eventually invent a
margin.

**3. Detecting trouble that is not one of the fourteen.** Weakest of the three.
The fourteen cover the things that actually cost money, and a model finding a
fifteenth pattern in nineteen jobs is finding noise.

## What I would do

**Nothing yet.** Set the mail key and build the channel, because that unblocks
real revenue work that needs no model at all. Then the briefing's forward half,
because it is small, useful, and safely wrong.

The guardrail should exist before the first feature, not after: every number a
model shows must come from the existing engine, never from the model. That is
cheap to build now and very expensive to retrofit once a figure somebody trusted
turns out to be invented.

Confidence: high on the sort, which is graded against code I checked. Lower on
the video item, which I could not read.
