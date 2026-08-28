-- A phone must ASK whether it may see pay, not guess from an empty answer.
--
-- The app decided with `withPay.isEmpty()` -- treating no rows as "not
-- allowed". Empty also means the request returned nothing for any other
-- reason, and when that happened the phone replaced its local rates with the
-- pay-free roster's zeros and pushed them back over the real ones. A real
-- hourly rate on this database went from 25 to 0 that way.
--
-- One question, one answer, no inference.
create or replace function public.can_see_pay()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    select coalesce(public.has_permission('SEE_MONEY'), false);
$$;
revoke execute on function public.can_see_pay() from public, anon;
grant  execute on function public.can_see_pay() to authenticated;
