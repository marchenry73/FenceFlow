# What's necessary, what to cut, what's broken — 21 Oct 2026

Everything below is counted from your live database, not guessed. 20 jobs,
7 companies, 45 days of error reports.

---

## 1. The send buttons — yes, there are too many

**On the job screen**, three ways to get the quote to the customer:

| Control | What it does | Keep? |
|---|---|---|
| **Send quote** | opens a text to the customer | **keep** — the main one |
| **Send quote · Email** | sends through FenceFlow, records it | **keep** — the only one that knows it arrived |
| **Email link** | hands the link to a mail app | **cut** |

**On the estimate screen**, four more:

| Control | Keep? |
|---|---|
| **Send contract** | **keep** |
| **Send invoice** | **keep** |
| **Send material list** (to a supplier) | **keep** — different reader, different document |
| **Share working estimate** (internal, with your costs on it) | **cut** — it is a leak waiting to happen |

That is **7 ways to send something**. Four earn their place: the customer's
quote, the contract, the invoice, the supplier list. Three are older paths to
the same destination.

**My recommendation: cut two** — "Email link" and the internal working
estimate share. That takes the job screen from three send buttons to two, and
removes the one document that has your material costs on it from the share
menu entirely.

Say the word and I'll do it.

---

## 2. The signature — you need one of the three, not three

There are three places a signature can happen:

1. **The customer approves online** on the quote page — types their name or
   draws it. **5 jobs.**
2. **A wet signature in the app** — you hand them the phone. **6 jobs signed.**
3. **Final sign-off** when the work is done. **1 job.**

**Is it necessary? Yes — one of them is.** Not for ceremony: a signature is
what locks the price. The moment a job is signed, `accepted_total` is stamped
and the engine stops re-pricing it, so a re-quote cannot move the number the
customer agreed to. Without that, a material price change after the handshake
silently changes what you are owed.

It is also the only evidence you would have in a dispute — the amount, the
date, and the drawing as it was.

**What I'd cut: nothing, yet.** 1, 2 and 3 are genuinely different moments.
But **(3) final sign-off has been used once in 20 jobs**, and if you don't use
it on site, it is a button taking up room. Your call.

---

## 3. What nobody has ever used

Counted across every real company:

| Feature | Times used |
|---|---|
| **Change orders** | **0** |
| **Punch lists** | **0** |
| Expenses | 1 |
| Final sign-off | 1 |
| Customers (as a separate record) | 2 |
| Manufacturers | 2 |
| Automation rules | 4 |
| Employees | 4 |
| Follow-ups actually sent | 4 |

Against what is carrying the product:

| Feature | Times used |
|---|---|
| Job steps | 350 |
| Catalog items | 124 |
| **Runs drawn on screen** | **36** |
| Payments recorded | 26 |
| Jobs | 20 |

**Change orders and punch lists are the two candidates for removal.** Both are
real features with real code behind them, and neither has been touched once.
The honest question is whether that's because they aren't needed, or because
nobody found them. I'd ask that before deleting either — a change order is the
thing that stops extra work being done for free.

---

## 4. What actually breaks

**Last 14 days: three error reports, two kinds.** That is a quiet app.

The one worth chasing:

> **`r4.j cannot be cast to c0.a`** — 7 times, most recently 18 October, on the
> jobs screen.

That is a real crash. The class names are scrambled by the release build, so I
can't tell you what it is without matching it to the build's mapping file. It
is the only live crash in the product.

**Already fixed, for context on the older numbers:**

- **157 × "push time_entries: 2 of 7 rows rejected"** (September) — the biggest
  single failure the app has ever had. Crew hours not reaching the cloud.
- **58 × "Expected string literal but 'null' was found"** — sync choking on a
  null the parser didn't allow.
- **12 × the app failing to start at all** (21 September).
- **7 × a database migration failure** on time_entries.

All September–early October, none in the last two weeks.

**The pattern worth knowing:** every one of those is **sync**. Not the drawing,
not the pricing, not the PDFs. When FenceFlow breaks, it breaks between the
phone and the cloud.

---

## 5. My rating — and it isn't flattery

**Against fence-specific software: 8.5/10. Against the big horizontal tools
(Jobber, Contractor Foreman): 7/10, with one thing none of them can do.**

**Where it genuinely wins**

- **It works with no signal.** ArcSite — the best drawing tool in the category
  — doesn't. That is the single hardest thing here to copy, and it is never
  mentioned in your marketing.
- **Crew phones physically cannot show money.** Not hidden; refused by the
  database. No competitor does this.
- **The office and the phone price identically, and it's proven** — 90 fixture
  cases both engines must reproduce exactly. Nobody else can claim it because
  nobody else has two engines to reconcile.
- **It does the whole chain**: measure → price → quote → sign → schedule →
  crew → pay. Fence-specific rivals do one or two links.
- **Fence knowledge is in the defaults** — posts, gates, caps, concrete,
  waste. QuoteIQ treats a fence as one straight line.

**Where it's genuinely behind**

- **Drawing precision.** ArcSite has typed exact lengths, tap-to-dimension,
  angle lock, custom snap points. You have a one-foot nudge pad and a loupe.
  This is the biggest real gap.
- **No QuickBooks.** For a contractor with a bookkeeper, that's a hard no.
- **Not on the Play Store**, so no reviews, no search presence, and every
  install is a link you send by hand.
- **Job costing is thinner** than Contractor Foreman's.
- **Reliability history.** 157 sync failures in one month is the kind of thing
  a review remembers. It's fixed; the reputation cost of that class of bug is
  what the next one would cost you.

**The honest summary:** this is a better *fence* product than anything sold as
one, built by someone who knows the trade, and it is held back by polish and
distribution rather than by capability. The two things standing between it and
a real product are **the Play Store** and **drawing precision** — not features.

---

## What I'd do next, in order

1. **Chase the `r4.j` crash.** It's the only live one.
2. **Cut the two redundant send paths** (Email link, internal estimate share).
3. **Decide on change orders and punch lists** — use them or remove them.
4. **Drawing precision**: typed exact lengths and angle lock. One feature,
   closes the biggest competitive gap.
5. **Play Store.** Everything else is worth less without it.
