# The office re-price button needs one deploy

Written 2 Oct 2026. Nothing in here has been deployed. The code on this machine is
fixed; the server is still running the old copy.

## What is wrong right now

Press **Re-price** in the office and you get one number. Price the same job on the
phone and you get a bigger one. That happens on every job you have — nine of them.

The office is always the LOWER one. It has been undercharging.

Two separate reasons, and they stack:

1. **The office server is a month behind.** It was last updated 5 September. Since
   then the quote stopped rounding up to the next $10 (you asked for that), posts
   learned to match the fence height, and a gate learned to charge for the post it
   bolts through. The phone has all of that. The office server has none of it.

2. **The office was not even asking the price list for the fence height.** This one
   was a real fault in the code, not just an old copy — so a deploy on its own
   would NOT have fixed it. It is fixed now, on this machine, waiting to go out.

Reason 2 is the one worth understanding, because it was buying the wrong posts. When
the office priced a six-foot fence it could not see how tall anything on your price
list was, so it picked posts on price alone — the cheapest. That is the post your
supplier sells for a **four-foot** fence. On a six-foot fence almost none of it is in
the ground. The phone has been picking the right post all along.

## The command

One function, one command, from the project folder:

```
npx supabase functions deploy price-job --project-ref newcrgafcptspmapacrx
```

That is the whole deploy. `price-job` is the only thing on the server that prices a
job, so nothing else needs to go out with it.

It does not touch the database, so there is nothing to back up first and nothing to
undo. If it goes wrong, the fix is to run it again.

## What changes about the numbers

Every job goes UP. Nothing goes down. The "after" column is measured — the real price
list and the real jobs, read out of the live database and run through the same pricing
code the phone uses.

Two cautions on the table, so the numbers are not oversold:

- The jump combines BOTH reasons above, not just the posts. Of job 6's $539.84, the
  fence-height fix is $545.21 and dropping the round-up-to-$10 gives $5.37 back.
- "Office shows now" was read off your screen for jobs 4, 6 and 7 — the three you
  checked — and those three match to the cent. For the other six it is calculated
  from the old code, not observed. Treat them as close, not exact.

| Job | Office shows now | Office after the deploy | Goes up by |
|----:|-----------------:|------------------------:|-----------:|
| 1 | $15,520.00 | $15,934.34 | $414.34 |
| 2 | $1,120.00 | $1,140.07 | $20.07 |
| 3 | $7,710.00 | $8,020.95 | $310.95 |
| 4 | $35,220.00 | $36,196.21 | $976.21 |
| 5 | $5,680.00 | $5,822.44 | $142.44 |
| 6 | $24,380.00 | $24,919.84 | $539.84 |
| 7 | $830.00 | $840.14 | $10.14 |
| 8 | $4,580.00 | $4,752.16 | $172.16 |
| 9 | $2,220.00 | $2,258.04 | $38.04 |

**After the deploy the office matches the phone exactly, to the cent.** That is the
point of it. On the three jobs you checked by hand, the "after" column above is
exactly the phone number you read off the handset.

Most of the increase is the posts, not the panels. A taller post costs more, and you
have been quoting the short one from the office.

## What to check afterwards

Do these four, in order. The first two take a minute.

1. **Pick any job and press Re-price.** Compare the grand total with the table above.
   It should match the "after" column to the cent.
2. **Open the same job on the phone.** The two numbers should now be identical. They
   are the thing that was broken; this is the check that matters.
3. **Look at a post line on a six-foot job.** It should name the post for a six-foot
   fence, not a four-foot one. If it still says the short one, stop and say so — that
   means the deploy did not take.
4. **Check one job with a gate.** Gate panels moved too.

If a number comes out *lower* than the "now" column, something is wrong — every
change here pushes upward. Stop and say so rather than sending the quote.

## Two things this does not do

- **It does not change any quote you have already sent.** A saved quote keeps the
  number it was saved with. Re-pricing a job is what changes it, and that is your
  decision per job. Worth knowing before you re-price something a customer has
  already signed.
- **It does not add heights to price-list rows that do not have one.** 39 of your 123
  rows say how tall they are. The other 84 price exactly as they do today — a row
  that does not say its height is not guessed at. Filling more of them in is a
  separate job, done on the catalog page.
