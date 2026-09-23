# FIXED 2026-09-23 — kept as the record of what was wrong

Closed by `supabase_r7_admin_second_factor.sql`, applied and proven the same day:
the same admin, password only, now reads `is_platform_admin = false`
(`supabase_r7_admin_second_factor_probe.sql`, arm b). One thing below turned out
to be understated — `protect_billing_columns()` does not call
`is_platform_admin()` at all, it inlines its own lookup, so tightening the shared
function alone would have left every billing column on the password-only rule.
It was pointed at the shared gate in the same change.

---

# The admin second factor is enforced in the browser, not on the server

Found 2026-09-22, read-only, against production (`newcrgafcptspmapacrx`). Not yet fixed.

## What is true today

`website/admin.html` asks for the authenticator code and refuses to render the console
without it: `assuranceLevel()` (line 1741) reads the `aal` claim, and `mfaGate()` returns
`'missing'` or `'stale'` and blocks the page. That part works — the claim is present in the
access token and the page reads it.

The server does not check it at all. Every admin power is a SECURITY DEFINER function gated
by `public.is_platform_admin()`, and that function's entire body is:

    select coalesce((select is_platform_admin from profiles where id = auth.uid()), false);

Checked on the live database, the same day:

* `is_platform_admin()` body mentions `aal`: **false**
* public functions whose body mentions `aal` / `amr` / `assurance`: **none**
* RLS policies whose expression mentions `aal`: **none**

So the eighteen functions gated by it — `admin_suspend`, `admin_unsuspend`,
`admin_grant_access`, `admin_extend_trial`, `admin_start_trial`, `admin_create_company`,
`admin_promote_release`, `admin_demote_release`, `admin_companies`,
`admin_companies_count`, `admin_error_summary`, `admin_mark_errors_seen`,
`admin_mark_invited`, `admin_releases`, `release_for_payment`, plus the
`protect_billing_columns` and `protect_platform_admin_flag` triggers — accept any session
belonging to an account with the flag, whatever assurance level it carries.

## Why that matters

A password alone is enough to use every admin power. An access token obtained with the
password and no code (aal1) can call the functions directly; the authenticator only stops
someone loading the page, which nobody has to do. Suspending a company, granting access,
extending a trial and promoting or demoting a release are all reachable that way.

This is not a leak of data through a missing policy — it is the second factor the owner set
up on 2026-09-22 protecting the wrong thing.

## The fix, and the one hazard in it

Require `aal2` inside `is_platform_admin()` **only when the account actually has a verified
factor enrolled**:

    the profile flag is true
    AND ( auth.jwt() ->> 'aal' = 'aal2'
          OR no verified row in auth.mfa_factors for auth.uid() )

Written that way there is no lockout: an account with no factor behaves exactly as it does
now, and an account with one has to have used it. Removing a factor already needs aal2 in
Supabase, so the escape hatch cannot be opened by an attacker.

Three things to hold it to when it is written:

1. **Service role must not change behaviour.** `auth.uid()` is null there and the function
   already returns false; `supabase_admin_columns_patch.sql` depends on that shape
   (`if auth.uid() is not null and not is_platform_admin() then raise`). The aal clause must
   not turn a null-uid caller into anything new.
2. **The two triggers use it as an ALLOW.** `protect_platform_admin_flag` and
   `protect_billing_columns` refuse a write when it returns false, so an aal1 admin starts
   being refused rather than let through. That is the wanted direction, but it must be
   proven, not assumed.
3. **Positive controls, or the proof is worthless.** A probe must show: the enrolled admin
   with `aal: aal2` still passes; the same admin with `aal: aal1` is refused; an account
   with no factor is unaffected; a non-admin is still refused; and a planted failure that
   must read false. Impersonation sets `request.jwt.claims` by hand, so the probe has to
   include the `aal` claim itself — leaving it out would fake a pass.

## Not to be confused with

`supabase_service_role_guard*` and the `auth.uid() is null` escape hatch already recorded in
memory as `service-role-guard-trap`. That one is about SECURITY DEFINER functions being open
to anon; this one is about assurance level, and the two fixes do not overlap.
