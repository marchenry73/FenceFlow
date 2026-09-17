/* Pure per-foot pay/footage maths, moved out of website/dashboard.html as the
   first slice of the split described in docs/OFFICE_SPLIT_PLAN.md.

   No DOM, no Supabase, no globals -- everything here takes its inputs as
   plain arguments, same as it did inline. Moved verbatim; no logic changed.

   Covered by tests/per-foot-pay.test.mjs, tests/downstream-pay-overtime.test.mjs
   and tests/catalog-run-viewer.test.mjs, each of which now reads this file in
   addition to dashboard.html when it lifts a function by name -- see the
   `grab()` helper in each of those files. */

/** FenceCodec.decodePoints, reproduced: "x:y,x:y,..." -> [{x,y}], dropping any
    pair that fails to parse rather than throwing. Pure. */
export function decodeRunPoints(raw){
  if(!raw) return [];
  return raw.split(',').map(pair=>{
    const parts = pair.split(':');
    if(parts.length!==2) return null;
    const x=parseFloat(parts[0]), y=parseFloat(parts[1]);
    if(Number.isNaN(x)||Number.isNaN(y)) return null;
    return {x,y};
  }).filter(Boolean);
}

/** FenceGeometryEngine.pixelLength/analyze's own distance sum, divided by
    the calibration in effect -- 20 px/ft unless the job carries its own
    calibration_pixels_per_foot. Pure. */
export function runLengthFt(points, closedLoop, pxPerFoot){
  const pts = points||[];
  if(pts.length<2 || !pxPerFoot) return 0;
  const list = closedLoop ? pts.concat([pts[0]]) : pts;
  let total=0;
  for(let i=1;i<list.length;i++) total += Math.hypot(list[i].x-list[i-1].x, list[i].y-list[i-1].y);
  return total/pxPerFoot;
}

/* A PER_FOOT crew member earns the job's built footage, split evenly among
   the PER_FOOT people who worked it, times their own $/ft. Mirrors
   CrewPay.kt (perFootShareFeet / perFootPay) and the server's
   per_foot_crew_count(); tests/per-foot-pay.test.mjs lifts these.

   Only a COMPLETED job pays. ACCEPTED means sold, not built -- its footage
   still moves with change orders and field corrections, so paying on it
   would pay for fence that may never go in.

   "Who worked it" is who has a finished, non-rejected shift on the job; a job
   nobody clocked on falls back to its assigned crew member. Built footage is
   the typed length when there is one, else the drawing -- the same order
   CrewPay.builtFeet uses. All pure. */
export function runBuiltFeet(r, pxPerFoot){
  const manual = Number(r.manual_linear_feet || 0);
  if (manual > 0) return manual;
  const pts = decodeRunPoints(r.points_encoded);
  return pts.length > 1 ? runLengthFt(pts, !!r.closed_loop, pxPerFoot) : 0;
}
export function jobBuiltFeet(job, allRuns){
  const px = Number(job.calibration_pixels_per_foot) || 20;
  return (allRuns || []).filter(r => r.job_sync_id === job.sync_id && !r.deleted_at)
    .reduce((s, r) => s + runBuiltFeet(r, px), 0);
}
export function shiftCountsForPay(t){
  return !!t.ended_at && !t.deleted_at && !(t.rejected_at && !t.approved_at);
}
export function perFootShareFeet(jobFeet, workers){
  if (!(jobFeet > 0)) return 0;
  return jobFeet / Math.max(1, Math.floor(Number(workers) || 0));
}
export function perFootPayForJob(jobFeet, workers, rate, completed){
  if (!completed || !(Number(rate) > 0)) return 0;
  return perFootShareFeet(jobFeet, workers) * Number(rate);
}
/** One credit per PER_FOOT worker per COMPLETED job: their share and pay,
    dated by their own last shift on it (else the job's last update). */
export function perFootCredits(jobsIn, shifts, emps, allRuns){
  const out = [];
  (jobsIn || []).forEach(j => {
    if (j.status !== 'COMPLETED' || j.deleted_at) return;
    const mine = (shifts || []).filter(t => t.job_sync_id === j.sync_id && t.employee_sync_id && shiftCountsForPay(t));
    let crew = [...new Set(mine.map(t => t.employee_sync_id))];
    if (!crew.length && j.assigned_employee_sync_id) crew = [j.assigned_employee_sync_id];
    const pf = crew.map(sid => (emps || []).find(e => e.sync_id === sid))
      .filter(e => e && e.pay_type === 'PER_FOOT');
    if (!pf.length) return;
    const feet = jobBuiltFeet(j, allRuns);
    pf.forEach(e => {
      const ends = mine.filter(t => t.employee_sync_id === e.sync_id).map(t => t.ended_at).sort();
      const rate = Number(e.per_foot_rate || 0);
      out.push({
        empSyncId: e.sync_id, who: e.name || 'Unknown', jobSyncId: j.sync_id,
        jobFeet: feet, workers: pf.length, share: perFootShareFeet(feet, pf.length),
        rate, pay: perFootPayForJob(feet, pf.length, rate, true),
        finishedAt: ends.length ? ends[ends.length - 1] : (j.updated_at || null)
      });
    });
  });
  return out;
}
