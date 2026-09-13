# Edge function red-team — 2026-09-12

Read every file under `supabase/functions/` (14 functions + 3 shared modules).
Read-only audit; nothing was changed, deployed, or written to the database.

**Headline: this is the most defensively-written set of edge functions I have
seen.** Nearly every failure mode this brief asked me to hunt for — plain
`===` on a secret, an ordering enforced only by the page, a swallowed write
error, a null `auth.uid()` treated as a server job — has already been found
and fixed here, with a comment at the fix explaining the exact incident that
caused it. That is worth knowing on its own: the three DB holes and whatever
prompted this sweep were not signs of a sloppy codebase, they were the last
few instances of a pattern the team had otherwise already stamped out.

I found one real, provable bug and two things worth a look. Nothing here is
an open door the way the three database holes evidently were.

---

## 1. A payment link can be handed back to the wrong company (real bug, low likelihood, meaningful cost if it fires)

**File:** `supabase/functions/create-payment-link/index.ts`, lines 595–608 (the
`openRows` lookup inside `makeLink`).

```js
const { data: openRows } = await admin
  .from("job_payments")
  .select("payment_url")
  .eq("job_sync_id", jobSyncId)
  .eq("kind", kind)
  .eq("amount_cents", amount)
  .eq("status", "pending")
  .limit(1);
if (openRows?.[0]?.payment_url) {
  return json({ url: openRows[0].payment_url });
}
```

This is the double-tap guard: before creating a new Stripe/Square link, it
checks for an already-open one for the same job and hands that back instead.
Every other query in this codebase that touches `job_sync_id` — in
`price-job`, `quote-view`, `stripe-webhook`, `record-payment.ts`, the same
file's own webhook-side lookups — also filters on `company_id`, and the
comments throughout the repo explain at length why (`quote-view`: "Pinned to
the company as well as the job... defence in depth against exactly the
cross-company write the rest of the system guards for"). This one query
breaks that pattern: it matches on `job_sync_id` + `kind` + `amount_cents`
alone.

`job_sync_id` is a client-generated id (the phone app creates jobs offline
and assigns their sync id before ever talking to the server); the schema's
own uniqueness constraints treat it as unique only *within* a company
(`company_id, sync_id`), not globally. If two different companies' jobs ever
carry the same sync id — a UUID collision, or, more realistically, a bug or
migration that ever produced a non-UUID or reused id — and both request a
deposit of the same kind and the same dollar amount, this function will serve
Company B a live payment URL that belongs to Company A. That URL is a
Stripe/Square checkout page for Company A's own customer and, depending on
the processor, may point at Company A's connected account.

**Exploit path:** not something a random attacker can trigger on demand (it
needs a same-day sync-id collision plus a matching amount+kind), but it does
not need a signed-in attacker either — a MANAGER on any company hitting the
office door with a guessed/looped `jobSyncId` and common amounts (e.g.
`$500.00` deposit) would occasionally get back someone else's link. Nothing
in the current code prevents it from happening by mistake.

**Cost if it fires:** a homeowner from one company pays into a checkout
session actually meant for a different company's customer, or a company
office sees a stale link that was never theirs. Support/trust cost more than
direct theft, but it is exactly the class of cross-tenant leak this app has
spent real effort closing everywhere else.

**Confidence:** the code defect is certain — I read it directly and confirmed
by grepping every other `job_sync_id` query in the codebase, all of which
scope by `company_id`. Whether it has ever actually fired live I could not
determine from reading alone (would need to check `job_payments` for
duplicate `job_sync_id` values across different `company_id`s, which I did
not run since it wasn't a rolled-back read — happy to if you want it).

**Fix shape (not applied, per scope):** add `.eq("company_id", a.companyId)`
to that query, matching the pattern everywhere else in the file.

---

## 2. Quote approval isn't checked for write failure

**File:** `supabase/functions/quote-view/index.ts`, lines 2479–2488.

```js
if (justApproved) {
  await admin.from("jobs").update({
    quote_approved_at: new Date().toISOString(),
    quote_approved_name: name,
    ...
  }).eq("id", job.id);
}
...
return json({ ok: true, approvedBy: job.quote_approved_name || name });
```

The result of this `update` is never inspected. If it fails — a constraint,
an outage, a policy — the function still returns `{ ok: true }` to the
homeowner, who is told they approved a quote that was never actually marked
approved. This is the same class of bug the brief's item 4 describes (a write
whose error is ignored), applied to approval instead of a payment.

**Cost:** this doesn't lose money by itself — `create-payment-link` re-reads
`quote_approved_at` from the database before issuing a payment link, so a
failed write here would actually block the homeowner from paying at all
(the safe direction), rather than letting an unapproved quote get billed.
The customer-facing failure mode is confusion ("I approved it, why won't it
let me pay?") rather than a financial loss.

**Confidence:** the missing check is certain from the code. Whether it has
ever actually failed in production I can't tell from reading alone.

---

## 3. A "public but metered" secret compared with `===`

**File:** `supabase/functions/quote-map/index.ts`, `paidProvidersAllowed()`
(around line 2103): `header === anon`.

This is a plain equality check on the Supabase anon key, which gates whether
a request gets the paid imagery chain (Google/Mapbox) or falls back to free
Esri tiles. Item 1 of the brief asks specifically about non-constant-time
secret comparisons. This one is not constant-time, but the function's own
comment is correct that it doesn't matter here: the anon key is not a secret
— it ships inside the public web page and every legitimate caller already
sends it. The worst a timing attack buys here is nothing an attacker doesn't
already have. I'm flagging it only so it isn't mistaken for a missed instance
of item 1; every function that guards something actually secret (the
Stripe/Square webhook signatures, `NOTIFY_TRIGGER_SECRET`,
`BILLING_SETUP_TOKEN`) already does this correctly with a constant-time
XOR-accumulate loop.

**Confidence:** high that this is a non-issue as written; noted for
completeness only.

---

## Functions checked and found sound

- **`price-job`** — the function this brief cared most about keeping crew out
  of. Role gate (OWNER/MANAGER only) *and* a separate `SEE_MONEY` permission
  check, both required; `company_allowed` checked; every read/write scoped to
  `company_id`; commit path tombstones old lines before writing new ones and
  checks the result of every write; stale-job guard via `expected_updated_at`.
  No hole found.
- **`quote-view`** (aside from finding 2) — explicit field whitelist out to
  the homeowner (no line items, no supplier cost, no labour rate); phone-gate
  on approval with generic error text and a lockout, checked server-side only,
  digits never sent to the browser; suspended-company check via
  `company_allowed` rather than trusting a stale flag; push notification only
  fires on the approval that actually landed (fixed from a prior bug where it
  fired on every request).
- **`create-payment-link`** (aside from finding 1) — amount for the public
  door is computed entirely server-side from the job row via the shared
  `depositFigures()` helper, never from the caller; the office door's
  caller-supplied amount is a legitimate business action (an owner billing
  their own customer), not an authorization bypass; suspended/plan gates
  moved above the processor branch; idempotency key for Square is hashed,
  not truncated (a prior bug silently dropped the amount from the key on
  long job ids); write errors on link creation are checked.
- **`stripe-webhook` / `square-webhook` / `_shared/record-payment.ts`** — the
  four ignored-write-error incidents the brief mentions are visibly the
  reason `mustWrite()` exists and is used consistently on every ledger/job
  write in all three files; signature verification is constant-time and
  covers every `v1=` candidate during a secret rotation, not just the last
  one; test/sandbox money is explicitly refused before touching the ledger;
  refunds/disputes only ever step `payment_status` down, never up.
- **`stripe-connect` / `square-oauth`** — OAuth `state` value ties the
  callback back to the company that started it (prevents attaching one
  contractor's payment account to another company); OWNER-only to start.
- **`billing-setup`** — constant-time token compare, fails closed on an unset
  secret, and the one genuinely dangerous action (`cancel_subscription`, a
  bare-id cancel with no scoping) has already been removed and replaced with
  a `410` telling the caller to use the Stripe dashboard instead.
- **`notify-job-change`** — constant-time shared-secret compare, fails closed
  on an unset secret; sends no money figures to any device.
- **`lead-intake`** — token format validated before hitting the database;
  suspended-company check via `company_allowed`; per-company flood cap;
  write error checked.
- **`invite-company` / `invite-crew`** — both validate the bearer JWT
  explicitly (not via an implicit client header) and re-check role and
  `company_allowed` before sending mail; `invite-crew`'s rate limit is
  enforced by a database-side RPC counter, not by anything the client could
  skip.
- **`apk-proxy`** — filename is regex-anchored to the release-file naming
  pattern, so it cannot be used as a general open proxy for arbitrary URLs.
- **`quote-map`** (aside from note 3) — nothing behind it is sensitive
  (public satellite imagery/geocoding); the per-IP rate limiter is honestly
  documented as ineffective at Supabase's scale and not what actually caps
  cost — the anon-key gate on paid providers is.

## Anything I could not determine from reading alone

- Whether finding 1's cross-tenant collision has ever actually happened live
  (would need a read of `job_payments` grouped by `job_sync_id` across
  companies — did not run it since it wasn't pre-agreed as part of this
  pass, but it's a single read-only query if you want it done).
- `billing-setup` is absent from `supabase/config.toml`'s function list,
  which means it defaults to `verify_jwt = true` — stricter than its own
  header comment implies is needed ("must run before any user context
  exists"). This fails safe (requires a valid Supabase JWT *in addition to*
  the setup token) rather than open, so it is not a hole, just a possible
  sign the file was meant to be deleted after go-live and wasn't. Not scored
  as a finding.
- I did not attempt to reproduce any of these against the live project —
  the two real findings are read-only conclusions from the code itself, not
  proven against `newcrgafcptspmapacrx`.

## Path

Findings written to `C:\Users\march\AndroidProjects\FenceEstimator\SUPABASE_EDGE_FUNCTION_AUDIT.md`.
