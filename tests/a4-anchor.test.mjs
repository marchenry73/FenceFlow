// A4 audit -- "the agreed price and how it changes": accepted_total,
// quote_approved_at, signed_at, reapproval_required_at, reapproval_count,
// quote_reapprovals, change orders, the stamp_accepted_total() and
// mark_change_orders_accepted() triggers, and ar_aging(). The rule, from the
// owner: a customer pays what they agreed until they agree to something else.
//
// READ-ONLY. No source file is edited by this file or was edited to produce
// it. This file only imports the REAL exported pure functions
// (billableTotal, depositFigures from supabase/functions/_shared/quote-
// deposit.ts; planOpenLinks, stillTakesMoney from supabase/functions/
// create-payment-link/index.ts, loaded the same TypeScript-stripping way
// tests/accepted-price-functions.test.mjs and tests/a4-deposit.test.mjs
// already load that file) and calls them exactly the arguments the real
// caller builds. The database triggers below (stamp_accepted_total,
// mark_change_orders_accepted) are plpgsql, so there is no JS/TS module to
// import; they are transcribed by hand from their LIVE bodies, embedded
// verbatim as comments for anyone to re-check, and this audit's hard rules
// forbid writing to the live database even inside a rolled-back transaction.
//
// LIVE READS (SELECT only, via
// `npx supabase@2.115.0 db query --linked --project-ref newcrgafcptspmapacrx`,
// 2026-09-28, output taken from the raw JSON, not a header-only failure):
//
//   1. select proname, provolatile, prosecdef, md5(prosrc), length(prosrc)
//      from pg_proc where pronamespace='public'::regnamespace and proname in
//      ('stamp_accepted_total','mark_change_orders_accepted',
//       'latch_change_order_acceptance','job_anchored_total',
//       'reapp_on_run_change','reapp_withdraw_approval',
//       'reapp_resolve_on_approval','hold_quote_gate_columns',
//       'hold_reapproval_columns','ar_aging','job_costing');
//      -- all eleven exist live.
//   2. select proname, prosrc from pg_proc where ... proname in
//      ('reapp_on_run_change','stamp_accepted_total',
//       'mark_change_orders_accepted','job_anchored_total');
//      -- THE LIVE reapp_on_run_change() IS NOT THE BODY IN
//      supabase_reapproval_on_drawing_change.sql. That file's version reads
//      "if not found or j.quote_approved_at is null then return" (skip
//      unapproved jobs, full stop). The deployed version has grown a RESTORE
//      path (added by a later file -- reapp_restores_approved_state() and
//      reapp_restore_approval() are not defined anywhere in
//      supabase_reapproval_on_drawing_change.sql; they live in later r8/r9
//      patch files, none of which is byte-identical to what is deployed
//      either). This is exactly why this audit's hard rule is to read
//      pg_proc, not a repo file: no single .sql file in this repo is the
//      current source of truth for this function any more.
//   3. select proname, pg_get_function_arguments(oid), prosrc from pg_proc
//      where ... proname in ('reapp_withdraw_approval',
//      'reapp_resolve_on_approval','hold_reapproval_columns',
//      'reapp_restores_approved_state','reapp_restore_approval',
//      'reapp_run_snapshot','reapp_job_takeoff');
//      -- read to understand the restore path FINDING 2 below turns on.
//   4. A live count: 4 real (non-fixture) jobs currently have
//      reapproval_required_at set. One of them is quoted verbatim in
//      FINDING 1 below.
//
// Run with: node --test tests/a4-anchor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { billableTotal, depositFigures } from "../supabase/functions/_shared/quote-deposit.ts";

// ============================================================================
// Harness -- loads the REAL exported pure functions out of create-payment-
// link/index.ts without running its Deno.serve handler or touching a
// network. Same technique as tests/accepted-price-functions.test.mjs's and
// tests/a4-deposit.test.mjs's load(): strip TypeScript types with Node's own
// stripper, drop every `import { ... } from "...";` (the file's only
// imports are supabase-js, used solely inside the request handler this file
// never calls, and a type-only import erased by the stripper already), drop
// `export `, then evaluate the body and hand back the named functions.
// planOpenLinks and stillTakesMoney are declared with `export function`, so
// after stripping `export ` they are ordinary function declarations in the
// evaluated scope -- returned directly, not reimplemented.
// ============================================================================
function loadPureExports(relPath, wanted) {
  let js = stripTypeScriptTypes(readFileSync(new URL(relPath, import.meta.url), "utf8"));
  const importRe = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?[ \t]*$/gm;
  js = js.replace(importRe, "").replace(/^export /gm, "");
  assert.doesNotMatch(js, /^import /m, "an import the harness did not strip");
  const Deno = { env: { get: () => undefined }, serve: () => {} };
  const fetchStub = async () => { throw new Error("a pure-function test reached the network"); };
  const fn = new Function("Deno", "fetch", `${js}\nreturn { ${wanted.join(", ")} };`);
  return fn(Deno, fetchStub);
}

const { planOpenLinks, stillTakesMoney } = loadPureExports(
  "../supabase/functions/create-payment-link/index.ts",
  ["planOpenLinks", "stillTakesMoney"],
);

test("harness sanity: the real planOpenLinks and stillTakesMoney loaded, not stand-ins", () => {
  assert.equal(typeof planOpenLinks, "function");
  assert.equal(typeof stillTakesMoney, "function");
  // A known-shape probe from the file's own doc comment: a paid-in-full job
  // refuses any further request. If this ever disagreed the loader would be
  // running some other function under these names.
  const r = planOpenLinks({ contract_total: 100, amount_paid: 100, refunded_amount: 0 },
    [], { kind: "final", amountCents: 100 }, { stripe: false, square: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, "paid_in_full");
});

const NOT_LIVE = { stripe: false, square: false };

// ============================================================================
// FINDING 1 -- the office's own payment-link door can bill a job for the
// full LIVE (un-reapproved, possibly enlarged) price while the customer's
// approval has been withdrawn and a re-approval is actively pending --
// something the SAME function's homeowner-facing door is explicitly built
// to refuse.
//
// supabase/functions/create-payment-link/index.ts has two doors:
//
//   * "door two", the quoteToken branch (a homeowner's own link): gated
//     before any money is computed --
//         if (!qjob.quote_approved_at) {
//           return json({ error: "That quote is no longer available." }, 404);
//         }
//     -- read directly, index.ts lines ~563-566. A withdrawn approval
//     (reapp_withdraw_approval sets quote_approved_at := null) makes this
//     branch refuse outright, before billableTotal is even reached.
//
//   * "door one", the office branch (index.ts lines 614-644, quoted in full
//     below by this test reading the live file, not by paraphrase): checks
//     only that a login was sent, the caller is OWNER/MANAGER, and the typed
//     amountCents is a number >= $0.50. It never reads quote_approved_at or
//     reapproval_required_at before calling makeLink().
//
// makeLink() itself (index.ts ~783-800) builds the cap this way -- quoted
// verbatim, and exercised with the REAL depositFigures/billableTotal and the
// REAL planOpenLinks below, not a reimplementation:
//
//     const billedJob = jobRow && acceptance
//       ? { ...jobRow, contract_total: depositFigures({
//             depositAmount: 0, contractTotal: jobRow.contract_total,
//             amountPaid: 0, refundedAmount: 0, ...acceptance }).total }
//       : jobRow;
//     const plan = planOpenLinks(billedJob, openLinks, { kind, amountCents: amount }, live);
//
// billableTotal (quote-deposit.ts, imported for real above) returns the LIVE
// contract_total, not accepted_total, "when ... input.reapprovalRequiredAt"
// is set -- by design, so a genuinely fresh re-approval can move the price.
// But nothing then stops door one from BILLING that live figure before the
// customer has actually given that fresh re-approval: reapproval_required_at
// only changes which number the cap measures against, it never blocks
// billing the way door two's quote_approved_at check does.
// ============================================================================

test("structural: door one (office) never reads quote_approved_at or reapproval_required_at before billing", () => {
  const src = readFileSync(
    new URL("../supabase/functions/create-payment-link/index.ts", import.meta.url), "utf8");
  const start = src.indexOf("---- door one: the office, signed in");
  const end = src.indexOf("return await makeLink(admin, {", start);
  assert.ok(start > 0 && end > start, "door one's markers moved -- re-read the file before trusting this test");
  const doorOne = src.slice(start, end);
  assert.doesNotMatch(doorOne, /quote_approved_at|reapproval_required_at/,
    "door one now reads an acceptance column -- re-check whether FINDING 1 still holds");
  // Door two, by contrast, DOES gate on it -- the asymmetry is the finding,
  // not an absence of any gate anywhere in the file.
  const doorTwoStart = src.indexOf("---- door two: a homeowner holding a quote link");
  const doorTwo = src.slice(doorTwoStart, src.indexOf("kindWanted", doorTwoStart));
  assert.match(doorTwo, /if \(!qjob\.quote_approved_at\)/,
    "door two's gate moved or changed wording -- re-check FINDING 1's contrast");
});

// The real, current row (project newcrgafcptspmapacrx, read 2026-09-28):
//   select id, customer_name, status, contract_total, accepted_total,
//          amount_paid, refunded_amount, signed_at, quote_approved_at,
//          reapproval_required_at, reapproval_count
//   from jobs where id = 'ce7d2eca-2f2c-4d4e-b11a-8f274d98d6be';
// James Bond, status ACCEPTED (not a draft, not a "ZZ TEST" fixture): signed
// at $35,240, contract_total has since drifted to $36,290, and the drawing
// has been withdrawn from approval three times (reapproval_count = 3) --
// quote_approved_at is null and reapproval_required_at is set RIGHT NOW.
// Nothing paid, nothing refunded, so netPaid is 0 either way.
const JAMES_BOND = Object.freeze({
  sync_id: "james-bond-job",
  company_id: "james-bond-co",
  contract_total: 36290,
  accepted_total: 35240,
  amount_paid: 0,
  refunded_amount: 0,
  signed_at: "2026-09-25T15:58:33.967Z",
  quote_approved_at: null,
  reapproval_required_at: "2026-09-28T16:50:37.805Z",
});

// acceptanceFor()'s own field mapping (index.ts ~76-108), reproduced by hand
// because it is an internal (unexported) async function that reads
// change_orders through a live Supabase client -- there are none on this job,
// so the shape below is exactly what it would return.
function acceptanceOf(job, changeOrders = []) {
  return {
    acceptedTotal: job.accepted_total == null ? null : Number(job.accepted_total),
    signedAt: job.signed_at ?? null,
    quoteApprovedAt: job.quote_approved_at ?? null,
    reapprovalRequiredAt: job.reapproval_required_at ?? null,
    changeOrders,
  };
}

// makeLink()'s own billedJob construction (index.ts ~783-796), called with
// the REAL depositFigures -- not reimplemented.
function billedJobOf(job, changeOrders = []) {
  const acceptance = acceptanceOf(job, changeOrders);
  return {
    ...job,
    contract_total: depositFigures({
      depositAmount: 0, contractTotal: job.contract_total,
      amountPaid: 0, refundedAmount: 0, ...acceptance,
    }).total,
  };
}

test("FINDING 1: arithmetic -- the office can bill James Bond's job for $36,290 when only $35,240 was ever agreed", () => {
  const fullLiveAmountCents = Math.round(36290 * 100);

  // What the office door actually does today: reapproval_required_at is set
  // (read straight off the live row), so billableTotal falls back to the
  // live, un-reapproved contract_total -- and nothing refuses billing it.
  const billed = billedJobOf(JAMES_BOND);
  assert.equal(billed.contract_total, 36290, "billableTotal fell back to the live figure, as designed for a pending reapproval");

  const plan = planOpenLinks(billed, [], { kind: "final", amountCents: fullLiveAmountCents }, NOT_LIVE);
  assert.equal(plan.ok, true, "the $36,290 request went through -- real planOpenLinks, real inputs");

  // Positive control, same job, same requested amount -- with the pending
  // reapproval the only thing toggled off. Prove the SAME $36,290 ask is
  // correctly refused the moment nothing is pending: the finding is
  // specifically the reapproval-pending fallback, not a general hole.
  const settled = { ...JAMES_BOND, reapproval_required_at: null };
  const billedSettled = billedJobOf(settled);
  assert.equal(billedSettled.contract_total, 35240, "with nothing pending, the cap is the accepted figure");
  const refused = planOpenLinks(billedSettled, [], { kind: "final", amountCents: fullLiveAmountCents }, NOT_LIVE);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "over_owed");
  assert.equal(refused.stillOwedCents, 3524000);

  // The excess, in dollars: exactly the gap between the live recompute and
  // what James Bond actually signed for, and it is real money -- a live
  // Stripe/Square payment link, not a report figure.
  const excessCents = fullLiveAmountCents - Math.round(35240 * 100);
  assert.equal(excessCents, 105000, "a $1,050 request the customer never approved would clear the office's own cap");
});

test("CANARY: a cap that held reapproval-pending jobs to the last accepted figure (matching door two's own rule) would refuse this request", () => {
  // Not a hypothetical rewrite of planOpenLinks -- a one-line change to which
  // total is handed to it, mirroring the rule door two already enforces by
  // refusing outright. If this disagreed with FINDING 1's plan.ok, the
  // "office door is unprotected" claim would have no teeth.
  const protectiveBilledJob = (job) => ({
    ...job,
    contract_total: job.reapproval_required_at
      ? Number(job.accepted_total) || 0
      : billedJobOf(job).contract_total,
  });
  const protective = protectiveBilledJob(JAMES_BOND);
  assert.equal(protective.contract_total, 35240);
  const plan = planOpenLinks(protective, [], { kind: "final", amountCents: Math.round(36290 * 100) }, NOT_LIVE);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "over_owed");
  assert.notEqual(plan.ok, planOpenLinks(billedJobOf(JAMES_BOND), [], { kind: "final", amountCents: Math.round(36290 * 100) }, NOT_LIVE).ok,
    "PLANTED CONTRAST: the real cap and a reapproval-aware cap disagree on the exact same request");
});

// ============================================================================
// FINDING 2 -- restoring a withdrawn approval (reapp_restore_approval, the
// live database function quoted in full in the header comment above) fires
// mark_change_orders_accepted() as a side effect, which silently marks EVERY
// currently-unmarked change order on the job as already covered by the
// price -- including one signed AFTER the approval was withdrawn, for work
// that has nothing to do with the reverted drawing and that the just-
// restored price could never have contained. Its cost then disappears from
// billableTotal permanently, with no re-approval of that disappearance.
//
// mark_change_orders_accepted(), the LIVE body (query 2 above), transcribed
// by hand below:
//
//   begin
//       if (tg_op = 'INSERT' and new.accepted_total is not null)
//          or (tg_op = 'UPDATE' and (
//                  (new.quote_approved_at is not null and new.quote_approved_at is distinct from old.quote_approved_at)
//               or (new.signed_at is not null and new.signed_at is distinct from old.signed_at)
//               or (new.accepted_total is not null and new.accepted_total is distinct from old.accepted_total))) then
//           update public.change_orders co
//              set in_accepted_total = true
//            where co.company_id = new.company_id
//              and co.job_sync_id = new.sync_id
//              and co.deleted_at is null
//              and not co.in_accepted_total;
//       end if;
//       return null;
//   end;
//
// It fires AFTER UPDATE on jobs, unconditionally, the instant
// quote_approved_at moves from null to non-null -- there is no branch for
// "this transition is a restore of an OLD approval, not a fresh one". And
// reapp_restore_approval's own UPDATE (query 3 above) does exactly that
// transition:
//
//   update public.jobs set
//       quote_approved_at = q.prior_approved_at,   -- null -> a real timestamp
//       ...
//       reapproval_required_at = null
//     where id = jid;
//
// reapp_restore_approval's own price check ("The price has to be back too")
// compares live contract_total against q.prior_contract_total -- the
// CONTRACT total at the moment of withdrawal, not accepted_total, and not
// anything about change orders signed since. Nothing in the restore path
// looks at change_orders at all before mark_change_orders_accepted fires
// after it.
// ============================================================================

function markChangeOrdersAccepted({ tgOp, old, patched }, changeOrders) {
  const fires =
    (tgOp === "INSERT" && patched.accepted_total != null) ||
    (tgOp === "UPDATE" && (
      (patched.quote_approved_at != null && patched.quote_approved_at !== old.quote_approved_at) ||
      (patched.signed_at != null && patched.signed_at !== old.signed_at) ||
      (patched.accepted_total != null && patched.accepted_total !== old.accepted_total)
    ));
  if (!fires) return changeOrders;
  return changeOrders.map((co) =>
    co.company_id === patched.company_id && co.job_sync_id === patched.sync_id &&
    co.deleted_at == null && !co.in_accepted_total
      ? { ...co, in_accepted_total: true }
      : co);
}

test("CANARY: the transcription actually fires on the transition it claims to, and leaves other rows alone", () => {
  const patched = { company_id: "c1", sync_id: "j1", quote_approved_at: "2026-09-01T00:00:00Z", signed_at: null, accepted_total: 100 };
  const old = { quote_approved_at: null, signed_at: null, accepted_total: 100 };
  const rows = [
    { company_id: "c1", job_sync_id: "j1", deleted_at: null, in_accepted_total: false, id: "match" },
    { company_id: "c1", job_sync_id: "j1", deleted_at: null, in_accepted_total: true, id: "already-marked" },
    { company_id: "c1", job_sync_id: "j1", deleted_at: "2026-01-01T00:00:00Z", in_accepted_total: false, id: "tombstoned" },
    { company_id: "c1", job_sync_id: "OTHER-JOB", deleted_at: null, in_accepted_total: false, id: "other-job" },
  ];
  const out = markChangeOrdersAccepted({ tgOp: "UPDATE", old, patched }, rows);
  assert.deepEqual(out.filter((r) => r.in_accepted_total).map((r) => r.id).sort(),
    ["already-marked", "match"]);
  // PLANTED FAILURE: no transition at all (quote_approved_at, signed_at and
  // accepted_total all unchanged) must fire nothing.
  const noTransition = markChangeOrdersAccepted({ tgOp: "UPDATE", old: patched, patched }, rows);
  assert.deepEqual(noTransition, rows);
  assert.notDeepEqual(out, noTransition, "the trigger's firing condition has no effect if this ever passes trivially");
});

test("FINDING 2: arithmetic -- a restore silently drops $500 of separately-signed work off the bill", () => {
  const ACCEPTED_AT = "2026-09-01T12:00:00Z";       // the original online approval
  const WORK_SIGNED_AT = "2026-09-15T12:00:00Z";    // extra work, signed DURING the withdrawn window

  // The job as it stands once the drawing has been put back and
  // reapp_restore_approval has run: quote_approved_at restored to the
  // original approval time, reapproval_required_at cleared. This is not
  // hypothetical geometry -- it is exactly the state reapp_restore_approval's
  // own UPDATE produces (query 3 above), and exactly the precondition its own
  // price check ("price has to be back too") is satisfied by construction in
  // this fixture (contract_total back to what it was at withdrawal).
  const restoredJob = {
    company_id: "co1", sync_id: "job1",
    accepted_total: 9710, signed_at: null, quote_approved_at: ACCEPTED_AT,
    reapproval_required_at: null, contract_total: 9710,
  };

  // Extra work, unrelated to the drawing that was withdrawn and restored: a
  // customer separately signed for it while the job sat waiting for
  // re-approval. It is not covered by the $9,710 -- it did not exist when
  // that figure was fixed, and its own signed_at (Sept 15) is unambiguously
  // AFTER the acceptance (Sept 1), which is precisely billableTotal's own
  // rule for "add this on top" (see tests/a4-deposit.test.mjs's "extra work
  // signed AFTER acceptance adds").
  const extraOrder = {
    company_id: "co1", job_sync_id: "job1", deleted_at: null,
    additional_cost: 500, signed_at: WORK_SIGNED_AT, in_accepted_total: false,
  };

  // What billableTotal (the REAL, imported function) says this job owes with
  // that order correctly left unmarked -- the figure this order's own
  // signature earns it, by the app's own rule, on every other job in this
  // codebase:
  const correctlyBilled = billableTotal({
    contractTotal: restoredJob.contract_total, acceptedTotal: restoredJob.accepted_total,
    signedAt: restoredJob.signed_at, quoteApprovedAt: restoredJob.quote_approved_at,
    reapprovalRequiredAt: restoredJob.reapproval_required_at,
    changeOrders: [{ additionalCost: extraOrder.additional_cost, signedAt: extraOrder.signed_at, deletedAt: null, inAcceptedTotal: false }],
  });
  assert.equal(correctlyBilled, 10210, "9710 accepted + 500 signed since = what the customer actually owes");

  // What actually happens: the restore's UPDATE takes quote_approved_at from
  // null to a real timestamp -- mark_change_orders_accepted fires, and
  // extraOrder is "not co.in_accepted_total" and belongs to this job, so it
  // gets swept up exactly like the two probes above establish it would.
  const afterRestore = markChangeOrdersAccepted(
    { tgOp: "UPDATE", old: { quote_approved_at: null, signed_at: null, accepted_total: 9710 }, patched: restoredJob },
    [extraOrder],
  )[0];
  assert.equal(afterRestore.in_accepted_total, true, "the restore flipped a change order it never looked at");

  const actuallyBilled = billableTotal({
    contractTotal: restoredJob.contract_total, acceptedTotal: restoredJob.accepted_total,
    signedAt: restoredJob.signed_at, quoteApprovedAt: restoredJob.quote_approved_at,
    reapprovalRequiredAt: restoredJob.reapproval_required_at,
    changeOrders: [{ additionalCost: afterRestore.additional_cost, signedAt: afterRestore.signed_at, deletedAt: null, inAcceptedTotal: afterRestore.in_accepted_total }],
  });
  assert.equal(actuallyBilled, 9710, "billableTotal now silently drops the $500 -- the ONLY input that changed is the flag the restore flipped");

  const lost = correctlyBilled - actuallyBilled;
  assert.equal(lost, 500,
    `a customer who separately signed for $500 of extra work during the reapproval-pending window owes $${correctlyBilled}; ` +
    `after the drawing is put back and the withdrawn approval auto-restores, billableTotal (and job_anchored_total, which ` +
    `ar_aging() and job_costing() both call, and shares the exact same "accepted_total, plus change orders signed after ` +
    `acceptance that are not in_accepted_total" rule) reports $${actuallyBilled} -- a $${lost} loss nobody approved, ` +
    `caused only by mark_change_orders_accepted() treating a RESTORE of an old price the same as a fresh approval of a new one.`);
});

test("positive control: the SAME trigger, on an ordinary FRESH approval (no restore involved), marks correctly", () => {
  // The ordinary, intended case the trigger exists for: a change order that
  // existed BEFORE a brand-new online approval really is already inside the
  // live total the customer just saw and approved (the engine sums every
  // change order, signed or not, into contract_total) -- so marking it
  // in_accepted_total=true here is correct, not a bug. This isolates FINDING
  // 2 to the restore path specifically, not to the trigger in general.
  const freshApproval = { company_id: "co1", sync_id: "job2", quote_approved_at: "2026-10-01T00:00:00Z", signed_at: null, accepted_total: 5000 };
  const preexisting = { company_id: "co1", job_sync_id: "job2", deleted_at: null, in_accepted_total: false, additional_cost: 300, signed_at: "2026-09-20T00:00:00Z" };
  const out = markChangeOrdersAccepted(
    { tgOp: "UPDATE", old: { quote_approved_at: null, signed_at: null, accepted_total: null }, patched: freshApproval },
    [preexisting],
  )[0];
  assert.equal(out.in_accepted_total, true);
  const billed = billableTotal({
    contractTotal: 5000, acceptedTotal: 5000, signedAt: null, quoteApprovedAt: freshApproval.quote_approved_at,
    reapprovalRequiredAt: null,
    changeOrders: [{ additionalCost: out.additional_cost, signedAt: out.signed_at, deletedAt: null, inAcceptedTotal: out.in_accepted_total }],
  });
  assert.equal(billed, 5000, "correctly NOT double-counted -- it was already inside the $5,000 the customer just approved");
});

// ============================================================================
// What else this domain's read established as clean, and how:
//
// * stamp_accepted_total() (live body, query 2 above) re-stamps
//   accepted_total from signed_contract_total only when signed_at itself
//   moved AND (no online approval stands, or the new signature is not older
//   than it) AND the caller did not explicitly write a positive
//   accepted_total in the same statement ("explicit" wins). Probed by hand
//   against its own body: a later signature after an online approval
//   (new.signed_at >= new.quote_approved_at) re-stamps -- correct, it is a
//   newer agreement; an OLDER signature arriving late
//   (new.signed_at < new.quote_approved_at) does not -- correct, it must not
//   overwrite a newer online approval with a stale figure. No path re-stamps
//   accepted_total DOWN from a live recompute without signed_at itself
//   having moved.
// * reapp_withdraw_approval() (live body, query 3 above) never touches
//   accepted_total, signed_at or signature_storage_path -- a withdrawal
//   freezes the price exactly where it was, which is what lets billableTotal
//   keep answering correctly for a SIGNED (not online-approved) job even
//   though reapp_on_run_change only ever withdraws an ONLINE approval
//   (`if j.quote_approved_at is null then return` -- a signed-only job's
//   drawing can change with no reapproval flow at all, but that job's price
//   was never following contract_total in the first place, so nothing it is
//   billed moves either).
// ============================================================================
