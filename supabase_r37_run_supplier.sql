-- WHICH SUPPLIER THIS SIDE IS BUILT FROM.
--
-- "For the 4ft fence I want to be able to specify what type of fence it is
--  when I draw it, so it can get the right price, if there is no prices for
--  that fencing, let me know too."
--
-- WHAT IS WRONG TODAY. A run records its fence type, its panel size, its
-- colour and its styles -- and nothing at all about WHO SUPPLIES IT. So for a
-- 4 ft vinyl side the engine picks between Flori Fence's panel at $61.74 and
-- Hartford's at $71.50 by price alone, and the cheapest priced row wins. The
-- owner's standing rule that 4 ft vinyl is Flori fence comes out right by
-- accident of price, not because anything records it. The day Flori raises a
-- price above Hartford's, every 4 ft quote silently changes supplier.
--
-- WHY A COLUMN ON THE RUN AND NOT SOMETHING NEW. jobs already carries
-- preferred_manufacturer_sync_id, and both engines already narrow candidates
-- by it -- "narrow only if something matches". This is the same idea one
-- level down, because a job can have a 6 ft Hartford fence along the back and
-- a 4 ft Flori fence down the side, and a single preference for the whole job
-- cannot say that. The run's preference WINS over the job's; the job's stays
-- as the fallback for every run that names nobody, so nothing already drawn
-- changes behaviour.
--
-- NULL MEANS "WHATEVER FITS BEST", which is exactly today's behaviour. Every
-- existing run is null, so this column changes no price until somebody picks
-- a supplier on a side. That is the property that makes it safe to apply
-- before the app that writes it has shipped.
--
-- PRODUCT LINE IS NOT HERE, deliberately. He asked for supplier AND line, and
-- there is no line column anywhere: "Melrose" and "Clearwater" live inside
-- the item NAME, and parsing a name to make a pricing decision is how a
-- rename becomes a wrong quote. In this catalog the two are one-to-one today
-- -- Flori sells Melrose, Hartford sells Clearwater -- so pinning the
-- supplier gives the same control. A real line column, filled in the catalog
-- rather than guessed from text, is the right answer the day one supplier
-- carries two lines.
--
-- Idempotent. Safe to re-run.

alter table public.fence_runs
    add column if not exists preferred_manufacturer_sync_id uuid;

comment on column public.fence_runs.preferred_manufacturer_sync_id is
  'The supplier this side is built from, winning over jobs.preferred_manufacturer_sync_id. NULL means no preference, which is the behaviour every run had before this column: the engine picks the best fitting priced row whoever supplies it.';

-- NO FOREIGN KEY, on purpose, and the reason is the same one the join columns
-- follow. A phone drawing in a yard with no signal can name a supplier whose
-- row has not reached the cloud yet; a foreign key would refuse that write at
-- the moment it is least recoverable. The engines already treat an id they
-- cannot resolve as "no preference", which is the same answer as null.

-- The column is covered by the table's existing policies -- it is a column of
-- fence_runs, not a new table -- so nothing new is granted here. Stated
-- because a reader checking "who can write this" should not have to go
-- looking for a policy that does not exist.
--
-- COLUMN-LEVEL GRANTS ARE THE TRAP HERE, not policies. companies carries
-- per-column SELECT for authenticated, and a column added there is ungranted
-- and invisible until someone notices. fence_runs does not: it is granted at
-- table level, which the self-check below proves rather than assumes.

do $$
declare
    n integer;
begin
    -- Positive control: a column that does not exist must not be found, or
    -- the checks below prove nothing.
    select count(*) into n from information_schema.columns
     where table_schema = 'public' and table_name = 'fence_runs'
       and column_name = 'preferred_manufacturer_sync_id_nope';
    assert n = 0, 'the control found a column that does not exist';

    select count(*) into n from information_schema.columns
     where table_schema = 'public' and table_name = 'fence_runs'
       and column_name = 'preferred_manufacturer_sync_id';
    assert n = 1, 'the column was not created';

    -- Every existing run must be null, which is what makes this inert.
    select count(*) into n from public.fence_runs
     where preferred_manufacturer_sync_id is not null;
    assert n = 0, format('%s runs already name a supplier; this should be a new column', n);

    -- Table-level grant, not per-column: if fence_runs had per-column grants
    -- the new column would be unreadable and every side would quietly lose
    -- its supplier. This is the failure that took company email down once.
    select count(*) into n from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'fence_runs'
       and grantee = 'authenticated' and privilege_type = 'SELECT'
       and column_name = 'preferred_manufacturer_sync_id';
    assert n >= 1, 'authenticated cannot SELECT the new column -- fence_runs has per-column grants after all';

    raise notice 'r37 run supplier: column present, every run null, readable by authenticated';
end;
$$;
