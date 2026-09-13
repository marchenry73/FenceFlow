-- MIGRATION -- Defect 1 fix, server side. NOT RUN.
--
-- Adds a monotonic per-row version counter to the four synced tables where
-- last-edit-wins currently trusts a device's own clock (jobs, fence_runs,
-- pricing_tiers, material_items -- see Repository.kt: updateJob,
-- createFenceRun/updateFenceRun, savePricingTier, saveMaterialItem/
-- updateMaterialItem all stamp `System.currentTimeMillis()` and JobSync.kt
-- / EntitySync.kt compare those stamps directly against the server's own
-- clock-derived updated_at).
--
-- Why a version counter and not a fix to the clock comparison itself:
--   Three options were considered.
--     1. Trust the server's clock only, drop the device timestamp from the
--        comparison entirely, and have the phone push blind (last write to
--        reach the server wins, full stop). Rejected: this throws away the
--        one piece of real information last-edit-wins is trying to use --
--        which edit actually happened later -- and replaces it with which
--        edit's *network request* arrived first, which is worse in exactly
--        the situation that matters most: a truck with a bad connection
--        that syncs an hour late would always lose to whatever the office
--        already pushed, even when the truck's edit was the one made most
--        recently.
--     2. A server-assigned timestamp at write time (stamp `updated_at` from
--        `now()` on the row the instant it lands, and have the phone defer
--        to whichever push reaches the server later). This is actually the
--        same idea as (1) with extra steps -- "later to arrive" still
--        stands in for "later in truth" -- and it still cannot resolve two
--        edits made within the same sync window in the order they actually
--        happened, only the order they were uploaded.
--     3. A monotonic per-row version counter, incremented by the server on
--        every real write and carried down to the phone on every pull.
--        Chosen. It does not need clocks to agree at all -- a phone compares
--        "the version I last saw" to "the version the server has now" and
--        only pushes when it saw the latest one, exactly the optimistic-
--        concurrency pattern this app is missing. A phone offline for a
--        week and a phone offline for ten minutes are treated identically:
--        whichever one is editing a version the other has already moved
--        past loses, regardless of either device's clock.
--   The real cost of (3): it does not, on its own, tell you what to do when
--   two phones edit the *same* version concurrently (both offline, both
--   start from version 7, both push). It only detects that a conflict
--   happened -- it does not resolve which edit should win. Today's silent
--   last-write-wins at least always produces an answer, wrong as it can be.
--   A version counter change would need the app to actually handle a
--   rejected push (surface it, retry against the new version, or queue a
--   manual merge) rather than silently discarding the loser the way
--   last-edit-wins already does today. That app-side handling is NOT part
--   of this migration and would be real, separate work.
--
-- What this migration does NOT do:
--   It does not change touch_updated_at(), does not remove updated_at (kept
--   for display/reporting -- "last edited" is still a real question users
--   ask, decoupled here from "which edit wins"), and does not change any
--   RLS policy or permission. Purely additive: one integer column and one
--   trigger per table, all backward compatible with any phone still on the
--   old comparison until it upgrades (see the paired Room migration in
--   this same commit's writeup -- ROOM_MIGRATIONS.md).
--
-- Risk / what could go wrong if this ships:
--   - Every row defaults to version 1 on migration day. A phone that is
--     mid-edit offline across the exact moment this migration runs, and
--     that has NOT yet updated its app to understand versions, keeps
--     comparing clocks against a cloud row whose updated_at is unaffected
--     by this migration -- so old app builds keep working exactly as
--     today, badly, until they update. This migration is safe to run
--     before the app update ships; it does nothing until read.
--   - If the eventual app-side change increments version on every push
--     without checking it first, this becomes theater -- a column nobody
--     reads for its actual purpose. The value here is entirely in the
--     comparison logic that consumes it, which is Kotlin work, not SQL.
--   - A trigger that fires on every UPDATE, including bookkeeping writes,
--     would re-break exactly the bug supabase_quiet_touch_patch.sql fixed
--     for updated_at. The trigger below reuses the SAME quiet-column list
--     for that reason -- version must be quiet about exactly what
--     updated_at is quiet about, or a payment webhook bumping amount_paid
--     would look like a real edit again and cause spurious conflicts.

begin;

alter table public.jobs           add column if not exists edit_version bigint not null default 1;
alter table public.fence_runs     add column if not exists edit_version bigint not null default 1;
alter table public.pricing_tiers  add column if not exists edit_version bigint not null default 1;
alter table public.material_items add column if not exists edit_version bigint not null default 1;

-- Bumps edit_version exactly when touch_updated_at() would move updated_at
-- -- i.e. on a real edit, never on a bookkeeping write. Install AFTER
-- touch_updated_at() in trigger order (alphabetically "bump_" > "touch_" on
-- most Postgres trigger-name orderings, but do not rely on that -- verify
-- with \d+ on each table before relying on ordering in production).
create or replace function public.bump_edit_version()
returns trigger
language plpgsql
as $$
declare
    quiet constant text[] := array[
        'updated_at', 'edit_version',
        'amount_paid', 'refunded_amount', 'payment_status', 'payments_from_processor',
        'contract_total',
        'quote_viewed_at', 'site_lat', 'site_lon',
        'last_seen_at'
    ];
begin
    if (to_jsonb(new) - quiet) is distinct from (to_jsonb(old) - quiet) then
        new.edit_version = old.edit_version + 1;
    else
        new.edit_version = old.edit_version;
    end if;
    return new;
end $$;

drop trigger if exists "bump-jobs-edit-version" on public.jobs;
create trigger "bump-jobs-edit-version" before update on public.jobs
    for each row execute function public.bump_edit_version();

drop trigger if exists "bump-fence-runs-edit-version" on public.fence_runs;
create trigger "bump-fence-runs-edit-version" before update on public.fence_runs
    for each row execute function public.bump_edit_version();

drop trigger if exists "bump-pricing-tiers-edit-version" on public.pricing_tiers;
create trigger "bump-pricing-tiers-edit-version" before update on public.pricing_tiers
    for each row execute function public.bump_edit_version();

drop trigger if exists "bump-material-items-edit-version" on public.material_items;
create trigger "bump-material-items-edit-version" before update on public.material_items
    for each row execute function public.bump_edit_version();

commit;
