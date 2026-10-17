-- RESTORE THE 18 LINE ITEMS DELETED OFF JOHN BEAUNISSANT'S JOB
-- 1 October 2026, 21:26:40 to 21:26:58 UTC -- eighteen seconds, by no user.
--
-- NOT APPLIED. Nothing below has been run. Read it, then tell me to run it.
--
-- =============================================================== WHAT HAPPENED
--
-- John Beaunissant's job was COMPLETED and signed on 25 September 2026 for
-- $15,540. On 1 October at 21:26, eighteen of its twenty line items were
-- tombstoned in eighteen seconds -- a complete bill of materials for a vinyl
-- privacy fence with a gate: 119 panels, 112 line posts, 123 bags of concrete,
-- 4 corner posts, 6 end posts, the gate, its hinges, latch, handle, brace,
-- trim and stiffener. $9,475.34 of lines.
--
-- Three things say this was not a person deleting things:
--
--   1. deleted_by is the EMPTY STRING on every one of the eighteen. A deletion
--      made in the office records an email address -- there are 39 rows in this
--      table deleted that way, so the column works.
--   2. The same minute took 33 rows across THREE jobs. Every other no-user
--      deletion in the table's history is 1 to 9 rows on a single job.
--   3. Nobody deletes a complete materials list, line by line over eighteen
--      seconds, off a job that was finished and signed six days earlier.
--
-- The "$200" on that job today is the MINIMUM LABOUR CHARGE. With every line
-- gone, that floor is all there is left to charge.
--
-- ============================================================= WHY IT IS SAFE
--
-- These rows were tombstoned, not destroyed: deleted_at is set and the row is
-- intact. Clearing it puts them back, and the phones pull them back down.
--
-- NO DELIBERATE DELETION IS UNDONE BY THIS. On this job the count of rows
-- deleted by a real person is ZERO, and the two rows NOT in the list below
-- (one GATE_POST x4 on 25 August, one END_POST x2 on 29 August) were removed
-- while the job was still being estimated, a month before it was signed. They
-- stay gone. That is why this names eighteen sync ids explicitly instead of
-- clearing everything on the job, or everything with an empty deleted_by:
-- what you approve is exactly what runs.
--
-- The money columns are NOT touched. accepted_total and signed_contract_total
-- already read $15,540, which is what the customer signed and what every owed
-- figure bills against. Only the materials detail underneath comes back.
--
-- updated_at WILL move on these eighteen rows, by the table's own touch
-- trigger. That is correct: the row really did change, and the phones need to
-- see it to pull them back.

-- ==========================================================================
-- STEP 1 -- DRY RUN. Read-only. Run this on its own first.
-- Expect: 18 rows, total 9475.34, every one "tombstoned by nobody".
-- ==========================================================================

select count(*)                                                as rows_to_restore,
       round(sum(li.quantity * li.unit_price)::numeric, 2)      as value_to_restore,
       count(*) filter (where coalesce(li.deleted_by,'') <> '') as deleted_by_a_person,
       count(*) filter (where li.deleted_at is null)            as not_actually_deleted,
       min(li.deleted_at)::text                                 as first_deleted,
       max(li.deleted_at)::text                                 as last_deleted
  from estimate_line_items li
 where li.job_sync_id = '10b0407f-2322-476f-af96-0520dd84aea1'
   and li.sync_id in (
     '103566c1-d35e-3b08-8fdc-c81d70ff94af',  -- 5130.30  Panel T&G Vinyl Privacy 6'H x 6'W - White
     '665bcdde-dd5e-3db7-93c3-01526bc0efb7',  -- 1099.35  Panel T&G Vinyl Privacy 6'H x 6'W - White
     '6571177a-6f8c-3a9b-9971-099517a88bbd',  -- 1540.08  5"x5" Co-Ex Line Post, White
     '95e12304-8fdb-33d8-857b-ef9a3625b140',  --  314.64  5"x5" Co-Ex Line Post, White
     '4942a1b4-a9a5-3303-a91f-5c1e61c377f5',  --   33.12  5"x5" Co-Ex Corner Post, White
     '92eca978-6a32-3e42-80ac-b0fd96538b4f',  --   33.12  5"x5" Co-Ex Corner Post, White
     '8320311c-c3ff-3008-8e9b-2802b70d404d',  --   15.54  5" External Pyramid PVC Post Cap, White
     '8f7160dd-a03b-3f27-a538-9028560df158',  --   99.36  5"x5" Co-Ex End Post, White
     '272cede5-1b71-3e54-a212-b3ab9d739bdc',  --   74.74  5" External Pyramid PVC Post Cap, White
     '5027a494-5093-3203-83bf-fe929c2d3770',  --   99.75  Concrete Mix 60lb Bag
     '733b2712-37c5-395b-9719-163f8e03dcad',  --  290.10  Regular PVC Gate 6'H x 5'W, White
     '9269e330-e3b4-3592-802d-6042760b06bc',  --   64.50  Self-Closing Hinge Set (box, 12 pairs)
     '7a1619a2-9bf9-36dd-bd17-7961f3a8277c',  --   51.74  Two-Way Latch (box of 20)
     '2ebc794f-43ea-31aa-bade-943170957b4b',  --   10.00  7" SS Gate Handle (box of 50)
     'deb3a709-5a53-302c-8727-9f02a9eb9789',  --   13.00  Gate Support Brace, 8'
     'd922e741-c922-3138-a7a0-f48d745d0732',  --   16.00  7/8 x 1-1/2 x 62 1/4 Trim U-Channel, White
     '6ff1c522-3a91-3460-a960-553bdeb77341',  --  105.50  5" Econo Stiffener x 8'(H)
     '73644e58-d539-3f8b-8b1d-3cc1fffd7595'   --  484.50  Concrete Mix 60lb Bag
   );

-- ==========================================================================
-- STEP 2 -- THE RESTORE. One transaction, and it REFUSES ITSELF unless it
-- moves exactly 18 rows. A different count means the data moved under me
-- since I read it, and in that case nothing should happen at all.
-- ==========================================================================

do $restore$
declare
  moved int;
begin
  update estimate_line_items li
     -- deleted_by is `text NOT NULL default ''`, not a nullable column
     -- (fingerprint-prod.txt:231). Writing null here raised
     -- "null value in column deleted_by violates not-null constraint",
     -- the DO block rolled back, and the restore moved nothing while
     -- looking like it had run. The empty string is what a live row
     -- carries and what supabase_a64_restore_tombstoned_line_items.sql:824
     -- wrote on the 64-row restore that did work.
     set deleted_at = null,
         deleted_by = ''
   where li.job_sync_id = '10b0407f-2322-476f-af96-0520dd84aea1'
     and li.deleted_at is not null
     -- Belt and braces: never clear a tombstone a PERSON set, even if one of
     -- the ids below somehow became that.
     and coalesce(li.deleted_by, '') = ''
     and li.sync_id in (
       '103566c1-d35e-3b08-8fdc-c81d70ff94af',
       '665bcdde-dd5e-3db7-93c3-01526bc0efb7',
       '6571177a-6f8c-3a9b-9971-099517a88bbd',
       '95e12304-8fdb-33d8-857b-ef9a3625b140',
       '4942a1b4-a9a5-3303-a91f-5c1e61c377f5',
       '92eca978-6a32-3e42-80ac-b0fd96538b4f',
       '8320311c-c3ff-3008-8e9b-2802b70d404d',
       '8f7160dd-a03b-3f27-a538-9028560df158',
       '272cede5-1b71-3e54-a212-b3ab9d739bdc',
       '5027a494-5093-3203-83bf-fe929c2d3770',
       '733b2712-37c5-395b-9719-163f8e03dcad',
       '9269e330-e3b4-3592-802d-6042760b06bc',
       '7a1619a2-9bf9-36dd-bd17-7961f3a8277c',
       '2ebc794f-43ea-31aa-bade-943170957b4b',
       'deb3a709-5a53-302c-8727-9f02a9eb9789',
       'd922e741-c922-3138-a7a0-f48d745d0732',
       '6ff1c522-3a91-3460-a960-553bdeb77341',
       '73644e58-d539-3f8b-8b1d-3cc1fffd7595'
     );

  get diagnostics moved = row_count;

  if moved <> 18 then
    raise exception
      'REFUSED: % rows would have been restored, not 18. Nothing was changed. '
      'Re-read the job before trying again.', moved;
  end if;

  raise notice 'Restored % line items to John Beaunissant''s job.', moved;
end
$restore$;

-- ==========================================================================
-- STEP 3 -- READ IT BACK. The figure that matters is live_lines: it should
-- read 9574.70, which is the 9475.34 restored here plus the 99.36 end-post
-- line that was already live. Run after step 2.
-- ==========================================================================

select j.customer_name,
       j.status,
       j.accepted_total,
       j.signed_contract_total,
       (select count(*) from estimate_line_items k
         where k.job_sync_id = j.sync_id and k.deleted_at is null)  as live_rows,
       (select round(sum(k.quantity * k.unit_price)::numeric, 2)
          from estimate_line_items k
         where k.job_sync_id = j.sync_id and k.deleted_at is null)  as live_lines,
       (select count(*) from estimate_line_items k
         where k.job_sync_id = j.sync_id and k.deleted_at is not null) as still_tombstoned
  from jobs j
 where j.sync_id = '10b0407f-2322-476f-af96-0520dd84aea1';

-- Expect: live_rows 19, live_lines 9574.70, still_tombstoned 2 (the two
-- August edits, which stay gone).
--
-- AFTERWARDS, on the phones: pull to refresh. The lines come back down with
-- the tombstones cleared. If the app still shows $200 on that job, the phone
-- has not synced yet -- it is not a second fault.
