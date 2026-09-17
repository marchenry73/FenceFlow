/* Test-fixture jobs are hidden from the office unless the OWNER opts in.
   visibleJobs() lifted from dashboard.html, same grab() idiom as
   tests/per-foot-pay.test.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const visibleJobs = new Function(grab('visibleJobs') + '\nreturn visibleJobs;')();

const rows = [
  { id: 1, customer_name: 'Real', is_test_fixture: false },
  { id: 2, customer_name: 'ZZ TEST fixture', is_test_fixture: true },
  { id: 3, customer_name: 'Old cache, no column' },
  // Named like a fixture but not flagged: the flag decides, never the text.
  { id: 4, customer_name: 'ZZ TEST lookalike', is_test_fixture: false },
];
const ids = (l) => l.map(j => j.id);

test('hidden by default for everyone, including the owner', () => {
  assert.deepEqual(ids(visibleJobs(rows, 'OWNER', false)), [1, 3, 4]);
  assert.deepEqual(ids(visibleJobs(rows, 'MANAGER', false)), [1, 3, 4]);
});

test('only the owner can show them', () => {
  assert.deepEqual(ids(visibleJobs(rows, 'OWNER', true)), [1, 2, 3, 4]);
  for (const role of ['MANAGER', 'SALES', 'CREW', undefined]) {
    assert.deepEqual(ids(visibleJobs(rows, role, true)), [1, 3, 4], String(role));
  }
});

test('tolerates missing lists', () => {
  assert.deepEqual(visibleJobs(null, 'OWNER', false), []);
});

test('filter is applied where jobs are loaded', () => {
  assert.match(src, /jobs=visibleJobs\(allJobsLoaded, profile\?\.role, showTestPref\(\)\)/);
});
