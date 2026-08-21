-- Why it ran late, separated from why it is stuck.
--
-- One field carried both, so typing "hit rock, lost a day" as an overrun
-- reason started the tell-the-customer blocked flow about nothing. Additive
-- and defaulted; old app versions simply never write it.
alter table public.jobs add column if not exists overrun_reason text not null default '';
select 'overrun_reason added' as done;
