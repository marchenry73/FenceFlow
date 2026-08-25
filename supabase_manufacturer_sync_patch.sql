-- A job's chosen supplier could not travel between phones: it was stored as a
-- Room id, which is unique to the phone that made it. On a second phone the
-- job arrived with no supplier set, and regenerating the takeoff there priced
-- every material from whichever manufacturer came first -- two phones, two
-- quotes, same fence.
alter table public.jobs
  add column if not exists preferred_manufacturer_sync_id text;
select 'manufacturer sync column added' as done;
