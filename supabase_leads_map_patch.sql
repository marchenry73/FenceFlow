-- Online lead capture (Jobber's booking form, fence-flavoured) and job
-- geocoding for the dashboard map view.
alter table public.companies
  add column if not exists leads_token uuid not null default gen_random_uuid();
comment on column public.companies.leads_token is
  'Public key for this company''s get-a-quote page. Rotating it kills old links.';
create index if not exists companies_leads_token_idx on public.companies (leads_token);

alter table public.jobs
  add column if not exists site_lat double precision,
  add column if not exists site_lon double precision;
comment on column public.jobs.site_lat is
  'Geocoded once from the address, so the map view does not re-geocode every load.';
