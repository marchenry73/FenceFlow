/* The "Download a copy" file on the homeowner quote page (website/quote.html)
   now says how to pay.

   WHY. The copy she saves is the one she forwards to a husband, a lender or an
   HOA. It carried the scope, the pricing and the approval, but not the
   contractor's Cash App tag, Zelle address, wire instructions or the fact that
   he takes cash -- those lived only in the live "How to pay" panel. So the one
   document that travels did not say how to pay him.

   HOW IT IS BUILT (what these tests pin). downloadQuoteCopy() takes the live
   page's own scope and totals markup and hands it to buildQuoteDocument(), which
   assembles a standalone HTML string. The pay section is built the same way and
   from the same place: payDocModel() reads payList, the list renderHowToPay()
   is showing on screen right now (and empties whenever it hides the panel), and
   buildQuoteDocument() lays it out with INLINE styles only. So the file and the
   screen cannot disagree about which methods exist.

   WHAT EACH GROUP EXISTS TO CATCH:
     - a Copy button in a saved file does nothing, and a control that does
       nothing in a document she may act on is worse than none: the saved
       section has no button, no link, no script, and the value is plain text;
     - a method he did not fill in must not appear, and with nothing to show
       there must be no heading either (she cannot refresh an empty line away);
     - no figure of the contractor's is restated; the Pricing section is the one
       copy of every amount;
     - three languages, compared by KEY and by what the page itself rendered --
       never by looking for a particular word (a test once asserted every
       language contains "CANCEL"; French is ANNULATION);
     - every inline <script> of the page still compiles. quote.html is ONE file
       with ONE script tag, and a stray apostrophe once left every contractor
       looking at "Loading your office" for a day and a half.

   Run the REAL functions out of the shipped source, called the way the page
   calls them: quote -> renderHowToPay -> payList -> downloadQuoteCopy -> the
   bytes of the Blob that would be saved. A buildQuoteDocument call with a
   hand-written pay argument would never notice downloadQuoteCopy forgot to pass
   it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A54_PAGE: point the suite at another copy of the page -- how the mutation runs
// show these tests fail when the feature is broken.
const src = process.env.A54_PAGE
  ? readFileSync(process.env.A54_PAGE, 'utf8')
  : readFileSync(new URL('../website/quote.html', import.meta.url), 'utf8');

/* ---- lifting code out of the page --------------------------------------- */

const grabFn = (name) => {
  const m = src.match(new RegExp('(?:async )?function ' + name + '\\('));
  if (!m) throw new Error('not found: ' + name);
  const start = m.index;
  const i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
};
const grabLine = (prefix) => {
  const start = src.indexOf(prefix);
  if (start < 0) throw new Error('not found: ' + prefix);
  return src.slice(start, src.indexOf('\n', start)).replace(/\r$/, '');
};
const grabL = () => {
  const start = src.indexOf('const L = {');
  if (start < 0) throw new Error('not found: const L');
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1) + ';'; }
  }
  throw new Error('unbalanced L');
};
const LTABLE = new Function(grabL() + '\nreturn L;')();

const PIECES = [
  grabL(),
  grabLine('const esc='),
  grabFn('tr'),
  grabLine('const PAY_ORDER='), grabLine('const PAY_NAME_KEY='), grabLine('const PAY_IN_KEY='), grabLine('const PAY_FIELD='),
  grabFn('payMethodsFrom'), grabFn('payHowModel'), grabFn('payNameList'),
  grabFn('payCopyOutcome'), grabFn('selectNodeContents'),
  'let payList=[];', grabFn('renderHowToPay'),
  grabFn('payDocModel'), grabFn('buildQuoteDocument'), grabFn('downloadQuoteCopy'),
].join('\n');

/* The day the page "runs" on, frozen so the as-of date is exact. */
const NOW = new Date(2026, 9, 1, 12, 0, 0);
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW.getTime()); }
}
const dateIn = (lang) => NOW.toLocaleDateString(lang);

/* A fresh page "instance": its own language, a fake DOM, and a Blob that keeps
   what downloadQuoteCopy tried to save. */
function page({ lang = 'en', dueNow = 0 } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', style: {} });
  // Created up front: the tests read and set these before the page has touched them.
  ['scope', 'totals', 'approvedText', 'payHow', 'payMethods', 'payNotes'].forEach(el);
  const saved = { text: null, name: null, opened: null };
  class FakeBlob { constructor(parts) { saved.text = parts.join(''); } }
  const anchor = { click() {}, set download(v) { saved.name = v; }, get download() { return saved.name; } };
  const documentStub = {
    createElement: () => anchor,
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => false,
    createRange: () => ({ selectNodeContents() {} }),
  };
  const factory = new Function(
    'LANG', '$', 'dueNow', 'Blob', 'URL', 'document', 'window', 'setTimeout', 'clearTimeout', 'navigator', 'Date',
    PIECES + `
    let quote=null;
    const signatureForDownload=async()=>null;
    return { L, tr, payMethodsFrom, payHowModel, renderHowToPay, payDocModel, buildQuoteDocument,
             downloadQuoteCopy, setQuote:q=>{ quote=q; }, getList:()=>payList };`);
  const api = factory(
    lang, el, () => dueNow, FakeBlob,
    { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    documentStub,
    { getSelection: () => null, open: (...a) => { saved.opened = a; return null; } },
    () => 0, () => {}, { clipboard: undefined }, FixedDate,
  );
  return { ...api, els, saved };
}

/* ---- the response shape, spelled out once -------------------------------- */
// supabase_a38_company_payment_methods.sql PART 1 is the contract: quote-view
// sends `paymentMethods` with exactly these four fields, "" / false when the
// owner has a method off or empty.
function quoteWith(m, extra = {}) {
  const pm = { cashApp: '', zelle: '', wire: '', cash: false };
  for (const [k, v] of Object.entries(m)) pm[k === 'cashapp' ? 'cashApp' : k] = v;
  return {
    customerName: 'Pat Buyer', address: '1 Test Lane',
    company: { name: 'Test Fence Co', phone: '(555) 010-0100', email: 'office@testfence.example' },
    total: 12400, deposit: 3100, paymentMethods: pm, ...extra,
  };
}
const FULL = {
  cashapp: '$TestFenceCo',
  zelle: 'pay@testfence.example',
  wire: 'Test Bank\nRouting 000000000\nAccount 0000000000',
  cash: true,
};
// A fixture with a figure in the pricing panel that appears NOWHERE else, so
// "the pay section restated an amount" is detectable by looking for it.
const TOTALS = '<div class="grand"><span>Total</span><span>$12,400.00</span></div>'
  + '<div><span>Balance due</span><span>$913.37</span></div>';
const SCOPE = '<div><strong>Vinyl fence</strong> — 120 ft</div>';

/* The whole chain, as the page runs it: the quote arrives, render() draws the
   How to pay panel from it, the customer presses "Download a copy". */
async function savedCopy(methods, opts = {}) {
  const { lang = 'en', dueNow = 250, extra = {} } = opts;
  const balance = 'balance' in opts ? opts.balance : 913.37;
  const p = page({ lang, dueNow });
  const q = quoteWith(methods, extra);
  p.setQuote(q);
  p.renderHowToPay(q, balance);
  p.els.scope.innerHTML = SCOPE;
  p.els.totals.innerHTML = TOTALS;
  p.els.approvedText.textContent = 'Approved by Pat Buyer.';
  await p.downloadQuoteCopy();
  assert.equal(typeof p.saved.text, 'string', 'downloadQuoteCopy saved nothing');
  return { doc: p.saved.text, p, q };
}

/* ---- reading the saved file back ----------------------------------------- */
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const APPROVAL_AT = '<div style="margin-top:26px';
/** The pay section of a saved file, or null when the file has none. */
function paySection(doc, lang = 'en') {
  const head = '>' + LTABLE[lang].howToPayHead.replace(/&/g, '&amp;') + '</h2>';
  const at = doc.indexOf(head);
  if (at < 0) return null;
  const from = doc.lastIndexOf('<h2 ', at);
  let to = doc.indexOf(APPROVAL_AT, at);
  if (to < 0) to = doc.indexOf('</body>', at);
  return doc.slice(from, to);
}
/** [{name, text}] for every method box in a saved file. */
function savedRows(doc, lang = 'en') {
  const sec = paySection(doc, lang);
  if (!sec) return [];
  const re = /<div style="margin:0 0 10px;padding:12px 14px;[^"]*"><div style="[^"]*">([^<]*)<\/div><div style="[^"]*">([^<]*)<\/div><\/div>/g;
  return [...sec.matchAll(re)].map((m) => ({ name: decode(m[1]), text: decode(m[2]) }));
}
/** [{key, value}] for every method row the LIVE panel is showing. */
function panelRows(p) {
  return p.els.payMethods.innerHTML.split('<div class="pm" data-method="').slice(1).map((chunk) => {
    const v = chunk.match(/<div class="pm-val"[^>]*>([^<]*)<\/div>/);
    return { key: chunk.slice(0, chunk.indexOf('"')), value: v ? decode(v[1]) : null };
  });
}
/** What makes a control in a saved file: something the saved file cannot run. */
const DEAD = [/<button/i, /<a[\s>]/i, /<script/i, /<form/i, /<input/i, /<select/i, /<img/i, /<svg/i, /<canvas/i,
  /\bon[a-z]+\s*=/i, /href\s*=/i, /role\s*=\s*"button"/i, /tabindex/i, /cursor:\s*pointer/i];
const deadControls = (html) => DEAD.filter((re) => re.test(html));
const NAME_KEY = { cashapp: 'pmCashApp', zelle: 'pmZelle', wire: 'pmWire', cash: 'pmCash' };

/* ======================================================================== */
/* 1. How the document is assembled, and where the new section sits         */
/* ======================================================================== */

test('the saved copy carries every method he filled in, in the live panel\'s order, with its details', async () => {
  const { doc } = await savedCopy(FULL);
  const rows = savedRows(doc);
  assert.deepEqual(rows.map((r) => r.name), ['Cash App', 'Zelle', 'Wire transfer', 'Cash']);
  assert.equal(rows[0].text, '$TestFenceCo');
  assert.equal(rows[1].text, 'pay@testfence.example');
  assert.equal(rows[2].text, FULL.wire, 'wire instructions keep the line breaks he typed');
  assert.equal(rows[3].text, LTABLE.en.pmCashHow, 'cash is a sentence, not a value box');
});

test('the section sits after the Pricing section and before the approval record, like the live page', async () => {
  const { doc } = await savedCopy(FULL);
  const scope = doc.indexOf('Vinyl fence');
  const pricing = doc.indexOf('$12,400.00');
  const pay = doc.indexOf('>' + LTABLE.en.howToPayHead + '</h2>');
  const approval = doc.indexOf('Approved by Pat Buyer.');
  assert.ok(scope > 0 && pricing > scope && pay > pricing && approval > pay, [scope, pricing, pay, approval].join(' < '));
});

test('POSITIVE CONTROL: with nothing else changed, the same page DOES show the live panel, so the cases below can fail', async () => {
  const { p } = await savedCopy(FULL);
  assert.equal(p.els.payHow.style.display, '');
  assert.ok(p.els.payMethods.innerHTML.includes('pm-copy'), 'the live panel has Copy buttons');
  assert.equal(panelRows(p).length, 4);
});

/* ======================================================================== */
/* 2. A control in a saved file does nothing, so there is none               */
/* ======================================================================== */

test('the saved section has no button, link, script, form, handler or image: nothing in it can be a dead control', async () => {
  const { doc } = await savedCopy(FULL);
  const sec = paySection(doc);
  assert.ok(sec && sec.length > 200, 'could not find the section');
  assert.deepEqual(deadControls(sec).map(String), [], 'the saved section contains a control it cannot run:\n' + sec);
  // The whole saved file, too: this page-built document has never carried
  // script, and adding the pay section must not be what introduces one.
  assert.ok(!/<script|<button|<link\b/i.test(doc), 'the saved file gained a control or an external dependency');
});

test('PLANTED FAILURE: lifting the live panel\'s markup into the file WOULD put dead Copy buttons in it, and this check sees them', async () => {
  const { p } = await savedCopy(FULL);
  const naive = p.buildQuoteDocument({
    lang: 'en', title: 't', companyName: 'c', companyContact: '', customerHeading: 'q', customerName: 'n', address: '',
    scopeHeading: 's', scopeHtml: SCOPE, totalsHeading: 'p', totalsHtml: TOTALS, approvalText: '',
  }).replace('</body>', '<div class="paym">' + p.els.payMethods.innerHTML + '</div></body>');
  assert.ok(deadControls(naive).length > 0, 'the check must fire on the naive approach');
  assert.match(naive, /<button type="button" class="pm-copy"/, 'the naive approach carries the live Copy buttons');
});

test('the value is plain text she can select: a real text node, selection allowed, long values wrap', async () => {
  const { doc } = await savedCopy(FULL);
  const sec = paySection(doc);
  for (const v of ['$TestFenceCo', 'pay@testfence.example']) assert.ok(sec.includes('>' + v + '</div>'), v + ' is a plain text node');
  // The value box carries the rules that make it usable: it may be selected,
  // it keeps the wire instruction's line breaks, and a long run of digits
  // breaks anywhere instead of pushing the page sideways on a phone.
  const valueBox = sec.match(/<div style="font-size:16\.5px[^"]*">/);
  assert.ok(valueBox, 'no value box found');
  for (const rule of [/user-select:text/, /white-space:pre-wrap/, /overflow-wrap:anywhere/]) assert.match(valueBox[0], rule);
  assert.ok(!/user-select:none/.test(sec), 'nothing in the section may stop selection');
});

test('every element of the section carries its own inline style: none depends on a stylesheet rule the saved file does not have', async () => {
  const { doc } = await savedCopy(FULL);
  const sec = paySection(doc);
  const tags = [...sec.matchAll(/<(div|p|h2)\b([^>]*)>/g)];
  assert.ok(tags.length >= 10, 'expected the heading, lead, four boxes and notes; found ' + tags.length);
  for (const [tag, name, attrs] of tags) {
    assert.match(attrs, /\sstyle="/, tag + ' has no inline style');
    assert.ok(!/\sclass=|\sid=/.test(attrs), tag + ' leans on a class or id the saved file has no rule for');
  }
  // The saved file's <style> block exists for the totals rows. Nothing here may
  // lean on it, including through the variables it defines: strip it (a mail
  // client does) and a var(--muted) would silently become no colour at all.
  assert.ok(!/var\(--/.test(sec), 'the section uses a CSS variable only the <style> block defines');
});

/* ======================================================================== */
/* 3. Show only what he filled in                                            */
/* ======================================================================== */

test('a method with no details has no row in the file (blank, whitespace, null, wrong type)', async () => {
  for (const empty of ['', '   ', '\n\t', null, undefined, 0, false, true, {}, []]) {
    for (const key of ['cashapp', 'zelle', 'wire']) {
      const { doc } = await savedCopy({ [key]: empty });
      assert.equal(paySection(doc), null, key + ' = ' + JSON.stringify(empty) + ' must not make a row or a heading');
    }
  }
  for (const notOn of [false, '', null, undefined, 0, 1, 'true', 'yes', {}, []]) {
    const { doc } = await savedCopy({ cash: notOn });
    assert.equal(paySection(doc), null, 'cash = ' + JSON.stringify(notOn));
  }
  // POSITIVE CONTROL: each of them, filled in, does make exactly one row.
  for (const key of ['cashapp', 'zelle', 'wire', 'cash']) {
    const { doc } = await savedCopy({ [key]: FULL[key] });
    assert.equal(savedRows(doc).length, 1, key);
  }
});

test('only the methods he filled in are in the file, and the others are not even named', async () => {
  const { doc } = await savedCopy({ zelle: 'pay@testfence.example' });
  const sec = paySection(doc);
  assert.deepEqual(savedRows(doc).map((r) => r.name), ['Zelle']);
  for (const k of ['pmCashApp', 'pmWire', 'pmCash', 'pmCashHow']) {
    assert.ok(!sec.includes(LTABLE.en[k]), k + ' leaked into a section where he did not turn it on');
  }
  assert.ok(!sec.includes('Cash App'), 'Cash App is not named');
  assert.ok(!sec.toLowerCase().includes('wire'), 'wire is not named');
});

test('nothing filled in: NO section at all -- no heading, no lead, no empty box', async () => {
  for (const methods of [{}, { cashapp: '   ', zelle: '', wire: '\n', cash: false }]) {
    const { doc } = await savedCopy(methods);
    assert.equal(paySection(doc), null);
    for (const lang of ['en', 'es', 'fr']) {
      assert.ok(!doc.includes(LTABLE[lang].howToPayHead), 'the heading is in a file with nothing under it');
      assert.ok(!doc.includes(LTABLE[lang].howToPayLead), 'the lead is in a file with nothing under it');
    }
  }
});

test('an old quote-view (no payment field at all) saves a file with no section, nothing else added to it', async () => {
  const p = page({ dueNow: 250 });
  const q = quoteWith({});
  delete q.paymentMethods;
  p.setQuote(q);
  p.renderHowToPay(q, 913.37);
  p.els.scope.innerHTML = SCOPE; p.els.totals.innerHTML = TOTALS; p.els.approvedText.textContent = 'Approved by Pat Buyer.';
  await p.downloadQuoteCopy();
  const doc = p.saved.text;
  assert.equal(paySection(doc), null);
  // The totals are followed straight by the approval record, as before.
  assert.ok(doc.includes('</div></div>' + APPROVAL_AT), 'the totals should be followed straight by the approval strip');
  const unchanged = p.buildQuoteDocument({
    lang: 'en', title: p.tr('downloadTitle', 'Pat Buyer'), companyName: 'Test Fence Co',
    companyContact: '(555) 010-0100 · office@testfence.example', customerHeading: p.tr('quoteFor', 'Pat Buyer'),
    customerName: 'Pat Buyer', address: '1 Test Lane', scopeHeading: p.tr('scopeHeading'), scopeHtml: SCOPE,
    totalsHeading: p.tr('totalsHeading'), totalsHtml: TOTALS, approvalText: 'Approved by Pat Buyer.',
    signatureDataUrl: null, signatureAlt: p.tr('signatureAlt'),
  });
  assert.equal(doc, unchanged, 'downloadQuoteCopy added something to a quote with no payment methods');
});

test('the builder itself drops a row with no text, so even a bad caller cannot print an empty line', () => {
  const p = page();
  const base = { lang: 'en', title: 't', companyName: 'c', companyContact: '', customerHeading: 'q', customerName: 'n', address: '',
    scopeHeading: 's', scopeHtml: SCOPE, totalsHeading: 'p', totalsHtml: TOTALS, approvalText: '' };
  const model = (rows) => ({ heading: 'How to pay', lead: 'lead', rows, notes: [] });
  const none = p.buildQuoteDocument({ ...base, pay: model([{ name: 'Cash App', value: '' }, { name: 'Zelle', value: '   ' }, { name: 'Wire', value: undefined }]) });
  assert.ok(!none.includes('How to pay'), 'every row was empty, so there is nothing to put a heading over');
  const some = p.buildQuoteDocument({ ...base, pay: model([{ name: 'Cash App', value: '' }, { name: 'Zelle', value: 'pay@testfence.example' }]) });
  assert.deepEqual(savedRows(some).map((r) => r.name), ['Zelle']);
  // PLANTED: the helper that reads rows back does see an empty box if one is there.
  const bad = '<h2 style="x">How to pay</h2><div style="margin:0 0 10px;padding:12px 14px;x"><div style="y">Cash App</div><div style="z"></div></div></body>';
  assert.deepEqual(savedRows(bad).map((r) => r.text), [''], 'the reader would show an empty row if the builder emitted one');
});

/* ======================================================================== */
/* 4. The file and the live panel agree, always                              */
/* ======================================================================== */

test('for every combination of methods, the file lists exactly the methods the live panel lists, with the same values', async () => {
  const keys = ['cashapp', 'zelle', 'wire', 'cash'];
  let checked = 0;
  for (let mask = 0; mask < 16; mask++) {
    const methods = {};
    keys.forEach((k, i) => { if (mask & (1 << i)) methods[k] = FULL[k]; });
    const { doc, p } = await savedCopy(methods);
    const live = panelRows(p);
    const saved = savedRows(doc);
    assert.deepEqual(saved.map((r) => r.name), live.map((r) => LTABLE.en[NAME_KEY[r.key]]), 'mask ' + mask);
    saved.forEach((r, i) => {
      if (live[i].key === 'cash') assert.equal(r.text, LTABLE.en.pmCashHow);
      else assert.equal(r.text, live[i].value, 'mask ' + mask + ' ' + live[i].key);
    });
    checked += live.length;
  }
  assert.equal(checked, 32, 'fifteen non-empty combinations of four methods list 32 rows between them');
});

test('nothing left to pay: the panel hides and the file has no section, with the methods still on the quote', async () => {
  for (const balance of [0, 0.004, -5, NaN, undefined, null]) {
    const { doc, p } = await savedCopy(FULL, { balance });
    assert.equal(p.els.payHow.style.display, 'none', 'balance ' + balance);
    assert.equal(paySection(doc), null, 'balance ' + balance + ' left a how-to-pay section in a paid-up file');
  }
  // POSITIVE CONTROL: the same quote with a balance owed does have one.
  assert.equal(savedRows((await savedCopy(FULL, { balance: 100 })).doc).length, 4);
});

test('a re-render that hides the panel empties the list the file is built from (no stale methods in the next download)', async () => {
  const p = page();
  const q = quoteWith(FULL);
  p.setQuote(q);
  p.els.scope.innerHTML = SCOPE; p.els.totals.innerHTML = TOTALS;
  p.renderHowToPay(q, 900);
  await p.downloadQuoteCopy();
  assert.equal(savedRows(p.saved.text).length, 4);
  p.renderHowToPay(q, 0); // she paid in full; the page re-rendered
  await p.downloadQuoteCopy();
  assert.equal(savedRows(p.saved.text).length, 0);
  assert.equal(paySection(p.saved.text), null);
});

test('the card is not offered in the file: there is no button in a file for a row to point at', async () => {
  const { doc, p } = await savedCopy({ zelle: 'pay@testfence.example' }, { dueNow: 250 });
  // POSITIVE CONTROL: the live panel, on this very quote, does have the card row and the "skips the card" sentence.
  assert.ok(p.els.payMethods.innerHTML.includes(LTABLE.en.pmCard));
  assert.ok(p.els.payNotes.innerHTML.includes('skips the card checkout'));
  for (const lang of ['en', 'es', 'fr']) {
    for (const k of ['pmCard', 'pmCardHow']) assert.ok(!doc.includes(LTABLE[lang][k]), k + ' is in the file');
  }
  assert.ok(!doc.includes('skips the card'));
  assert.ok(!/payment button/i.test(doc));
});

test('the "put your name in the note" sentence follows the same rule as the live panel, for every combination', () => {
  const p = page();
  for (let mask = 1; mask < 16; mask++) {
    const q = { paymentMethods: { cashApp: mask & 1 ? 'x' : '', zelle: mask & 2 ? 'x' : '', wire: mask & 4 ? 'x' : '', cash: !!(mask & 8) } };
    const methods = p.payMethodsFrom(q);
    assert.ok(methods.length > 0, 'mask ' + mask);
    const live = p.payHowModel(q, 900, true);
    assert.equal(live.show, true);
    assert.equal(p.payDocModel(methods, '').notes.includes(p.tr('pmNameNote')), live.nameNote, 'mask ' + mask);
  }
});

/* ======================================================================== */
/* 5. No figure is restated                                                  */
/* ======================================================================== */

test('the section prints no amount of its own: the balance, total and deposit never appear in it', async () => {
  const { doc } = await savedCopy(FULL, { balance: 913.37 });
  const sec = paySection(doc);
  // Take out what the contractor typed (a wire instruction is a run of digits
  // by nature) and the one date; whatever is left is ours.
  let ours = sec;
  for (const v of Object.values(FULL).filter((x) => typeof x === 'string')) ours = ours.split(v.replace(/&/g, '&amp;')).join('');
  ours = ours.split(dateIn('en')).join('');
  const text = ours.replace(/<[^>]*>/g, ' ');
  assert.ok(!/\d/.test(text), 'a digit appeared in text that is not his: ' + text);
  assert.ok(!/[$€£]/.test(text), 'a currency sign appeared in text that is not his: ' + text);
  assert.ok(!/913|12,?400|3,?100/.test(sec), 'a pricing figure leaked into the section');
  // The amounts exist once in the file, in the Pricing section, where they were.
  assert.equal(doc.split('$12,400.00').length - 1, 1);
  assert.equal(doc.split('$913.37').length - 1, 1);
});

test('the new sentence and the reused ones carry no digit or currency sign in any language (the date is added by the page)', () => {
  for (const lang of ['en', 'es', 'fr']) {
    for (const k of ['howToPayHead', 'howToPayLead', 'pmCashHow', 'pmNameNote', 'dlPayAsOf', 'pmCashApp', 'pmZelle', 'pmWire', 'pmCash']) {
      const text = LTABLE[lang][k].replace(/%s/g, '');
      assert.ok(!/\d/.test(text), lang + '.' + k + ' contains a digit: ' + text);
      assert.ok(!/[$€£]/.test(text), lang + '.' + k + ' contains a currency sign');
    }
  }
});

/* ======================================================================== */
/* 6. A snapshot says when it is a snapshot                                  */
/* ======================================================================== */

test('the file dates itself in the section, because the amounts above it are as they were when she saved it', async () => {
  const { doc } = await savedCopy(FULL);
  assert.ok(doc.includes(dateIn('en')), 'no date: ' + dateIn('en'));
  assert.ok(doc.includes(LTABLE.en.dlPayAsOf.replace('%s', dateIn('en'))));
  assert.ok(!doc.includes('%s'), 'an unfilled %s reached the file');
});

test('the date sentence is part of the section, so a file with no section has no stray "as of" line', async () => {
  const { doc } = await savedCopy({});
  for (const lang of ['en', 'es', 'fr']) assert.ok(!doc.includes(LTABLE[lang].dlPayAsOf.split('%s')[0]));
  assert.equal(page().payDocModel([], dateIn('en')), null);
  assert.equal(page().payDocModel(null, dateIn('en')), null);
  // And with no date supplied there is no sentence rather than a hole.
  const m = page().payDocModel([{ key: 'zelle', value: 'pay@testfence.example' }], '');
  assert.ok(m.notes.every((n) => !n.includes('%s') && n !== ''));
});

/* ======================================================================== */
/* 7. A value he typed is text, never HTML                                   */
/* ======================================================================== */

test('a value the contractor typed is escaped in the file, never run as HTML', async () => {
  const hostile = '<img src=x onerror=alert(1)>"&</div><script>alert(2)</script>';
  const { doc } = await savedCopy({ zelle: hostile, cashapp: '$A&B' });
  const sec = paySection(doc);
  assert.ok(!/<img|<script/i.test(sec), sec);
  assert.ok(sec.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&lt;/div&gt;&lt;script&gt;alert(2)&lt;/script&gt;'), sec);
  assert.deepEqual(savedRows(doc).map((r) => r.text), ['$A&B', hostile], 'the reader recovers exactly what he typed');
});

/* ======================================================================== */
/* 8. Three languages                                                        */
/* ======================================================================== */

const NEW_KEYS = ['dlPayAsOf'];
const REUSED = ['howToPayHead', 'howToPayLead', 'pmCashApp', 'pmZelle', 'pmWire', 'pmCash', 'pmCashHow', 'pmNameNote'];
const SAME_EVERYWHERE = new Set(['pmCashApp', 'pmZelle']); // proper nouns

test('three languages: the new sentence exists in English, Spanish and French, with one hole each, and is translated', () => {
  for (const lang of ['en', 'es', 'fr']) {
    for (const k of NEW_KEYS) {
      assert.equal(typeof LTABLE[lang][k], 'string', lang + '.' + k + ' is missing');
      assert.ok(LTABLE[lang][k].trim().length > 0);
      assert.equal((LTABLE[lang][k].match(/%s/g) || []).length, 1, lang + '.' + k + ' must have exactly one %s hole');
    }
  }
  assert.notEqual(LTABLE.es.dlPayAsOf, LTABLE.en.dlPayAsOf);
  assert.notEqual(LTABLE.fr.dlPayAsOf, LTABLE.en.dlPayAsOf);
  assert.notEqual(LTABLE.fr.dlPayAsOf, LTABLE.es.dlPayAsOf);
});

test('three languages: no key was added to only some of them', () => {
  const keys = (l) => Object.keys(LTABLE[l]).sort();
  assert.deepEqual(keys('es'), keys('en'));
  assert.deepEqual(keys('fr'), keys('en'));
});

for (const lang of ['en', 'es', 'fr']) {
  test('three languages: the file built for a reader in "' + lang + '" is in that language, compared by key', async () => {
    const { doc } = await savedCopy(FULL, { lang });
    assert.match(doc, new RegExp('<html lang="' + lang + '">'));
    const sec = paySection(doc, lang);
    assert.ok(sec, 'no section in ' + lang);
    const inSec = (s) => sec.includes(s.replace(/&/g, '&amp;'));
    for (const k of ['howToPayHead', 'howToPayLead', 'pmCashHow', 'pmNameNote']) assert.ok(inSec(LTABLE[lang][k]), lang + '.' + k + ' missing from the file');
    for (const k of ['pmCashApp', 'pmZelle', 'pmWire', 'pmCash']) assert.ok(inSec(LTABLE[lang][k]), lang + '.' + k + ' missing from the file');
    assert.ok(inSec(LTABLE[lang].dlPayAsOf.replace('%s', dateIn(lang))), lang + ' as-of sentence missing or the date is not formatted for ' + lang);
    assert.ok(!doc.includes('%s'));
    if (lang !== 'en') {
      // None of the English sentences, whole, anywhere in the file. Compared as
      // whole strings by key; never "does it contain the word X".
      for (const k of ['howToPayHead', 'howToPayLead', 'pmCashHow', 'pmNameNote']) {
        assert.ok(!doc.includes(LTABLE.en[k]), lang + ' file still has the English ' + k + ': ' + LTABLE.en[k]);
      }
      assert.ok(!doc.includes(LTABLE.en.dlPayAsOf.split('%s')[0]), lang + ' file still has the English as-of sentence');
      for (const k of ['pmWire', 'pmCash']) {
        assert.ok(!sec.includes('>' + LTABLE.en[k] + '<'), lang + ' file still labels a box with the English ' + k);
      }
    }
  });
}

test('three languages: every reused key is real in all three (a renamed key would silently print nothing)', () => {
  for (const lang of ['en', 'es', 'fr']) for (const k of REUSED) {
    assert.ok(typeof LTABLE[lang][k] === 'string' && LTABLE[lang][k].trim(), lang + '.' + k);
    if (!SAME_EVERYWHERE.has(k)) {
      if (lang !== 'en') assert.notEqual(LTABLE[lang][k], LTABLE.en[k], lang + '.' + k + ' is still English');
    }
  }
});

test('three languages: the new sentence does not say a fee is charged or explain the deposit (the page\'s two honesty scans)', () => {
  const FEE = { en: /\bfees?\b|surcharge|processing charge|service charge/i, es: /comisi[oó]n|recargo|cargo (adicional|extra)|tarifa/i, fr: /\bfrais\b|supplément|supplement|commission|majoration/i };
  const DEPOSIT = [/transport/i, /surcharge|recargo|suppl[eé]ment/i, /mobili[sz]ation/i, /rounded?\s+up/i, /next\s+(\$\s?)?hundred/i];
  for (const lang of ['en', 'es', 'fr']) {
    assert.ok(!FEE[lang].test(LTABLE[lang].dlPayAsOf), lang);
    for (const re of DEPOSIT) assert.ok(!re.test(LTABLE[lang].dlPayAsOf), lang + ' ' + re);
  }
});

/* ======================================================================== */
/* 9. The wiring, and the page still loads                                   */
/* ======================================================================== */

test('downloadQuoteCopy hands the section to the builder from the live panel\'s list, with the page\'s own language and date', () => {
  const body = grabFn('downloadQuoteCopy');
  assert.match(body, /pay:\s*payDocModel\(payList,\s*new Date\(\)\.toLocaleDateString\(LANG\)\)/);
  const model = grabFn('payDocModel');
  // The model is built from the list it is given, and from nothing else on the
  // page: it does not re-read the quote, so it cannot show a method the panel
  // is not showing.
  assert.ok(!/\bquote\b|paymentMethods|payMethodsFrom|\$\(/.test(model), 'payDocModel reaches for something other than its arguments');
});

test('the saved file declares a mobile viewport, so the Cash App tag is readable on the phone she opens it on', async () => {
  const { doc } = await savedCopy(FULL);
  assert.match(doc, /<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">/);
  // And the only thing that reads the viewport is the file's own head: no script.
  assert.ok(!/<script/i.test(doc));
});

test('the saved file is still an .html document, as before (PDF is a separate decision, see the report)', async () => {
  const { p } = await savedCopy(FULL);
  assert.equal(p.saved.name, 'pat-buyer-quote.html');
  assert.match(p.saved.text, /^<!doctype html>/i);
  assert.match(p.saved.text, /<\/html>$/);
});

test('every inline <script> of quote.html still compiles (a stray apostrophe once blanked the whole page)', () => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0;
  while ((m = re.exec(src))) { n++; new vm.Script(m[1], { filename: 'quote.html inline script ' + n }); }
  assert.ok(n >= 2, 'expected the translation script and the page script; found ' + n);
  // PLANTED: the same check does fail on the mistake it exists for.
  assert.throws(() => new vm.Script("const s = 'it's';"));
});

test('quote.html still has one page script and the file is still CRLF throughout (no mixed line endings from the edit)', () => {
  assert.equal((src.match(/(?<!\r)\n/g) || []).length, 0, 'a bare LF crept into a CRLF file');
  assert.equal((src.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []).length, 2);
});
