-- EXPENSES ARE MONEY, AND THE DATABASE DID NOT KNOW IT.
--
-- The crew money lockdown of 11 September closed four tables to anyone without
-- SEE_MONEY: jobs, estimate_line_items, material_items and change_orders. It
-- did not cover expenses. Read straight from pg_policy, expenses_read is
--
--     (company_id = current_company_id())
--
-- and nothing else, so every signed-in member of a company -- crew and foremen
-- included -- can read every expense and its amount with any HTTP client.
--
-- It has not leaked anything yet for one reason only: the expenses table is
-- empty. Every row of it, system-wide, is zero today. That is luck, not a
-- control, and it is about to stop being true -- delivery and misc job costs
-- are now recorded as expense rows, which is the first real money this table
-- will ever hold. Closing it before it fills is the whole point; closing it
-- afterwards would mean it was readable for a while.
--
-- Worth being explicit about what was NOT proof: a foreman account was
-- impersonated and read zero expenses. That zero came from an empty table, not
-- from a policy, and reading it as a pass would have been exactly the mistake
-- this project keeps making. The evidence here is the policy text itself.
--
-- Nothing in the app depends on this access. EntitySync only stores expense
-- rows when the money scope came back ALLOWED, so a crew build never uses them
-- and none can break. That is why this needs no staged rollout, unlike the
-- four tables above, which older builds read directly.
--
-- RESTRICTIVE is ANDed with the permissive policies, so it can only ever take
-- access away, and it is on SELECT only: writing an expense is already gated
-- elsewhere and is not what this is about.
--
-- To undo:  drop policy expenses_money_hidden_from_crew on expenses;

drop policy if exists expenses_money_hidden_from_crew on expenses;

create policy expenses_money_hidden_from_crew
  on expenses
  as restrictive
  for select
  using (has_permission('SEE_MONEY'));

select 'expenses closed to anyone without SEE_MONEY' as done;
