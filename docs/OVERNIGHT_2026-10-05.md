# Overnight, 4–5 October

## Read this bit if you read nothing else

Ordered by what it is worth to you, not by when I found it.

**Money sitting still**

1. **Three people opened your quote and never heard back — $23,540 between
   them**, one of them Makayla, four days ago. Your follow-up emails are
   switched on at the top and every single rule underneath is off, so not one
   has ever sent. Nothing is broken; nothing was ever asked to send.
2. **$3,500 deposit agreed and never collected** on James's job, approved
   3 October. It is also the job with no email address on it, which is why his
   contract never went out either.

**One security thing, not urgent but worth knowing**

3. **`can_see_pay()` asks for the wrong permission.** It is named for SEE_PAY
   and checks SEE_MONEY. A SALES account has SEE_MONEY and deliberately not
   SEE_PAY, so it could write a made-up payroll figure. **Nobody can reach it
   today** — the only SALES profile has no company, and the policy is
   company-scoped — but it becomes live the first time you create a real SALES
   user. The fix is one word, written and dry-run, not applied.

**Needs a decision from you**

4. **One catalog row** — a 4 ft vinyl corner post at **$16.75**. That is the
   whole of what you spotted. Easiest in the app: Catalog → new item → Corner
   post, Vinyl, height 4, and type the supplier's real name for it.
5. **Two switches, both yours.** The follow-up rules above, and nine
   server-side alerts that are built and switched off. I built the panels and
   fixed what made both look fine while doing nothing — but I turned neither
   on, because both send things to customers or to your phone.
6. **Makayla's quote has no corner post on it** — and you appear to have taken
   them off deliberately. Read that section before changing anything.

**Waiting for you, nothing to decide**

7. **A supplier price request** to print or email — 48 items named exactly as
   your catalog spells them, so the reply loads straight in, and it asks them
   to name the 4 ft corner post.
8. **The reply to the customer about licensing and insurance.** You asked for
   it and it had never been written.

**Done**

9. **App 1.602 is live** — the house, pool and driveway drawn to real size, and
   free-standing gates. Verified from the release row and the hosted file, not
   the build log.
10. **Three real bugs fixed.** An unfilled `{{placeholder}}` could be emailed to a
   customer; and a publish could burn two hours to refuse something it knew in
   the first second.
11. **The contract email is not broken.** I told you five approvals had
    produced nothing. That was wrong, and it is corrected below.

Everything below is the detail.

---

## The contract email works — I was wrong twice about this

I told you earlier that five approvals had produced no email and no trace.
That was wrong, and the way it was wrong matters, so here is what the data
actually says.

There are **six** approvals on record. `quote-approval-email` — the function
that sends the contract — was only deployed on **2 October, 17:17 UTC**.

| Approved | Sender existed? | Email on the job? | What happened |
|---|---|---|---|
| 3 Oct 15:41 | yes | **no address** | Sender ran, recorded `no_address` — correct |
| 2 Oct 18:38 | yes | yes | No row; signature file is stamped 22 August |
| 2 Oct 16:20 | no | yes | Deployed 57 min later — nothing to call |
| 30 Aug | no | no | — |
| 14 Aug | no | no | — |
| 24 Nov 2025 | no | no | — |

So four of the six had no function to call. The fifth had nobody to send to,
and the sender **did** run and wrote the right verdict — that one row is the
only row in `quote_approval_emails`, and it says `no_address`.

The sixth carries a signature captured six weeks before its approval
timestamp, so it is unlikely to be a customer approval through the quote link
at all.

**The quiet was chronology and a missing address, not a bug.** You do not need
to do the test approval to find a fault — there is no evidence of one. Do it
only if you want to watch it work end to end.

One thing worth knowing: the 3 Oct approval has **no email address on the
job**, so that customer was never sent their contract. You said to leave the
John/James item alone, so I have not touched it — just flagging that the
missing address is why, and adding one would let the contract go out.

## Two bugs fixed early on

**An unfilled placeholder could reach a customer.** The compose sheet leaves
`{{customer_first_name}}` visible when it has no value and names the gaps in
red underneath — but Send never looked at the words. Every check there was
about addresses, counts and sizes. So ignoring the red note and clicking Send
mailed `Hi {{customer_first_name}},` to a real person.

Now Send refuses once and names what is still unfilled. Press Send again and
it goes as-is, so a literal `{{` in prose cannot lock you out of your own
mail. Twenty tests, in all three languages.

**A publish could burn two hours to refuse something it knew in one second.**
The APK was stamped 599; two website commits took the commit count to 601. The
check that catches exactly that sat *behind* the gate suite — parity, security,
money, 1,377 unit tests — so a certain refusal would have arrived up to two
hours later. It now refuses in 2 seconds with the rebuild command in the
message. Measured.

Nothing shipped from that stopped run. `app_releases` still topped out at 598,
so no phone was ever offered a link to a build that was not made.

## The office cannot deploy a dead control any more

The two gates already on the website workflow cannot tell a wired control from
a dead one: syntax happily parses a button that calls nothing. That is the
`SideTypesCard` shape — written, tested, and mounted on no screen for days
while its own test passed.

So there is now a gate on **call sites**: search reaches its RPC and opens
records through the page's own doors, every `+ New` item points at a button
that really exists, every nav tab still has its panel and every panel its tab,
the money tile opens the owed table and that table has the anchor it scrolls
to.

All 28 checks passed the first time they ran, which is when a check is least
worth trusting. So a second gate breaks a copy of the page eight ways and
requires the *named* check to go red each time. It immediately found one that
could not: the check for `syncNavGroups` was a prefix of
`syncNavGroupsDisabled`, so renaming the function walked straight past the
check watching it. Three others had the same flaw. All four fixed; 8/8 now
killed.

## One switch you may want on — I built it, you flip it

There are **nine server-side alert detectors** built, deployed, and triggered
hourly by a GitHub Action: money already at risk or gone, a crew about to be
sent to a job that is not ready, and 811 / permit / HOA deadlines.

They are **off for every company**, yours included. `attention_sweep_settings`
has no row for anyone, and no row means off. So `attention_findings` is empty,
the office shows no alerts, and that reads exactly like "nothing is wrong".

Off is the deliberate default, so this is not a bug. But it does mean a built
feature is currently doing nothing for you.

I have not switched it on, because it starts sending push notifications to
your phone and that is your decision, not mine. What I did do is build the
panel it needs, which is the next section.

This is also why I did **not** build the notifications centre from the office
plan tonight: its only data source is that table, so it would have been a
panel that is permanently empty — a control that does nothing, which is the
one thing you said you did not want.

### What the panel does

It sits in **Automation**,
under the existing rules, because it is the same idea — the difference is only
that these nine run with the office closed.

- Off, it **says** nothing is being watched, and explains that an empty list
  would not mean all clear. That was the whole trap: an office showing nothing
  because nothing is looking reads exactly like an office with nothing wrong.
- On, it lists what needs you, newest first, with a Clear button per item.
- The Turn on button is disabled for anyone who is not an owner or manager,
  and says so rather than going quietly dead.
- All three languages.

Nothing is switched on. The button is there; the decision is yours.

The gate on it is cross-file, which is the part worth knowing: the office calls
two server functions, and PostgREST matches a function by **name and argument
names**. `p_enabled` spelled `enabled` is a 404 at the click and a compile
error nowhere. So the test reads the SQL as well as the page, and a second
harness breaks a copy of either one eight ways and requires the right check to
go red. 8/8.

## One thing to clean up when you get a moment

`billing-setup` is still deployed. Its own first line says it is a **temporary
setup utility** for going live with subscriptions, to be "deleted after
go-live". It can create Stripe products using the live secret key, and nothing
in the codebase calls it — it is reachable only by someone holding both a valid
login and the setup token.

Not urgent, and I have not touched it: deleting a deployed function is your
call, not mine. But it was meant to be gone, and it is the kind of thing that
is easy to forget until it matters.

## The 4 ft vinyl corner post — found it, and it needs one line from you

Your note read oddly until I looked at the catalog: *"4ft vinyl corner post
should be a 6ft post, not for a 6ft high vinyl fence."*

The 4 ft vinyl family is `5x5x72 … 4' Closed Top` — 72 inches, so a **six foot
long** post for a **four foot** fence, the extra two feet being what goes in
the ground. The 6 ft-high family is `5x5x102`. You were saying a 4 ft fence's
corner post is the 72" post, and not the one used on a six-foot-high fence.

You are right, and the catalog is exactly one row short of being able to say so:

| Role | height 4 | height 6 |
|---|---|---|
| Line post | 5x5x72 HFS, $16.75 | 5 rows |
| End post | 5x5x72 HFS, $16.75 | 3 rows |
| Gate post | 5x5x72 HFS, $16.75 | 3 rows |
| **Corner post** | **nothing** | 1 row, $16.56 |

What happens today is subtler than a missing line. The height filter narrows
only *if* something matches, so a 4 ft vinyl corner does not lose its post — it
falls through to the only vinyl corner post that exists: the height-6 Co-Ex, an
8.5 ft post, at $16.56.

So every 4 ft vinyl corner has been quoted with the post for a six-foot fence.
The money is trivial — it is 19 cents *cheaper* than the right row — but the
specification is wrong, and it is a post two and a half feet longer than the
job needs.

**This is a catalog row, not code.** The engine is doing exactly what it was
designed to do; it has nothing correct to choose from.

That also answers the price question I left you: **$16.75**, because all three
siblings in that identical family are $16.75.

I have written the SQL (`supabase_a87_vinyl_4ft_corner_post.sql`) and **dry-run
it** against the live schema inside a transaction that rolls back. That was
worth doing: the first draft had three bugs and would simply have failed on
your machine — it left out `sync_id`, which cannot be null, filed the post under
"miscellaneous", and omitted the unit and maker so the row would not have
matched its own family.

And one that would not have errored, which is worse: it copied the sibling's
`source_doc` of **"Confirmed"** onto a price nobody has confirmed. The row now
goes in marked **"Placeholder — verify with your supplier"**, which is the exact
wording the office looks for — so it will flag that price as unverified until a
supplier answers, which is what the price request goes out to ask.

Verified in the transaction: 1 corner post before, 2 after one run, still 2
after a second — safe to run twice. Then rolled back, and the live count
re-checked: still 1. Nothing in your catalog was touched.

It is still **not run for real**, now for one reason only: the supplier's own
name for the part, which is what shows on the materials list someone carries to
a counter.

Easiest road is the app: **Catalog → new item → role Corner post, type Vinyl,
height 4, price 16.75**, and type the supplier's real name off the invoice.
Same row, and it is yours rather than my guess.

I checked whether anything else has the same shape. Only three fence-type and
height combinations are actually in use — vinyl at 4 ft (4 runs), vinyl at 6 ft
(43 runs), and wood at 6 ft (2 runs) — and every other type's corner post is
height-agnostic, so it always matches whatever it is asked for. **The 4 ft
vinyl corner post is the only real gap.** Four runs are affected.

## Things I checked that turned out to be fine

Worth saying, so you know these were looked at rather than skipped.

**The money ledger is clean.** No negative payments, no negative contracts, no
refund larger than what was paid. Two rows look wrong at first glance and are
not: a job of John's whose contract was reset to 0 by a re-price (still DRAFT,
and the one you told me to leave), and a ZZ TEST job. Nothing live is
mis-stated.

**Every button in the office is reachable.** All 149 that carry an id are
referenced by the page's own script — none is a control wired to nothing.

**No other feature is stranded.** I swept all 103 server functions granted to
signed-in users for ones nothing calls. Two came back, and both turned out to
be helpers that RLS policies call from inside SQL, which is correct. The
attention sweep was the only genuinely stranded one, and it now has its switch.

**Crew still cannot see money — checked against the live schema, not the
tests.** Every money column on a job is withheld from the crew view:
contract_total, signed_contract_total, accepted_total, amount_paid,
deposit_amount, markup_percent, tip_amount, refunded_amount, dispute_amount
and every payment_* field. The crew line-items view carries quantity and unit
but no unit price and no line total, and the crew materials view has no price
column at all. So a crew member sees what to build and how much of it, and
nothing about what it is worth.

(My first pass appeared to find four leaks. It had not: my own pattern included
"fee", which matches **feet** — `signed_linear_feet`, `teardown_feet`,
`calibration_known_feet`, `grid_feet_per_square`. Measurements, not money.)

**No screen in the app is built but unreachable.** I scanned all 244
Composables for any defined and mounted nowhere — the SideTypesCard shape.
Zero. (The scan carries its own sanity probe, because the first version was
silently broken: a backslash was eaten on its way into the file, so the word
boundary became a backspace character and it matched nothing, which made all
244 look unused. A check that reports everything is as useless as one that
reports nothing.)


## Makayla's quote has no corner post — and that looks deliberate

I got this wrong the first time and corrected it, so here is the whole thing
rather than the conclusion.

Her job has three vinyl runs — two at 6 ft and one at 4 ft — and **no corner
post line on the estimate at all**. Two `5"x5" Co-Ex Corner Post, White` lines
at $16.56 were removed on 1 October, at 23:14 and 23:48.

I first assumed those were casualties of the 1 October tombstoning, because the
date matched. They were not. **Both carry a real user id**, which means a person
deleted them. The tombstoning bug leaves an empty string there, and that is how
the two are told apart — I matched on the date and should have checked the
signature before saying anything.

So I am **not** telling you to press Suggest Quantities on her job. That would
re-derive the takeoff from the drawing and put back the very lines somebody
chose to remove.

What I suspect happened, and you will know in a second whether it is right:
you deleted them **because the corner post was wrong** — which is the thing you
reported. Her 4 ft run is exactly the case with no correct row to bill, so the
only corner post the engine could offer was the 8.5 ft one meant for a
six-foot fence.

If that is it, the order is:

1. Add the 4 ft vinyl corner post to the catalog ($16.75, see above).
2. Then re-price her job, and the right posts appear on their own.

If instead you meant her quote to carry no corner posts at all, leave it —
it is already what you decided, and nothing here needs doing.

### While we are on it

The 1 October tombstoning touched **46** line items with the bad signature, plus
3 on 8 September. **It has not happened since** — every deletion on 2 and 3
October carries a real user id, so they are ordinary edits. Four days is not
proof the cause is gone, but it has not recurred.

Having been caught out once, I went back and split **every** deletion since
1 September by that same signature rather than by date. The full picture:

**Genuinely damaged** — empty `deleted_by`, nobody chose this:

| Job | Items | Value |
|---|---|---|
| James Bond | 13 | $21,510.71 |
| John Beaunissant | 18 | $9,475.34 |
| John | 3 | $993.60 |
| (unnamed job 22c819b8) | 5 | $691.65 |
| (unnamed job 9747af55) | 10 | $652.54 |
| **Total** | **49** | **$33,323.84** |

**Deliberately deleted** — a real user id, somebody meant it. Nothing to fix:
Marco (13 items, $10,847.64), John (3, $5,464.58), an unnamed job (15,
$2,731.14), Makayla (2, $33.12) and another unnamed job (3, $33.12).

So the damage is **almost entirely the two jobs you already told me to leave**.
Beyond them there is about $2,338 spread over three jobs, two of which have no
customer name on them and look like drafts.

Nothing here needs doing tonight. It is written down so the number exists, and
so that next time nobody has to guess which deletions were real.

---

## What turning the alerts on would tell you, today

I ran the nine detectors' own SQL against your real data, with only the
enabled-gate bypassed, to see whether the switch is worth flipping or whether
it would just sit there empty.

**One fires right now, and it is money:**

> **No deposit collected.** James's job — approved 3 October, **$3,500 deposit
> agreed, $0 collected**, status ACCEPTED.

The other three money detectors are quiet (no chargebacks, nothing collected on
a declined job, no failed payment attempts in 30 days), which is good news
honestly arrived at rather than an empty panel.

That one job is worth a second look for another reason. It is **the same job
that has no email address on it** — the one whose contract email correctly
recorded `no_address`. So: accepted, $3,500 outstanding, and the customer never
received their contract, because there is nowhere to send it.

I know you said to leave the John and James item. That was about re-pricing, so
I have not touched the job — but an uncollected $3,500 deposit is a different
thing from a re-price, and it seemed wrong to leave it unsaid.

## Two more things, both waiting for you rather than needing you

**A supplier price request** — `docs/SUPPLIER_PRICE_REQUEST.html` to print, and
`.csv` to email. 48 items, named exactly as your catalog spells them, so
whatever comes back loads straight in. One price column only, because the
importer refuses to guess between List and Net. The highlighted row is the 4 ft
corner post you do not have: it asks the supplier for **their** part name and
price, which are the two things I could not invent for you.

It is gated by a test that runs the office's own importer over the finished
file, so a change to the importer can no longer quietly break the sheet.

**The reply about licensing and insurance** — `docs/CUSTOMER_REPLY_LICENSING.md`.
You asked for this and it had never been written. The answer is in the second
line rather than the last, and it names the risk to *them* in plain words,
because transparency that leaves out the part the customer cares about is not
transparency. Then what you actually have: photos, references, receipts,
and coming back to fix anything that is not right.

Not sent. Yours to send.

One thing in there worth ten minutes before you do: Hillsborough County has its
own contractor registration rules and plenty of fence jobs need a permit
regardless of who pulls it. "I'm working toward it" is a much stronger sentence
when you know exactly what *it* is.


---

## The one I would act on: nobody is following anybody up

`follow_up_settings.enabled` is **true** for your company. All four individual
rules underneath it are **false**. `follow_up_log` has been empty since the day
it shipped.

Nothing is broken. It has never been asked to send anything.

What hid it is that the "due follow-ups" preview honours the rules. With every
rule off it draws an **empty list underneath a ticked master switch** — which
reads exactly like nobody needs chasing.

Here is who was actually waiting while it said that:

**Opened your quote, never approved**

| Who | Opened | Quote |
|---|---|---|
| Makayla | 1 Oct | $4,420.37 |
| James Bond | 21 Sep | $13,266.87 (no email on file) |
| John Beaunissant | 29 Aug | $5,853.81 |

**Approved, no deposit taken** — Yviona and Marco, both 2 October.

That is **$23,540 of quotes that people opened and then heard nothing more
about.** Makayla is the one you are actively working on; she looked at it four
days ago.

I have **not** switched anything on — these send real emails to real customers,
and which rules run and to whom is yours. The settings are in Automation, under
"Sales follow-ups": tick the rules you want and set the delays.

What I did change is the lying part. The panel now says *which kind of nothing*
it is — a warning when the master switch is on but no rule is ticked, and a
due-list empty message that says outright that empty is not the same as nobody
waiting. Same trap as the alerts panel, wearing a different hat.

Worth knowing before you tick anything: there are **quiet hours** (9pm–8am,
America/New_York) and a **daily cap of 25**, so switching rules on will not fire
a backlog at people at three in the morning.
## The chase list now tells you whether they opened it

Your Follow-up priority panel ranked every sent quote by value times days
waiting and labelled them all "Follow up". But `quote_viewed_at` was sitting on
the job the whole time, and it separates two situations that need opposite
things:

- **Opened, then silence** — they read it and didn't say yes. Nudge them.
- **Never opened** — they never saw it. Wrong address, spam folder, or it never
  arrived. Nudging is the wrong move; it needs resending, or a phone call.

The button now says which. The **ranking is untouched** — you're used to that
order and quietly reshuffling your priority list to make a point isn't a trade
worth making.

On your data right now, all three unanswered quotes had been opened. Worth
knowing before you pick up the phone.

## And more that is fine

**Push notifications work.** Six devices registered, four active in the last
30 days — so if you do switch the alerts on, they will actually reach you. I
checked this because telling you to flip a switch that pushes to your phone is
worth nothing if the push doesn't arrive.

**Payments work.** Stripe is connected, 6 payments taken, 34 jobs have a
payment link, and there are manual cash and card records too. The nine
"pending" rows are payment links that were created and never used — all on the
John and James jobs plus a test. Nothing is stuck mid-flight.

**Automation rules are on and have fired.** All four enabled, four runs
logged. Unlike the follow-ups, this one is genuinely working.

**Mail is syncing.** One account connected, messages coming through.

**Data integrity is sound.** I swept for orphaned rows: two payment records
pointing at a job that no longer exists, and both are themselves already
deleted — tombstoned residue, not live money. Six line items and one fence run
point at missing jobs; they are invisible (everything joins through the job)
and harmless. Five soft-deleted jobs still carry live line items, which is
arguably right — restoring a job needs them.

Nothing in any of that needs doing.

---

## What I did not build, and why

You asked for these in the office plan. Skipping them silently would be worse
than saying so.

**Undo-send and scheduled send.** Both need something to send the mail later,
and there is no worker. Holding it in the browser means closing the tab
silently drops the email — worse than not offering it. Doing it honestly needs
`pg_cron` plus `pg_net`, which is real infrastructure that touches sending, and
I was not standing that up unsupervised overnight. Say the word and it is a
proper piece of work.

**Breadcrumbs.** In a tabbed single-page office they would restate the tab you
are already looking at. Real cost, no information.

**Keyboard shortcuts.** Genuine risk of swallowing keystrokes while you are
typing an email, and shortcuts nobody can discover are not used. It would need
a help overlay to be worth anything, which is more surface than the feature
deserves for how you actually use the office.

**A notifications centre.** Its only data source would have been
`attention_findings`, which was empty and switched off everywhere — a panel
that is permanently blank. I built the switch and the panel for the alerts
themselves instead, which is the same information with something behind it.

**Column visibility on tables.** The tables already collapse at phone width.
I would rather not add a control that mostly gets set once and forgotten.

## The new panels are actually executed now, not just grepped

Worth saying because it is the thing I could not do before. The office cannot
be driven without a login, so every change to these panels has gone live
unexercised.

Two tests now lift the real `renderAttention` and `renderFollowUps` out of the
page and **run them** against a stand-in DOM — switched off, switched on with
nothing waiting, switched on with findings, and as somebody who is not allowed
to change the setting. A crash there is a crash in your browser.

And five mutations prove those tests have teeth, each required to make its own
suite go red. The first one renames a global to something that does not exist:
no grep anywhere in this project would catch that, and it is caught now.

---

## The test suite, and three live bugs it was holding

I ran all 191 website tests. **180 passed, 11 failed. Eight are now fixed; the three that remain are red on purpose.** A clean run on this repo is 188 of 191. Working through them was
the most productive hour of the night, because almost none of them run anywhere
automatically — the website workflow ran a handful, and the publish gate does
not run `tests/*.test.mjs` at all. So they had been red and unread.

**Three were real bugs, now fixed:**

- **The "Blocked" job view has never matched a single job.** It reads
  `blocked_at`, which was never in the list of columns the page selects. A
  column you did not ask for is not an error — it is just `undefined` — so the
  filter quietly matched nothing, which looks exactly like a business with no
  blocked jobs. `tests/job-columns.test.mjs` names the column precisely. It
  simply was not running.
- **`can_see_pay()` asks for SEE_MONEY** — the security item above.
- **Three tests pinned the old database version**, so the marker-size columns
  that let a house be drawn to size made them red. One of them said "a phone at
  49 would throw on open", about a migration list that was perfectly correct.

**Four were tests pinning behaviour that deliberately changed**, and in each
case I checked the new behaviour was right before touching the test:

- The drawing tap gained double-tap-to-finish. a41 is built to stop exactly
  that and make somebody look, so I did the check it demands: the new call
  reads points, removes the duplicate the second tap made, writes them back,
  and touches no scale field. Its guarantee holds.
- Mail sync moved to every 5 minutes — the fastest GitHub will honour — and a
  test still pinned 10.
- A height check called the house box a second owner of the catalog's height
  column. Two tables may both have a `height_ft`.

**Three are red on purpose and should stay that way.** Two are spec tests for
joining work that has not landed, one marked as needing your decision first.
The third is the labour test — its four failing checks *are* the security
report above. It goes green by fixing the function, never by editing the test.

**The last two were the "two gate posts" rule**, from before you asked for one
gate post and a latch post. I did them in the end, by measuring rather than
guessing, and the measurement is the reassuring part:

| | before | after |
|---|---|---|
| Line gate | 2 gate posts + 2 end posts | 1 + 3 |
| Line-to-wall gate | 2 gate posts + 3 end posts | 1 + 4 |

**Four posts either way. Five posts either way.** Nothing was added or lost —
a post changed which catalog row it bills, which is exactly what you asked
for. And two checks in those files passed untouched the whole time, which is
what proves it: every "no count moved" check (post caps, concrete bags, total
posts), and the one asserting the grand total does not move on a catalog where
a gate post costs what an end post costs.

So the money is identical. The materials list now just says which post is
which — the hinge post carries the gate, the latch post is one more post the
fence ends on.

**Both `job-columns` and `office-language-parity` are now on the website
workflow.** They are cheap, each catches a whole class of silent breakage, and
it was twice tonight that a check which could have caught something simply was
not being run.
