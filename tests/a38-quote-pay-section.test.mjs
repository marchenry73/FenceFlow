/* The "How to pay" section of the homeowner quote page (website/quote.html).

   The owner asked for exactly this: a place he types his own payment details
   in the office, and a place the customer reads them on her quote link --
   Cash App, Zelle, wire, cash. This file pins the half the customer sees.

   The page code is pulled straight out of quote.html and run standalone, the
   same grab()/new Function() idiom as tests/quote-summary.test.mjs, so what is
   tested is the shipped source and not a copy of it.

   What each group of tests exists to catch:
     - a method he has NOT filled in must not produce a row (an empty Cash App
       line on a customer's quote looks broken and invites a question he cannot
       answer);
     - nothing may restate a total, deposit or balance (a second copy of a
       figure in a second place is how the two come to disagree);
     - the section vanishes when nothing is left to pay;
     - a customer must always be able to get the value out: it is selectable
       text, there is a Copy button, and a REFUSED clipboard write is never
       reported as a successful copy;
     - a value typed by the contractor is escaped, never interpreted as HTML;
     - at phone width the value may wrap anywhere and the button never shrinks;
     - THE PAGE MUST NOT SAY A CARD FEE WILL BE ADDED, because none is (see the
       FEE TRUTH tests, which read the real create-payment-link source);
     - three languages, compared by KEY and never by looking for a particular
       word (a cancellation test once assumed every language contains the word
       CANCEL and failed on the ones that do not). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const src = read('website/quote.html');

/* ---- lifting code out of the page --------------------------------------- */

const grabFn = (name) => {
  const m = src.match(new RegExp('(?:async )?function ' + name + '\\('));
  if (!m) throw new Error('not found: ' + name);
  const start = m.index;
  let i = src.indexOf('{', src.indexOf(')', start)), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
};
const grabLine = (prefix) => {
  const start = src.indexOf(prefix);
  if (start < 0) throw new Error('not found: ' + prefix);
  // The working copy of quote.html is CRLF (git converts), so strip the CR.
  return src.slice(start, src.indexOf('\n', start)).replace(/\r$/, '');
};
// The L = { en:{...}, es:{...}, fr:{...} } table, by brace depth. No string in
// it contains a brace; if one ever does, the throw says so instead of this
// quietly lifting half a table.
const grabL = () => {
  const start = src.indexOf('const L = {');
  if (start < 0) throw new Error('not found: const L');
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1) + ';'; }
  }
  throw new Error('unbalanced L');
};
const LTABLE = new Function(grabL() + '\nreturn L;')();

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The page's own esc is a one-liner; assert it is still the one this helper
// copies, so a change there is noticed here instead of silently diverging.
assert.ok(src.includes("const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');"),
  'esc() in quote.html changed: update this test helper to match');

const PIECES = [
  grabL(),
  grabFn('tr'),
  grabLine('const PAY_ORDER='), grabLine('const PAY_NAME_KEY='), grabLine('const PAY_IN_KEY='), grabLine('const PAY_FIELD='),
  grabFn('payMethodsFrom'), grabFn('payHowModel'), grabFn('payNameList'),
  grabFn('payCopyOutcome'), grabFn('selectNodeContents'),
  'let payList=[];', grabFn('renderHowToPay'), grabFn('copyPayRow'),
].join('\n');

/* A fresh page "instance": its own language, fake DOM and fake clipboard. */
function page({ lang = 'en', dueNow = 0, clipboard, execCopy = () => false, select = true } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', style: {}, _t: null });
  const doc = { execCommand: () => execCopy(), createRange: () => ({ selectNodeContents() {} }) };
  const selection = { removeAllRanges() {}, addRange() { selection.added = true; }, added: false };
  const win = { getSelection: () => (select ? selection : null) };
  const factory = new Function('LANG', '$', 'esc', 'dueNow', 'navigator', 'document', 'window', 'setTimeout', 'clearTimeout',
    PIECES + '\nreturn { L, tr, payMethodsFrom, payHowModel, payNameList, payCopyOutcome, renderHowToPay, copyPayRow,'
    + ' getList: () => payList };');
  return { ...factory(lang, el, esc, () => dueNow, { clipboard }, doc, win, () => 0, () => {}), els, selection };
}

/* ---- the response shape, spelled out once -------------------------------- */
// supabase_a38_company_payment_methods.sql PART 1 is the contract. quote-view
// sends `paymentMethods` with exactly these four fields, "" / false when the
// owner has a method off or empty. Every test goes through quoteWith, so the
// day a name changes there is one function to fix -- and the CONTRACT test
// below fails first, against the migration file itself.
function quoteWith(m) {
  const pm = { cashApp: '', zelle: '', wire: '', cash: false };
  for (const [k, v] of Object.entries(m)) pm[k === 'cashapp' ? 'cashApp' : k] = v;
  return { total: 12400, deposit: 3100, paymentMethods: pm };
}
const FULL = {
  cashapp: '$TestFenceCo',
  zelle: 'pay@testfence.example',
  wire: 'Test Bank\nRouting 000000000\nAccount 0000000000',
  cash: true,
};

test('CONTRACT: the field names this page reads are the ones the migration says quote-view sends', () => {
  const mig = read('supabase_a38_company_payment_methods.sql');
  const block = mig.slice(mig.indexOf('paymentMethods: {'), mig.indexOf('RULES THE PAGE CAN RELY ON'));
  assert.ok(block.length > 100, 'could not find the contract block in the migration');
  for (const field of ['cashApp', 'zelle', 'wire', 'cash']) {
    assert.match(block, new RegExp('\\n--\\s+' + field + ':'), 'the migration no longer names ' + field);
  }
  // And this page reads exactly those, under exactly the key `paymentMethods`.
  assert.match(grabFn('payMethodsFrom'), /q\.paymentMethods/);
  assert.equal(grabLine('const PAY_FIELD='), "const PAY_FIELD={cashapp:'cashApp',zelle:'zelle',wire:'wire',cash:'cash'};");
});

/* ---- which methods appear ------------------------------------------------ */

test('every method he turned on gets a row, in a fixed order', () => {
  const got = page().payMethodsFrom(quoteWith(FULL));
  assert.deepEqual(got.map((m) => m.key), ['cashapp', 'zelle', 'wire', 'cash']);
  assert.equal(got[0].value, '$TestFenceCo');
  assert.equal(got[2].value, FULL.wire, 'multi-line wire instructions keep their line breaks');
  assert.equal(got[3].value, null, 'cash is a fact with nothing to copy');
});

test('a method with no details has no row (blank, whitespace, null, wrong type)', () => {
  const p = page();
  for (const empty of ['', '   ', '\n\t', null, undefined, 0, false, true, {}, []]) {
    for (const key of ['cashapp', 'zelle', 'wire']) {
      const got = p.payMethodsFrom(quoteWith({ [key]: empty }));
      assert.deepEqual(got, [], key + ' = ' + JSON.stringify(empty) + ' must not make a row');
    }
  }
});

test('cash shows only when it is exactly true -- never for a string, a number or false', () => {
  const p = page();
  for (const notOn of [false, '', null, undefined, 0, 1, 'true', 'yes', {}, []]) {
    assert.deepEqual(p.payMethodsFrom(quoteWith({ cash: notOn })), [], 'cash = ' + JSON.stringify(notOn));
  }
  assert.deepEqual(p.payMethodsFrom(quoteWith({ cash: true })).map((m) => m.key), ['cash']);
});

test('only his own text is shown: surrounding whitespace is trimmed, the middle is not touched', () => {
  const got = page().payMethodsFrom(quoteWith({ zelle: '   pay@testfence.example  \n' }));
  assert.equal(got[0].value, 'pay@testfence.example');
  const wire = page().payMethodsFrom(quoteWith({ wire: 'Bank A\n\nAccount   123' }));
  assert.equal(wire[0].value, 'Bank A\n\nAccount   123');
});

test('an old quote-view (no payment field at all) leaves the page exactly as it was', () => {
  const p = page({ dueNow: 100 });
  for (const old of [{ total: 1000, deposit: 100 }, { paymentMethods: null }, { paymentMethods: 'oops' }, {}, null, undefined]) {
    assert.deepEqual(p.payMethodsFrom(old), []);
  }
  p.renderHowToPay({ total: 1000, deposit: 100 }, 900);
  assert.equal(p.els.payHow.style.display, 'none');
  assert.equal(p.els.payMethods.innerHTML, '');
});

test('PLANTED FAILURE: a field nobody listed is ignored, never rendered', () => {
  // If payMethodsFrom ever walked every key of the object instead of its own
  // list, an unexpected field (a secret, an internal flag) would reach the
  // customer's screen.
  const got = page().payMethodsFrom(quoteWith({ zelle: 'pay@testfence.example', internalNote: 'do not show', routing_secret: '123' }));
  assert.deepEqual(got.map((m) => m.key), ['zelle']);
});

/* ---- when the section shows --------------------------------------------- */

test('nothing typed: section hidden', () => {
  const p = page({ dueNow: 100 });
  p.renderHowToPay(quoteWith({}), 900);
  assert.equal(p.els.payHow.style.display, 'none');
  assert.equal(p.els.payMethods.innerHTML, '');
});

test('something typed and money still owed: section shown', () => {
  const p = page();
  p.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example' }), 900);
  assert.equal(p.els.payHow.style.display, '');
});

test('nothing left to pay: section hidden even though methods exist', () => {
  const p = page();
  for (const balance of [0, 0.004, -5, NaN, undefined, null]) {
    p.renderHowToPay(quoteWith(FULL), balance);
    assert.equal(p.els.payHow.style.display, 'none', 'balance ' + balance);
    assert.equal(p.els.payMethods.innerHTML, '', 'rows cleared for balance ' + balance);
  }
});

test('re-rendering after a payment clears the old rows rather than leaving them behind', () => {
  const p = page();
  p.renderHowToPay(quoteWith(FULL), 900);
  assert.ok(p.els.payMethods.innerHTML.includes('pm-val'));
  p.renderHowToPay(quoteWith(FULL), 0);
  assert.equal(p.els.payMethods.innerHTML, '');
  assert.equal(p.els.payNotes.innerHTML, '');
  assert.equal(p.getList().length, 0);
});

/* ---- the card row and the sentence about the others -------------------- */

test('the card row is there exactly when the card button is', () => {
  const withCard = page({ dueNow: 250 });
  withCard.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example' }), 900);
  assert.ok(withCard.els.payMethods.innerHTML.includes(withCard.L.en.pmCard));

  const noCard = page({ dueNow: 0 });
  noCard.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example' }), 900);
  assert.ok(!noCard.els.payMethods.innerHTML.includes(noCard.L.en.pmCard), 'no button, so no row pointing at one');
});

test('"skips the card checkout" is only said when there is a card option to contrast with, and names only what is listed', () => {
  const withCard = page({ dueNow: 250 });
  withCard.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example', cash: true }), 900);
  const notes = withCard.els.payNotes.innerHTML;
  assert.ok(/Zelle,? or cash/.test(notes), notes);
  assert.ok(!notes.includes('Cash App'), 'must not name a method he did not turn on');
  assert.ok(!notes.includes('wire'), 'must not name a method he did not turn on');

  const noCard = page({ dueNow: 0 });
  noCard.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example', cash: true }), 900);
  assert.ok(!noCard.els.payNotes.innerHTML.includes('skips the card'), 'nothing to skip when there is no card option');
});

test('"put your name in the note" is not said when the only method is cash', () => {
  const cashOnly = page();
  cashOnly.renderHowToPay(quoteWith({ cash: true }), 900);
  assert.ok(!cashOnly.els.payNotes.innerHTML.includes(cashOnly.L.en.pmNameNote));
  const zelle = page();
  zelle.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example' }), 900);
  assert.ok(zelle.els.payNotes.innerHTML.includes(zelle.L.en.pmNameNote));
});

test('the list of names reads naturally in each language', () => {
  const keys = ['cashapp', 'zelle', 'cash'];
  assert.match(page({ lang: 'en' }).payNameList(keys), /^Cash App, Zelle,? or cash$/);
  assert.match(page({ lang: 'es' }).payNameList(keys), /^Cash App, Zelle o efectivo$/);
  assert.match(page({ lang: 'fr' }).payNameList(keys), /^Cash App, Zelle ou espèces$/);
});

/* ---- no figure is restated ---------------------------------------------- */

test('the section never prints a dollar amount or a figure of its own', () => {
  const p = page({ dueNow: 250 });
  // The balance passed in is 913.37. If it ever leaked into the markup, it
  // would show here.
  p.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example', cash: true }), 913.37);
  const all = p.els.payMethods.innerHTML + p.els.payNotes.innerHTML;
  const withoutValue = all.replace(/<div class="pm-val"[^>]*>[^<]*<\/div>/g, '');
  assert.ok(!/\$/.test(withoutValue), 'a currency sign appeared: ' + withoutValue);
  assert.ok(!/913/.test(all), 'the balance leaked into the section');
  for (const lang of ['en', 'es', 'fr']) {
    for (const k of ['howToPayHead', 'howToPayLead', 'pmCard', 'pmCardHow', 'pmCashHow', 'pmSkipCard', 'pmNameNote', 'pmSelected']) {
      const text = LTABLE[lang][k].replace(/%s/g, '');
      assert.ok(!/\d/.test(text), lang + '.' + k + ' contains a digit: ' + text);
      assert.ok(!/\$/.test(text), lang + '.' + k + ' contains a currency sign');
    }
  }
});

/* ---- she can get the value out ------------------------------------------ */

test('the value is real text in the page: selectable, copyable, never an image', () => {
  const p = page();
  p.renderHowToPay(quoteWith(FULL), 900);
  const html = p.els.payMethods.innerHTML;
  assert.ok(!/<img|<canvas|<svg|background-image|data:image/i.test(html), 'a payment destination must not be a picture');
  for (const k of ['$TestFenceCo', 'pay@testfence.example']) assert.ok(html.includes('>' + k + '<'), k + ' is a plain text node');
  // One real, non-submitting Copy button per method that HAS a value; cash has none.
  assert.equal((html.match(/<button type="button" class="pm-copy"/g) || []).length, 3);
  assert.ok(html.includes('data-method="cash"') && !/data-method="cash"[^]*?pm-copy[^]*?data-method=/.test(html.slice(html.indexOf('data-method="cash"'))), 'cash row has no copy button');
  // The page's CSS must say text is selectable on the value, explicitly.
  const css = src.slice(src.indexOf('.paym{'), src.indexOf('/* ------- saying yes'));
  assert.match(css.match(/\.pm-val\{[^}]*\}/)[0], /user-select:text/);
  assert.ok(!/user-select:none/.test(css), 'nothing in the pay CSS may stop selection');
});

test('at phone width the value wraps anywhere and the Copy button is never squeezed', () => {
  const css = src.slice(src.indexOf('.paym{'), src.indexOf('/* ------- saying yes'));
  assert.match(css, /\.pm-val\{[^}]*min-width:0/, 'a flex child holding one long word must be allowed to shrink');
  assert.match(css, /\.pm-val\{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.pm-val\{[^}]*white-space:pre-wrap/, 'wire instructions keep the line breaks he typed');
  assert.match(css, /\.pm-copy\{[^}]*flex:0 0 auto/, 'the button must not shrink');
  assert.match(css, /\.pm-copy\{[^}]*min-height:40px/, 'a thumb-sized target');
  // The name sits ABOVE the value, not beside it: the layout bug on this page
  // was two labels side by side with no room.
  assert.match(css, /\.pm-name\{[^}]*margin-bottom/);
});

test('a value he typed is escaped, never run as HTML', () => {
  const p = page();
  p.renderHowToPay(quoteWith({ zelle: '<img src=x onerror=alert(1)>"&' }), 900);
  const html = p.els.payMethods.innerHTML;
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;'), html);
});

test('Copy: a clipboard that works reads "Copied"', async () => {
  let written = null;
  const p = page({ clipboard: { writeText: async (t) => { written = t; } } });
  p.renderHowToPay(quoteWith({ cashapp: '$TestFenceCo' }), 900);
  await p.copyPayRow(0);
  assert.equal(written, '$TestFenceCo');
  assert.equal(p.els.pmb0.textContent, p.L.en.pmCopied);
  assert.equal(p.els.pms0.textContent, '');
});

test('Copy: a REFUSED clipboard write is never reported as copied; the text is selected instead', async () => {
  const p = page({ clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } }, execCopy: () => false });
  p.renderHowToPay(quoteWith({ cashapp: '$TestFenceCo' }), 900);
  await p.copyPayRow(0);
  assert.notEqual(p.els.pmb0.textContent, p.L.en.pmCopied, 'claimed it copied when the browser refused');
  assert.equal(p.els.pms0.textContent, p.L.en.pmSelected, 'tells her what to do next');
  assert.ok(p.selection.added, 'the value must be left selected so she can press and hold it');
});

test('Copy: no clipboard API at all (an older or in-app browser) falls back to selecting', async () => {
  const p = page({ clipboard: undefined, execCopy: () => false });
  p.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example' }), 900);
  await p.copyPayRow(0);
  assert.equal(p.els.pms0.textContent, p.L.en.pmSelected);
  assert.ok(p.selection.added);
});

test('Copy: the selection fallback may say "Copied" only when the browser said it copied', async () => {
  const yes = page({ clipboard: undefined, execCopy: () => true });
  yes.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example' }), 900);
  await yes.copyPayRow(0);
  assert.equal(yes.els.pmb0.textContent, yes.L.en.pmCopied);

  const cannotSelect = page({ clipboard: undefined, execCopy: () => true, select: false });
  cannotSelect.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example' }), 900);
  await cannotSelect.copyPayRow(0);
  assert.equal(cannotSelect.els.pms0.textContent, cannotSelect.L.en.pmSelected, 'no selection means nothing was copied');
});

test('PLANTED FAILURE: the naive copy handler (await writeText, then say Copied) lies on a refused write', async () => {
  // What the obvious one-liner does. This proves the shape of the bug is real
  // and that payCopyOutcome answers differently where it matters.
  const refuse = { writeText: async () => { throw new Error('NotAllowedError'); } };
  const naive = async (text) => { try { await refuse.writeText(text); } catch (e) { /* swallowed */ } return 'copied'; };
  assert.equal(await naive('x'), 'copied');
  assert.equal(await page().payCopyOutcome('x', { writeText: refuse.writeText, select: () => true, execCopy: () => false }), 'selected');
});

/* ---- the page is wired -------------------------------------------------- */

test('render() calls the section with the same balance that decides "Nothing left to pay"', () => {
  const at = src.indexOf("$('totals').innerHTML=rows.join('');");
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 400), /renderHowToPay\(q, balance\);/);
});

test('the section sits between the pricing panel and the approve box, hidden until render() shows it', () => {
  const totals = src.indexOf('<div class="totals" id="totals">');
  const how = src.indexOf('<div class="panel" id="payHow" style="display:none">');
  const approve = src.indexOf('<div class="approve" id="approveBox"');
  assert.ok(totals > 0 && how > totals && approve > how);
});

test('the downloaded copy of the quote does not carry payment details', () => {
  // downloadQuoteCopy builds from the page's own totals/scope markup. A file the
  // customer saves and forwards must not become a place the contractor's bank
  // details live. If someone adds #payMethods to it, that is a decision to make
  // on purpose, so it fails here first.
  const start = src.indexOf('function downloadQuoteCopy');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(!/payMethods|payHow|payNotes|paymentMethods/.test(body));
});

test('the 3D stage, the approval and the signature code are not touched by this feature', () => {
  const mine = src.slice(src.indexOf('/* ===================== how to pay'), src.indexOf('/* ================== drawn signature'));
  assert.ok(mine.length > 1000, 'could not find the section');
  assert.ok(!/build3D|doApprove|signatureCanvasDataUrl|THREE\./.test(mine));
});

/* =========================================================================
   Honest copy, and three languages.
   ========================================================================= */

const cpl = read('supabase/functions/create-payment-link/index.ts');

// Words that say "a fee is added", per language. A list per language rather
// than one English word: a check that only knew "fee" would pass a Spanish page
// promising a "comision".
const FEE_WORDS = {
  en: /\bfees?\b|surcharge|processing charge|service charge/i,
  es: /comisi[oó]n|recargo|cargo (adicional|extra)|tarifa/i,
  fr: /\bfrais\b|supplément|supplement|commission|majoration/i,
};
const sayFee = (lang, s) => FEE_WORDS[lang].test(s);

test('FEE TRUTH: the card checkout adds no fee today, so the page must not say it does', () => {
  // The owner asked for the customer to be told "stripe has a fee". The code
  // says otherwise: create-payment-link hardcodes stripeFee to 0 for every
  // customer link, and cardFeeCents (the 3%-capped formula) has no caller.
  // companies.pass_card_fee is FenceFlow's own subscription setting, read by
  // create-checkout-session, not a surcharge on a homeowner's payment.
  assert.match(cpl, /const stripeFee = 0;/,
    'create-payment-link no longer hardcodes stripeFee = 0. A card fee may now be charged: ' +
    'quote.html must then state the REAL amount or percentage from that code, never a guess ' +
    'and never "a fee may apply". Update the copy and this test together.');
  assert.equal([...cpl.matchAll(/\bcardFeeCents\s*\(/g)].length, 1, 'cardFeeCents gained a caller: a fee may now be charged');
  // The Stripe line item for a fee is only built when stripeFee > 0.
  assert.match(cpl, /stripeFee > 0 \? await stripe\("\/prices"/);

  for (const lang of ['en', 'es', 'fr']) {
    for (const [k, v] of Object.entries(LTABLE[lang])) {
      assert.ok(!sayFee(lang, v), lang + '.' + k + ' mentions a fee although none is charged: ' + v);
    }
  }
});

test('FEE TRUTH has teeth: the detector fires on a sentence that would be a lie, and passes the true one', () => {
  assert.ok(sayFee('en', 'A 3% card fee will be added at checkout.'));
  assert.ok(sayFee('es', 'Se añadirá una comisión del 3 % al pagar con tarjeta.'));
  assert.ok(sayFee('fr', 'Des frais de 3 % s’appliquent au paiement par carte.'));
  for (const lang of ['en', 'es', 'fr']) assert.ok(!sayFee(lang, LTABLE[lang].pmSkipCard));
});

test('FEE TRUTH: no percentage or surcharge figure appears in the new copy', () => {
  for (const lang of ['en', 'es', 'fr']) for (const k of Object.keys(LTABLE[lang])) {
    if (!/^pm|^howToPay/.test(k)) continue;
    const text = LTABLE[lang][k].replace(/%s/g, '');
    assert.ok(!/\d\s*%|percent|por ciento|pour cent/i.test(text), lang + '.' + k + ': ' + text);
  }
});

const NEW_KEYS = ['howToPayHead', 'howToPayLead', 'pmCard', 'pmCardHow', 'pmCashApp', 'pmZelle', 'pmWire', 'pmCash', 'pmCashHow',
  'pmCashAppIn', 'pmZelleIn', 'pmWireIn', 'pmCashIn', 'pmCopy', 'pmCopied', 'pmCopyAria', 'pmSelected', 'pmSkipCard', 'pmNameNote'];
// Proper nouns that are legitimately identical in every language. Everything
// else must actually be translated -- compared by KEY, never by looking for a
// particular word inside the text.
const SAME_EVERYWHERE = new Set(['pmCashApp', 'pmZelle', 'pmCashAppIn', 'pmZelleIn']);

test('three languages: every new string exists in English, Spanish and French', () => {
  for (const lang of ['en', 'es', 'fr']) for (const k of NEW_KEYS) {
    assert.equal(typeof LTABLE[lang][k], 'string', lang + '.' + k + ' is missing');
    assert.ok(LTABLE[lang][k].trim().length > 0, lang + '.' + k + ' is empty');
  }
});

test('three languages: no new key exists in only some of them, and none is unlisted here', () => {
  const mine = (lang) => Object.keys(LTABLE[lang]).filter((k) => /^pm|^howToPay/.test(k)).sort();
  assert.deepEqual(mine('es'), mine('en'));
  assert.deepEqual(mine('fr'), mine('en'));
  assert.deepEqual(mine('en'), [...NEW_KEYS].sort(), 'a key was added without being listed in this test');
});

test('three languages: each string has the same number of %s holes in every language', () => {
  const holes = (s) => (s.match(/%s/g) || []).length;
  for (const k of NEW_KEYS) {
    assert.equal(holes(LTABLE.es[k]), holes(LTABLE.en[k]), 'es.' + k);
    assert.equal(holes(LTABLE.fr[k]), holes(LTABLE.en[k]), 'fr.' + k);
  }
  assert.equal(holes(LTABLE.en.pmSkipCard), 1);
  assert.equal(holes(LTABLE.en.pmCopyAria), 1);
});

test('three languages: translated strings are not the English ones left in place', () => {
  for (const k of NEW_KEYS) {
    if (SAME_EVERYWHERE.has(k)) continue;
    assert.notEqual(LTABLE.es[k], LTABLE.en[k], 'es.' + k + ' is still English');
    assert.notEqual(LTABLE.fr[k], LTABLE.en[k], 'fr.' + k + ' is still English');
  }
});

test('three languages: rendering in Spanish and French shows none of the English sentences', () => {
  for (const lang of ['es', 'fr']) {
    const p = page({ lang, dueNow: 250 });
    p.renderHowToPay(quoteWith(FULL), 900);
    const html = p.els.payMethods.innerHTML + p.els.payNotes.innerHTML;
    // Short labels are compared as whole element text: 'Cash' is a substring of
    // 'Cash App', which is correct in every language.
    for (const k of ['pmCard', 'pmWire', 'pmCash', 'pmCopy']) {
      assert.ok(!html.includes('>' + esc(LTABLE.en[k]) + '<'), lang + ' page still shows English ' + k + ': ' + LTABLE.en[k]);
    }
    for (const k of ['pmCardHow', 'pmCashHow', 'pmSkipCard', 'pmNameNote']) {
      const english = LTABLE.en[k].replace('%s', '');
      assert.ok(!html.includes(esc(english)), lang + ' page still shows English ' + k + ': ' + english);
    }
    for (const k of ['pmCard', 'pmCardHow', 'pmCashHow', 'pmNameNote', 'pmWireIn', 'pmCashIn']) {
      assert.ok(html.includes(esc(LTABLE[lang][k])), lang + ' page is missing its own ' + k);
    }
  }
});

test('three languages: the static heading and lead go through the page\'s own data-t pass', () => {
  assert.match(src, /<h2 data-t="howToPayHead">/);
  assert.match(src, /<p class="sub" data-t="howToPayLead">/);
  assert.match(grabFn('applyStaticText'), /querySelectorAll\('\[data-t\]'\)/);
});

test('the Copy button\'s accessible name says what it copies, in the reader\'s language', () => {
  const p = page({ lang: 'es' });
  p.renderHowToPay(quoteWith({ zelle: 'pay@testfence.example' }), 900);
  assert.ok(p.els.payMethods.innerHTML.includes('aria-label="Copiar Zelle"'), p.els.payMethods.innerHTML);
});
