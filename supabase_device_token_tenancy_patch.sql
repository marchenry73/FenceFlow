-- A phone could put itself on another company's push list.
--
-- device_tokens.company_id IS the addressing scheme for push. Both senders fan
-- out by it using the service role, so RLS is not watching them:
--   supabase/functions/notify-job-change/index.ts:110  -- job assignments
--   supabase/functions/stripe-webhook/index.ts:231     -- notifyPaid, whose
--     body carries the customer's name and the amount they just paid
--
-- Every policy on the table only ever checked user_id. company_id was free
-- text on both write paths, so an ordinary signed-in user could INSERT a row
-- for their OWN handset carrying someone else's company id -- or PATCH their
-- existing row to it -- and start receiving that company's notifications.
--
-- Reproduced against the live database inside a rolled-back transaction, as a
-- real signed-in member of one company writing a row addressed to another:
-- the insert was accepted and the handset appeared on the victim's fan-out.
--
-- The victim sees nothing. Their own rows are untouched, so their phones keep
-- working normally, and no screen anywhere lists who is subscribed. The
-- attacker needs only the other company's uuid, which every current and former
-- member of that company already has.
--
-- company_id is bound to the caller's own company on both write paths now.
-- register_device_token is unaffected: it is SECURITY DEFINER owned by the
-- table owner and already sets company_id from current_company_id(), and the
-- table is not FORCE ROW LEVEL SECURITY, so the legitimate path bypasses these
-- policies exactly as it did before.

grant execute on function public.current_company_id() to authenticated;

drop policy if exists device_tokens_own_insert on public.device_tokens;
create policy device_tokens_own_insert on public.device_tokens
    for insert to public
    with check (user_id = auth.uid() and company_id = public.current_company_id());

-- The UPDATE policy had no WITH CHECK at all, so Postgres reused its USING
-- expression -- which meant the row could be rewritten to any company as long
-- as it still belonged to you.
drop policy if exists device_tokens_own_update on public.device_tokens;
create policy device_tokens_own_update on public.device_tokens
    for update to public
    using (user_id = auth.uid())
    with check (user_id = auth.uid() and company_id = public.current_company_id());

-- Anything already mis-addressed is put back where it belongs. Nothing is
-- deleted: a token whose owner has since left every company simply has no
-- company to be moved to and is left alone for the sender's own stale-token
-- cleanup to handle.
update device_tokens d
   set company_id = p.company_id
  from profiles p
 where p.id = d.user_id
   and p.company_id is not null
   and d.company_id is distinct from p.company_id;
