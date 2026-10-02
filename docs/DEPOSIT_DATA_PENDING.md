# Two deposits that a dropped trigger rewrote — your decision, not mine

Written 2 Oct 2026, while making the deposit mean one thing on every surface
(`tests/a66-deposit-one-meaning.test.mjs`). **Nothing in the database was
changed.** Every figure below was read with SELECT only, no customer name,
address, phone or email in this file, jobs lettered as in
`docs/MONEY_AUDIT_SURFACES.md`.

`docs/LINE_ITEM_LOSS_2026-10-01.md` does not exist in this tree, so this is its
own file.

## What happened

A database trigger (`deposit_follows_price`) used to rescale a stored deposit in
proportion to the price on every re-price. On 1 Oct at 21:26–21:27 UTC a phone
sync pass tombstoned every generated line item on six jobs and re-priced them at
labour and gates only (`OVERNIGHT_2026-10-01.md`, the 03:00 section). The
trigger fired on those new, much smaller totals and scaled the deposits down
with them. **The trigger has since been dropped.** It is not going to do this
again — but it is also not going to put anything back.

## The two jobs that kept the damage

| | Job D | Job H |
|---|---|---|
| deposit you typed | **5,730.00** | **21,520.00** |
| what it had been scaled to before the event | 5,896.82 | 22,157.13 |
| what the trigger wrote, 1 Oct 21:27 UTC | **2,158.45** | **8,101.68** |
| deposit stored today (read live, 2 Oct) | **2,158.45** | **8,101.68** |
| signed contract total | 15,540.00 | 35,240.00 |
| `contract_total` today (labour and gates only) | 5,853.81 | 13,266.87 |
| paid so far | 0.00 | 0.00 |
| re-approval pending | yes | yes |

The deposits-today row, the totals and the paid figures were re-read live on
2 Oct with a positive control (rows came back) and a canary that came back
false; the trigger's before/after figures are from the `audit_log` read recorded
in `docs/MONEY_AUDIT_SURFACES.md`, finding F1.

Job K was rescaled in the same second (1,690.00 → 588.93) and recovered as its
lines came back; you set it to 3,000.00 at 22:00 the same evening, which is what
it still reads. **K needs nothing.**

## Why I have not touched them

1. It is live money on two of your jobs, and which figure you want is a business
   decision, not a bug fix.
2. Neither 2,158.45 nor 8,101.68 is what the deposit rule would produce today
   anyway: the rule works off **the materials still to be bought**, and the
   material lines on both jobs are tombstoned. Until they are back there is no
   honest figure to compute — so I am not going to put a number in this file and
   call it the answer.
3. Both jobs are mid re-approval, so the price itself is still moving.

## The question, in one line

**Do you want D and H put back to the deposits you typed (5,730.00 and
21,520.00), or recomputed from the materials once the line items are restored,
or left where they are?**

Worth knowing before you answer, so you are choosing with the facts:

- Put back as typed: those figures were set against the signed prices
  (15,540.00 and 35,240.00) and are the ones your customers were told.
- Recomputed later: the rule is now the materials with their sales tax, rounded
  up to the next $100, plus $100 — a bigger deposit than the old next-$10 rule
  gave, and it cannot be worked out until the lines come back.
- Left as they are: the quote page, the approval email, the pay link and the
  office will all ask those customers for 2,158.45 and 8,101.68, which is 38%
  and 38% of what they signed for.

Nothing anywhere in the app will change these on its own now. The trigger is
gone, the "Set deposit" button only ever writes when you tap it, and the one
place that could seed a deposit (`JobMoney.depositToSeed`) still refuses any job
a customer is already in.
