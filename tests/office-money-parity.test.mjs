// The office page carries its own copy of the money rules (netPaid, balanceOf,
// stillOwed, contractTotalOf), written to mirror JobMoney.kt in the app on
// purpose -- the comment above contractTotalOf in dashboard.html describes a
// real incident where the two disagreed: a fully paid $19,204 job read as
// $10,568 owing $8,636 more, because the office was summing materials and
// change orders instead of using the app's engine total.
//
// This pulls the four functions out of dashboard.html with the same
// technique tests/office-pricing.test.mjs uses -- read the source, grab the
// balanced-brace function body, eval it standalone -- and checks them against
// the rules JobMoney.kt documents:
//   - netPaid is (paid - refunded), floored at zero, never negative.
//   - stillOwed floors at zero (what gets ASKED for).
//   - balanceOf does NOT floor -- an overpayment must show as a negative
//     balance, not disappear into "$0 owed".
//   - contractTotalOf prefers jobs.contract_total; falls back to
//     materials + change orders only when contract_total is absent.
//
//   node tests/office-money-parity.test.mjs

import { readFileSync } from 'node:fs';
const src = readFileSync('website/dashboard.html', 'utf8');

const grab = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
};

// contractTotalOf closes over the page-level `items` and `orders` arrays
// rather than taking them as parameters, so the harness supplies them as
// function-local variables the extracted body can see, then hands back a
// wrapper that lets the test set them per-case.
const code = ['netPaid', 'balanceOf', 'stillOwed', 'contractTotalOf'].map(grab).join('\n\n');
const factory = new Function(
  'items', 'orders',
  code + '\nreturn {netPaid, balanceOf, stillOwed, contractTotalOf};'
);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const same = typeof want === 'number' ? Math.abs(got - want) < 0.005 : got === want;
  if (same) pass++;
  else { fail++; console.log('FAIL  ' + label + '\n      got  ' + JSON.stringify(got)
    + '\n      want ' + JSON.stringify(want)); }
};

/* ---------- netPaid: floors at zero, is paid minus refunded ---------- */
{
  const M = factory([], []);
  eq('nothing paid', M.netPaid({}), 0);
  eq('paid, nothing refunded', M.netPaid({ amount_paid: 500 }), 500);
  eq('a refund reduces what counts as paid',
    M.netPaid({ amount_paid: 500, refunded_amount: 200 }), 300);
  eq('fully refunded floors at zero, not negative',
    M.netPaid({ amount_paid: 500, refunded_amount: 500 }), 0);
  eq('refunded more than paid (data glitch) still floors at zero, never negative',
    M.netPaid({ amount_paid: 300, refunded_amount: 500 }), 0);
}

/* ---------- balanceOf: the real figure, NOT floored ---------- */
{
  const M = factory([], []);
  eq('balance owed is positive', M.balanceOf({ amount_paid: 200 }, 1000), 800);
  eq('fully paid balance is zero', M.balanceOf({ amount_paid: 1000 }, 1000), 0);
  // The exact bug this file exists to catch: an overpayment must read as a
  // negative balance, not vanish into zero the way stillOwed deliberately does.
  eq('CANARY: an overpayment shows as a NEGATIVE balance, not zero',
    M.balanceOf({ amount_paid: 1400 }, 1000), -400);
  eq('a refund reduces netPaid and so brings the balance back toward zero',
    M.balanceOf({ amount_paid: 1400, refunded_amount: 400 }, 1000), 0);
  eq('a refund big enough puts the balance owed again, positive',
    M.balanceOf({ amount_paid: 1400, refunded_amount: 900 }, 1000), 500);
}

/* ---------- stillOwed: what may be ASKED for -- floors at zero ---------- */
{
  const M = factory([], []);
  eq('normal case matches balanceOf', M.stillOwed({ amount_paid: 200 }, 1000), 800);
  eq('overpaid floors at zero for billing purposes (never ask for negative money)',
    M.stillOwed({ amount_paid: 1400 }, 1000), 0);
}

/* ---------- contractTotalOf: engine total wins; sum is a fallback only --- */
{
  // contract_total present: it wins outright, even over a huge change-order sum.
  // This is the exact regression the comment above the function describes.
  const jobWithTotal = { sync_id: 'j1', contract_total: 19204.45 };
  const items = [{ job_sync_id: 'j1', quantity: 10, unit_price: 5 }]; // 50
  const orders = [{ job_sync_id: 'j1', additional_cost: 8636 }];
  const M = factory(items, orders);
  eq('CANARY: contract_total wins over the materials+CO fallback',
    M.contractTotalOf(jobWithTotal), 19204.45);

  // contract_total absent: falls back to materials + change orders.
  const jobNoTotal = { sync_id: 'j2', contract_total: null };
  const items2 = [{ job_sync_id: 'j2', quantity: 4, unit_price: 25 }]; // 100
  const orders2 = [{ job_sync_id: 'j2', additional_cost: 50 }];
  const M2 = factory(items2, orders2);
  eq('falls back to materials + change orders when contract_total is null',
    M2.contractTotalOf(jobNoTotal), 150);

  eq('fallback with nothing on the job at all is zero, not NaN or undefined',
    M2.contractTotalOf({ sync_id: 'nope', contract_total: null }), 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
