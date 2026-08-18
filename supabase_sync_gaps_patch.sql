-- Columns for fields the app has always had but never synced.
--
-- Purely additive: every statement is ADD COLUMN IF NOT EXISTS with a default
-- that matches the app's own default for that field. No existing row changes
-- value, nothing is dropped, and running it twice is harmless.
--
-- Why it matters most for fence_runs: the app stored a run's entire
-- specification -- panel style, picket width and gap, rail count, whether there
-- is a top rail or tension wire -- and pushed none of it. So a run drawn on the
-- owner's phone arrived on the crew's phone carrying only its outline and the
-- default spec for its fence type. Two phones could compute different material
-- takeoffs from what is supposedly the same run, and the difference shows up as
-- a short order at the supply house.

alter table public.fence_runs
  add column if not exists sort_order              integer not null default 0,
  add column if not exists aluminum_style          text    not null default 'RACKABLE',
  add column if not exists wood_style              text    not null default 'PRIVACY',
  add column if not exists wood_rail_count         integer not null default 3,
  add column if not exists picket_width_in         real    not null default 5.5,
  add column if not exists picket_gap_in           real    not null default 0,
  add column if not exists fabric_height_ft        real    not null default 4,
  add column if not exists include_top_rail        boolean not null default true,
  add column if not exists include_tension_wire    boolean not null default false,
  add column if not exists include_barbed_wire_arms boolean not null default false,
  add column if not exists include_privacy_slats   boolean not null default false,
  add column if not exists split_rail_count        integer not null default 2;

-- Pay arrangement. Without these, a crew member paid by the foot arrived on
-- another device as hourly at whatever their hourly field happened to hold,
-- which is a payroll figure being quietly changed by a sync.
alter table public.employees
  add column if not exists pay_type      text             not null default 'HOURLY',
  add column if not exists per_foot_rate double precision not null default 0;

-- What the supplier charges, as opposed to what the customer is quoted. The
-- whole point of the supplier-price workflow, and it was local-only.
-- Nullable on purpose: null means "not quoted separately", which is different
-- from "quoted at zero".
alter table public.estimate_line_items
  add column if not exists supplier_unit_price double precision;
