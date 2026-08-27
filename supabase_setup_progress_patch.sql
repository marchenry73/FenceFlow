-- What a company still has to set up before it can quote a job properly.
--
-- Two of the three companies on this database have no labour rate, no markup,
-- no minimum charge and an empty catalog -- and nothing anywhere stops them
-- quoting in that state. A contractor who does that sends a customer a number
-- built on zeroes, wins the job, and finds out at the end. The product cannot
-- let that be a quiet default.
--
-- One function, so the website and the phone say the same thing. The whole
-- reason the paid figure and the reports drifted apart was two places working
-- the same question out differently.
--
-- "Done" is deliberately generous where zero is a real answer: a company with
-- no sales tax and no markup has genuinely set those. It is strict where zero
-- is certainly wrong -- nobody charges nothing per foot, and nobody's minimum
-- job is zero.
create or replace function public.my_setup_progress()
returns table(
    step        text,
    label       text,
    detail      text,
    done        boolean,
    essential   boolean,
    where_to_go text
)
language sql stable security definer set search_path to 'public'
as $$
with me as (
    select c.id, c.subscription_plan
      from companies c
     where c.id = (select company_id from profiles where id = auth.uid())
),
s as (
    select cs.settings from company_settings cs, me where cs.company_id = me.id
),
num as (
    -- A jsonb value that is not a number must not blow the whole function up,
    -- so anything unparseable reads as unset rather than raising.
    select
      (select case when (select settings->>'labor_rate' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'labor_rate' from s))::numeric end)     as labour,
      (select case when (select settings->>'markup' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'markup' from s))::numeric end)         as markup,
      (select case when (select settings->>'tax_rate' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'tax_rate' from s))::numeric end)       as tax,
      (select case when (select settings->>'min_job_charge' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'min_job_charge' from s))::numeric end) as min_charge
),
counts as (
    select
      (select count(*) from material_items m, me where m.company_id = me.id and m.deleted_at is null) as catalog,
      (select count(*) from pricing_tiers t, me  where t.company_id = me.id and t.deleted_at is null) as tiers,
      (select count(*) from employees e, me      where e.company_id = me.id and e.deleted_at is null) as crew
)
select * from (values
  ('labour_rate', 'What you charge for labour',
   'Your rate per foot of fence. Every quote is built on it, so a job priced without one is priced at nothing.',
   (select labour from num) is not null and (select labour from num) > 0,
   true, 'settings'),

  ('markup', 'Your markup',
   'The margin added to materials and labour. Zero is a real answer if that is how you price -- it just has to be a decision rather than a blank.',
   (select markup from num) is not null,
   true, 'settings'),

  ('min_charge', 'Your minimum job charge',
   'The least you will do any job for, however small. Without it a gate-only job can quote for almost nothing.',
   (select min_charge from num) is not null and (select min_charge from num) > 0,
   true, 'settings'),

  ('tax_rate', 'Your sales tax rate',
   'Set it to zero if you do not charge tax -- but set it, so the number on the quote is the number the customer pays.',
   (select tax from num) is not null,
   true, 'settings'),

  ('catalog', 'Your supplier prices',
   'What you actually pay for panels, posts, rails and concrete. Add them in the phone app under Catalog and they appear here within a minute.',
   (select catalog from counts) > 0,
   -- Strongly wanted, but NOT a blocker, because it cannot be satisfied from
   -- this website: the catalog is entered on the phone. Blocking on it left an
   -- owner who works at a desk unable to create a job at all, with a checklist
   -- item they had no way to tick. The blockers are the four numbers a quote is
   -- arithmetic on, and those are all on the Settings page in front of them.
   false, 'catalog'),

  ('tiers', 'Your pricing tiers',
   'Different rates for different kinds of work -- a repair, a full install, a commercial job. Not required, but it is how you stop quoting everything the same way.',
   (select tiers from counts) > 0,
   false, 'catalog'),

  ('crew', 'Your crew',
   'The people who work for you, so hours and job assignments have a name on them.',
   -- On Solo the owner IS the crew, so there is nothing to add and nagging
   -- about it would be wrong.
   (select lower(coalesce(subscription_plan,'')) from me) = 'solo'
     or (select crew from counts) > 0,
   false, 'crew')
) as t(step, label, detail, done, essential, where_to_go);
$$;
revoke execute on function public.my_setup_progress() from public, anon;
grant  execute on function public.my_setup_progress() to authenticated;
