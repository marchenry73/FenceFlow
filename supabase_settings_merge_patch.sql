-- Saving settings from the website destroyed everything it did not know about.
--
-- The whole settings blob was replaced with whatever the page sent, and the
-- page knows about a subset of what the app stores: tool lists, the order and
-- HOA and review templates, panel dimensions, whether prices have been
-- reviewed. Pressing Save Settings in the office quietly wiped all of it, and
-- the next sync carried the loss to every phone.
--
-- Merged now: `||` on jsonb keeps every existing key and lets the incoming
-- ones win. A page that does not know about a setting can no longer delete it.
create or replace function public.save_company_settings(new_settings jsonb)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare target uuid;
begin
    target := current_company_id();
    if target is null then
        raise exception 'You are not part of a business yet.';
    end if;
    if current_user_role() not in ('OWNER', 'MANAGER') then
        raise exception 'Only owners and managers can change business settings.';
    end if;

    insert into company_settings (company_id, settings, updated_at)
        values (target, new_settings, now())
    on conflict (company_id) do update
        set settings = company_settings.settings || excluded.settings,
            updated_at = now();
end;
$$;
select 'settings merge fixed' as done;
