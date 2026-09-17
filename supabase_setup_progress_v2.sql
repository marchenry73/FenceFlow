-- Setup checklist v2: extends the 10-step my_setup_progress() to the order
-- the owner actually walks a new company through, and makes the catalog step
-- essential now that new companies start with an EMPTY catalog (the seeded
-- starter catalog is no longer created for them -- see CATALOG_SEED /
-- catalogSeedRowsToAdd in dashboard.html, which now exists purely as an
-- opt-in "start from FenceFlow's catalog" action, not something that runs on
-- signup). A company that never visits Catalog on the phone can otherwise
-- quote every job at whatever the missing material price defaults to, which
-- is exactly the silent-zero failure mode supabase_setup_progress_patch.sql
-- already fixed for labour_rate/markup/min_charge/tax_rate.
--
-- Same return signature as the live function (step, label, detail, done,
-- essential, where_to_go) -- CREATE OR REPLACE, no shape change, so the
-- office's existing rendering code (renderSetup/swDoneHtml, now going through
-- setupText() for i18n) does not need to branch on two shapes.
--
-- New steps, verified against the live database before being added here
-- (npx supabase db query --linked --project-ref newcrgafcptspmapacrx):
--   * manufacturers   -- table exists, already loaded by the office
--                        (dashboard.html loadAll()/q('manufacturers')) and by
--                        the phone. Optional: a quote's price comes from
--                        material_items regardless of whether a manufacturer
--                        is attached, so this cannot make a quote wrong.
--   * gate_rate       -- company_settings.settings->>'gate_rate' is a real
--                        key already written by at least one live company
--                        (confirmed via jsonb_object_keys(settings)). A job
--                        with a gate on it prices the gate at nothing without
--                        it, the same failure shape as a missing labour rate,
--                        so this is ESSENTIAL.
--   * ready           -- a virtual final step, done only when every essential
--                        step above it is done. Not itself essential (it
--                        would be circular), and not dismissable as a
--                        reminder either, since a step that only reports on
--                        other steps has nothing of its own to dismiss.
--
-- Deliberately NOT added, because nothing in the schema can check them yet:
--   * branding (logo/colour)  -- no such columns on companies or
--                                company_settings.settings (checked live).
--   * roles beyond OWNER/crew -- employees.role and profiles.role are the
--                                only role data that exists; that is already
--                                what the 'crew' step below covers. There is
--                                no separate roles table or roles-configured
--                                flag to check.
--   * notifications           -- no notification_settings/notifications table
--                                in the schema. FenceFlow's notifications (if
--                                any) are not backed by a company-scoped
--                                settings row this function could query.
-- If any of these gain real, queryable data later, add them the same way:
-- verify live first, then a new row here.

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
                   then ((select settings->>'min_job_charge' from s))::numeric end) as min_charge,
      (select case when (select settings->>'gate_rate' from s) ~ '^-?[0-9]+([.][0-9]+)?$'
                   then ((select settings->>'gate_rate' from s))::numeric end)      as gate_rate
),
counts as (
    select
      (select count(*) from material_items m, me where m.company_id = me.id and m.deleted_at is null) as catalog,
      (select count(*) from pricing_tiers t, me  where t.company_id = me.id and t.deleted_at is null) as tiers,
      (select count(*) from employees e, me      where e.company_id = me.id and e.deleted_at is null) as crew,
      (select count(*) from manufacturers f, me  where f.company_id = me.id and f.deleted_at is null) as manufacturers,
      (select count(*) from build_templates b, me
        where b.company_id = me.id and b.deleted_at is null and b.is_default) as own_default_template
),
essentials as (
    -- Every essential row's own `done` expression, repeated here (not
    -- selected from the rows below -- Postgres can't self-reference a VALUES
    -- list it's building) so the final "ready" step can require all of them.
    select
      ((select labour from num) is not null and (select labour from num) > 0)     as labour_ok,
      ((select markup from num) is not null)                                       as markup_ok,
      ((select min_charge from num) is not null and (select min_charge from num) > 0) as min_charge_ok,
      ((select tax from num) is not null)                                          as tax_ok,
      ((select gate_rate from num) is not null and (select gate_rate from num) > 0) as gate_rate_ok,
      ((select catalog from counts) > 0)                                           as catalog_ok
)
select * from (values
  ('business', 'Your business details',
   'Business name, so it is on the quote instead of blank. Phone, email and licence number too if you use them.',
   coalesce(trim((select settings->>'business_name' from s)), '') <> '',
   false, 'settings'),

  ('manufacturers', 'Your suppliers',
   'The manufacturers and suppliers you buy from. Add them in the phone app under Catalog so materials can be tied to who you order them from.',
   (select manufacturers from counts) > 0,
   -- Cannot break a quote by being unset -- pricing comes from material_items
   -- regardless -- and, like catalog, cannot be satisfied from this website.
   false, 'catalog'),

  ('catalog', 'Your supplier prices',
   'What you actually pay for panels, posts, rails and concrete. A quote with no catalog prices in it cannot be trusted -- add items in the phone app under Catalog and they appear here within a minute.',
   (select catalog_ok from essentials),
   -- ESSENTIAL as of v2: new companies no longer get a seeded starter
   -- catalog (see comment above), so an empty catalog is now a real,
   -- reachable state for a brand new company rather than something that only
   -- happened to two pre-existing test companies. Still points at 'catalog'
   -- (this website cannot add catalog rows itself), same as before.
   true, 'catalog'),

  ('labour_rate', 'What you charge for labour',
   'Your rate per foot of fence. Every quote is built on it, so a job priced without one is priced at nothing.',
   (select labour_ok from essentials),
   true, 'settings'),

  ('markup', 'Your markup',
   'The margin added to materials and labour. Zero is a real answer if that is how you price -- it just has to be a decision rather than a blank.',
   (select markup_ok from essentials),
   true, 'settings'),

  ('tiers', 'Your pricing tiers',
   'Different rates for different kinds of work -- a repair, a full install, a commercial job. Not required, but it is how you stop quoting everything the same way.',
   (select tiers from counts) > 0,
   false, 'catalog'),

  ('build', 'Your standard build',
   'A default fence spec (height, panel width, post spacing, bags of concrete) so the New Client wizard starts from your usual job instead of a blank one every time.',
   (select own_default_template from counts) > 0,
   false, 'settings'),

  ('gate_rate', 'Your gate pricing',
   'What you charge to add a gate. Without it a job with a gate on it prices the gate at nothing, same as a missing labour rate.',
   (select gate_rate_ok from essentials),
   true, 'settings'),

  ('tax_rate', 'Your sales tax rate',
   'Set it to zero if you do not charge tax -- but set it, so the number on the quote is the number the customer pays.',
   (select tax_ok from essentials),
   true, 'settings'),

  ('min_charge', 'Your minimum job charge',
   'The least you will do any job for, however small. Without it a gate-only job can quote for almost nothing.',
   (select min_charge_ok from essentials),
   true, 'settings'),

  ('card_payments', 'Taking card payments',
   'Connect Stripe or Square and the app can ask a customer for a deposit by card. Without it the app tells you to take the payment another way rather than taking one nobody can record.',
   -- The SAME test my_payment_connection() already uses, deliberately, so the
   -- checklist and the Settings panel can never disagree about whether the
   -- account is connected. Not a test on access_token: Stripe Connect clears
   -- that on purpose, since the platform key acts on the connected account.
   exists (select 1 from payment_connections pc, me
            where pc.company_id = me.id
              and coalesce(pc.processor, 'none') <> 'none'
              and coalesce(pc.external_id, '') <> ''),
   false, 'settings'),

  ('crew', 'Your crew',
   'The people who work for you, so hours and job assignments have a name on them.',
   -- On Solo the owner IS the crew, so there is nothing to add and nagging
   -- about it would be wrong.
   (select lower(coalesce(subscription_plan,'')) from me) = 'solo'
     or (select crew from counts) > 0,
   false, 'crew'),

  ('ready', 'Ready for your first job',
   'Every essential step above is done. You can quote a real job with confidence in the number.',
   (select labour_ok and markup_ok and min_charge_ok and tax_ok and gate_rate_ok and catalog_ok from essentials),
   false, 'settings')
) as t(step, label, detail, done, essential, where_to_go);
$$;
revoke execute on function public.my_setup_progress() from public, anon;
grant  execute on function public.my_setup_progress() to authenticated;
