# Overnight, 4–5 October

## Read this bit if you read nothing else

- **The contract email is not broken.** I told you five approvals had produced
  nothing. That was wrong. It has run once, correctly, and the quiet was
  chronology and a missing address. Details below.
- **Two real bugs fixed.** An unfilled `{{placeholder}}` could be mailed to a
  customer; and a publish could burn two hours to refuse something it knew in
  one second.
- **One thing needs you, one line:** add a 4 ft vinyl **corner post** to the
  catalog at **$16.75**. That is the whole of what you spotted. Easiest in the
  app: Catalog → new item → Corner post, Vinyl, height 4.
- **One switch is yours to flip:** nine server-side alerts are built and off.
  I built the panel; I did not turn them on, because it starts pushing
  notifications to your phone.
- **App 1.602 is live**, with the house/pool/driveway box drawn to scale and
  free-standing gates. Verified from the release row and the hosted file, not
  the build log.
- **Makayla's quote has no corner post on it** — but you appear to have
  removed them on purpose, so read that section before changing anything.

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

## Two real bugs, both fixed

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

## Not built, on purpose

**Undo-send and scheduled send.** Both need something to send the mail later.
There is no worker — holding it in the browser means closing the tab silently
drops the mail, which is worse than not offering it. It would take `pg_cron`
plus `pg_net` to do honestly, which is real infrastructure that touches
sending, and I am not standing that up unsupervised overnight. Say the word
and it is a proper piece of work.

## One switch you may want on — your call, I have not touched it

There are **nine server-side alert detectors** built, deployed, and triggered
hourly by a GitHub Action: money already at risk or gone, a crew about to be
sent to a job that is not ready, and 811 / permit / HOA deadlines.

They are **off for every company**, yours included. `attention_sweep_settings`
has no row for anyone, and no row means off. So `attention_findings` is empty,
the office shows no alerts, and that reads exactly like "nothing is wrong".

Off is the deliberate default, so this is not a bug. But it does mean a built
feature is currently doing nothing for you.

I have not switched it on, because it starts sending push notifications to
your phone and that is your decision, not mine. It is one row per company when
you want it.

This is also why I did **not** build the notifications centre from the office
plan tonight: its only data source is that table, so it would have been a
panel that is permanently empty — a control that does nothing, which is the
one thing you said you did not want.

## I built the switch, so it is now yours to flip

Rather than leave that as a note, I built the panel. It sits in **Automation**,
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

I have written the SQL (`supabase_a87_vinyl_4ft_corner_post.sql`) but **not run
it**, because two things in it are inferred rather than yours: the price, and
the supplier's actual name for the part — and that name is what shows on the
materials list someone carries to a counter.

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

John's and James's jobs are still tombstoned (18 items / $9,475 and 13 /
$21,511). You said to leave those, so I have. They are written down here only
so the number exists somewhere.
