select
  r.sync_id, r.label, r.is_teardown, r.closed_loop,
  r.manual_linear_feet, r.post_spacing_ft, r.panel_width_ft,
  r.picket_width_in, r.picket_gap_in, r.fence_type,
  r.points_encoded, r.gates_encoded,
  j.customer_name, j.status as job_status, j.signed_at,
  j.calibration_pixels_per_foot, j.grid_extent_ft, j.survey_storage_path
from public.fence_runs r
join public.jobs j on j.sync_id = r.job_sync_id
where r.deleted_at is null and j.deleted_at is null
order by j.customer_name, r.sort_order;
