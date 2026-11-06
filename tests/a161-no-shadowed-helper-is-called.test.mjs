/**
 * A LOCAL VARIABLE THAT SHADOWS A HELPER, AND THEN CALLS IT.
 *
 * FOUND 6 Nov 2026 on the admin console's "Email clients" page, while looking
 * at something else. Three blocks built a table row as
 *
 *     const tr = document.createElement('tr');
 *
 * which shadows tr(), the translation function, for the rest of the block.
 * Two of them then asked for a label:
 *
 *     tdTo.textContent = canMail ? byId.get(c.id) : tr('emNoAddress');
 *
 * and got the <tr> ELEMENT, not the translator. MEASURED in the live console
 * before the fix: the companies table rendered 12 rows and the email roster
 * rendered 4, under the words "tr is not a function". The throw happens inside
 * a forEach, so the loop ABORTS at the first company with no usable address --
 * 8 of 12 companies could not be emailed from that page at all, and the only
 * clue on screen was three words naming a variable rather than a company.
 *
 * IT PARSES AND IT LINTS. Nothing is undefined, no name is misspelled, and the
 * syntax sweep this repo already runs over both pages is perfectly happy. It
 * fails only when that one branch is taken, with that one kind of company in
 * the list -- which is why a page with its own test file (a126) had it for
 * weeks. a126 checks the SEND path: who the recipient may be, exactly-once,
 * what a 4xx means. The render was in the layer nothing tested.
 *
 * WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT. Only the defect: a
 * `const`/`let`/`var` that takes the name of a top-level function in the same
 * file AND is then CALLED as a function inside its own block. A shadow that is
 * never called is harmless, and both of the ones standing in dashboard.html
 * today are exactly that -- `const msg = tr(...)` holding a string, and `const
 * pickable = g.mine.concat(...)` holding an array, neither called in its
 * scope. Failing those would make this file noise, and a noisy file gets
 * skipped.
 *
 *     node --test tests/a161-no-shadowed-helper-is-called.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = ['website/admin.html', 'website/dashboard.html'];

/**
 * Every place a top-level function's name is re-declared AND then called
 * inside the block that re-declares it.
 *
 * Exported shape: {name, line, calls}. Pure string work -- no DOM, no parser
 * dependency to install, and the page is read exactly as it ships.
 */
function shadowedCalls(src) {
  const fns = new Set(
    [...src.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(m => m[1])
  );
  const found = [];
  for (const name of fns) {
    const decl = new RegExp('\\b(?:const|let|var)\\s+' + name.replace(/\$/g, '\\$') + '\\s*=', 'g');
    for (const m of src.matchAll(decl)) {
      // The block the declaration sits in: forward from the declaration to the
      // brace that closes its scope. Good enough for this defect, which always
      // lives between a createElement and the appendChild a few lines later,
      // and cheap enough to need nothing installed.
      let depth = 0, i = m.index;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { if (depth === 0) break; depth--; }
      }
      const scope = src.slice(m.index, i);
      const calls = scope.match(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\s*\\(', 'g')) || [];
      if (calls.length) {
        found.push({ name, line: src.slice(0, m.index).split('\n').length, calls: calls.length });
      }
    }
  }
  return found;
}

for (const page of PAGES) {
  test(`${page}: no local shadows a helper it then calls`, () => {
    const src = readFileSync(path.join(ROOT, page), 'utf8');
    const bad = shadowedCalls(src);
    assert.deepStrictEqual(bad, [],
      'a local variable takes a top-level function\'s name and is then called ' +
      'as a function in the same block, which throws "<name> is not a ' +
      'function" only when that branch runs:\n' +
      bad.map(b => `  ${page}:${b.line}  ${b.name} (${b.calls} call(s))`).join('\n'));
  });
}

test('POSITIVE CONTROL: the sweep finds the exact bug that was shipped', () => {
  // Without this, a sweep that silently matched nothing -- a changed function
  // style, a regex that stopped firing -- would report both pages clean for
  // ever. This is the admin code as it actually stood, verbatim.
  const shipped = `
function tr(key) { return key; }
function emRender(list, tb, byId) {
  list.forEach(c => {
    const tr = document.createElement('tr');
    const tdTo = document.createElement('td');
    tdTo.textContent = canMail ? byId.get(c.id) : tr('emNoAddress');
    tr.append(tdTo);
    tb.appendChild(tr);
  });
}`;
  const bad = shadowedCalls(shipped);
  assert.strictEqual(bad.length, 1, 'the sweep no longer detects the shipped defect');
  assert.strictEqual(bad[0].name, 'tr');
});

test('POSITIVE CONTROL: a shadow that is never called is not reported', () => {
  // The other half. If this ever fails the file has become noise, and a noisy
  // check is one people learn to skip.
  const benign = `
function msg(id, text) { return text; }
function report() {
  const msg = 'just a string';
  document.title = msg;
}`;
  assert.deepStrictEqual(shadowedCalls(benign), []);
});
