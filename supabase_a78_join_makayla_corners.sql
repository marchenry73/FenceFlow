-- =============================================================================
-- Close the open corner and attach both corners on the three-sided job.
-- AUTHORISED BY MARCH, 2 Oct 2026: "drag that end over and connect both corners".
-- =============================================================================
--
-- WHAT THIS DOES, in two parts:
--
--   PART 1  moves ONE drawn point about 64 drawing units so the third side
--           actually reaches the corner it already looks like it reaches.
--   PART 2  writes two joints, so each corner bills ONE shared corner post
--           instead of two end posts standing in the same hole.
--
-- THE GEOMETRY, measured read-only before this was written. Three sides in a U,
-- points_encoded is "x:y,x:y" and the FIRST pair is the start:
--
--   Left Side   start (2000.2798, 803.1039)   end (2000.2798, 6723.104)
--   Back        start (6000.28,   803.1039)   end (2000.2798, 803.1039)
--   Right side  start (5995.1436, 6499.2954)  end (6000.3374, 739.2977)
--
--   Back END  == Left START   -- the SAME point already. Corner A.
--   Back START ~= Right END   -- x differs by 0.06, y by 63.8. Corner B, open.
--
-- Both corners are about 90 degrees (Back is horizontal, the other two are
-- near-vertical), so both bill a CORNER_POST rather than a line post.
--
-- WHY THE DRAG IS NOT WHAT MAKES THE JOIN WORK. adjustJoins() groups ends by
-- JOINT ID and never consults position (joins.ts:319-334; tests/a33 pins the
-- case of two ends on one identical point still billing two end posts, so
-- nothing is ever inferred from proximity). A joint is honoured at any
-- distance. The drag is here because the drawing should be TRUE -- the fence
-- meets at that corner in the yard, the customer's quote drawing shows the gap,
-- and a side 0.6 ft longer than it is bills 0.6 ft of labour that will not be
-- built. It is not needed to make the corner post appear.
--
-- SAFE TO APPLY BEFORE THE NEW APK IS INSTALLED, and that was checked:
--   - The installed build (574) has Room 50, so it HAS these two columns, and
--     its EntitySync.JOIN_COLUMNS_LIVE is false -- which leaves both keys OUT
--     of its push body entirely (explicitNulls = false drops a null key). So
--     the phone in his hand cannot create a joint and cannot erase one.
--   - Its JOIN_PRICING_READY is false, so that build's engine does not read a
--     joint: the price on the phone does not move until he installs the new one.
--   - The DEPLOYED price-job is v12 (5 Sep) and does not select the columns
--     either, so the office does not move yet either.
--   - reapp_row_takeoff DOES read start_joint, and reapproval_on_drawing_change
--     is an enabled AFTER INSERT OR UPDATE OR DELETE trigger on fence_runs, so
--     this WILL move the re-approval fingerprint. That is why the guard below
--     refuses unless the job is unsigned, unapproved and unaccepted: on this job
--     there is no agreement to disturb. Do NOT reuse this file on a signed job
--     without thinking about what the customer would be asked to re-approve.
--
-- REVERSIBLE. The BEFORE select prints the original points_encoded and the
-- original (empty) joints. To undo: put that points_encoded back and set both
-- joint columns to ''.
--
-- REFUSES rather than guesses. If the drawing has changed, if any joint is
-- already set, if the job has gained a signature or an approval, or if the set
-- is not exactly these three runs, nothing is written.
-- =============================================================================

begin;

do $guard$
declare
  v_job      uuid;
  n_jobs     int;
  n_runs     int;
  n_joined   int;
  n_back     int;
  n_left     int;
  n_right    int;
  v_status   text;
  v_signed   numeric;
  v_accepted numeric;
  v_approved timestamptz;
begin
  select count(*) into n_jobs
    from public.jobs
   where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
     and deleted_at is null
     and customer_name ilike '%makayla%';
  if n_jobs <> 1 then
    raise exception 'REFUSING: expected exactly 1 matching job, found %.', n_jobs;
  end if;

  select sync_id, status, coalesce(signed_contract_total, 0), accepted_total, quote_approved_at
    into v_job, v_status, v_signed, v_accepted, v_approved
    from public.jobs
   where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
     and deleted_at is null
     and customer_name ilike '%makayla%';

  -- No agreement to disturb. The fingerprint trigger fires on these updates.
  if v_signed > 0.005 or v_accepted is not null or v_approved is not null then
    raise exception
      'REFUSING: this job now has a signature (%), an accepted total (%) or an approval (%). Moving a drawn point and attaching two corners changes the price, and the re-approval fingerprint would withdraw an agreement a customer has already given. Decide that deliberately, not through this file.',
      v_signed, v_accepted, v_approved;
  end if;

  select count(*) into n_runs
    from public.fence_runs where job_sync_id = v_job and deleted_at is null;
  if n_runs <> 3 then
    raise exception 'REFUSING: expected exactly 3 sides, found %.', n_runs;
  end if;

  select count(*) into n_joined
    from public.fence_runs
   where job_sync_id = v_job and deleted_at is null
     and (coalesce(start_joint, '') <> '' or coalesce(end_joint, '') <> '');
  if n_joined <> 0 then
    raise exception
      'REFUSING: % side(s) already carry a joint. This file assumes six free ends; applying it twice would overwrite an attachment made since.',
      n_joined;
  end if;

  -- The drawing must still be the one this file was measured against.
  select count(*) into n_back from public.fence_runs
   where job_sync_id = v_job and deleted_at is null
     and points_encoded = '6000.28:803.1039,2000.2798:803.1039';
  select count(*) into n_left from public.fence_runs
   where job_sync_id = v_job and deleted_at is null
     and points_encoded = '2000.2798:803.1039,2000.2798:6723.104';
  select count(*) into n_right from public.fence_runs
   where job_sync_id = v_job and deleted_at is null
     and points_encoded = '5995.1436:6499.2954,6000.3374:739.2977';

  if n_back <> 1 or n_left <> 1 or n_right <> 1 then
    raise exception
      'REFUSING: the drawing has moved since this was measured (back=%, left=%, right=%). Re-read the three points_encoded values and rewrite this file; the joint pairing depends on WHICH END of each side meets which.',
      n_back, n_left, n_right;
  end if;

  raise notice 'Guard passed: 1 unsigned job, 3 sides, 6 free ends, drawing unchanged.';
end
$guard$;

select 'BEFORE' as stage, label,
       points_encoded,
       coalesce(nullif(start_joint, ''), '(free)') as start_joint,
       coalesce(nullif(end_joint,   ''), '(free)') as end_joint
  from public.fence_runs
 where job_sync_id = (select sync_id from public.jobs
                       where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
                         and deleted_at is null and customer_name ilike '%makayla%')
   and deleted_at is null
 order by sort_order;

-- --- PART 1: drag Right side's END onto Back's START -------------------------
-- Only the second pair changes: 6000.3374:739.2977 -> 6000.28:803.1039. The
-- start of that side is untouched, so the side gets about 0.6 ft shorter and
-- now terminates exactly where Back begins.
update public.fence_runs
   set points_encoded = '5995.1436:6499.2954,6000.28:803.1039',
       updated_at = now()
 where job_sync_id = (select sync_id from public.jobs
                       where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
                         and deleted_at is null and customer_name ilike '%makayla%')
   and deleted_at is null
   and points_encoded = '5995.1436:6499.2954,6000.3374:739.2977';

-- --- PART 2: the two joints -------------------------------------------------
-- One shared uuid per corner, written to BOTH ends that meet there. adjustJoins
-- groups by this id; a value that is not a canonical uuid reads as a free end,
-- which is why these are generated rather than hand-typed.
do $join$
declare
  v_job     uuid;
  v_corner_a uuid := gen_random_uuid();   -- Back END  <-> Left START
  v_corner_b uuid := gen_random_uuid();   -- Back START <-> Right END
begin
  select sync_id into v_job from public.jobs
   where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
     and deleted_at is null and customer_name ilike '%makayla%';

  -- Corner A: the one that was already a single point.
  update public.fence_runs set end_joint = v_corner_a::text, updated_at = now()
   where job_sync_id = v_job and deleted_at is null
     and points_encoded = '6000.28:803.1039,2000.2798:803.1039';          -- Back
  update public.fence_runs set start_joint = v_corner_a::text, updated_at = now()
   where job_sync_id = v_job and deleted_at is null
     and points_encoded = '2000.2798:803.1039,2000.2798:6723.104';        -- Left

  -- Corner B: the one PART 1 just closed.
  update public.fence_runs set start_joint = v_corner_b::text, updated_at = now()
   where job_sync_id = v_job and deleted_at is null
     and points_encoded = '6000.28:803.1039,2000.2798:803.1039';          -- Back
  update public.fence_runs set end_joint = v_corner_b::text, updated_at = now()
   where job_sync_id = v_job and deleted_at is null
     and points_encoded = '5995.1436:6499.2954,6000.28:803.1039';         -- Right, moved

  raise notice 'Corner A %, corner B %', v_corner_a, v_corner_b;
end
$join$;

-- --- Both corners must now have exactly TWO ends each ------------------------
do $verify$
declare
  bad int;
begin
  select count(*) into bad from (
    select j.joint, count(*) as members from (
      select start_joint as joint from public.fence_runs
       where deleted_at is null and coalesce(start_joint,'') <> ''
         and job_sync_id = (select sync_id from public.jobs
                             where company_id='aba5b097-afc4-48dd-9851-b50200d5e8f4'
                               and deleted_at is null and customer_name ilike '%makayla%')
      union all
      select end_joint from public.fence_runs
       where deleted_at is null and coalesce(end_joint,'') <> ''
         and job_sync_id = (select sync_id from public.jobs
                             where company_id='aba5b097-afc4-48dd-9851-b50200d5e8f4'
                               and deleted_at is null and customer_name ilike '%makayla%')
    ) j group by j.joint having count(*) <> 2
  ) t;
  if bad > 0 then
    raise exception
      'REFUSING: % joint(s) do not have exactly two ends. A joint with one end reads as a FREE end (the dearer answer) and a joint with three is a different post entirely. Rolling back.',
      bad;
  end if;
  raise notice 'Verified: every joint has exactly two ends.';
end
$verify$;

select 'AFTER' as stage, label,
       points_encoded,
       coalesce(nullif(start_joint, ''), '(free)') as start_joint,
       coalesce(nullif(end_joint,   ''), '(free)') as end_joint
  from public.fence_runs
 where job_sync_id = (select sync_id from public.jobs
                       where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
                         and deleted_at is null and customer_name ilike '%makayla%')
   and deleted_at is null
 order by sort_order;

commit;
