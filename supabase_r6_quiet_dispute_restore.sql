-- ============================================================
-- FenceFlow -- chargeback and dispute writes are quiet again
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
-- KIND: FUNCTION-REPLACING touch_updated_at() -- the LIVE body with five
-- names added back to its quiet list. No row, table or policy changes.
--
-- supabase_quiet_dispute_columns.sql put dispute_opened_at, dispute_closed_at,
-- dispute_status, dispute_reason and dispute_amount on the quiet list: they
-- are written only by the payment webhooks, whenever a bank decides, and must
-- not move updated_at -- otherwise a chargeback landing after a crew phone's
-- offline edit makes the cloud row look newer and the phone's edit is
-- silently discarded. supabase_followups_settings.sql later retyped the
-- function to add opted_out_at and dropped those five names; every later
-- patch (including supabase_r6_price_stability.sql) preserved the shortened
-- list. Caught by tests/sync-clock-guard.test.mjs on 2026-09-22.
--
-- Patched in place from the live definition (the function is shared by
-- thirteen tables); a name already present is not added twice.
-- ============================================================
do $restore$
declare
    d text;
    missing text[];
    add_list text;
begin
    d := pg_get_functiondef('public.touch_updated_at()'::regprocedure);
    select array_agg(c) into missing
      from unnest(array['dispute_opened_at', 'dispute_closed_at', 'dispute_status',
                        'dispute_reason', 'dispute_amount']) c
     where position(quote_literal(c) in d) = 0;
    if missing is null then
        raise notice 'touch_updated_at already carries every dispute column';
        return;
    end if;
    if position('''updated_at'',' in d) = 0 then
        raise exception 'touch_updated_at no longer has the expected quiet list; not touched';
    end if;
    select string_agg(quote_literal(c), ', ') into add_list from unnest(missing) c;
    d := replace(d, '''updated_at'',', '''updated_at'', ' || add_list || ',');
    execute d;
end $restore$;
