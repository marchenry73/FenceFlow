# Two places where FenceFlow shows two different money numbers for the same thing

Both of these are real, in the code today, confirmed by reading the actual files (not
described from memory). Neither is a pricing bug — the 77-fixture pricing engine, the
tax, the concrete and waste math are untouched and not in question here. These are two
places where a *second* calculation, done somewhere else, disagrees with the first one.

---

## Issue 2 first, because it's the one that costs you a customer relationship: the deposit request

**What a customer experiences.** Say a $10,000 fence job, $1,000 deposit, and the
customer has already paid $500 toward it.

- Open the job on your **phone** and tap "Request Payment." The button asks for
  **$9,500** — the whole remaining balance, treated as though no deposit was ever set
  and nothing paid toward it.
- Open the **customer's own quote link** (the page they got by text/email) and it still
  offers to pay **$500** — the rest of the original $1,000 deposit.

Two live links, two different amounts, for the same job, at the same moment. If you
send the customer the $9,500 link, you are asking them to pay off the whole job before
you've even done a walkthrough on remaining work — a mistake that looks like you don't
know your own numbers.

**Where this lives in the code:**

- Phone side: `app/src/main/java/com/fenceestimator/app/estimate/JobMoney.kt`,
  `nextRequestAmount()` (lines 70–79). Once *any* money has landed on the job
  (`netPaid(job) > 0.005`), it stops treating the deposit as its own thing and returns
  `stillOwed` — the whole balance. It only offers the deposit figure when nothing has
  been paid yet.
- Quote-page side: `supabase/functions/_shared/quote-deposit.ts`, `depositFigures()`
  (used by both `quote-view` and `create-payment-link`'s customer-facing door). It
  tracks the deposit as its own running total: `due = min(depositAmount, contractTotal)
  - netPaid`, capped at zero. It keeps offering "the rest of the deposit" until the
  deposit itself is paid off, regardless of how much of the *whole job* has come in.
- Confirmed this isn't just a display quirk: `app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailScreen.kt`
  line 1630 wires the phone's "Request Payment" button straight to
  `JobMoney.nextRequestAmount`, and the request is sent to the server as a raw dollar
  amount (`PaymentsApi.kt` line 66, `amountDollars`) that the signed-in-office door of
  `create-payment-link/index.ts` (lines 151–156) accepts at face value — it does **not**
  recompute it. So a link for the wrong figure isn't just shown on the phone, it can
  actually be created and sent. (The customer-token door, lines 63–125 of the same
  file, is the one that's safe: it ignores whatever amount the caller claims and always
  recomputes through `depositFigures()` server-side.)

**Two scenarios, worked:**

1. *$10,000 job, $1,000 deposit, $500 paid* (the case above). Phone: `stillOwed =
   10000 - 500 = 9500`; since `netPaid (500) > 0.005`, the deposit branch is skipped,
   so `nextRequestAmount = 9500`, labeled "balance." Quote page: `asked = min(1000,
   10000) = 1000`; `due = 1000 - 500 = 500`, payable. **Phone says $9,500, customer's
   own page says $500.**
2. *$10,000 job, $1,000 deposit, nothing paid yet.* Phone: `netPaid = 0`, so the
   deposit branch fires: `nextRequestAmount = min(1000, 10000) = 1000`, labeled
   "deposit." Quote page: `asked = 1000`, `due = 1000 - 0 = 1000`, payable. **Both say
   $1,000.** The disagreement only appears once a partial payment has landed — which is
   exactly the case a contractor is least likely to think to double-check, because nothing
   about the job looks unusual.

**Which is "right"?** Neither is wrong on its own terms — they're two different,
defensible readings of "what should we ask for next." The problem is that they are
wired to two different buttons a customer can independently reach, and they disagree
by $9,000 in scenario 1.

**Options:**

- **A. Make the phone track the deposit the way the quote page does** — i.e. have
  `JobMoney.nextRequestAmount` call the same rule as `depositFigures()` (deposit is its
  own running total, separate from the rest of the balance, until it's paid off; then
  switch to asking for the balance). This is the smallest change and it makes the
  office and the customer agree on every job, always. Downside: none that I can see —
  it doesn't touch pricing, tax, or anything server-computed; it only changes which
  number the "Request Payment" button proposes before you tap it.
- **B. Make the quote page ask for the balance the way the phone does** — once any
  payment has landed, stop treating the deposit as separate and switch the customer's
  own page to asking for the full remaining balance. This is more aggressive collection
  (you'd be asking every partially-paid customer for the whole rest of the job, not
  just the rest of their deposit) and is a bigger change in what customers experience —
  some may feel rushed. It also means undoing a deliberate design in
  `quote-deposit.ts`, whose header comment explains it was built this way on purpose to
  stop double-billing a deposit.
- **C. Make the customer-facing number always win** — have the phone's "Request
  Payment" button call `depositFigures()` (or its logic) instead of `nextRequestAmount`
  whenever a deposit is still open, so the office literally cannot generate a link
  different from what the customer's own page already promises. Functionally the same
  outcome as A, described the other way around: whichever surface is authoritative,
  the other must defer to it, not compute independently.

**Recommendation: Option A (or equivalently C — they converge on the same number).**
Confidence: high. The deposit-first design already exists and is deliberately built
into `quote-deposit.ts` (its own comments describe the exact bug — a page that ignored
payments and asked twice — that this was built to prevent). The phone's `JobMoney.kt`
simply never got the same rule. Aligning the phone's logic to match the already-correct
shared module is a small, low-risk change with no pricing or security implications; it
just changes which draft amount a human sees before deciding whether to send a link.
Option B would work too but changes customer-facing collection behavior in a way that
deserves its own decision, not a side effect of a bug fix.

---

## Issue 1: the same shift shows two different pay figures

**What a crew member experiences.** Someone works 46 hours in one week at $20/hour
(say 30 hours Monday–Wednesday, 16 hours Thursday–Friday).

- The **office dashboard's** "estimated pay" card applies overtime: 40 hours regular +
  6 hours at time-and-a-half = `40×20 + 6×20×1.5 = $800 + $180 = $980.00`.
- The **phone's own crew pay screen**, which the crew member actually carries around,
  shows straight time with no weekly threshold and no multiplier at all:
  `46 × $20 = $920.00`.

That's a $60 gap on one week for one person, and it's not a rounding issue — it's a
completely different rule. A crew member who glances at their phone and later hears a
different number from the office has a real reason to think something is being taken
from them, even if the office figure is the one that's actually more generous and
"correct" by federal overtime rules.

**Where this lives in the code:**

- Office side: `website/dashboard.html` — constants `OT_AFTER_HOURS = 40` and
  `OT_MULTIPLIER = 1.5` (lines 5789–5790), read from `company_settings` with a fallback
  to those defaults (`getOtSettings()`, lines 5688–5694), applied in the weekly pay
  table (`reg = min(hours, otAfter)`, `otHrs = max(0, hours - otAfter)`, `gross = reg *
  rate + otHrs * rate * otMult`, lines 5821–5823). The screen explicitly labels this an
  assumption: "Assumes overtime after 40 hours... there is no on-screen setting for
  this yet" (lines 5839–5844).
- Phone side: `app/src/main/java/com/fenceestimator/app/estimate/CrewPay.kt`,
  `forJob()` (lines 90–101). For hourly employees, `amount = approved.sumOf {
  it.laborCost }` — the sum of each clocked shift's own straight `hours × rate`, with
  no weekly bucketing, no 40-hour threshold, and no multiplier anywhere in the file.
  Confirmed by reading the whole file: the word "overtime" does not appear in it or
  anywhere else under `app/src` or `supabase/functions`.
- This is also independently confirmed by the repo's own test,
  `tests/downstream-pay-overtime.test.mjs`, whose header states plainly: "there is no
  app-side equivalent to check against... CrewPay.kt... computes straight hours * rate
  with no weekly threshold or multiplier at all," and calls this out as a finding, not
  something it fixes.

**Two scenarios, worked** (rate $20/hr both times):

1. *46 hours in one week (30 + 16 split across two shifts).* Office: 40 reg + 6 OT ×
   1.5 = **$980.00**. Phone: 46 × $20 = **$920.00**. Gap: **$60**, and it grows with every
   hour past 40 that week.
2. *35 hours in one week, no shift near the threshold.* Office: all 35 regular
   (`reg=35, ot=0`, no multiplier triggers) = **$875.00** (at $25/hr in the test fixture).
   Phone: 35 × $25 = **$875.00**. **They agree.** The disagreement is invisible on any
   week under 40 hours and only appears once someone works overtime — which is exactly
   the week a crew member is most likely to be watching the number closely.

**Which is more urgent — this one or the deposit one?**

**The deposit issue (Issue 2) is more urgent**, even though the pay gap is a real
dollar difference for a real person. Here's the money reasoning, not just the ease of
fixing:

- The pay figure on both office and phone is explicitly labeled "estimated" —
  it's a preview, not payroll. Actual paychecks come from wherever you actually run
  payroll (outside this app), so nobody will be shorted a real dollar because of this
  screen — but a crew member's *trust* in the app, and possibly a wage-and-hour
  argument if this ever got treated as authoritative, is a real cost.
- The deposit issue can put a **specific dollar figure in front of a customer and
  ask them to pay it** — and as shown above, that figure can generate an actual live
  Stripe/Square payment link for the wrong amount, sent from a legitimate, signed-in
  office account, with no server-side check catching the mismatch. That's not a
  display disagreement, that's a real charge that could go out for $9,000 more than
  the customer expects on a job they haven't finished discussing. Money can actually
  move on the wrong number; nobody's paycheck can move on the wrong number here,
  because payroll doesn't run through this screen.

Rank: **deposit (Issue 2) first, pay display (Issue 1) second** — cost of Issue 2 going
wrong is a real overcharge attempt on a real customer; cost of Issue 1 going wrong is a
crew member's confidence in a screen that is already labeled an estimate.

**Options for the pay screen:**

- **A. Teach the phone the same overtime rule.** Port `OT_AFTER_HOURS` /
  `OT_MULTIPLIER` (and the `company_settings` override) into `CrewPay.kt`, bucketing
  approved hours by week the same way `dashboard.html` does. Pro: the two numbers
  agree, which is the cleanest outcome. Con: it's real new logic on the phone —
  grouping shifts into Sunday–Saturday weeks, handling shifts that cross a week
  boundary, keeping it in sync if the office's `company_settings` override ever
  changes — and every future change to the office's rule has to be mirrored here or
  the drift comes right back.
- **B. Remove pay from the phone screen entirely**, leaving hours worked (which the
  phone already tracks accurately and which crew clearly needs to see) but no dollar
  total, with a note like "see the office for your estimated pay." Pro: eliminates the
  disagreement by eliminating one of the two numbers — zero risk of drift because
  there's only one calculation left. Con: takes away something crew members currently
  find useful (a same-day sense of what they earned), and might read as the company
  hiding pay information from the people it's about, even though the intent is the
  opposite.
- **C. Label the two clearly as different things**, changing no math: the phone's
  screen already computes straight hours × rate, so relabel it plainly as
  "straight-time pay (does not include any overtime premium — see the office for
  your full estimated pay)." Pro: cheapest fix, ships today, doesn't touch a single
  number that's actually used anywhere. Con: doesn't close the gap, and a crew member
  who doesn't read the fine print will still see a different number than the office
  and wonder why.

**Recommendation: Option C now, Option A if/when it's worth the engineering time.**
Confidence: medium. Given that both screens already say "estimated" and payroll
doesn't run through either one, the actual financial exposure here is reputational —
a crew member's trust — not a wrong paycheck. A one-line label change removes the
"which number is right" confusion today at near-zero cost and risk. Porting the real
overtime rule (Option A) is the right long-term answer and isn't hard, but it's real
code, and it's exactly the kind of "two-line port" the repo's own test comment warns
against doing carelessly — it deserves its own change and its own review, not a rider
on this document. Removing pay from the phone (Option B) is the one I'd argue against:
it takes away something crew members use without actually reducing any real financial
risk, since the number was never authoritative to begin with.
