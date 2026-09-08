import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The one deposit rule, exercised as JavaScript.
 *
 * quote-view showed the homeowner one number and create-payment-link charged
 * another. They now read a single module; this pins what that module says,
 * because the failure mode is a button that promises a figure the card
 * machine refuses.
 *
 * The module is TypeScript for Deno. Rather than add a build step for four
 * lines of arithmetic, the type annotations are stripped and the function is
 * evaluated directly -- if the shape of the file changes enough to break
 * that, this test fails loudly, which is the correct outcome.
 */
const src = readFileSync('supabase/functions/_shared/quote-deposit.ts', 'utf8');
const body = src
  .replace(/export interface[\s\S]*?\n}\n/g, '')
  .replace(/export /g, '')
  .replace(/: DepositInput/g, '')
  .replace(/: DepositFigures/g, '')
  .replace(/: number \| null \| undefined/g, '')
  .replace(/\(v\)/g, '(v)');
const depositFigures = new Function(`${body}; return depositFigures;`)();

const job = (o = {}) => ({
  depositAmount: 0, contractTotal: 0, amountPaid: 0, refundedAmount: 0, ...o,
});

test('a deposit the contractor asked for is what is shown and charged', () => {
  const d = depositFigures(job({ depositAmount: 1200, contractTotal: 8425 }));
  assert.equal(d.asked, 1200);
  assert.equal(d.due, 1200);
  assert.equal(d.payable, true);
});

test('no deposit asked for means nothing shown and nothing charged', () => {
  // This is the bug that started it: the page used to invent a figure from
  // the material cost and print it, while the payment link refused to take
  // it. Both now say the same thing, which is nothing.
  const d = depositFigures(job({ depositAmount: 0, contractTotal: 8425 }));
  assert.equal(d.asked, 0);
  assert.equal(d.due, 0);
  assert.equal(d.payable, false);
});

test('a part-paid deposit shows what is still owed', () => {
  const d = depositFigures(job({ depositAmount: 1200, contractTotal: 8425, amountPaid: 500 }));
  assert.equal(d.asked, 1200);
  assert.equal(d.due, 700);
  assert.equal(d.payable, true);
});

test('a fully paid deposit is not payable again', () => {
  const d = depositFigures(job({ depositAmount: 1200, contractTotal: 8425, amountPaid: 1200 }));
  assert.equal(d.due, 0);
  assert.equal(d.payable, false);
});

test('a refund puts the deposit back on the table', () => {
  const d = depositFigures(
    job({ depositAmount: 1200, contractTotal: 8425, amountPaid: 1200, refundedAmount: 1200 }),
  );
  assert.equal(d.due, 1200);
  assert.equal(d.payable, true);
});

test('a deposit can never exceed the job it belongs to', () => {
  const d = depositFigures(job({ depositAmount: 9000, contractTotal: 8425 }));
  assert.equal(d.asked, 8425);
});

test('an unpriced job does not cap the deposit to zero', () => {
  // contract_total 0 means "not priced yet", not "free". Capping to it would
  // silently zero a deposit the contractor did ask for.
  const d = depositFigures(job({ depositAmount: 500, contractTotal: 0 }));
  assert.equal(d.asked, 500);
});

test('anything under fifty cents is not chargeable', () => {
  assert.equal(depositFigures(job({ depositAmount: 0.4, contractTotal: 100 })).payable, false);
  assert.equal(depositFigures(job({ depositAmount: 0.5, contractTotal: 100 })).payable, true);
});

test('overpayment never produces a negative amount due', () => {
  const d = depositFigures(job({ depositAmount: 1200, contractTotal: 8425, amountPaid: 5000 }));
  assert.equal(d.due, 0);
});

test('rubbish in the columns is treated as zero, not NaN', () => {
  const d = depositFigures({
    depositAmount: null, contractTotal: undefined, amountPaid: NaN, refundedAmount: 'x',
  });
  assert.equal(d.asked, 0);
  assert.equal(d.due, 0);
  assert.equal(d.payable, false);
});

test('a negative stored deposit is not a credit', () => {
  const d = depositFigures(job({ depositAmount: -300, contractTotal: 8425 }));
  assert.equal(d.asked, 0);
  assert.equal(d.due, 0);
});
