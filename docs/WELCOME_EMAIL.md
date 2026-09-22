# The welcome email for new companies

Every new fence company gets one email from FenceFlow when its owner finishes
signing up: a welcome by business name, three first steps (add your prices,
invite your crew, send your first quote) and an **Open your office** button.
It is sent once per company, ever.

| Piece | Where |
|---|---|
| The email (HTML and plain text) | `supabase/functions/_shared/welcome-email.ts` |
| The sender | `supabase/functions/send-welcome-email/index.ts` |
| The trigger, the column, the secret | `supabase_r6_welcome_email.sql` |
| Its proof (runs and rolls back) | `supabase_r6_welcome_email_probe.sql` |
| Wording and safety checks | `node tests/welcome-email.test.mjs` |

## When it goes out

The moment a company first has **both**:

- its details completed (the first step on `welcome.html`, which every way
  of signing up passes through), and
- a way in: a plan from Stripe checkout, or a trial started from the staff
  console.

That is when the office first opens for them, so the button leads somewhere
they can use. Whichever of the two happens second sends it. Companies that
were already set up before this existed never get one.

It is not sent to a company named "ZZ TEST...", to a company with no owner,
or twice. It goes to the owner's own sign-in address, never to the contact
email typed on the details form.

## Switching it on (main session, in this order)

1. Deploy the function:
   `npx --no-install supabase@2.115.0 functions deploy send-welcome-email --project-ref newcrgafcptspmapacrx --use-api`
   (`supabase/config.toml` already pins `verify_jwt = false` for it; the
   function checks its own secret instead.)
2. Run `supabase_r6_welcome_email.sql`. It creates its own secret in Vault;
   nobody needs to copy anything anywhere.
3. Run `supabase_r6_welcome_email_probe.sql`. Every row should say
   `ok = true`. It changes nothing and sends nothing.

It uses the mail secrets invite-company already uses (`MAIL_API_KEY`,
`MAIL_FROM`), so there is nothing new to set.

## Checking a real one

After a real company finishes signing up:

```sql
select name, details_completed_at, welcome_sent_at
  from companies order by details_completed_at desc nulls last limit 5;
```

`welcome_sent_at` filled in means it was claimed and handed to the mail
provider. The function's log (Supabase -> Edge Functions ->
send-welcome-email -> Logs) has one line per call, e.g.
`{"fn":"send-welcome-email","outcome":"sent",...}`, or `skipped` / `refused`
with the reason. No email address is ever logged.

## Sending it again by hand

Nothing retries a failed send on its own. To send it (again) to one company,
run this in the SQL editor. The secret is read inside the query and never
shown:

```sql
update companies set welcome_sent_at = null where id = '<company id>';

select net.http_post(
  url := 'https://newcrgafcptspmapacrx.supabase.co/functions/v1/send-welcome-email',
  body := jsonb_build_object('company_id', '<company id>'::uuid),
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-fenceflow-welcome',
    (select decrypted_secret from vault.decrypted_secrets
      where name = 'welcome_email_trigger_secret')));
```

The company still has to be set up (details plus a plan or trial) or the
function answers `skipped: not ready`.

## Turning it off

`drop trigger companies_queue_welcome_email on public.companies;` stops it.
Nothing else depends on it, and the column can stay.
