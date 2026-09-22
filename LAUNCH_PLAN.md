# FenceFlow launch plan

Three parts: what must be true before you sell, how to check the product
yourself, and how to find and win the first customers. Written 21 Sep 2026,
after five rounds of audit and fixes.

---

## Part 1 — Do not sell until these are done

These are the only things standing between the product and a paying company.
Most are yours because they involve a password, a key or money.

| # | What | Why it blocks | Time |
|---|---|---|---|
| 1 | **Back up the signing key** — copy `C:\Users\march\.android\debug.keystore` somewhere off this computer (two places). | It is the identity of every phone running FenceFlow. Lose it and no phone can ever update again. | 10 min |
| 2 | **Decide the signing transition**, then I build it: key rotation (updates keep working) or everyone reinstalls. | Today's app is a debug build — anyone with the file and a cable can read a phone's data. Can't hand that to a customer. | Your decision + 1 day |
| 3 | **Decide where customer deposits land** — contractor connects their own Stripe (money goes straight to them) or FenceFlow collects and pays out. | Today a deposit lands in *your* Stripe account and the job reads "paid". | Your decision + 1 day |
| 4 | **Switch Stripe to live keys** — steps in `GO_LIVE.md` items 5–6. | The site uses test keys: a real card is declined at signup. | 1 hour |
| 5 | **Fix or drop "no card to start"** on the homepage. | It isn't true — signup always asks for a card. First thing a skeptical contractor checks. | 15 min |
| 6 | **Check the "FenceFlow" name** — search USPTO and your state registry. | A different company runs `fence-flow.com`, a chain-link estimator, and plans to grow into job management. Know before you spend on the name. | 1 hour |
| 7 | **Turn on the follow-up scheduler** (`docs/FOLLOW_UPS_SCHEDULER.md`) — optional but it's a selling point. | It's built; nothing runs it until the one secret is set. | 20 min |

### Two market facts to plan around, not hide

- **There is no iPhone app.** The field app is Android only. An iPhone user can
  use the office in a browser but not the field app. Ask this in the first
  minute of every call — it decides whether they're a prospect today.
- **It installs from a link, not the Play Store.** Contractors expect a store
  listing. A signed build (item 2) is the prerequisite for a Play listing; that
  should follow shortly after launch.

---

## Part 2 — Check it yourself, like a customer would

Do this on real phones, not the simulator. Two phones if you can: one as the
owner, one as a crew member. Tick each one; anything that fails, tell me the
exact screen and what you saw.

### A new company, start to finish (the test that matters most)

1. Create a brand-new company from the staff console and claim it with a
   second email address you control.
2. **Setup:** the checklist shows what's missing. Catalog should start empty —
   no invented prices. Enter a few real prices.
3. **Invite a crew member** to a second phone. The email should arrive from
   your business name. They join, and see no prices anywhere.
4. **A lead:** submit the get-a-quote form on your own website. It should appear
   in the office pipeline.
5. **Measure and draw:** draw a fence, type an exact side length, add a gate,
   close a loop. Undo and Redo should both work. Check the length on the
   estimate matches what you typed.
6. **Quote:** send it. Open the link on a phone as the customer. The summary at
   the top should show the fence, length, price, deposit and balance clearly.
7. **Approve and sign** as the customer. It should not ask for a signature twice.
8. **Change the drawing** after approval — the job should say it needs approval
   again, and the customer's link should say so too.
9. **Schedule it** and assign the crew member. Check the job header in the office
   shows what's blocking it (HOA, permit, 811, materials).
10. **Crew clocks in, takes a break, clocks out** on their phone — offline for a
    bit if you can.
11. **Correct their hours** in the office. The crew phone gets a notice; accept
    one correction, dispute another. The answer should show on both.
12. **Complete the job** and record final payment. The office should show it paid
    and the job costing should look right.
13. **Reports:** the business report should reflect the job.

### Things to try to break

- Sign out on the phone — it should work, or tell you exactly what's unsynced.
- Forgot password from the office sign-in page — you should be able to set a new
  one, and the phone should then accept it.
- Put the phone in airplane mode, do work, reconnect — nothing should be lost.
- Switch the office to Spanish and French, and to dark mode.
- Open the office on a phone-sized browser window.
- As a crew member, look everywhere for a price, a total or someone's pay rate.

### The website

- Open `fenceflowapp.com` on a phone. Does the first screen say what it is
  within five seconds? Play the demo video.
- Click every button on the homepage. Pricing, signup, sign-in, get-a-quote.
- Read every claim out loud and ask: is this true today? (The audit found one
  that isn't — item 5 above.)

---

## Part 3 — Marketing: how to get the first customers

### Who to sell to first

Small fence contractors, 1–10 people, **using Android**, who currently price
jobs on paper, a spreadsheet, or a generic tool that can't measure a fence.
The best early customers are owner-operators who do their own estimates —
they feel the time savings personally and they decide on the spot.

Skip for now: companies above ~15 people (they want integrations you don't have
yet, like QuickBooks), and all-iPhone crews.

### What makes FenceFlow different — say these, in this order

These are true today and hard to copy:

1. **It works with no signal.** Draw, quote and clock in at a rural site; it
   syncs when you're back. Most competitors fail in a field with no bars.
2. **Your crew's phones physically cannot show money.** Not hidden — the
   database won't send it. Owners worry about this more than they say.
3. **The homeowner sees their fence in 3D** before they sign.
4. **It measures and prices a fence**, posts, gates, concrete and all.
   Jobber is excellent software and cannot measure a fence at all. QuoteIQ
   treats a fence as one line with no posts or gates.
5. **One product for the whole job** — lead to final payment — with crew seats
   included rather than charged per person.
6. **Spanish and French** throughout, including the field app.

Don't say: anything about AI, QuickBooks, an iPhone app, or "no card to start"
(until it's true). Never claim something the product doesn't do today — a
contractor who catches one false claim won't believe the true ones.

### Answer the price question head-on

At $99 / $199 / $349 you're mid-market against fence-specific tools and look
expensive next to Jobber ($49) or QuoteIQ ($30). Don't avoid the comparison:
*"Jobber is great for scheduling and invoicing, but it can't measure a fence or
build a material list. FenceFlow does both, so you stop pricing jobs twice."*

Two cheap moves that help: a **price-lock promise** for early customers (a
competitor just nearly doubled its top tier and reviewers noticed), and
**doing their setup for them** — see below.

### The single biggest onboarding hurdle — remove it

A new company starts with an empty catalog. That's correct (no invented prices)
but it's work. **Offer to enter their supplier prices for them** as part of
signing up. It turns the hardest step into a reason to say yes, and it gives
you a second conversation.

### Channels — where fence contractors actually are

**1. Your own company first (week 1).** You run a fence company. Use FenceFlow
on every job for two weeks and record real numbers: minutes to quote, quotes
won, a before/after. That becomes your case study and your demo — nobody else
selling software to fence contractors can say "I run a fence company and this
is what I use."

**2. Phone calls (weeks 1–4), your main channel.**
- Build the list from Google Maps ("fence contractor" + each nearby city) and
  Google Business profiles. You may already have one: the "One Hundred and
  Eleven Fencing Companies" list from earlier.
- Call **6:30–7:30 am or 4:30–6 pm** — they're on site during the day.
- Goal of the call is one thing: a 15-minute demo, not a sale.
- 30-second opener:
  > "Hi, this is March — I run [your company] here in [city]. I built an app
  > for my own crew that measures the fence on the phone and builds the quote
  > and material list right there, even with no signal. Other fence guys asked
  > to use it. Are you still pricing jobs by hand, or do you have something for
  > that?"
- Their answer tells you which pain to demo. First question after interest:
  "Is your crew on Android or iPhone?"

**3. Visit in person — supply houses (the best channel you're not using).**
Every fence contractor buys from a local fence supply yard (fence distributors
and lumber yards with a fence counter). Go early morning when contractors are
picking up material. Bring a phone with a demo job loaded. Ask the counter
manager if you can leave a flyer or run a coffee-and-demo morning — they want
their contractors busier. One good yard can introduce you to dozens.

**4. Visit in person — job sites and trucks.** If you see a fence crew working,
a two-minute "I run a fence company too, look at this" with the 3D view on your
phone gets attention. Leave a card with a QR code to the demo video.

**5. Facebook groups.** There are active groups of fence contractors. Don't
advertise — answer questions, share a real before/after from your own jobs, and
let people ask.

**6. Referrals.** Offer each paying customer a free month for every contractor
they bring. Contractors know other contractors.

**7. Trade associations and shows (later).** The American Fence Association and
its FenceTech show are where the industry gathers; worth it once you have a few
customers and a Play Store listing.

### The demo (15 minutes, on your phone)

1. Their pain, in their words (2 min).
2. Draw a real fence on a satellite view of a property near them, type a side
   length, add a gate (3 min).
3. The material list and price appear from the drawing (2 min).
4. Send the quote to their own phone; they open it and see the 3D fence (3 min).
5. The crew view — no prices anywhere (1 min).
6. The office dashboard and "needs attention" (2 min).
7. Close: "Want me to set it up with your prices this week?" (2 min).

### Measure it weekly

Calls made → conversations → demos booked → demos done → trials started →
paying. For a new product, expect something like 1 demo per 10–15 calls and a
third of demos to start a trial. If demos happen but trials don't start, the
product or the price is the problem; if calls don't turn into demos, the
opener is.

### First 30 days

| Week | Do |
|---|---|
| 1 | Finish Part 1. Run your own company on FenceFlow; start recording numbers. Build a list of 100 local contractors. |
| 2 | 20 calls a day. Visit 3 supply houses. Aim for 10 demos. |
| 3 | Keep calling. Set up the first 3 customers yourself, prices included. Ask each for one referral. |
| 4 | Write up your own case study with real numbers. Ask the first customers what almost stopped them buying — fix that next. |

The goal for the first month isn't revenue — it's **five real companies using it
every day**, and learning exactly what they need next.
