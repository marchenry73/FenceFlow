# Turning on the server-side attention sweep

`attention-sweep` (`supabase/functions/attention-sweep/index.ts`) detects
nine high-severity conditions -- money already at risk or gone, a crew about
to be sent to a job that is not ready, an 811/permit/HOA gap -- and pushes
the owner/manager, **without** a dashboard tab needing to be open. Today,
every one of these only fires from `website/dashboard.html`'s own JavaScript,
on page load or the "Check now" button (AUDIT_2026-09-18_PHASE1.md, P1
"Automation" cluster). This closes that gap for the detectors that matter
most; it does not touch the dashboard page or the 4 legacy automation rules.

It is **off for every company by default** (`attention_sweep_settings.enabled
= false`, no row = off) and only produces a candidate at all for a company
that has both turned it on and is allowed to use the product
(`company_allowed()`). Proved live against the production database:

- With every company at its default (off), `attention_sweep_candidates()`
  returns **zero rows**, even though real jobs in the database genuinely
  match several of the detectors (confirmed by counting the raw predicates
  directly, ignoring the eligibility gate).
- Turning the setting on for one company (inside `begin; ... rollback;`,
  nothing kept) immediately surfaces that company's real findings across
  multiple detectors, then rolls back to exactly the prior state.

## Before the secret is set

`.github/workflows/attention-sweep.yml` runs every hour whether or not it is
configured. Without `ATTENTION_SWEEP_TRIGGER_SECRET` a scheduled run skips:
it exits green with a notice ("ATTENTION_SWEEP_TRIGGER_SECRET is not set ...
nobody was notified") on the run page and in its summary, and GitHub sends no
"run failed" email. (Until 21 September 2026 it failed instead, and GitHub
emailed about it every hour.) A manual **Run workflow** press without the
secret still fails, and once the secret is set a refused secret (HTTP 401) or
a function error still fails the run. A blip between GitHub and Supabase is
retried twice before it counts; a retried sweep notifies nobody twice, because
each finding is claimed in `attention_findings` first.

## One-time setup (owner only)

Same shape as `docs/FOLLOW_UPS_SCHEDULER.md` -- read that file's reasoning
for *why* each step is a human action, not repeated here.

### 1. Confirm the trigger secret

This reuses `NOTIFY_TRIGGER_SECRET`, the same shared secret
`notify-job-change` and `send-follow-ups` already have set as a Supabase
function secret -- no new value to generate for the *function* side.

```
npx --no-install supabase@2.115.0 secrets list --project-ref newcrgafcptspmapacrx
```

Confirm `NOTIFY_TRIGGER_SECRET` is present (it will be, since the other two
functions already depend on it). If a dedicated value is preferred instead
(so rotating the scheduler's credential doesn't also affect the other two
functions), set a new one and change the one line in `attention-sweep/
index.ts` that reads `Deno.env.get("NOTIFY_TRIGGER_SECRET")`.

### 2. Set it as a GitHub repository secret

**Settings -> Secrets and variables -> Actions -> New repository secret**

- Name: `ATTENTION_SWEEP_TRIGGER_SECRET`
- Value: the same value `NOTIFY_TRIGGER_SECRET` holds in Supabase (from
  step 1), or the dedicated one if that route was taken.

### 3. Deploy the function

```
npx --no-install supabase@2.115.0 functions deploy attention-sweep --project-ref newcrgafcptspmapacrx --use-api
```

### 4. Turn it on per company

There is no dashboard toggle for this yet (see "Open item" below) --
today it is a direct RPC call as a signed-in OWNER/MANAGER:

```sql
select set_attention_sweep_enabled(true);
```

Or with custom quiet hours (defaults: 21:00-08:00, `America/New_York`):

```sql
select set_attention_sweep_enabled(true, 22, 6, 'America/Chicago');
```

## Verifying it worked

Trigger it by hand from **Actions -> Attention sweep scheduler -> Run
workflow**, or wait for the next :15-past-the-hour run. A green run means
the function responded `200` with no `error` field -- as long as the run page
does not carry the "not set" notice, which is what a green run looks like
while the sweep is still off. Check `attention_findings`
in the database for new rows (`notified_at` is set once a push actually
went out; a row with `notified_at` still null and `FIREBASE_SERVICE_ACCOUNT`
unset means the finding was recorded but nothing was pushed -- see the
function's own comment on that fallback).

## Verifying an unauthenticated call is refused

```
curl -i -X POST https://newcrgafcptspmapacrx.supabase.co/functions/v1/attention-sweep \
  -H "apikey: sb_publishable_2WmwTcQkUNCRzDCRpNmwWA_s3gxJk3b" \
  -H "Authorization: Bearer sb_publishable_2WmwTcQkUNCRzDCRpNmwWA_s3gxJk3b"
```

Expect `401 {"error":"unauthorized"}` -- no `x-fenceflow-trigger` header was
sent. This is the same door notify-job-change and send-follow-ups already
use; it was not reinvented here.

## Turning it off

Three independent switches, any one stops all pushes from this channel:

- Delete or disable `.github/workflows/attention-sweep.yml` (or remove the
  `schedule` trigger) -- stops the hourly call entirely, for every company.
- Per company: `select set_attention_sweep_enabled(false);` -- stops just
  that company, leaves the scheduler running for everyone else.
- Per person: mute the relevant `ALERT_DEFS` key in the dashboard's Settings
  -> Your alerts (`notification_prefs.muted_alerts`) -- the sweep reads and
  respects the exact same mute list the dashboard's own alerts already use,
  so muting `no_deposit` there also stops it from being pushed here.

## What this function does NOT do

- It never messages a customer. Every recipient is an OWNER or MANAGER on
  the company's own team.
- It never changes a job, moves a production stage, or writes a note --
  unlike the 4 legacy automation rules (`supabase_automation.sql`), this is
  detection and notification only.
- It does not touch `website/dashboard.html` or `send-follow-ups` -- those
  stay exactly as they are; the dashboard's own alert panel and this sweep
  read the same underlying facts independently, through the same predicates
  (kept in sync by comment, per `supabase_p4_attention_candidates_fn.sql`'s
  header), not through a shared code path.

## Open items this document does not resolve

**Recipient scope.** The function sends to every OWNER and MANAGER on the
company, unconditionally (subject to their own mute list). The audit task
that produced this function did not specify a narrower routing rule (e.g.
money findings to whoever holds `SEE_MONEY` specifically, permit/HOA
findings to whoever schedules crews) and none of that routing existed
anywhere in this codebase to reuse -- inventing a finer-grained mapping
would have been a guessed business rule, not a moved one. OWNER/MANAGER was
chosen because those are the only two roles that always hold both
`SEE_MONEY` and `EDIT_JOBS` (the two permissions that already gate every one
of these nine conditions from appearing on the dashboard at all today), so
this cannot put a figure or a liability detail in front of someone who
couldn't already see it there. "Always" held for the role but not for the
person: a `-SEE_MONEY` override takes the figures off a manager's screens, so
since 2026-09-22 the function also requires `SEE_MONEY` itself (the same
`moneyAudience` rule the payment pushes use) -- an OWNER or MANAGER whose
money was switched off gets no sweep push. If a narrower routing is wanted, that is a
product decision for the owner to make, not something this function should
have guessed at silently.

**Per-person quiet hours.** The mute list (`notification_prefs.muted_alerts`)
is genuinely per-person; quiet hours are not -- there is no per-person quiet-
hours field anywhere in this codebase, only `follow_up_settings`' per-company
one for customer email. This function reuses that same shape at the company
level (`attention_sweep_settings.quiet_hours_start/end/timezone`) rather than
inventing a per-person field from nothing. If different people on the same
team genuinely want different quiet hours for this channel, that is a new
column and a new setting screen, not something to infer from the existing
per-company pattern.

**The dashboard has no UI for `attention_sweep_settings` or
`attention_findings` yet.** Turning the sweep on, adjusting quiet hours, and
seeing what it has found are all direct SQL/RPC calls today (see "Turning it
on per company" above). Building that screen belongs on the office-console
track (`website/dashboard.html`), which this track was explicitly told not
to touch.
