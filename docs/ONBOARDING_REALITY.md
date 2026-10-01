# What a new company can actually do

Reconnaissance, 29 September 2026. HEAD 280d0c0, pricing engine 2026.09.3.
Traced from the code and from the live database (read-only). Nothing was
changed, applied, deployed or sent; nobody was contacted; no account was made.

Evidence for every claim below is in `tests/a25-new-company-onboarding.test.mjs`
(how to run it is at the end). Where a claim is an inference and not a
measurement, it says so.

---

## The answer, in ten lines

1. **Nothing seeds anything.** A signup produces one `companies` row holding a
   name and one `profiles` row. No settings row, no catalog, no tiers, no
   suppliers. There is no trigger on `auth.users`, and no database function
   inserts into `material_items` or `pricing_tiers`; only a person pressing a
   button in the app or the office does. (Live-checked; the callers are pinned.)
2. **Until a plan exists the company cannot use even that.** A fresh company is
   `pending`, `company_allowed()` is false, and 21 restrictive policies refuse
   every tenant table. The only way past is a Stripe checkout with a card.
3. **A new company can still produce a number with an empty catalog, and it is
   labour only.** 100 ft of vinyl quotes **$800** with an empty catalog and
   **$2,120** with the starting list. Materials $0, tax $0, no error, and
   price-job's commit writes the $800 as the contract total.
4. **The phone has no setup gate at all.** A new phone job takes 7% tax, 0%
   markup, $8/ft, $200 minimum, $20 gate from literals in the code. The office
   has a gate, but it is satisfied by a single catalog row, and the row can be
   a concrete bag: that quote is $900 against a real $2,120.
5. **The office wizard turns a company's zero into the founder's number.**
   A company that decided on 0% tax and 0% markup gets a job at 7% and 15%.
   A company that set nothing gets 7 / 15 / $8 / $200 / $20. (Run, not read.)
6. **The starting list every new company is told to copy still ships the four
   untaxed rows that the A1 correction fixed on the owner's own live catalog**
   (three 6 ft vinyl panels and the PVC gate). On 100 ft of vinyl that is $27.78
   of tax collected where $90.08 is due (the quote reads $2,120, not $2,180).
7. **The "unverified price" protection is one door of three, and its exit does
   not exist on the web.** The job sheet refuses to give out the quote link
   while starting prices are on it, and the office has no control that marks a
   price as checked. The New client wizard's send step applies no such gate,
   and the phone only warns, with a Send anyway button.
8. **Of the three real strangers who signed up, none stalled at the catalog,
   and none produced a quote.** One never got past the plan screen, one was
   locked out when its trial ended while holding a subscription, one was
   suspended "UNPAID" within two days of its trial starting. The empty catalog is a
   predicted wall, proven by the engine; it has not been observed to stop
   anyone, because nobody has got that far.
9. **Two companies are stuck `trialing` with a trial end in the past and a
   subscription id, and both are locked out**: Legacy (real) and Marc (an
   internal-looking test company). Only March can see Stripe to say why. If the
   trial-to-active step is not landing, every customer is locked out on day 15.
10. **The site never links to the app**, and the last screen of sign-up says to
    install it.

---

## 1. What a company is at the moment it exists

Five things can create a company or an owner. All were read from the live
function bodies, never from a repo `.sql` file.

| Path | Who calls it | What it writes |
|---|---|---|
| `create_company_with_owner(name, owner_name)` | website sign-up (`dashboard.html` `signUp`/`finishCompany`/`boot`) and phone sign-up (`SupabaseModule.createCompany`) | `companies (name)` and `profiles (OWNER)` |
| `admin_create_company(name, email)` then invite | staff console; `invite-company` emails a link | `companies (name, email, status 'pending')` and a `company_setup_codes` row |
| `claim_invited_company()` | `welcome.html` after the invite link | `profiles (OWNER)` onto the waiting company |
| `claim_company_setup(code, name)` | dashboard or phone, "I have a setup code" | `profiles (OWNER)` onto the waiting company |
| `join_company(id, name, role)` | a crew member | `profiles (CREW)`; never creates a company |

Column defaults, from the catalogue: `subscription_status 'pending'`,
`subscription_plan ''`, `trial_ends_at null`, `suspended false`, `phone ''`,
`email ''`, `license_no ''`. Every job pricing column defaults to **0**
(`tax_rate_percent`, `markup_percent`, `labor_rate_per_ft`,
`minimum_job_charge`, `gate_rate_per_ft`).

What a company therefore has on day one: **a name, an owner, and nothing to
price with.** Rolled-back probe: a company row holding only a name reads
`pending`, no plan, no trial, and `company_allowed()` = **false** (controls: a
synthetic trialing company and the owner's paid company both read true).

What happens next depends on the door (section 2). The welcome flow is
details, agreement, plan. `welcome.html`'s last screen says "Your business is
set up, the agreement is signed, and your plan is running", which is true of
those three things and of nothing else.

## 2. The road to a first quote

### Website, the designed path

Marketing page "Start free trial" goes to `dashboard.html#signup`.

1. Company name, your name, email, password (8+). Sign-up. *(Whether the
   project requires email confirmation cannot be read from the database. The
   three real signups each have a profile 0 to 30 seconds after the user, which
   fits confirmation being off. Times in this file are UTC, as stored.)*
2. `welcome.html`: business name (required, phone/email/licence optional) →
   type a name to sign the agreement → pick Solo $99 / Crew $199 / Pro $349 →
   Stripe checkout, **card up front**, 14-day trial. **The three price ids in
   both `dashboard.html` and `welcome.html` are still the test-mode ones**
   (`price_1U7mF...`). `GO_LIVE.md` items 5 and 6 say the Stripe secrets are
   test mode as well, and nothing I can read says they were swapped.
3. "You're all set" → Open my dashboard. Setup panel lists **six essential
   steps**, all open: catalog, labour rate, markup, gate rate, tax rate,
   minimum job charge. (`my_setup_progress()`, live.)
4. `+ New Job`, with any of the six open, opens the **Business setup wizard**
   instead of a job: Business (skippable) → Rates → Standard build → Supplier
   prices → Tiers → Card payments → Crew (skipped on Solo) → Done.
   - Rates: labour $/ft and minimum charge must be above 0; markup and tax
     count as done at 0 (a blank saves as 0); gate rate is pre-filled 20.
   - Supplier prices: **"Start from FenceFlow's catalog"** → confirm dialog →
     92 rows inserted, every one flagged as a starting price.
5. "Create your first client" → **New client wizard**, seven steps: who →
   build → runs (feet or drawing, gates) → pricing → estimate (price-job dry
   run, "Looks right") → schedule → send.
6. Step 7 gives a customer link.

Four screens (sign-up, details, agreement, plan) come before the product shows
anything, and about fourteen more follow the card.

### Phone first

The phone's first screen is Sign in / Try the demo (a read-only sample). Creating
an account: sign up → create company (name) → **a blocked screen, "Start your
free trial"** (status `pending`; it says "Your business is set up", which is a
name) → Choose a plan → **the browser**, sign in again → `welcome.html` (details,
agreement, plan) → back to the phone → Check again → Jobs → New job. Two apps and
two sign-ins before the first job.

- **No setup gate.** A new job is built from `BusinessProfile` literals:
  `defaultTaxRatePercent 7.0`, `defaultMarkupPercent 0.0`,
  `defaultLaborRatePerFt 8.0`, `defaultMinimumJobCharge 200.0`, and
  `Job.gateRatePerFt 20.0`. `createJob` asks nothing about setup or the catalog.
- First-run tour, five dialogs. Step 1 promises "posts, panels, concrete and a
  price in about a minute". No step says the catalog is empty or names the copy
  button.
- Draw a run, press Suggest Quantities. With an empty catalog:
  *"Your materials catalog is empty. Add items under Catalog, then try again."*
  It does not name the copy button either. (A one-line message; the tour and
  the Home banner do not name it.)
- Catalog screen, **only while it is empty**: a card, "Your catalog is empty",
  with **Copy FenceFlow's starting list**. Add one item by hand and the card,
  and the button, are gone.
- The Home banner "Make these prices yours" leads there, and says the catalog
  and labour rates "came pre-filled". They did not (section 4).

Where the phone app comes from is not on the public site (defect 11).

### What can stop a new owner, step by step

| Step | What can stop them | Status |
|---|---|---|
| Plan screen | Card before any value; test-mode ids reject a real card | Horizon stopped here |
| Trial end | Status stays `trialing` past `trial_ends_at`; company locked | Legacy, and Marc |
| First return visit | Suspended `UNPAID` | PeterLLC |
| Setup wizard, Rates | Gate rate has no field outside the wizard | measured |
| Setup wizard, Supplier | One row satisfies the step; the checklist text sends them to the phone | measured |
| First estimate | Empty catalog: labour-only total, no gate on the phone | measured |
| Send | Wizard door has no unverified-price gate; job-sheet door has one with no exit | measured |

## 3. What starts empty or zero, and what happens if it is left

| Thing | Starts as | If left that way | Where it is set |
|---|---|---|---|
| Plan, payment method | `pending`, no plan, no trial | The whole company is blocked: 21 restrictive policies, the dashboard's "Almost there", the phone's blocked screen, price-job 403 | welcome.html / Billing (Stripe) |
| Business name for quotes | `companies.name` from welcome; `settings.business_name` **blank** | Phone PDF headed **"FenceFlow"**, contract text says "The contractor"; the web quote page uses `companies.name` and reads correctly. Checklist "business" step stays open even after welcome. Two stores, asked twice. | phone Settings, or office Settings, saves both |
| Phone / email / licence | `''` | Blank on the customer quote page and crew invitations; mail reply-to reads `companies.email` | welcome.html, office Settings |
| Labour rate | web: gate needs > 0; phone: 8.0; DB/lead/import: **0** | Web blocks a new job. A lead or import job prices labour at **$0** | wizard Rates, Settings tab, phone Settings |
| Markup | web: 0 counts as done; phone 0.0; wizard `\|\|15` | See defect 4 | same |
| Tax rate | web: 0 counts as done; phone **7.0**; wizard `\|\|7`; DB 0 | 7% on a no-tax company (phone, wizard); no tax on lead/import jobs; and tax is only ever taken on **materials**, so an empty catalog collects none | same |
| Minimum job charge | web: gate needs > 0; phone 200; DB 0 | DB-default jobs have no floor, so a gate-only job can quote near nothing | same |
| Gate rate | wizard shows 20; phone job 20.0; DB **0** | A gate on a lead or import job prices at $0. **Only the wizard can set the company figure** (defect 7) | wizard Rates only |
| Waste % | 0 everywhere | Counts are exact; no overage bought | wizard Rates, job |
| Catalog | **0 rows** | Labour-only quote, every material role unmatched (section 5) | catalog tab, phone Catalog, import, seed button |
| Pricing tiers | none | Nothing breaks; phone job starts on no tier. Phone starter tiers carry the founder's rates and discounts, the office's are five blank names | Settings |
| Standard build | shipped templates only | Wizard starts from a shipped template | wizard step, Settings |
| Suppliers | none | Catalog rows unlinked | catalog / Suppliers |
| Crew | none | No hours, no assignments; Solo is excused | Crew tab |
| Card payments | none | The app tells the owner to take payment another way. **Solo cannot take card payments at all** (server-enforced in create-payment-link) | Settings, Stripe or Square |
| Deposit | 0, per job | Quote page asks for nothing up front | job |
| Contract terms | default text | The default carries a block meant to be replaced with the state's right-to-cancel wording; the phone warns before sending | phone Settings |

## 4. The starting list ("Copy FenceFlow's starting list")

**Where.**
- Phone: `CatalogScreen`, inside the "Your catalog is empty" card, shown only
  while the catalog is empty. Tiers have their own "Copy FenceFlow's starting
  tiers" in Settings.
- Office: "Start from FenceFlow's catalog", top right of the Catalog tab
  (always), and on the setup wizard's Supplier step. "Add starter tiers" is a
  separate button.

**What it copies.** 92 rows, identical on both sides (name, unit, price,
taxable, covers, colour, category, role, source, checked row for row). Per
type: vinyl 19, wood 10, chain link 18, aluminium 14, ornamental iron 11, split
rail 8, composite 10, universal 2. Every row carries the label "Starting price
— verify with your supplier". Prices are "typical Tampa-market", said in the
office's confirm dialog. Additive: the office skips rows it already has by
(type, role, name); on the phone a second copy duplicates until the next app
start (per the comment on `copyFenceFlowStartingCatalog`).

**Is it complete?** For a plain 100 ft run, yes, for all seven fence types (no
unmatched role). For a run with a gate, **only vinyl is complete**; the other
six leave `HANDLE`, `BRACE` and `STIFFENER` unmatched. The office's "Check my
catalog" says "every role covered" for those types, because it takes the
starting list itself as the definition of what a type needs.

**Is it right?** Four rows are untaxed: the three 6 ft vinyl privacy panels
and the 5 ft PVC gate. The 8 ft panel and every other gate are taxed. These are
the four rows `supabase_r9_taxable_panels.sql` corrected on the owner's live
catalog under A1; the source list was not corrected, so each new company that
copies the list re-creates A1. The phone's and the office's copies are
identical, so both carry it.

**Who can press it.** Phone: anyone with `EDIT_CATALOG_AND_SETTINGS` (owner and
manager by default; per-person overrides apply); the Catalog route is closed to
everyone else. Office: `canEdit()`, which is role OWNER or MANAGER. The
database is looser than either: `material_items_insert` only checks
`company_id = current_company_id()`, with no permission test and no
`BEFORE INSERT` trigger, so any member's login can insert catalog rows through
the API (seen in passing; not probed; it belongs to the crew-boundary track).

**Is a new owner told?**

| Where | Names the button? |
|---|---|
| Sign-up, welcome.html, its last screen | No. Says nothing about rates or catalog. |
| Setup checklist row "Your supplier prices" (live SQL text) | **No; sends them to the phone app** ("add items in the phone app under Catalog") |
| Office Catalog tab, empty message and header button | Yes |
| Office setup wizard, Supplier step | Yes |
| Welcome email (three first steps, step 1) | Yes, **but only after details and a plan**, so Horizon never got it. PeterLLC's was sent about 20 hours after its checkout, not at it (cause unknown: the trigger fires when both are true, which was 20:29 on the 21st; `welcome_sent_at` is 16:56 on the 22nd) |
| Phone first-run tour | No |
| Phone "Suggest quantities" with no catalog | No |
| Phone Home banner "Make these prices yours" | No, and it says the catalog came pre-filled |
| Phone Catalog screen, empty card | Yes (only place on the phone) |

The phone banner is the most damaging: its body reads "The catalog and labor
rates came pre-filled so you can estimate from day one". **Either** of its two
buttons ("Review catalog", "They're right") dismisses it for good **and pushes
the phone's whole profile to the company** (`markPricesReviewed` then
`SettingsSync.push`), which writes 7 / 0 / 8 / 200 into `company_settings` as
if the owner had chosen them and turns four essential checklist steps to done.
(Gate rate is not in that payload, and the catalog is still empty.) A feature nobody finds is the same as no
feature; here the one thing that points at it says something untrue on the way.

## 5. An empty catalog, answered by the engine

Real engine (the one `price-job` runs), 100 ft of vinyl, typed footage, phone
default rates (7% tax, 0% markup, $8/ft, $200 minimum, $20 gate):

| Catalog | Line items | Unmatched roles | Materials | Tax | Total |
|---|---|---|---|---|---|
| empty | 0 | panel, line post, end post, post cap, concrete | $0 | $0 | **$800** |
| the starting list | 5 | none | $1,286.85 | $27.78 | **$2,120** |
| one concrete row | 1 | 4 | $85.50 | $5.99 | $900 |
| one vinyl panel row | 1 | 4 | $889.95 | $0 | $1,690 |
| empty, every rate 0 (lead / import job) | 0 | 5 | $0 | $0 | **$0** |
| starting list, every rate 0 | 5 | none | $1,286.85 | $0 | $1,290 (materials only, labour $0) |

So an empty catalog is **not** an error, not a zero, and not a silent nothing:
it is a plausible number. The parity gate pins this on purpose
(`fixtures/pricing/catalog-empty.json`: "every role unmatched, no items,
labour and the gate charge still price"). The contract is right for an engine;
what is missing is any caller that refuses.

- `price-job` returns `unmatched_roles` and then, on commit, writes
  `contract_total = grand_total` regardless (`load.ts buildCommitPlan`).
- **Office:** the dry run shows a warning box per unmatched role with an
  add-item form, and "Looks right" stays enabled. The setup gate (`+ New Job`)
  is what normally keeps an empty-catalog company out, but it fails **open**:
  `setupSteps = setupRes.error ? [] : ...`, and `renderSetup` treats no steps
  as nothing to do.
- **Phone:** `EstimateViewModel` refuses to generate lines and shows the
  one-line message. But a job with no lines can still be sent: there is no
  estimate warning for "no materials at all" (`estimateWarnings`), tax is 0,
  and the only thing that blocks is `zeroQuoteBlocked`, which needs a $0 total
  *and* an uncalibrated photo. Labour makes the total > 0.
- One row is enough to pass the setup step: `catalog_ok` is
  `(select count(*) from material_items ...) > 0`. Inactive, unpriced, any role.

## 6. The three real signups (read-only)

Each has one owner login. All three signed up themselves (`invited_at` empty),
so all three came through the website's public sign-up. Counted across all 47
tenant tables.

| | Horizon fence llc | Legacy | PeterLLC |
|---|---|---|---|
| Signed up | 2026-09-09 19:41 (company 19:42:06) | 2026-08-27 17:58 | 2026-09-21 20:25 |
| Details, agreement | 19:42:27, 19:42:47 (71 s in) | 17:58:49, 18:01:23 | 20:25:52, 20:25:56 |
| Plan and card | **never**; no Stripe customer id | 18:02:24, Solo, trial to 09-10 | 20:29:18, Crew, trial to 10-05 |
| Used | desktop browser only; session alive until 23:30 | phone app 1.519; last opened 09-24 16:45 | mobile browser only; last refresh 09-23 17:46; app never opened |
| Made | nothing (1 profile row) | 1 draft job | nothing (1 profile row) |
| Now | `pending`, blocked | `trialing`, trial ended 09-10, **blocked** | `trialing`, allowed |

**Horizon fence llc.** 71 seconds from creating the account to the plan
screen, then nothing. It never reached the dashboard, the checklist, the
catalog or the welcome email. Its status is still `pending`, so the database
refuses every tenant table for it. `stripe_customer_id` is empty; the customer
is created before the checkout session, so checkout never got that far (never
pressed, or refused before that point; the data cannot tell which). This is the
paywall failure: card before value. It says nothing about the catalog.

**Legacy.** Went furthest. Paid (trial), then in the phone app, 7 minutes after
signing up, made a draft job with a customer name and address, and 5 minutes
after that put a **$100 deposit** on it. No fence run, no line items, no
contract total, no priced_at, no customers row, no settings row, no catalog.
The job carries 7% / 15% / $8 / $200 and gate 0: the founder's defaults, not
anything Legacy chose. Nothing was recorded after 18:10 on the 27th. **This is
the closest thing to a catalog stall**: it stopped exactly where the phone's
first estimate would have said the catalog is empty. That is an inference; no
log records it. Then the trial ended on 09-10 with the status still
`trialing`, so `company_allowed` went false; the phone was last opened on the
24th (the app stamps `last_seen_at` on each launch), and the gate would have
answered "FenceFlow is paused... Your trial has ended. Pick a plan below to
keep going", which tells a company that has a subscription to pick one.

**PeterLLC.** Details, agreement, checkout, all in about four minutes, on a
phone browser. It never opened the app and never saved a setting. The welcome
email went out on the 22nd. On the 23rd a session on that phone browser
refreshed at 17:46, and at **18:49:27 an admin lifted `suspended = true`,
reason `UNPAID`** (the only two company rows in `audit_log`). The suspension
itself is not in the audit trail: `audit_changes` says suspension "until now
... left no trace at all", so `companies` was not being recorded before.
Nothing says who suspended it or why; a company a day into a trial had no bill
to be unpaid on. No activity since. This is an access
failure on the one return visit, not a catalog failure.

Also seen: **Marc** (an `fenceflowapp.com` company, most likely an internal
test) is in the same state as Legacy, `trialing`, trial ended 09-14, holds a
subscription id, locked out. The owner's own company, whose trial ended 09-07,
is `active`. Two of two elapsed trials are stuck.

## 7. Defects, ranked for a public release

Each is pinned by name in the test file (`GAP (pinned)` passes while the defect
exists; `SHOULD (todo)` states the wanted behaviour and flips by itself).

| # | Defect | Where | Test |
|---|---|---|---|
| 1 | Elapsed trials stay `trialing` and lock the company out (2 of 2). Cause unverified | stripe-webhook `customer.subscription.updated`, `invoice.payment_succeeded`, `company_allowed()` | LIVE REPORT |
| 2 | Test-mode Stripe price ids on the site, secrets reported as test mode | `dashboard.html PLANS`, `welcome.html PLANS`, `GO_LIVE.md` 5, 6 | (source) |
| 3 | An empty or partial catalog produces a sendable, committed, labour-only quote; the phone has no gate | `load.ts buildCommitPlan`, `price-job`, `EstimateViewModel`, `JobsViewModel.createJob` | empty catalog, one row, DB defaults |
| 4 | Office wizard and import replace a company's 0 tax / 0 markup with 7 / 15, and a blank company with 7 / 15 / 8 / 200 / 20 | `dashboard.html wizSaveWho`, `runImport` | wizard tests (SHOULD todo) |
| 5 | The starting list ships 4 untaxed rows (A1 residue); tax short $62.30 per 100 ft vinyl | `SeedData.kt`, `CATALOG_SEED` | untaxed rows (SHOULD todo) |
| 6 | The office cannot confirm a starting price; the job-sheet gate can never clear; the wizard door has no gate; the phone's dialog can be waved through; the web's own import label and the phone's are not recognised as unchecked | `catalogItemPayload`, `isSeededUnverifiedPrice`, `wizStepSendHtml`, `renderQuoteBlock` | four tests (one SHOULD todo) |
| 7 | `gate_rate` is essential but has no field on the Settings tab or the phone; the checklist's "Set it" leads to a page without it | `my_setup_progress`, `SET`, `CloudSettings` | gate_rate test |
| 8 | "Catalog done" is a row count; "Check my catalog" derives needs from the seed; the seed is complete for vinyl gates only | `my_setup_progress`, `catalogExpectedRoles` | four tests |
| 9 | The Home banner says the catalog came pre-filled; its button pushes the founder's numbers as the company's | `jobs_make_prices_yours_body`, `JobsListScreen` | pre-filled (SHOULD todo) |
| 10 | Phone starter tiers carry the founder's rates and discounts; the office's are blank | `SeedData.pricingTiers`, `starterTierRows` | tiers test |
| 11 | No link to get the phone app anywhere on the public site | `welcome.html`, `index.html` | public site test |
| 12 | Welcome email is the only outside-the-app mention of the button, and needs a plan first | `queue_welcome_email` | (source) |
| 13 | Business name lives in two stores; PDFs read "FenceFlow" until phone Settings is saved | `complete_company_details`, `PdfExporter` | (source) |
| 14 | Setup gate fails open on an RPC error | `loadAll`, `renderSetup` | (source) |

## 8. Text that is stale or says more than the code does

- `SeedData.kt` ("the estimate screen refuses to send a quote built on prices
  nobody has checked"), and the dashboard comments at `startFromSeedCatalog`
  ("the estimate refuses to send a quote built on one until somebody confirms
  it") and above `unverifiedPricesOn` ("The phone refuses to send a quote priced
  off catalog rows nobody has checked"). The phone shows a dialog with **Send
  anyway**; the office job sheet refuses, with no way to confirm; the wizard
  does not check.
- `jobs_make_prices_yours_body` and the comment above it in `JobsListScreen`:
  "arrive seeded so day one works". Auto-seeding is off.
- `EstimateViewModel.regenerateInternal`: "Catalog can be empty on installs
  affected by the old seeding bug; repair and retry". `ensureSeedDataPresent`
  cannot seed any more, so the retry cannot help.
- `my_setup_progress`, catalog step: "cannot be satisfied from this website".
  It can (the seed button, import, add by hand).
- `dashboard.html renderSetup` comment: "catalog / tiers / crew ... my_setup_progress
  already marks them essential:false". Live: catalog is `essential = true`.
- `SettingsSync.kt` header, "There is no defensible literal" for the four
  pricing numbers: true of the merge, not of `BusinessProfile`'s defaults.
- Counts: "ninety-one" / "Eighty-one of the ninety-one" (`SeedData.kt`); the list
  is 92.
- `welcome.html` "You're all set" and `doneNoteText`.

## 9. What I could not establish

- Whether Stripe is live or test today, and why Legacy and Marc are stuck
  `trialing`. Only Stripe's dashboard and webhook log can say.
- What Legacy saw on 09-24, what Horizon clicked, whether PeterLLC ever saw
  the setup checklist. No log records screens; the timings are all there is.
- Who suspended PeterLLC and why. `companies` was not in the audit trail before
  09-23.
- Whether email confirmation is required at sign-up.
- Whether the setup wizard is usable on a phone-width browser (PeterLLC's only
  surface). Not tested.

## 10. Decisions this map hands to March

Not designs, only the questions the fixes will turn on.

- Should a quote with unmatched material roles be refused, or allowed with a
  loud, un-dismissable line on it, on the phone, in the office, and at commit?
- Should the starting list be offered, seeded automatically as unchecked rows
  (the old behaviour), or stay opt-in with better discovery? Either way it
  needs the four tax rows settled, a gate-hardware set for the other six types,
  and one predicate for "unchecked" that the phone, the office and the send
  gates share.
- Should there be one place a price is confirmed, reachable from the web?
- Is the card wall before first value a decision, or an accident of order?
- Is zero a company's answer (the checklist says it is) or a blank? The wizard
  currently says blank.

## 11. Reproducing this

```
node --test tests/a25-new-company-onboarding.test.mjs              # static, no network
A25_ONBOARD_LIVE=1 node --test tests/a25-new-company-onboarding.test.mjs   # + live, ~80 s
```

Last run: static 26 pass, 0 fail, 4 todo (failing as designed), 9 skipped
(live). With live: 35 pass, 0 fail, 4 todo. The live half is read-only except
one probe that inserts two synthetic `PROBE-A25-ONBOARD-*` companies and rolls
back; the file checks that none survived. No service_role key, no account
created, no third-party row written, no address or phone number selected.
