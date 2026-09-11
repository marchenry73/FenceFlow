-- Setup checklist gains 'business' and 'build': the two Setup Wizard steps
-- that had NO row in my_setup_progress() at all.
--
-- Why this matters: the Setup Wizard's Business and "Your standard build"
-- steps save on Next even when left blank (swSaveBusiness/swSaveBuild never
-- refuse an empty payload -- same as every other step, nothing here is
-- validated client-side). Skipping past them by clicking Next with nothing
-- typed produced NO trace anywhere: the wizard rail marked the step "done"
-- just for having been visited, and the dashboard checklist never mentioned
-- either one again. That is a step vanishing when skipped, which the office
-- launch review called out by name -- a real skip has to stay visible as
-- outstanding until the thing is actually there.
--
-- Neither is essential. Neither can affect what a customer is charged --
-- business_name/owner_name/phone/email/license are display-only fields
-- printed on a quote, and a default build template is a convenience picker
-- default for the New Client wizard's "Your standard build" step, not a
-- price input; price still comes from the tier/catalog/settings the job
-- itself carries. So both go in as essential:false, exactly like catalog,
-- tiers, card_payments and crew -- dismissible reminders, never a gate.
--
-- Additive only: same function, two more rows in the VALUES list, every
-- other row copied unchanged from supabase_setup_step_card_payments.sql
-- (the live definition). If anything looks wrong, check first that the
-- other six rows and their essential flags are untouched.

CREATE OR REPLACE FUNCTION public.my_setup_progress()
 RETURNS TABLE(step text, label text, detail text, done boolean, essential boolean, where_to_go text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      (select count(*) from employees e, me      where e.company_id = me.id and e.deleted_at is null) as crew,
      (select count(*) from build_templates b, me
        where b.company_id = me.id and b.deleted_at is null and b.is_default) as own_default_template
)
select * from (values
  ('business', 'Your business details',
   'Business name, so it is on the quote instead of blank. Phone, email and licence number too if you use them.',
   coalesce(trim((select settings->>'business_name' from s)), '') <> '',
   false, 'settings'),

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

  ('build', 'Your standard build',
   'A default fence spec (height, panel width, post spacing, bags of concrete) so the New Client wizard starts from your usual job instead of a blank one every time.',
   (select own_default_template from counts) > 0,
   false, 'settings'),

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

  ('card_payments', 'Taking card payments',
   'Connect Stripe or Square and the app can ask a customer for a deposit by card. Without it the app tells you to take the payment another way rather than taking one nobody can record.',
   -- The SAME test my_payment_connection() already uses, deliberately, so the
   -- checklist and the Settings panel can never disagree about whether the
   -- account is connected. A processor chosen but never finished is exactly the
   -- state this catches, and it is the state both live companies are in today.
   --
   -- NOT a test on access_token. Stripe Connect clears that on purpose -- the
   -- platform key acts on the connected account, so there is no token of
   -- theirs to keep -- and checking it would have told every properly
   -- connected Stripe user that they were not connected, for ever.
   exists (select 1 from payment_connections pc, me
            where pc.company_id = me.id
              and coalesce(pc.processor, 'none') <> 'none'
              and coalesce(pc.external_id, '') <> ''),
   -- Not a blocker. Plenty of fencing work is paid by cheque or bank transfer,
   -- and refusing to let somebody quote until they have a card processor would
   -- be inventing a requirement the business does not have.
   false, 'settings'),

  ('crew', 'Your crew',
   'The people who work for you, so hours and job assignments have a name on them.',
   -- On Solo the owner IS the crew, so there is nothing to add and nagging
   -- about it would be wrong.
   (select lower(coalesce(subscription_plan,'')) from me) = 'solo'
     or (select crew from counts) > 0,
   false, 'crew')
) as t(step, label, detail, done, essential, where_to_go);
$function$;
