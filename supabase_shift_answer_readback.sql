-- Crew shift answers, read back from the server so every phone agrees.
-- Additive: one new read-only function, and acknowledge_my_shift now also
-- restamps when the office corrected the shift AGAIN after the last look
-- (before, coalesce kept the first stamp, so a re-correction could never be
-- acknowledged). Same caller check as supabase_shift_dispute.sql.
create or replace function public.acknowledge_my_shift(shift_sync_id text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare touched int;
begin
    update time_entries t
       set correction_seen_at = case
             when t.correction_seen_at is null
               or (t.corrected_at is not null and t.correction_seen_at < t.corrected_at)
             then now() else t.correction_seen_at end
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and exists (select 1 from employees e
                    where e.company_id = t.company_id
                      and e.sync_id::text = t.employee_sync_id
                      and e.profile_id = auth.uid());
    get diagnostics touched = row_count;
    return touched > 0;
end;
$$;

-- 'accepted', 'disputed' or null (not answered since the latest correction).
-- Only the person the shift belongs to gets an answer; anyone else gets null.
create or replace function public.my_shift_answer(shift_sync_id text)
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
    select case
        when t.correction_disputed_at is not null
         and t.correction_disputed_at >= coalesce(t.corrected_at, '-infinity')
          then jsonb_build_object('answer','disputed','note',t.dispute_note)
        when t.correction_seen_at is not null
         and t.correction_seen_at >= coalesce(t.corrected_at, '-infinity')
          then jsonb_build_object('answer','accepted')
        end
      from time_entries t
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and exists (select 1 from employees e
                    where e.company_id = t.company_id
                      and e.sync_id::text = t.employee_sync_id
                      and e.profile_id = auth.uid());
$$;

revoke execute on function public.my_shift_answer(text) from public, anon;
grant  execute on function public.my_shift_answer(text) to authenticated;

select 'shift answer readback installed' as done;
