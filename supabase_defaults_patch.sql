-- ============================================================
-- FenceFlow -- make NOT NULL columns self-defending
-- Run in: SQL Editor -> New query -> Run  (safe to re-run)
--
-- The app was dropping fields that happened to equal their default value,
-- so Postgres received NULL and rejected the whole batch:
--   null value in column "unit" of relation "material_items"
--
-- The app-side cause is fixed, but adding column defaults means a single
-- missing field can never again block an entire sync.
-- ============================================================

alter table material_items      alter column unit            set default 'EA';
alter table material_items      alter column category        set default 'MISC';
alter table material_items      alter column role            set default 'NONE';
alter table material_items      alter column fence_type      set default 'UNIVERSAL';
alter table material_items      alter column color_or_finish set default '';
alter table material_items      alter column name            set default '';
alter table material_items      alter column source_doc      set default '';
alter table material_items      alter column unit_price      set default 0;
alter table material_items      alter column taxable         set default true;
alter table material_items      alter column is_active       set default true;

alter table estimate_line_items alter column unit        set default 'EA';
alter table estimate_line_items alter column description set default '';
alter table estimate_line_items alter column quantity    set default 0;
alter table estimate_line_items alter column unit_price  set default 0;
alter table estimate_line_items alter column taxable     set default true;
alter table estimate_line_items alter column sort_order  set default 0;

alter table fence_runs   alter column label                  set default '';
alter table fence_runs   alter column fence_type             set default 'VINYL';
alter table fence_runs   alter column color_or_finish        set default '';
alter table fence_runs   alter column points_encoded         set default '';
alter table fence_runs   alter column gates_encoded          set default '';
alter table fence_runs   alter column closed_loop            set default false;
alter table fence_runs   alter column panel_width_ft         set default 6;
alter table fence_runs   alter column panel_height_ft        set default 6;
alter table fence_runs   alter column post_spacing_ft        set default 6;
alter table fence_runs   alter column concrete_bags_per_post set default 1;

alter table employees    alter column name        set default '';
alter table employees    alter column role        set default '';
alter table employees    alter column phone       set default '';
alter table employees    alter column email       set default '';
alter table employees    alter column notes       set default '';
alter table employees    alter column hourly_rate set default 0;

alter table manufacturers alter column name    set default '';
alter table manufacturers alter column email   set default '';
alter table manufacturers alter column phone   set default '';
alter table manufacturers alter column address set default '';
alter table manufacturers alter column hours   set default '';
alter table manufacturers alter column notes   set default '';

alter table pricing_tiers alter column name              set default '';
alter table pricing_tiers alter column labor_rate_per_ft set default 0;
alter table pricing_tiers alter column labor_flat_fee    set default 0;
alter table pricing_tiers alter column markup_percent    set default 0;
alter table pricing_tiers alter column discount_percent  set default 0;
alter table pricing_tiers alter column sort_order        set default 0;

alter table expenses         alter column category    set default 'OTHER';
alter table expenses         alter column description set default '';
alter table expenses         alter column amount      set default 0;

alter table punch_list_items alter column description set default '';
alter table punch_list_items alter column resolved    set default false;

alter table change_orders alter column description     set default '';
alter table change_orders alter column additional_feet set default 0;
alter table change_orders alter column additional_cost set default 0;

alter table job_steps alter column kind                   set default 'INSTALL';
alter table job_steps alter column description            set default '';
alter table job_steps alter column checked                set default false;
alter table job_steps alter column verified_with_customer set default false;
alter table job_steps alter column sort_order             set default 0;

alter table site_markers alter column kind  set default 'OBSTACLE';
alter table site_markers alter column x     set default 0;
alter table site_markers alter column y     set default 0;
alter table site_markers alter column label set default '';

alter table time_entries alter column hourly_rate set default 0;
alter table time_entries alter column notes       set default '';

-- Crews are paid hourly or per linear foot; the app writes this per person.
alter table employees add column if not exists pay_type text not null default 'HOURLY';
alter table employees add column if not exists per_foot_rate double precision not null default 0;
