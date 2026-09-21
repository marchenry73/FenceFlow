# Turning on the follow-up email scheduler

`send-follow-ups` (`supabase/functions/send-follow-ups/index.ts`) emails
customers on a company's behalf, but only for companies that have opted in
(`follow_up_settings.enabled = true`, off by default). Nothing schedules it
today. `.github/workflows/follow-ups.yml` calls it once an hour, but the
workflow does nothing useful -- and refuses to run at all -- until the owner
does the two one-time steps below.

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
field in its body. Check `follow_up_log` in the database for new rows, or the
company's Resend dashboard, to see whether anything was actually sent --
remember sending stays zero for every company until that company also flips
its own `follow_up_settings.enabled` to `true`.

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
