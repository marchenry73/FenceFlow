# Turning on the follow-up email scheduler

`send-follow-ups` (`supabase/functions/send-follow-ups/index.ts`) emails
customers on a company's behalf, but only for companies that have opted in
(`follow_up_settings.enabled = true`, off by default). Nothing schedules it
today. `.github/workflows/follow-ups.yml` calls it once an hour, but the
workflow does nothing until the owner does the one-time steps below.

## "Follow-up email scheduler: run failed" emails from GitHub

Until 21 September 2026 the hourly run treated a missing
`FOLLOWUPS_TRIGGER_SECRET` as a failure, so GitHub emailed a "run failed"
notice every hour for a scheduler nobody had switched on yet. Nothing was
ever sent to a customer by those runs; they stopped before calling anything.

Now a scheduled run without the secret **skips**: it exits green with a
notice ("FOLLOWUPS_TRIGGER_SECRET is not set ... nothing was sent") on the
run page and in its summary, and GitHub sends no email. Two cases still fail
on purpose, because in both something is really wrong:

- **Run workflow pressed by hand without the secret.** You asked for a send
  and none can happen; a green tick would say it did.
- **The secret is set and the call does not succeed**: the value does not
  match the function's `NOTIFY_TRIGGER_SECRET` (HTTP 401), the function
  errors, or the mail provider refuses the sends (the function answers with
  an `error` and the run fails).

A blip between GitHub and Supabase is retried twice, 15 seconds apart, before
it counts as a failure. Retrying is safe: each email is claimed in
`follow_up_log` before it is sent, so a retry skips anything already sent.

A big backlog is not a failure either. Sends are spaced about half a second
apart (Resend allows two a second), and Supabase cuts off any function that
has not answered within 150 seconds. So one run sends for at most about 100
seconds, then answers green with an `unfinished` note, which the run page
shows as a notice. Nothing unsent was claimed, so the rest is still due and
goes out on the next hourly run.

This is deliberately an owner action, not something Claude or this workflow
can do: it requires generating a real secret and pasting it into two systems
Claude has no write access to (GitHub repository secrets, and choosing when
to first commit to a live value in Supabase's secret store).

## One-time setup (owner only)

### 1. Generate the secret

Generate a long random value once, e.g.:

```
openssl rand -hex 32
```

Do not put it in any file in this repo, any commit message, any chat, or
anywhere else it could be logged. Treat it exactly like a password.

### 2. Set it as the Supabase function secret

`send-follow-ups` already reads `NOTIFY_TRIGGER_SECRET` and already has a
value set in this project (it was set when the function was first deployed --
this project reuses the same secret `notify-job-change` uses for its own
shared-secret check, rather than minting a second one). Check what's already
there before overwriting it:

```
npx --no-install supabase@2.115.0 secrets list --project-ref newcrgafcptspmapacrx
```

If `NOTIFY_TRIGGER_SECRET` is already set and you want the scheduler to use
that same value, skip to step 3 and use that value there -- you do not need
to regenerate it. If you want a dedicated value instead (recommended, so
rotating the scheduler's credential doesn't also require re-pointing
`notify-job-change`), set it as a **new** function secret with its own name
and change the one line in `index.ts` that reads
`Deno.env.get("NOTIFY_TRIGGER_SECRET")` to read that name instead, e.g.:

```
npx --no-install supabase@2.115.0 secrets set FOLLOWUPS_TRIGGER_SECRET=<the value from step 1> --project-ref newcrgafcptspmapacrx
npx --no-install supabase@2.115.0 functions deploy send-follow-ups --project-ref newcrgafcptspmapacrx --use-api
```

Either way, never run `secrets list` output through anything that would print
the value -- the CLI only ever prints a redacted hash, which is intentional
and enough to confirm the name exists and when it was last updated.

### 3. Set it as a GitHub repository secret

In this repo's GitHub page: **Settings -> Secrets and variables -> Actions ->
New repository secret**.

- Name: `FOLLOWUPS_TRIGGER_SECRET`
- Value: the same value you set in Supabase in step 2 (either the existing
  `NOTIFY_TRIGGER_SECRET` value, or the new dedicated one).

The workflow reads this secret and sends it as the `x-fenceflow-trigger`
header on every hourly call. GitHub never displays a secret's value back to
anyone (including in logs) once saved.

## What the workflow does NOT need permission for

The `apikey` / `Authorization` header the workflow sends is the project's
**public** anon key (the same value already shipped in `website/config.js`
as `SUPABASE_KEY`, visible to anyone who views the website's source). It only
gets the request past the Supabase gateway; it proves nothing about who is
calling. The `x-fenceflow-trigger` secret from step 3 is the actual gate --
the function itself refuses any request without the exact matching value,
compared in constant time.

## Verifying it worked

After both secrets are set, either wait for the next hourly run or trigger it
by hand from the Actions tab (**Actions -> Follow-up email scheduler -> Run
workflow**). A green run means the function responded `200` with no `error`
field in its body -- check that the run page does **not** carry the "not
set" notice, which is what a green run looks like while the scheduler is
still off. Check `follow_up_log` in the database for new rows, or the
company's Resend dashboard, to see whether anything was actually sent --
remember sending stays zero for every company until that company also flips
its own `follow_up_settings.enabled` to `true`.

## The review request (the fifth kind), added 2026-10-29

The first four kinds chase a quote. The fifth goes out AFTER the work: a
review request, two or three days after a job is marked COMPLETED.

It rides this same scheduler on purpose -- the opt-out, the quiet hours, the
daily cap, and the claim-a-log-row-before-sending that makes a double send
impossible were all already here and already tested.

**What had to exist first.** There was a COMPLETED status and nothing that
recorded *when*, so "two days after the job is done" had nothing to count
from. `jobs.completed_at` is now stamped by a trigger (r47) wherever the
status changes -- the phone, the office and the crew flow all get the same
answer without any of them remembering to write it.

**Switching it on** (Office -> Follow-ups):

1. Tick **Review request (after the job is done)** and set the days (2 or 3).
2. Paste the **review link**. Without it nothing sends, by design: a review
   request with no link is a letter with a dead button. The panel says so in
   red when the toggle is on and the box is empty.

**The guards, and why each exists:**

| Guard | Without it |
|---|---|
| `review_url` must be set | the customer gets a dead button |
| `review_email_sent_at` must be null | the same customer is asked twice |
| `cancelled_at` must be null | a cancelled job's customer is asked to review the company |
| at least `job_done_review_days` since completion | asked while the crew is still packing up |
| at most `REVIEW_MAX_AGE_DAYS` (30) since completion | the night the switch is first turned on, EVERY job finished since r47 is eligible at once |
| no backfill of `completed_at` | every past customer asked at once, months after the work |

**Where the marker is.** `jobs.review_email_sent_at` is written the moment
the email leaves, and the job screen in the app shows it in place of the
hand-written review composer -- which is what "leave something so I know the
email was sent" asked for. r48 keeps that write out of `jobs.updated_at`, so
stamping it cannot beat a phone's offline edit of the same job.

**Two things that would have failed silently** and are now patched:

- `follow_up_log.kind` carried a CHECK listing only the four sales kinds. The
  claim insert would have been refused with 23514, which the sender does not
  treat as "already sent", so it logged to the console and moved on: no
  email, HTTP 200, an empty results array, indistinguishable from a quiet
  night. (r49)
- `set_follow_up_settings()` -- the only path the office may write these
  settings through -- named the four original rules column by column, so the
  new toggle would have accepted a click and changed nothing. For the three
  new fields an absent key now means *keep what is stored*, so a cached older
  dashboard cannot switch review requests back off. (r50)

**Drift.** `website/js/lib/follow-ups.mjs` is a hand-written copy of these
rules used by the office preview. `tests/follow-ups.test.mjs` (a151) now runs
both copies over the same jobs and fails if they disagree -- the dangerous
direction being a preview that shows nothing due on the night five emails go
out.

## Turning it off

Two independent switches, either one stops all sending:

- Delete or disable `.github/workflows/follow-ups.yml` (or remove the
  `schedule` trigger) -- stops the hourly call entirely.
- Per company, in the office dashboard's Automation tab -- stops just that
  company's emails, leaves the scheduler running for everyone else.

## Open item this document does not resolve

The follow-up email's own text says "if you'd rather not receive these, just
reply and let us know" -- but there is no reply-driven opt-out mechanism.
A customer's reply lands in the company's own inbox (the email's `reply_to`
is the company's address), not back into `jobs.opted_out_at`. Turning this
scheduler on makes that gap real for the first time (today the promise is
never actually shown to a customer, because nothing sends). Before enabling
this for any company, the owner should decide between: (a) building a real
opt-out path (e.g. a one-click unsubscribe link with a token, landing on a
small public endpoint that sets `opted_out_at`), or (b) softening the email
copy in `supabase/functions/send-follow-ups/index.ts`'s `buildEmail()` so it
doesn't promise automation that doesn't exist. This is a product decision,
not something this document or the scheduler workflow should decide --
flagged here, and in the returned `openQuestions`, rather than changed.
