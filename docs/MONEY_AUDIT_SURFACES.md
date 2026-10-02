# Money audit, lens one: every figure that appears on more than one surface

Written 2 Oct 2026. A hunt: no source file was changed, no SQL applied, nothing deployed,
nothing staged. Jobs are lettered A to K in creation order; no customer name, address or
email is in this file. Fixtures are marked FIXTURE (A, F, G are `is_test_fixture`).

The question: a contractor sees money in five places and they must agree. For every figure,
where is it computed, from what, and can two copies disagree? Then: test it, on his real
rows, read only.

## 0. Read this first

1. **Five of his jobs (D, E, H, I, J) are priced at labour and gates only, and every server
   surface agrees on the wrong number.** The stored `contract_total` of each equals, to the
   cent, what the engine returns with the materials list empty (D 5,853.81, E 700.00,
   H 13,266.87, I 200.00, J 400.00). All five were written in one phone sync pass between
   21:26:40 and 21:27:01 UTC on 1 Oct, the same pass that tombstoned every generated line on
   them. This is also the answer to "nine of eleven jobs hold no priced lines": it was not
   slow drift, it was one event. Job K shows the same signature in the same second and
   recovered within seconds as its lines came back. Details in section 4, F1.
2. **A customer who opens the link on D, H or I today and presses Approve records the
   labour-only figure as the accepted price.** Run against the real `quote-view` handler and
   his real rows (fake database, nothing written anywhere): D approves at 5,853.81 against a
   signed 15,540.00; H at 13,266.87 against 35,240.00; I at 200.00 against 870.00. D and H
   have both been opened by the customer (`quote_viewed_at` is set on both).
3. **The office "Re-price" button is a month behind the phone.** The deployed `price-job`
   is v12 from 5 Sep, engine 2026.09.1: it still rounds the total up to the next $10 and has
   no height rule. It disagrees with the phone's engine on every job (K: 4,560.00 office
   against 4,752.16 phone, stored 4,654.47). "Keep this price" stamps that figure.
4. **Phone "Request Payment" and the customer's own page ask for different amounts after any
   part-payment.** K with $500 in: phone asks 4,154.47 ("balance"), the customer page asks
   2,500.00 (rest of the deposit). Still open, and both sides are deliberate (section 4, F3).
5. The accepted-price rule itself is clean: three copies (TypeScript, office JavaScript,
   Kotlin) agree on 100,000 random cases, and the SQL copy agrees with them on all 11 live
   rows. Paid, refunds and the ledger agree on every job. Section 6 lists what was checked
   and found clean.

## 1. What was read, what was run, and what is deployed

Read: `EstimateEngine.kt`, `JobMoney.kt`, `PdfExporter.kt`, `JobDetailScreen.kt`,
`EstimateScreen.kt`, `JobsViewModel.kt`, `ReportsViewModel.kt`, `JobSync.kt`,
`TakeoffRefresher.kt`; `pricing/totals.ts`, `quote-deposit.ts`, `quote-view`,
`create-payment-link`, `quote-approval-email`, `price-job`, `record-payment.ts`;
`dashboard.html`, `quote.html`; the live bodies of `ar_aging`, `job_costing`,
`job_anchored_total`, `business_report`, `recompute_job_totals` and the trigger list on
`jobs`, `estimate_line_items`, `change_orders`.

Live reads (all SELECT, each with a positive control, raw output checked for errors):
six queries against his company, one `functions list`, and six `functions download` calls
that write only into a scratch folder. One query ran `ar_aging()` and `job_costing()` as his
owner inside a transaction that was rolled back; its control (11 visible jobs) passed.

**Source against deployed, and why it matters.** The working tree is mid-edit (engine
2026.10.9 on both sides; HEAD is 2026.10.6). What is live is older:

| Piece | Live | Working tree |
|---|---|---|
| `price-job` (office re-price) | v12, 5 Sep, engine 2026.09.1: `Math.ceil(x/10)*10`, no `height_ft` | 2026.10.9: exact cents; still no `height_ft` in `CATALOG_COLUMNS` |
| `create-payment-link` | v49, 22 Sep: older `quote-deposit.ts` (no `balance`, no re-approval cap) | has both |
| `quote-view` | v32, 1 Oct 18:09 UTC: `pageFigures` and `quote-deposit.ts` identical to the working tree; the other differences I read are email and push code | |
| `record-payment.ts` | identical | |
| approval email | **cannot run**: table `quote_approval_emails` does not exist live (a55 not applied) and the live `quote-view` does not call it | written |
| phone | unknown build; the 21:27 batch stamped engine 2026.10.2 | 2026.10.9 |

Everything below that says "the engine" and "the server" was run from the working-tree
files on his real rows unless it says "deployed".

## 2. Where each surface gets its numbers

| Surface | Total | Deposit | Paid / balance |
|---|---|---|---|
| PHONE job screen | `JobMoney.billableTotal(job, live, orders)`; live = `computeTotals` over lines held on the phone | stored `depositAmount`, raw | `netPaid`, `stillOwed`, `balance` (JobMoney) |
| PHONE estimate card | **live** `grandTotal` in the Total row | raw `depositAmount`; Balance from `billableTotal` | JobMoney |
| PHONE home, lists, reports | `billableTotal(live)` per job | n/a | `stillOwed`; Reports list filters `outstanding > 0.01` |
| OFFICE job sheet | `anchoredTotalOf ?? contract_total` | `depositAskedOf` = min(deposit, price) | `netPaid` from the cached columns |
| OFFICE reports | SQL `coalesce(anchored, contract_total, lines+extras)` | n/a | ledger sum, no floor |
| OFFICE re-price panel | `price-job` dry run, `grand_total` | `depositAskedOf(job, grand_total)` | n/a |
| QUOTE page | `depositFigures().total` (server) | `asked`, `due`, `balance` from the same call | same |
| CONTRACT / INVOICE PDF | `JobMoney.documentTotal` (billable) | **raw** `depositAmount`, row and `{DEPOSIT}` | `netPaid`, `stillOwed(billable)` |
| APPROVAL EMAIL | `depositFigures().total` re-read from the database at send time | `asked`, `due` | n/a (not live) |
| PAYMENT LINK | cap = `depositFigures().total`; office door cap = accepted figure only in the working tree | deposit link = `due`; balance link = `balance` | same |

## 3. The matrix, figure by figure

Three answers each: computed once or again; same rounding and order; what input makes two
copies differ.

### 3.1 Grand total

- **Where.** Kotlin `computeTotals` (EstimateEngine.kt:1481) and TypeScript `computeTotals`
  (pricing/totals.ts) are two engines. `jobs.contract_total` is a cache of one of them: the
  phone pushes `totalFor(job)` when it differs by more than half a cent and the job has any
  working (JobSync.kt:1071), and `price-job` commit writes it with `priced_by = OFFICE`.
- **Once or again.** Again: two engines, a cache of one of them, and three fallbacks for when
  the cache is 0 or null: quote-view adds the lines and tax; the office adds lines and
  change orders with no tax and no labour; SQL does the same as the office; the phone
  always runs its engine.
- **Rounding and order.** The two source engines are identical: same operation order
  (materials, tax, labour, teardown, change orders, gates, then markup, then discount), one
  `Math.round(x*100)/100` at the end, 85 parity fixtures. The deployed `price-job` is not:
  it rounds up to $10. The quote-view fallback computes tax as `Σtaxable * rate / 100`; the
  engine as `Σtaxable * (rate / 100.0)`.
- **What makes them differ.**
  - Deployed `price-job` against the phone on his rows, today (grand total):
    B 24,380.00 against 24,919.84; C 5,680.00 against 5,822.44; D 15,520.00 against 15,934.34;
    E 2,210.00 against 2,258.04; H 35,220.00 against 36,196.21; I 830.00 against 840.14;
    J 1,120.00 against 1,140.07; K 4,560.00 against 4,752.16.
  - Source `price-job` (no `height_ft` selected) against the phone, the height rule alone:
    B +545.21, C +148.28, D +419.84, E +40.11, H +980.58, I +14.79, J +28.94, K +177.79.
  - Fallback tie: one taxable line of $65.50 at 7%: the page prints 70.08, the engine 70.09.
    Found by search: about 1 in 20,000 random multi-line jobs, and the single-line case above.
  - Fallback scope: FIXTURE G (`contract_total` 0, six lines worth 7,735.45): quote page
    7,735.45, office 0.00 with a balance of -7,170.00, `ar_aging` and `job_costing` 0.00,
    pay link "nothing to pay", phone 7,735.45.

### 3.2 Materials subtotal

- **Where.** Engine: `Σ quantity * (supplier_unit_price ?? unit_price)`, unrounded, in
  (sort_order, sync_id) order (types.ts `lineTotal`, Entities.kt:942).
- **Again.** Yes: the office job-sheet "Materials" total, the quote-view fallback, the office
  `contractTotalOf` fallback and the `ar_aging` / `job_costing` `materials` CTEs all sum
  `quantity * unit_price` and ignore the supplier price. quote-view orders lines by
  `sort_order` only, so ties sum in database order.
- **Differ.** Any line with a supplier quote. Planted on K (one line, 13 panels at 52.35,
  supplier 10% under, real engine): engine materials 2,760.49; office job sheet 2,828.48,
  +67.99. No live line carries a supplier price today (0 of 38), so this is latent.

### 3.3 Tax

- **Where.** Engine only: `taxableSubtotal * (rate/100)`, unrounded. Shown on the phone card,
  the working-estimate PDF and the office dry run. Never printed for the customer.
- **Again.** Only inside the quote-view fallback (3.1). Taxable flags are copied from the
  catalog onto each line when it is generated, so the flag a surface sees is the line's.
- **Differ.** The half-cent tie in 3.1. On his rows: no difference.

### 3.4 Labour (and minimum labour)

- **Where.** Engine only: `laborFlatFee + rate * max(billableFeet - gateFeet, 0)`, floored at
  `minimumLaborCharge` only when that is above zero (both engines guard it the same way).
- **Again.** No second formula anywhere. The only way two surfaces differ is a different
  footage or a different engine version (3.1).
- **Differ.** Not on his rows beyond 3.1. It is the only thing left in the five labour-only
  totals of F1.

### 3.5 Gate charge

- **Where.** Engine only: `gateFeet * gateRatePerFt`, with labour feet reduced by gate feet.
  An uncalibrated photo run is blanked on the server (`neutralizeUnscaledRun`) and its gates
  refused on the phone (`blockedByUncalibratedPhoto`); same result.
- **Again.** No. The PDF prints gate feet with `%.0f`, a display rounding of the footage only.
- **Differ.** Not on his rows. The deployed `price-job` pre-dates the blank post on a wall
  gate (+17.72 on his vinyl), so an office re-price of a wall-gate job is short by that.

### 3.6 Markup and discount

- **Where.** Engine only. Markup is taken on the pre-markup figure that already includes
  tax; discount comes after markup. Documented in `totals.ts` as the field's own convention.
- **Again.** No. Shown on the phone card, PDF working copy and office dry run; never to the
  customer. Same rows, same fields.
- **Differ.** No. (The office "Stays with you" row and the phone's are the same formula,
  `grand - tax - materials`; it counts the markup on tax as the contractor's.)

### 3.7 Minimum job charge

- **Where.** Engine, applied before the final rounding: `max(afterDiscount, minimum)`.
- **Again.** Three explanations of it: the phone note (`grandTotal <= minimum`), the PDF row
  (`grand - rowsSum`, internal copy only) and the office note `opRoundedUpNote`. The customer
  sees none.
- **Differ.** The office note. With his real job J's rows and the minimum raised to 2,000
  (real `renderOfficePricingResult` from `dashboard.html`), the panel prints "The total is
  rounded up from $1,111.13 to the next $10 (and never below the minimum job charge)" beside
  a total of $2,000.00. True of the deployed engine, false of the source one: it becomes a
  false sentence the day `price-job` is redeployed. Nothing on his rows triggers it today.

### 3.8 Deposit asked

- **Where.** Stored `jobs.deposit_amount`, typed or set by the phone's "Set deposit"
  (`ruleDeposit`: materials still to buy, up to the next $100, plus $100, capped at what is
  owed). The rule exists twice (Kotlin, TypeScript) and agreed on 400,000 random inputs and
  200,000 capped-suggestion cases.
- **Again.** Three readings of the stored figure. Quote page, approval email and pay link:
  `min(deposit, billable)`. Office: `min(deposit, price)` where price is `contractTotalOf`,
  or the dry-run `grand_total` inside the re-price panel. Phone estimate card, contract PDF
  row and the `{DEPOSIT}` in the contract terms: the raw stored number.
- **Differ.** Deposit above the price. Input: deposit 3,963 on a 3,620 job (a real earlier
  case): page, email, link, office 3,620.00; PDF, contract terms and estimate card 3,963.00.
  No live job has a deposit over its price today.
- **Never disclosed.** No customer surface (page, email builder, PDF, contract terms) carries
  the extra $100 or any wording for it. The only text that explains the rule is on the
  owner's job screen, and it is wrong (F10).

### 3.9 Deposit due and balance

- **Where.** Server: `depositFigures` gives `due = max(0, asked - netPaid)` and
  `balance = max(0, total - netPaid)` once, and the page, the email and the pay link read
  them. Phone: `JobMoney.nextRequestAmount` is a second rule (F3). Office: `balanceOf` and
  `stillOwed`. PDF: `stillOwed(billable)`.
- **Again.** Yes: Kotlin (`JobMoney`), TypeScript (`depositFigures`) and the office's
  JavaScript each compute it. The server shape is one function; the phone's request amount
  is its own rule.
- **Rounding.** All plain subtraction on cents-exact figures; no rounding anywhere.
- **Differ.** After any payment (F3); and when the total is 0 or null (3.1: the page prints a
  fallback total but derives balance and due from total 0, so for G it says "Nothing left to
  pay" under a total of 7,735.45 with 565.45 actually owed against that total).

### 3.10 Paid and refunds

- **Where.** One source: `payment_records`. The trigger `payment_records_totals` rebuilds
  `jobs.amount_paid` (sum of rows >= 0) and `refunded_amount` (sum of rows < 0, positive) on
  every ledger write. Every surface reads `max(0, paid - refunded)` except `ar_aging`, which
  sums the ledger raw.
- **Again.** Twice in form (cache against ledger), once in fact.
- **Differ.** Only when refunds exceed payments: ledger +1,000 and -1,200 gives `ar_aging`
  paid -200 (owed = total + 200); the phone and office give paid 0 (owed = total). No live
  job has a refund. Live check: ledger against cache matches on all 11 jobs.

### 3.11 Change orders

- **Where.** Engine counts every change order in the live total, signed or not. After
  acceptance the price is `accepted_total` plus orders signed after acceptance that the
  acceptance did not already contain (`in_accepted_total`).
- **Once or again.** The anchoring rule is written four times (TypeScript `billableTotal`,
  office `anchoredTotalOf`, Kotlin `anchoredTotal`, SQL `job_anchored_total`) and does not
  differ: 100,000 random cases across the first three, including equal timestamps, 0.005
  thresholds, tombstoned orders and null flags, zero disagreements; the SQL function equals
  the others on all 11 live rows. A planted `>=` made the harness report 527 of 20,000 cases,
  so it can fail.
- **Differ.** No. No live job has a change order (0 rows), so nothing here is tested on real
  data beyond that.

### 3.12 The accepted, anchored price

- **Where.** `jobs.accepted_total`, stamped by the server: quote-view writes the page's total
  in the same UPDATE as the online approval; a trigger copies `signed_contract_total` on a
  drawn signature.
- **Differ.** Two places read something else on purpose, and they are the ones that matter on
  five of his jobs: (a) while a re-approval is pending the anchor is off and every surface
  falls back to the live `contract_total`, so on D, H and I the customer-facing price is the
  labour-only one (F1); (b) the phone's re-sign check (`signatureIsStale`) compares the
  signed total with the live total, not the billable one. Phone says "price moved, get a new
  signature" and blocks sending the estimate and invoice on B (19,810.00 against 9,290.57),
  C (200.00 against 2,160.47), D, H and I. The gate is working as designed; the live figure
  it compares against is the wrong one.

### 3.13 Payment status and open payment links (not figures, but money on screen)

- `record-payment.ts:161` sets `payment_status = DEPOSIT_PAID` on every payment, including the
  last one. The phone moves it up only when that job's screen is opened. Office attention and
  chips read the column, not the money (`dashboard.html` 11734, 11869, 13466). Live: B and D
  read DEPOSIT_PAID with $0 paid (their ledger rows are soft-deleted); G reads PAID_IN_FULL
  having paid 7,170 of 7,735.45.
- An open payment link keeps the amount it was made with. H holds a pending 21,520.00 deposit
  link while its deposit is 8,101.68; C holds pending links of 336.82 (balance) and 160.00
  (deposit) against 200.00 owed. All are test mode (`livemode` false), so nothing takes money
  today.

## 4. Findings

### F1. Five jobs are priced labour-and-gates only; the server surfaces agree on it (HIGH)

What happened, from the live rows:

- `contract_total` on D, E, H, I, J equals the engine's answer with an empty catalog (so no
  material line can be built) to the cent: D 5,853.81, E 700.00, H 13,266.87, I 200.00,
  J 400.00. B, C and K do not match (B and C are anchored; K was repaired).
- Each of those jobs had its generated lines tombstoned at 21:26:40 to 21:26:59 UTC on 1 Oct
  with `deleted_by` empty (all of them on E, I, J; 18 of 20 on D and 13 of 16 on H, the rest
  being older tombstones), then `priced_at` 1 to 2 seconds after its last tombstone
  (D 21:26:59.9, J 21:27:00.1, H 21:27:00.4, I 21:27:00.6, E 21:27:01.0), `priced_by = APP`,
  engine 2026.10.2. `price-job` writes `deleted_by` and `OFFICE`, so this was the phone.
- `audit_log` shows (actor not null, so his login) the deposits rescaled in the same second,
  by the deposit trigger since dropped, firing on the new total: D 5,896.82 to 2,158.45
  (21:27:00.09), H 22,157.13 to 8,101.68 (21:27:00.60), K 1,690.00 to 588.93 (21:27:01.02).
  K's deposit then
  climbed back (1,383.33, 1,638.08 ...) as K's lines returned, and he set it to 3,000.00 at
  22:00. D and H kept the damage: the deposits he typed were 5,730 and 21,520.
- K shows it was not the data: its deposit was rescaled in the same second as the others and
  then recovered as lines came back (probably when he opened it; a line revived by upsert
  leaves no tombstone, so nothing remains to prove it).

Unproven, and not mine to settle: why a pass deleted generated lines and built none. Leads,
in the code: `EntitySync.pullJobChildren` calls `deleteOrphanedGeneratedLineItems()` on every
pull (EntitySync.kt:2822), which tombstones in the cloud any generated line whose run is not
on the phone; `TakeoffRefresher.refreshRun` clears generated lines for a blocked photo run.
A pass that pulled lines before runs would do exactly this.

Who sees what today (rows D, H, I are re-approval pending, so the anchor is off):

| | D | H | I |
|---|---|---|---|
| signed contract | 15,540.00 | 35,240.00 | 870.00 |
| quote page, office, `ar_aging`, `job_costing` | 5,853.81 | 13,266.87 | 200.00 |
| customer presses Approve: `accepted_total` written | 5,853.81 | 13,266.87 | 200.00 |
| stored deposit (typed value) | 2,158.45 (5,730) | 8,101.68 (21,520) | 0 |
| phone live, phone billable | 5,853.81 | 13,266.87 | 200.00 |
| phone "re-sign" gate | blocks | blocks | blocks |

E (draft, sent, viewed) and J (draft) show 700.00 and 400.00 on the page.

Cost: a customer can sign for 23 to 38 percent of the signed price (I 200 of 870; D and H
about 38 percent), and the approval email, once deployed, would send that figure as the
contract. "Who owes you" is short by 9,686.19 on D
alone against the signed figure, 21,973.13 on H.

### F2. The office re-price disagrees with the phone on every job (HIGH)

Deployed `price-job` v12 is engine 2026.09.1. See 3.1 for the eight pairs. After an office
"Keep this price" the job carries `priced_by = OFFICE`; the phone then cannot overwrite it
once `quote_sent_at` is set (JobSync.kt:1132), so the customer sees the old-engine figure.
The re-price would put lines back on D, E, H, I, J, but stamping the deployed engine's
figures (D 15,520.00, E 2,210.00, H 35,220.00, I 830.00, J 1,120.00), not the phone's. Even
redeployed from the working tree, `CATALOG_COLUMNS`
has no `height_ft` (price-job/index.ts:127), so the office prices every panel and post as if
no height were set. The existing test has this as a `todo`
(tests/a46-catalog-height-office-chain.test.mjs:109).

### F3. Phone "Request Payment" and the customer's page ask for different amounts (HIGH, known)

`JobMoney.nextRequestAmount` (JobMoney.kt:72): once any money is in, it asks for the whole
balance. `depositFigures().due` keeps asking for the rest of the deposit. The Kotlin tests
pin the phone rule (JobMoneyTest, BalanceTest) and the estimate warning's comment describes it
as design. Real figures (K, deposit 3,000.00, total 4,654.47): $500 in: phone 4,154.47
("balance"), page 2,500.00; $3,000 in: phone 1,654.47, page 0 (nothing due). C (deposit
160.00, total 200.00): $100 in: phone 100.00, page 60.00. The office door of
`create-payment-link` accepts what the phone sends, so the 4,154.47 link can be sent.
This is `MONEY_DISAGREEMENTS.md` Issue 2; nothing has changed it.

### F4. Quote page fallback total and its own balance disagree when `contract_total` is 0 (MEDIUM, latent)

`quote-view` prints `roundToCents(Σlines + tax)` as the total (quote-view/index.ts:382) but
derives deposit, due, payable and balance from `depositFigures`, which sees a total of 0.
FIXTURE G: total 7,735.45, "Nothing left to pay", deposit 7,170.00 with 0 due. The office
reads 0.00 and a balance of -7,170.00 on the same job, the reports 0.00, the pay link
"nothing to pay". Three different fallbacks exist (3.1). No real job has `contract_total`
0 or null today (A is null and empty).

### F5. The phone estimate card puts a live Total above an accepted Balance (MEDIUM)

EstimateScreen.kt:685 prints `grandTotal` (live); 697 to 700 print the raw deposit and a
Balance from `billableTotal`. C today: Total 2,160.47, Deposit asked 160.00, Balance 200.00.
B has no deposit so the rows hide; the job screen shows "Accepted price" beside the moved
estimate, the estimate card does not.

### F6. Deposit shown raw on the contract and the estimate card, capped everywhere else (MEDIUM)

PdfExporter.kt:465 and 579, EstimateScreen.kt:699 print `depositAmount` uncapped. See 3.8.
The phone job screen warns (`depositOverContract`); the contract does not.

### F7. The office job sheet draws no deposit or balance for a job with no lines (MEDIUM)

`dashboard.html:21379`: `if(li.length && canSeeMoney())`. Seven of his eight real jobs hold
no live lines (B, C, D, E, H, I, J), so the sheet shows nothing where the phone and the page
show a deposit and a balance. A consequence of F1, but also a rule that hides money for a
reason unrelated to money.

### F8. Payment status is a column nobody keeps true (MEDIUM)

See 3.13. A card-paid job reads "Deposit paid" and "unpaid finished" in the office until the
phone opens that job.

### F9. Open payment links are not reconciled when the deposit or price moves (MEDIUM, test mode)

See 3.13. H's 21,520.00 link was made at the deposit he typed; the deposit then fell to
8,101.68 and the link did not. Stripe links do not expire. Harmless while the processor is in
test mode; the day it is live, this is a stale charge. The deployed `create-payment-link` (v49)
also lacks the working tree's re-approval cap, so while a re-approval is pending the office
door caps against the live figure, which on H and D is now the labour-only one.

### F10. Two stale sentences on money screens (LOW)

- `strings.xml:677-678`: the owner's job screen says deposit materials are "Rounded up to the
  next $10". The rule is the next $100 plus $100. `JobDetailScreen.kt` ~2057 still decides
  whether a suggestion was capped with `ceil(x/10)*10`, so the "all that is still owed"
  label never shows. Constructed input, materials 4,560.00 on a 4,654.47 job: the button
  reads "Set deposit to $4654 (covers materials)" and stores 4,654.47 (the customer is asked
  for the whole job).
- The office `opRoundedUpNote` (3.7).

### F11. Rounding at the edges (LOW)

- Cents-exact figures (totals, deposits) print identically everywhere. Un-rounded rows do not
  at a tie: Android `NumberFormat` (half-even on the exact binary value) prints 4.585 as
  $4.58, 12.125 as $12.12, 70.085 as $70.08; the web `Intl` (half-expand on the shortest
  decimal) prints $4.59, $12.13, $70.09. Java's own `String.format("%.2f")` agrees with the
  web, not with its own `NumberFormat`. Internal screens only (rows, line totals).
- The phone's Reports list drops a job owing exactly one cent (`outstanding > 0.01`); the
  office list and the job screen keep it (`> 0.005`).
- Displayed rows (each to cents) summed to the displayed total on all six engine outputs
  checked; the effect is possible in principle and was not found.

### F12. One more consequence worth knowing

C is signed and anchored at 200.00 on a 270 ft job whose runs price at about 5,700. Every
surface agrees on 200.00, so no comparison shows it.

## 5. Real jobs, every surface

Totals (dollars). "Phone live" is `computeTotals` over the lines the job holds. "Office
re-price (deployed)" is what the live button would produce now.

| Job | Stored / accepted | Page, email, office, `ar_aging`, `job_costing` | Phone billable (job, PDF) | Phone live (estimate Total) | Office re-price (deployed) | Phone re-generate |
|---|---|---|---|---|---|---|
| B | 19,810.00 / 19,810.00 | 19,810.00 | 19,810.00 | 9,290.57 | 24,380.00 | 24,919.84 |
| C | 200.00 / 200.00 | 200.00 | 200.00 | 2,160.47 | 5,680.00 | 5,822.44 |
| D | 5,853.81 / 15,540.00 (re-approval) | 5,853.81 | 5,853.81 | 5,853.81 | 15,520.00 | 15,934.34 |
| E | 700.00 / none | 700.00 | 700.00 | 700.00 | 2,210.00 | 2,258.04 |
| H | 13,266.87 / 35,240.00 (re-approval) | 13,266.87 | 13,266.87 | 13,266.87 | 35,220.00 | 36,196.21 |
| I | 200.00 / 870.00 (re-approval) | 200.00 | 200.00 | 200.00 | 830.00 | 840.14 |
| J | 400.00 / none | 400.00 | 400.00 | 400.00 | 1,120.00 | 1,140.07 |
| K | 4,654.47 / none | 4,654.47 | 4,654.47 | 4,654.47 | 4,560.00 | 4,752.16 |

"Phone re-generate" is the working-tree engine as the phone runs it (reads `height_ft`,
rebuilds lines from the runs); it is what a phone shows after a run is edited. For jobs with
no lines this is a hypothetical, not what the phone shows now.

Deposit (dollars):

| Job | Stored | Page asks / due | Phone request | PDF row | Office | Rule from materials |
|---|---|---|---|---|---|---|
| C | 160.00 | 160.00 / 160.00 | 160.00 deposit | 160.00 | 160.00 | n/a (no lines) |
| D | 2,158.45 (typed 5,730) | 2,158.45 / 2,158.45 | 2,158.45 | 2,158.45 | 2,158.45 | n/a |
| H | 8,101.68 (typed 21,520) | 8,101.68 / 8,101.68 | 8,101.68 | 8,101.68 | 8,101.68 | n/a |
| K | 3,000.00 | 3,000.00 / 3,000.00 | 3,000.00 | 3,000.00 | 3,000.00 | 3,000.00 (materials 2,828.48) |

Where two surfaces disagree today on a real job: B, C, D, H, I (phone re-sign gate against
all others); C (estimate card Total against Balance); B, C, D, E, H, I, J (office deposit
and balance block missing); every job (office re-price against all others); D, H, I (page
against the signed contract); B and D (payment status against money); H and C (open links
against deposit and balance). Where nothing disagrees: total across page, email, office and
reports on all 11 jobs; paid and refunds on all 11; deposit asked on all eight real jobs.

## 6. Checked and clean

- The anchored-price rule: TypeScript, office JavaScript and Kotlin on 100,000 fuzz cases;
  the SQL copy on the 11 live rows; planted failure caught.
- Paid, refunded and the cached columns against the ledger: all 11 jobs.
- The deposit rule and the capped suggestion, TypeScript against the Kotlin port: 600,000
  inputs, no difference.
- Page, email and pay link share `depositFigures`; the email builder carries one deposit
  field and no wording for the extra $100; nothing customer-facing mentions it.
- Rows summing to the total, six engine outputs.
- Statuses that count as won agree: phone, office, `ar_aging` (accepted and completed).
- The deposit warning (collected against deposit) is correct on its own arithmetic.
- The quote page's downloadable copy reuses the rendered rows; it recomputes nothing.

## 7. Not checked

- His phone's own database: "phone live" is the engine over the server's rows. It equals the
  stored `contract_total` on the six unanchored jobs D, E, H, I, J, K (K to the cent; B and C
  are anchored, so their stored figure is the accepted one), which makes it a faithful model,
  but it is not a read of the handset. The Kotlin figures are a line-for-line port of
  `JobMoney.kt`, not the Kotlin run; `gradlew` was off limits.
- The deployed `dashboard.html` and `quote.html` (the website's published copy).
- Whether the live `ar_aging` and `job_costing` differ in a case his data does not exercise
  (refunds above payments, a change order, supplier prices): the arithmetic above is from
  their live bodies, not from a run.
- The cause of the 21:26 pass (F1 leads).
- Customer-facing text in Spanish and French for the stale "next $10" sentence.

## 8. Reproduce

Scripts live in the session scratchpad, outside the repo (`scratchpad/q/*.mjs`, with the
pulled rows in `p3.out`, the owner-impersonated ledger query in `p5.out`, and the downloaded
deployed functions under `scratchpad/deployed*/`). `surfaces.mjs` builds the per-job table;
`nomat.mjs` shows the zero-materials match; `approve.mjs` runs the real approve handler on a
fake database; `dep.mjs` runs the deployed `price-job` engine; `fuzz.mjs` is the four-copy
rule check; `note.mjs` renders the office re-price panel from the real function. Node 24
imports the TypeScript directly.
