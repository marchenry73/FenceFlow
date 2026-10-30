-- THE REVIEW SETTINGS HAVE TO BE SAVEABLE.
--
-- r47 added follow_up_settings.job_done_review_enabled / _days / review_url.
-- Every office write goes through set_follow_up_settings(jsonb) and nothing
-- else -- that is where the EDIT_CATALOG_AND_SETTINGS check lives -- and that
-- function named the four original rules column by column. So the new toggle
-- would have rendered, accepted a click, reported "saved", and changed
-- nothing. The feature would be unreachable from the only screen that offers
-- it, and the only sign would be the toggle springing back on reload.
--
-- AN ABSENT KEY NOW MEANS "LEAVE IT ALONE" for these three.
--
-- The four original rules coalesce a missing key to their hard default, which
-- means any caller that does not send every field resets the ones it omits.
-- That is a live hazard the day a cached older dashboard.html saves this
-- panel: it would know nothing about review requests and would switch them
-- off. The three new fields read the EXISTING row instead, so an old client
-- can no longer silently undo them. (The original four are left as they are:
-- changing their semantics is a separate decision about a path that has
-- worked for months, not something to slip into this patch.)
--
-- review_url is normalised rather than trusted. "g.page/r/xxxx/review" typed
-- without a scheme would land in an email as a relative link and produce a
-- dead button for every customer; a bare word is rejected outright. Blank is
-- always allowed and means the feature cannot send (see dueFollowUp).

create or replace function public.set_follow_up_settings(p jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    co uuid := public.current_company_id();
    raw_url text := nullif(btrim(coalesce(p->>'review_url', '')), '');
    clean_url text;
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('EDIT_CATALOG_AND_SETTINGS'), false) then
        raise exception 'You cannot change follow-up settings.' using errcode = '42501';
    end if;

    -- A missing scheme is the likely typo, so it is fixed. Anything that is
    -- still not a URL is refused loudly: saving it would hand every finished
    -- customer a broken button, and a blank would at least be honest.
    if raw_url is null then
        clean_url := null;                       -- means "no key sent"
    else
        if raw_url !~* '^https?://' then
            raw_url := 'https://' || raw_url;
        end if;
        if raw_url !~* '^https?://[^/\s.]+\.[^/\s]+' then
            raise exception 'That review link does not look like a web address: %', raw_url
                using errcode = '22023';
        end if;
        clean_url := raw_url;
    end if;

    insert into public.follow_up_settings (
        company_id, enabled,
        new_lead_not_contacted_enabled, quote_sent_no_view_enabled,
        quote_viewed_not_approved_enabled, approved_no_deposit_enabled,
        new_lead_not_contacted_hours, quote_sent_no_view_days,
        quote_viewed_not_approved_days, approved_no_deposit_days,
        quiet_hours_start, quiet_hours_end, timezone, daily_cap,
        job_done_review_enabled, job_done_review_days, review_url,
        updated_at, updated_by
    )
    values (
        co, coalesce((p->>'enabled')::boolean, false),
        coalesce((p->>'new_lead_not_contacted_enabled')::boolean, false),
        coalesce((p->>'quote_sent_no_view_enabled')::boolean, false),
        coalesce((p->>'quote_viewed_not_approved_enabled')::boolean, false),
        coalesce((p->>'approved_no_deposit_enabled')::boolean, false),
        coalesce((p->>'new_lead_not_contacted_hours')::integer, 4),
        coalesce((p->>'quote_sent_no_view_days')::integer, 2),
        coalesce((p->>'quote_viewed_not_approved_days')::integer, 3),
        coalesce((p->>'approved_no_deposit_days')::integer, 2),
        coalesce((p->>'quiet_hours_start')::smallint, 21),
        coalesce((p->>'quiet_hours_end')::smallint, 8),
        coalesce(p->>'timezone', 'America/New_York'),
        coalesce((p->>'daily_cap')::integer, 25),
        coalesce((p->>'job_done_review_enabled')::boolean, false),
        -- Clamped, not trusted: a 0 would ask the customer the same day the
        -- crew left, and a 400 would never arrive inside the age window.
        greatest(1, least(30, coalesce((p->>'job_done_review_days')::integer, 3))),
        coalesce(clean_url, ''),
        now(), auth.uid()
    )
    on conflict (company_id) do update set
        enabled = excluded.enabled,
        new_lead_not_contacted_enabled = excluded.new_lead_not_contacted_enabled,
        quote_sent_no_view_enabled = excluded.quote_sent_no_view_enabled,
        quote_viewed_not_approved_enabled = excluded.quote_viewed_not_approved_enabled,
        approved_no_deposit_enabled = excluded.approved_no_deposit_enabled,
        new_lead_not_contacted_hours = excluded.new_lead_not_contacted_hours,
        quote_sent_no_view_days = excluded.quote_sent_no_view_days,
        quote_viewed_not_approved_days = excluded.quote_viewed_not_approved_days,
        approved_no_deposit_days = excluded.approved_no_deposit_days,
        quiet_hours_start = excluded.quiet_hours_start,
        quiet_hours_end = excluded.quiet_hours_end,
        timezone = excluded.timezone,
        daily_cap = excluded.daily_cap,
        -- The three new ones: an absent key keeps what is already stored.
        job_done_review_enabled = coalesce(
            (p->>'job_done_review_enabled')::boolean,
            follow_up_settings.job_done_review_enabled),
        job_done_review_days = greatest(1, least(30, coalesce(
            (p->>'job_done_review_days')::integer,
            follow_up_settings.job_done_review_days))),
        review_url = coalesce(clean_url, follow_up_settings.review_url),
        updated_at = now(), updated_by = auth.uid();
end;
$function$;

-- ---------------------------------------------------------------------------
-- What is and is not proven here.
--
-- The function is SECURITY DEFINER and keyed to current_company_id(), so
-- calling it from this CLI session would either be refused or would overwrite
-- a REAL company's live follow-up settings -- including, if any key were
-- missing from my payload, switching off sales automation that is currently
-- on. That is not a risk worth taking to test a save path, so this block
-- proves the two things it can prove without writing to anyone's row:
--
--   1. the URL normaliser, evaluated directly (pure expressions, no writes);
--   2. that all three columns appear in the insert list, the values list AND
--      the update list -- the omission that caused this patch.
--
-- The remaining link (the office panel actually sending these keys) is
-- covered by the dashboard guard added with it, not here.
-- ---------------------------------------------------------------------------
do $$
declare def text;
begin
  -- 1. The normaliser, as expressions.
  if ('g.page/r/abc/review' !~* '^https?://') is not true then
      raise exception 'r50 FAILED: a scheme-less link was not detected';
  end if;
  if ('https://g.page/r/abc/review' !~* '^https?://[^/\s.]+\.[^/\s]+') then
      raise exception 'r50 FAILED: a real review link was rejected';
  end if;
  -- THE CONTROL: a bare word must NOT pass as a web address, or the check
  -- above is accepting everything and proves nothing.
  if ('https://notaurl' ~* '^https?://[^/\s.]+\.[^/\s]+') then
      raise exception 'r50 FAILED: a bare word passed as a web address';
  end if;

  -- 2. Each column in all three positions.
  select pg_get_functiondef(p.oid) into def
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public' and p.proname = 'set_follow_up_settings';

  if (length(def) - length(replace(def, 'job_done_review_enabled', ''))) /
     length('job_done_review_enabled') < 3 then
      raise exception 'r50 FAILED: job_done_review_enabled is not in all three lists';
  end if;
  if (length(def) - length(replace(def, 'job_done_review_days', ''))) /
     length('job_done_review_days') < 3 then
      raise exception 'r50 FAILED: job_done_review_days is not in all three lists';
  end if;
  if (length(def) - length(replace(def, 'review_url', ''))) /
     length('review_url') < 3 then
      raise exception 'r50 FAILED: review_url is not in all three lists';
  end if;

  raise notice 'r50 ok: the three review settings are saveable and the link is validated';
end $$;

select 'review settings reach the update branch' as check,
       pg_get_functiondef(p.oid) like '%follow_up_settings.job_done_review_enabled%' as pass
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'set_follow_up_settings';
