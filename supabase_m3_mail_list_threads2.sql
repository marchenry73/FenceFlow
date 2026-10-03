-- ============================================================================
-- m3: the thread list, with the organisation layer in it.
--
-- A NEW FUNCTION, NOT A REPLACEMENT. mail_list_threads returns a fixed column
-- list, so adding starred/archived/snoozed to it means changing its return
-- type, and Postgres will not let CREATE OR REPLACE do that -- it has to be
-- dropped first. Dropping it leaves a window, however short, where the office
-- page's inbox is calling a function that does not exist, and the recovery if
-- the CREATE then failed would be an outage on the live site.
--
-- So the old one is left exactly where it is and this sits beside it. The page
-- moves over; if anything is wrong with this, the fix is to point the page back
-- at a function that never stopped working. The old one can be dropped later,
-- once this has been used in anger.
--
-- WHAT IS NEW, beyond the extra columns:
--
--   * 'inbox' NOW EXCLUDES archived, trashed and still-snoozed threads. This is
--     the whole point. Archiving something that stays in the inbox is not
--     archiving, and the previous function had no way to know.
--   * four new folders: starred, snoozed, archived, trash.
--   * snoozed is judged against now() at query time rather than a flag somebody
--     has to clear, so a thread comes back on its own with nothing scheduled.
-- ============================================================================
create or replace function public.mail_list_threads2(
    p_folder    text        default 'inbox',
    p_account   uuid        default null,
    p_query     text        default null,
    p_before    timestamptz default null,
    p_limit     integer     default 50,
    p_before_id uuid        default null)
returns table (
    id                  uuid,
    subject             text,
    last_message_at     timestamptz,
    message_count       integer,
    unread_count        integer,
    has_attachments     boolean,
    snippet             text,
    participants        text[],
    in_inbox            boolean,
    in_sent             boolean,
    latest_from_name    text,
    latest_from_address text,
    job_sync_ids        uuid[],
    -- the organisation layer
    is_starred          boolean,
    archived_at         timestamptz,
    trashed_at          timestamptz,
    snoozed_until       timestamptz,
    assigned_to         uuid,
    label_ids           uuid[],
    note_count          integer)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
    q      tsquery;
    folder text := coalesce(nullif(p_folder, ''), 'inbox');
    lim    integer := least(greatest(coalesce(p_limit, 50), 1), 100);
    -- Which message folder the underlying mail is read from. The four new
    -- views are filing states, not mailbox folders: a starred thread is still
    -- an inbox thread, so they all read 'inbox' underneath.
    base   text;
begin
    if folder not in ('inbox', 'sent', 'all', 'starred', 'snoozed', 'archived', 'trash') then
        raise exception 'Unknown folder' using errcode = '22023';
    end if;
    base := case when folder in ('sent', 'all') then folder else 'inbox' end;

    if nullif(btrim(coalesce(p_query, '')), '') is not null then
        q := public.mail_search_query(p_query);
        if q is null or numnode(q) = 0 then
            return;          -- typed something, none of it searchable: nothing matches
        end if;
    end if;

    return query
    with x as (
        select m.thread_id,
               max(m.received_at) as last_at,
               (count(*) filter (where m.folder_role = 'inbox' and not m.is_seen))::integer as unread
          from public.mail_messages m
         where m.server_gone_at is null
           and (base = 'all' or m.folder_role = base)
           and (p_account is null or m.account_id = p_account)
           and (q is null or m.search_tsv @@ q)
         group by m.thread_id
    )
    select t.id, t.subject, x.last_at, t.message_count, x.unread, t.has_attachments,
           t.snippet, t.participants, t.in_inbox, t.in_sent,
           lm.from_name, lm.from_address,
           coalesce((select array_agg(l.job_sync_id order by l.linked_at)
                       from public.mail_thread_jobs l where l.thread_id = t.id), '{}'),
           t.is_starred, t.archived_at, t.trashed_at, t.snoozed_until, t.assigned_to,
           coalesce((select array_agg(tl.label_id)
                       from public.mail_thread_labels tl where tl.thread_id = t.id), '{}'),
           coalesce((select count(*)::integer
                       from public.mail_thread_notes n where n.thread_id = t.id), 0)
      from x
      join public.mail_threads t on t.id = x.thread_id
      left join lateral (
            select m.from_name, m.from_address
              from public.mail_messages m
             where m.thread_id = t.id and m.server_gone_at is null
               and (base = 'all' or m.folder_role = base)
               and (p_account is null or m.account_id = p_account)
             order by m.received_at desc
             limit 1) lm on true
     where
       -- THE FILING RULES. Trash is excluded from every view except its own,
       -- because a thread he threw away should not come back because it was
       -- also starred.
       case folder
         when 'trash'    then t.trashed_at is not null
         when 'archived' then t.trashed_at is null and t.archived_at is not null
         when 'starred'  then t.trashed_at is null and t.is_starred
         when 'snoozed'  then t.trashed_at is null and t.snoozed_until is not null
                                                   and t.snoozed_until > now()
         when 'inbox'    then t.trashed_at is null and t.archived_at is null
                              and (t.snoozed_until is null or t.snoozed_until <= now())
         else                 t.trashed_at is null
       end
       and (p_before is null
            or x.last_at < p_before
            or (x.last_at = p_before and p_before_id is not null and t.id < p_before_id))
     order by x.last_at desc, t.id desc
     limit lim;
end;
$$;

revoke all on function public.mail_list_threads2(text, uuid, text, timestamptz, integer, uuid) from public, anon;
grant execute on function public.mail_list_threads2(text, uuid, text, timestamptz, integer, uuid) to authenticated;


-- ============================================================================
-- The unread badge has to agree with the inbox it is counting.
--
-- The tab badge counts unseen inbox messages directly off mail_messages, which
-- knows nothing about archiving. Archive an unread thread and the badge keeps
-- counting it forever while the inbox no longer shows it -- a number that can
-- never be cleared by reading anything.
-- ============================================================================
create or replace function public.mail_unread_count(p_account uuid default null)
returns integer language sql stable security invoker set search_path = public as $$
  select coalesce(count(*)::integer, 0)
    from public.mail_messages m
    join public.mail_threads  t on t.id = m.thread_id
   where m.server_gone_at is null
     and m.folder_role = 'inbox'
     and not m.is_seen
     and (p_account is null or m.account_id = p_account)
     and t.trashed_at is null
     and t.archived_at is null
     and (t.snoozed_until is null or t.snoozed_until <= now())
$$;

revoke all on function public.mail_unread_count(uuid) from public, anon;
grant execute on function public.mail_unread_count(uuid) to authenticated;
