-- AN EXPENSE AMOUNT WAS THE ONE MONEY FIGURE WITH NOTHING HOLDING IT.
--
-- Found by sweeping every write policy in the schema for the shape that
-- produced two real holes yesterday: scoped by company, with no authority
-- check of any kind. Twelve tables matched, and eleven turned out to be fine --
-- their money columns are held by a trigger rather than by the policy:
--
--   jobs                  00_protect_job_money
--   estimate_line_items   00_hold_line_item_prices, 00_stamp_line_item_price
--   change_orders         00_hold_change_order_costs, 00_zero_change_order_costs
--   material_items        00_hold_material_price
--
-- expenses had only enforce_delete_permission. So the amount could be written
-- or overwritten by any signed-in member of the company. Reading them is now
-- gated on SEE_MONEY, which makes this a blind write rather than a useful
-- one -- but blind or not, it changes what a job cost, and it is the only
-- money figure in the schema left uncovered. Delivery and misc job costs now
-- live in this table, so it holds real money for the first time.
--
-- Same shape as its neighbours, deliberately: check the permission, not the
-- role, and only on the column that carries the money. Recording an expense
-- is still open to anyone the office lets record one -- what needs the
-- permission is deciding what a job cost.
--
-- Not SECURITY DEFINER. Inside a definer function current_user is the owner
-- rather than the caller, which silently disabled a guard written yesterday:
-- it looked installed and waved every write through.
--
-- To undo:  drop trigger if exists expense_amount_needs_permission on expenses;

create or replace function public.guard_expense_amount()
returns trigger language plpgsql set search_path to 'public' as $fn$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.amount is not distinct from old.amount then
    return new;
  end if;
  if has_permission('SEE_MONEY') then
    return new;
  end if;
  raise exception 'Setting what a job cost needs SEE_MONEY.'
    using errcode = '42501';
end;
$fn$;

drop trigger if exists expense_amount_needs_permission on expenses;
create trigger expense_amount_needs_permission
  before insert or update on expenses
  for each row execute function public.guard_expense_amount();

select 'expense amounts now need SEE_MONEY' as done;
