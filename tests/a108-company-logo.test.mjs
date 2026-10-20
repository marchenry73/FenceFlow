// A108 -- the company's own logo, on the documents its customers see.
//
// Run with:  node --test tests/a108-company-logo.test.mjs
//
// Pure: no network, no database, no clock. composeBody is imported and run for
// real; everything else is read out of the source files, because a static page
// and an edge function cannot be executed here. Every source-slicing check is
// paired with a CANARY that sabotages a copy of the same text and asserts the
// check would have gone red -- a guard that reads a comment, or reads a region
// that has moved, reports "clean" for code it never looked at.
//
// WHAT IS BEING GUARDED, in one line each:
//   * the bucket is PRIVATE and raster-only, and only an OWNER may write it;
//   * every surface signs a URL -- the storage path never leaves the server;
//   * the letterhead is in the HTML part and NOT in the plain-text part;
//   * an email's URL outlives the email, and a page's does not have to;
//   * nothing anywhere fails because a picture could not be signed;
//   * the office uploads in the order that cannot leave a broken image live.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeBody } from "../supabase/functions/_shared/mail/mime-build.ts";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

const SQL = "supabase_r18_company_logo.sql";
const QUOTE_VIEW = "supabase/functions/quote-view/index.ts";
const QUOTE_PAGE = "website/quote.html";
const DASH = "website/dashboard.html";
const KT_LOGO = "app/src/main/java/com/fenceestimator/app/cloud/CompanyLogo.kt";
const KT_PDF = "app/src/main/java/com/fenceestimator/app/estimate/PdfExporter.kt";
const KT_SETTINGS = "app/src/main/java/com/fenceestimator/app/ui/settings/SettingsScreen.kt";
const KT_SESSION = "app/src/main/java/com/fenceestimator/app/cloud/SessionManager.kt";
const KT_CROP = "app/src/main/java/com/fenceestimator/app/ui/settings/LogoCrop.kt";
const KT_CROP_UI = "app/src/main/java/com/fenceestimator/app/ui/settings/LogoCropDialog.kt";
const KT_JOBS = "app/src/main/java/com/fenceestimator/app/ui/jobs/JobsListScreen.kt";
const WELCOME = "website/welcome.html";
const MAIL_SEND = "supabase/functions/mail-send/index.ts";
const CALLER = "supabase/functions/_shared/mail/caller.ts";
const FOLLOW_UPS = "supabase/functions/send-follow-ups/index.ts";
const APPROVAL = "supabase/functions/quote-approval-email/index.ts";

/** A source file with every // and block comment blanked, newlines preserved,
 *  and STRING LITERALS LEFT ALONE.
 *
 *  The string-literal part is not a nicety. The first version of this did not
 *  know about them, and `picker.launch("image/*")` in SettingsScreen.kt opened
 *  what it took to be a block comment -- so everything after that line was
 *  blanked and a check looking for `enabled = canChange` reported the control
 *  ungated when it was gated on the very next line. A stripper that can eat
 *  the rest of a file is an auditor that reports clean for code it never read.
 *
 *  Without this, a check could also be satisfied by a sentence ABOUT the code
 *  rather than the code, which is the other half of why it exists.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const blank = (ch) => (ch === "\n" ? "\n" : " ");
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    // A string or template literal: copied through, so nothing inside it can
    // open a comment.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i++;
      while (i < src.length) {
        if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        // An unterminated literal (a lone apostrophe in prose) must not run to
        // the end of the file: stop at the newline and carry on.
        if (src[i] === "\n" && quote !== "`") { i++; break; }
        i++;
      }
      continue;
    }
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
    } else if (two === "/*") {
      while (i < src.length && src.slice(i, i + 2) !== "*/") { out += blank(src[i]); i++; }
      out += "  "; i += 2;
    } else if (src.slice(i, i + 4) === "<!--") {
      while (i < src.length && src.slice(i, i + 3) !== "-->") { out += blank(src[i]); i++; }
      out += "   "; i += 3;
    } else { out += c; i++; }
  }
  return out;
}

/** A .sql file with every `--` comment blanked, newlines preserved.
 *  stripComments() handles //, block comments and <!-- and so leaves SQL
 *  comments whole -- which is how a `;` inside one came to bound the INSERT
 *  below after four lines, leaving three checks reading text that did not
 *  contain what they were looking for either way. */
function stripSql(src) {
  return src.split("\n").map((line) => {
    const at = line.indexOf("--");
    return at < 0 ? line : line.slice(0, at);
  }).join("\n");
}

/** The bucket INSERT alone, bounded at its own semicolon. Taking the rest of
 *  the file would sweep in PART 3's proof queries, which name 'image/svg+xml'
 *  and `public = false` in order to assert they are absent -- so a check could
 *  pass by reading the proof that proves it. */
function bucketInsert() {
  const sql = stripSql(read(SQL));
  const at = sql.indexOf("insert into storage.buckets");
  assert.ok(at > 0, "the bucket is never created");
  const end = sql.indexOf(";", at);
  assert.ok(end > at, "the bucket INSERT has no end");
  return sql.slice(at, end + 1);
}

/** The { ... } block starting at `open`, braces balanced, string literals and
 *  comments already gone (callers pass stripped source). Positional checks are
 *  not enough for "this branch must not do X": a statement inside the branch
 *  is after its opening line too. */
function braced(src, open) {
  if (open < 0 || src[open] !== "{") return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

// ===========================================================================
// 1. THE BUCKET
// ===========================================================================

test("the bucket is private, size-capped and raster-only", () => {
  const insert = bucketInsert();
  assert.ok(/'company-logos'/.test(insert), "the bucket is not called company-logos");
  // false in the INSERT and false again in the ON CONFLICT: a re-run of this
  // file must not be able to leave a bucket somebody flipped public.
  assert.ok(/values\s*\([^)]*false/s.test(insert), "the bucket is not created private");
  assert.ok(/do update[\s\S]*public\s*=\s*false/.test(insert),
    "a re-run does not force public back to false, so a flipped bucket would stay flipped");
  assert.ok(/2097152/.test(insert), "the 2 MB cap is gone");
  for (const mime of ["image/png", "image/jpeg", "image/webp"]) {
    assert.ok(insert.includes(mime), `${mime} is no longer accepted`);
  }
  assert.ok(!insert.includes("image/svg+xml"),
    "SVG is accepted again -- a signed URL opened directly would run its script on the Supabase domain");
});

test("only an OWNER may write the bucket, and every member may read it", () => {
  const sql = stripSql(read(SQL));
  const policy = (name) => {
    const at = sql.indexOf("create policy " + name);
    assert.ok(at > 0, `policy ${name} is gone`);
    // To the next create/alter/insert statement.
    const rest = sql.slice(at);
    const end = rest.slice(10).search(/\n(create|alter|insert|comment|select) /);
    return end < 0 ? rest : rest.slice(0, end + 10);
  };
  for (const w of ["company_logos_insert", "company_logos_update", "company_logos_delete"]) {
    assert.ok(/'OWNER'/.test(policy(w)), `${w} no longer requires OWNER`);
    assert.ok(/company_id/.test(policy(w)), `${w} is no longer scoped to the caller's own company`);
  }
  const r = policy("company_logos_read");
  assert.ok(/company_id/.test(r), "the read policy is no longer company-scoped");
  assert.ok(!/'OWNER'/.test(r),
    "the read policy now requires OWNER -- a crew phone could not fetch the logo for a PDF");
});

test("CANARY: a public bucket, an SVG, and an OWNER-gated read each turn those checks red", () => {
  const sql = stripSql(read(SQL));
  const insert = bucketInsert();

  // Teeth for "private": flipping the ON CONFLICT value must break the check.
  const flipped = insert.replace(/do update([\s\S]*?)public\s*=\s*false/, "do update$1public = true");
  assert.notEqual(flipped, insert, "the canary did not change the source");
  assert.ok(!/do update[\s\S]*public\s*=\s*false/.test(flipped),
    "THE CANARY DID NOT FAIL: a bucket forced public on re-run would have passed");

  // Teeth for "no SVG".
  const svg = insert.replace("'image/webp'", "'image/webp', 'image/svg+xml'");
  assert.notEqual(svg, insert, "the canary did not change the source");
  assert.ok(svg.includes("image/svg+xml"),
    "THE CANARY DID NOT FAIL: an SVG added to the allow-list went unnoticed");

  // Teeth for "the read is not OWNER-gated".
  const at = sql.indexOf("create policy company_logos_read");
  const readPolicy = sql.slice(at, sql.indexOf("drop policy", at + 10));
  const gated = readPolicy.replace("bucket_id = 'company-logos'", "bucket_id = 'company-logos' and 'OWNER' = 'OWNER'");
  assert.notEqual(gated, readPolicy, "the canary did not change the source");
  assert.ok(/'OWNER'/.test(gated),
    "THE CANARY DID NOT FAIL: an OWNER test added to the read policy went unnoticed");
});

// ===========================================================================
// 2. THE LETTERHEAD -- composeBody, run for real
// ===========================================================================

const LETTER = "Hi Dana,\n\nYour quote is ready.\n";

test("no logo leaves the body exactly as it was", () => {
  const before = composeBody({ text: LETTER });
  for (const absent of [undefined, null, "", "   "]) {
    const after = composeBody({ text: LETTER, logoUrl: absent, logoAlt: "Acme Fence" });
    assert.equal(after.html, before.html, `logoUrl ${JSON.stringify(absent)} changed the HTML`);
    assert.equal(after.text, before.text, `logoUrl ${JSON.stringify(absent)} changed the text`);
  }
});

test("the letterhead is in the HTML part and NOT in the plain-text part", () => {
  const url = "https://ref.supabase.co/storage/v1/object/sign/company-logos/c/logo-1.png?token=abc";
  const out = composeBody({ text: LETTER, logoUrl: url, logoAlt: "Acme Fence" });
  assert.ok(out.html.includes(`src="${url}"`), "the HTML part has no letterhead");
  assert.ok(out.html.includes('alt="Acme Fence"'),
    "the letterhead has no alt text -- a client that blocks images would show nothing");
  assert.ok(!out.text.includes(url),
    "the signed URL is in the plain-text part, where it reads as a line of noise");
  assert.ok(!out.text.includes("<img"), "markup reached the plain-text part");
  // The letter itself still arrives, both ways.
  assert.ok(out.text.includes("Your quote is ready."), "the plain-text letter is gone");
  assert.ok(out.html.includes("Your quote is ready."), "the HTML letter is gone");
  // And the picture comes FIRST, which is what makes it a letterhead rather
  // than an illustration in the middle of the letter.
  assert.ok(out.html.indexOf("<img") < out.html.indexOf("Your quote is ready."),
    "the logo is not above the letter");
});

test("only https reaches the src attribute", () => {
  for (const bad of [
    "javascript:alert(1)",
    "data:image/png;base64,iVBORw0KGgo=",
    "http://ref.supabase.co/logo.png",
    "//ref.supabase.co/logo.png",
    "not a url at all",
    "HTTPS:\u0000//x/y.png",
  ]) {
    const out = composeBody({ text: LETTER, logoUrl: bad, logoAlt: "Acme" });
    assert.ok(!out.html.includes("<img"), `${bad} produced an <img> tag`);
    assert.equal(out.html, composeBody({ text: LETTER }).html, `${bad} changed the HTML at all`);
  }
});

test("a logo URL cannot break out of its own attribute", () => {
  // Not a reachable input -- the only caller signs a storage URL -- but the
  // escaping is what makes that a fact about today rather than for ever.
  const nasty = 'https://x/y.png" onerror="alert(1)';
  const out = composeBody({ text: LETTER, logoUrl: nasty, logoAlt: 'Acme" onload="alert(2)' });
  assert.ok(!/onerror=/.test(out.html.replace(/&quot;/g, "")) || !out.html.includes('onerror="alert'),
    "an event handler escaped into the tag");
  assert.ok(!out.html.includes('onload="alert'), "an event handler escaped out of the alt text");
});

test("the letterhead rides with the signature and the footer, not instead of them", () => {
  const url = "https://ref.supabase.co/x/logo.png?token=t";
  const out = composeBody({
    text: LETTER, signature: "Marc\nAcme Fence", footer: "Sent by Acme Fence using FenceFlow",
    logoUrl: url, logoAlt: "Acme Fence",
  });
  assert.ok(out.html.includes("<img"), "the letterhead is gone when a signature is present");
  assert.ok(out.html.includes("Acme Fence using FenceFlow"), "the footer is gone");
  assert.ok(out.text.includes("-- \nMarc"), "the plain-text signature is gone");
});

// ===========================================================================
// 3. THE SERVER SURFACES -- a path is never handed out, a failure never blocks
// ===========================================================================

test("quote-view signs the logo and sends a URL, never the storage path", () => {
  const src = stripComments(read(QUOTE_VIEW));
  assert.ok(src.includes('.from("company-logos").createSignedUrl('),
    "quote-view no longer signs the logo");
  assert.ok(/logo_path/.test(src), "quote-view no longer reads companies.logo_path");
  assert.ok(/logoUrl,?\s*\n/.test(src) || src.includes("logoUrl"),
    "quote-view no longer sends a logoUrl");
  // The payload must carry the URL and NOT the path. Anchored on the object's
  // own first key: quote-view answers `return json({` in a dozen places, and
  // indexOf finds an early refusal instead of the quote itself.
  const payloadAt = src.indexOf("company: {");
  assert.ok(payloadAt > 0, "quote-view's customer-facing payload is gone");
  const payload = src.slice(payloadAt, src.indexOf("\n  });", payloadAt));
  assert.ok(payload.length > 200, "the payload slice did not reach the end of the object");
  assert.ok(payload.includes("logoUrl"), "logoUrl is not in the payload");
  assert.ok(!/logo_path/.test(payload),
    "the raw storage path is in the customer-facing payload");
});

test("every signer swallows its own failure, so no letter or page dies over a picture", () => {
  for (const [file, fnName] of [
    [QUOTE_VIEW, "companyLogoUrl"],
    [MAIL_SEND, "logoUrlFor"],
  ]) {
    const src = stripComments(read(file));
    const at = src.indexOf("function " + fnName);
    assert.ok(at > 0, `${fnName} is gone from ${file}`);
    const body = src.slice(at, at + 1600);
    assert.ok(/try\s*\{/.test(body), `${fnName} no longer catches its own failure`);
    assert.ok(/catch/.test(body), `${fnName} no longer catches its own failure`);
    assert.ok(/return null/.test(body), `${fnName} no longer answers null on failure`);
  }
  // The two that sign inline rather than in a named function.
  for (const file of [FOLLOW_UPS, APPROVAL]) {
    const src = stripComments(read(file));
    const at = src.indexOf('from("company-logos")');
    assert.ok(at > 0, `${file} no longer signs a logo`);
    const around = src.slice(Math.max(0, at - 400), at + 600);
    assert.ok(/try\s*\{/.test(around) && /catch/.test(around),
      `${file} signs the logo without catching a failure`);
  }
});

test("the service-role signers check the company id against the path themselves", () => {
  // Policies do not apply to the service role, so the one thing stopping a
  // company's row from naming another company's object is this check.
  for (const file of [MAIL_SEND, FOLLOW_UPS, APPROVAL]) {
    const src = stripComments(read(file));
    const at = src.indexOf('from("company-logos")');
    assert.ok(at > 0, `${file} no longer signs a logo`);
    const around = src.slice(Math.max(0, at - 900), at + 300);
    assert.ok(/startsWith\(/.test(around),
      `${file} signs a path without checking it is inside the caller's own company folder`);
  }
});

test("an email's URL outlives the email; a page's does not have to", () => {
  // A year for anything that lands in an inbox, because nothing can re-sign a
  // URL after the message has gone. An hour for a page, which re-fetches.
  const YEAR = "60 * 60 * 24 * 365";
  for (const file of [MAIL_SEND, FOLLOW_UPS, APPROVAL]) {
    assert.ok(stripComments(read(file)).includes(YEAR),
      `${file} no longer signs the letterhead for a year -- an email read later shows a broken image`);
  }
  const qv = stripComments(read(QUOTE_VIEW));
  const at = qv.indexOf('from("company-logos").createSignedUrl(');
  assert.ok(/createSignedUrl\([^)]*,\s*3600\)/.test(qv.slice(at, at + 200)),
    "quote-view no longer signs the logo for one hour");
});

test("the mail caller hands out the PATH, not a URL", () => {
  const src = stripComments(read(CALLER));
  assert.ok(src.includes("companyLogoPath"), "MailCaller no longer carries the logo path");
  assert.ok(src.includes("logo_path"), "the caller no longer reads companies.logo_path");
  assert.ok(!src.includes("createSignedUrl"),
    "the caller signs the URL itself, so every sender is stuck with one expiry");
});

// ===========================================================================
// 4. THE CUSTOMER'S PAGE
// ===========================================================================

test("the quote page shows the logo only when there is one, and hides a broken one", () => {
  const src = stripComments(read(QUOTE_PAGE));
  assert.ok(/id="coLogo"/.test(src), "the header has no logo element");
  // Starts hidden, in the markup, so a company without one never flashes a gap.
  const tagAt = src.indexOf('id="coLogo"');
  const tag = src.slice(src.lastIndexOf("<img", tagAt), src.indexOf(">", tagAt));
  assert.ok(/display:none/.test(tag), "the logo element does not start hidden");
  assert.ok(/max-height/.test(tag), "the logo has no height limit at all");
  // A BARE height:, not max-height: -- \\b cannot tell them apart, because the
  // hyphen before "height" is itself a word boundary.
  assert.ok(!/(^|[^-])height:\s*\d/.test(tag),
    "the logo is given a fixed height, which squashes whatever shape it really is");

  const renderAt = src.indexOf("const logoEl=$('coLogo')");
  assert.ok(renderAt > 0, "nothing renders the logo");
  const render = src.slice(renderAt, renderAt + 700);
  assert.ok(/onerror/.test(render),
    "an expired or revoked URL would leave a broken image frame in the header");
  assert.ok(/display='none'/.test(render), "nothing hides it again when there is no URL");
});

test("the saved copy inlines the logo, and never carries the signed URL", () => {
  const src = stripComments(read(QUOTE_PAGE));
  assert.ok(src.includes("logoForDownload"), "the saved copy has no logo at all");
  const fnAt = src.indexOf("async function logoForDownload");
  assert.ok(fnAt > 0, "logoForDownload is gone");
  const fn = src.slice(fnAt, fnAt + 900);
  assert.ok(/readAsDataURL/.test(fn),
    "the saved copy does not turn the logo into a data: URI -- the signed URL expires");
  assert.ok(/return null/.test(fn), "a fetch failure no longer means simply no logo");

  // The document builder must use the data URI, not the live URL.
  const docAt = src.indexOf("d.logoDataUrl");
  assert.ok(docAt > 0, "the saved document does not use the inlined copy");
  const docRegion = src.slice(src.indexOf("function buildQuoteDocument"), src.indexOf("</body></html>'"));
  assert.ok(!/logoUrl/.test(docRegion),
    "the saved document references the signed URL, which is dead an hour later");
});

test("CANARY: the saved copy reaching for the live URL turns that check red", () => {
  const src = stripComments(read(QUOTE_PAGE));
  const from = src.indexOf("function buildQuoteDocument");
  const to = src.indexOf("</body></html>'");
  const region = src.slice(from, to);
  const sabotaged = region.replace("d.logoDataUrl", "d.logoUrl");
  assert.notEqual(sabotaged, region, "the canary did not change the source");
  assert.ok(/logoUrl/.test(sabotaged),
    "THE CANARY DID NOT FAIL: a saved copy pointed at the expiring URL went unnoticed");
});

// ===========================================================================
// 5. THE OFFICE'S UPLOAD
// ===========================================================================

test("the upload order cannot leave logo_path naming something that is not there", () => {
  const src = stripComments(read(DASH));
  const at = src.indexOf("async function uploadCompanyLogo");
  assert.ok(at > 0, "uploadCompanyLogo is gone");
  const fn = src.slice(at, src.indexOf("\nasync function removeCompanyLogo", at));

  const upload = fn.indexOf(".upload(");
  const setColumn = fn.indexOf("logo_path: path");
  const removeOld = fn.indexOf("remove([previous])");
  assert.ok(upload > 0, "nothing uploads the file");
  assert.ok(setColumn > upload, "the column is written before the object exists");
  assert.ok(removeOld > setColumn, "the OLD object is deleted before the column points at the new one");

  // A failed column write must clean up the orphan it just made.
  assert.ok(/remove\(\[path\]\)/.test(fn),
    "a failed column write leaves the just-uploaded object orphaned in the bucket");
  // And it must judge the write on rows affected, not on the absence of an error.
  assert.ok(/\.select\('id'\)/.test(fn),
    "the column write is judged on error alone -- a policy-filtered UPDATE is zero rows with no error");
  assert.ok(/rows\.length/.test(fn), "nothing checks how many rows the update actually changed");

  // A new name each time, so a replaced logo is a new URL.
  assert.ok(/randomUUID\(\)/.test(fn),
    "the upload reuses one path, so caches and inboxes keep showing the old image");
});

test("removal clears the column BEFORE deleting the object", () => {
  const src = stripComments(read(DASH));
  const at = src.indexOf("async function removeCompanyLogo");
  assert.ok(at > 0, "removeCompanyLogo is gone");
  const fn = src.slice(at, at + 1400);
  const clear = fn.indexOf("logo_path: ''");
  const del = fn.indexOf("remove([gone])");
  assert.ok(clear > 0, "nothing clears the column");
  assert.ok(del > clear,
    "the object is deleted before the column is cleared -- a customer's quote would show a broken image");
  assert.ok(/confirm\(/.test(fn), "the logo can be removed without being asked");
});

test("only an owner can reach the controls, and they start disabled", () => {
  const src = read(DASH);
  // In the markup.
  for (const id of ["s_logoFile", "s_logoUpload", "s_logoRemove"]) {
    const at = src.indexOf('id="' + id + '"');
    assert.ok(at > 0, `${id} is gone from the markup`);
    const tag = src.slice(src.lastIndexOf("<", at), src.indexOf(">", at));
    assert.ok(/disabled/.test(tag), `${id} does not start disabled`);
  }
  // And only renderCompanyLogo, having confirmed OWNER, enables them.
  const code = stripComments(src);
  const at = code.indexOf("async function renderCompanyLogo");
  assert.ok(at > 0, "renderCompanyLogo is gone");
  const fn = code.slice(at, code.indexOf("\nasync function uploadCompanyLogo", at));
  assert.ok(/profile\.role === 'OWNER'/.test(fn), "the role is no longer checked before enabling");
  assert.ok(/disabled = !isOwner/.test(fn), "the controls are enabled regardless of role");

  // Both writers re-check, because a page that has sat open is not evidence.
  for (const fnName of ["uploadCompanyLogo", "removeCompanyLogo"]) {
    const a = code.indexOf("async function " + fnName);
    const body = code.slice(a, a + 500);
    assert.ok(/profile\.role !== 'OWNER'/.test(body), `${fnName} does not re-check the role`);
  }
});

test("CANARY: enabling the controls for anyone turns that check red", () => {
  const code = stripComments(read(DASH));
  const at = code.indexOf("async function renderCompanyLogo");
  const fn = code.slice(at, code.indexOf("\nasync function uploadCompanyLogo", at));
  const sabotaged = fn.replace(/disabled = !isOwner/g, "disabled = false");
  assert.notEqual(sabotaged, fn, "the canary did not change the source");
  assert.ok(!/disabled = !isOwner/.test(sabotaged),
    "THE CANARY DID NOT FAIL: controls enabled for every role went unnoticed");
});

// ===========================================================================
// 6. THE PHONE
//
// Source checks, because Kotlin is not compiled here. Each one is about a
// decision that would be invisible in a screenshot and expensive in the yard.
// ===========================================================================

test("the phone reads companies.logo_path, not the settings blob", () => {
  const kt = stripComments(read(KT_LOGO));
  assert.ok(/from\("companies"\)/.test(kt), "CompanyLogo no longer reads the companies row");
  assert.ok(/logo_path/.test(kt), "CompanyLogo no longer reads logo_path");
  // The blob is hidden from anyone without SEE_MONEY, so a crew phone would
  // never see a logo kept there -- and PdfExporter runs on crew phones.
  assert.ok(!/company_settings/.test(kt),
    "the phone reads the logo out of company_settings, which crew phones cannot read");
  const sync = stripComments(read(KT_SETTINGS + "")) + stripComments(read(KT_LOGO));
  assert.ok(!/logoPath\s*=|logo_path.*CloudSettings/.test(
    stripComments(read("app/src/main/java/com/fenceestimator/app/cloud/SettingsSync.kt"))),
    "the logo path has been added to the settings blob after all -- that is the two-store problem");
});

test("a read that failed, or came back empty, never clears the cached logo", () => {
  // The whole point of caching it: a phone with no signal must keep printing
  // the letterhead it has. Only an ANSWERED read with a blank path clears it.
  const kt = stripComments(read(KT_LOGO));
  const at = kt.indexOf("suspend fun sync(");
  assert.ok(at > 0, "CompanyLogo.sync is gone");
  const fn = kt.slice(at, kt.indexOf("sealed interface Upload", at));

  // THE FAILED-READ BRANCH ITSELF, not just what comes after it.
  //
  // This started as `firstDelete > getOrElse` -- the delete must come after
  // the failure handler -- and a deliberate sabotage walked straight past it:
  // a delete INSIDE the getOrElse block is after it positionally and is
  // exactly the bug (a phone with no signal loses its letterhead). So the
  // branch is lifted out by its braces and read on its own.
  const getOrElse = fn.indexOf("getOrElse");
  assert.ok(getOrElse > 0, "the read failure is no longer handled");
  const failureBranch = braced(fn, fn.indexOf("{", getOrElse));
  assert.ok(failureBranch.length > 20, "the read-failure branch could not be lifted out");
  assert.ok(!/delete|listFiles/.test(failureBranch),
    "a failed read deletes the cached logo -- a phone with no signal would lose its letterhead");
  assert.ok(/return@withContext/.test(failureBranch),
    "a failed read no longer returns early");
  assert.ok(/if \(row == null\) return/.test(fn),
    "a missing row no longer returns early -- it would be read as 'no logo'");
  // ...and the clear only happens on the empty-path branch.
  assert.ok(/if \(path\.isEmpty\(\)\)/.test(fn),
    "nothing distinguishes an answered blank path from an unanswered read");
});

test("the phone writes the new object before moving the column, and prunes last", () => {
  const kt = stripComments(read(KT_LOGO));
  const at = kt.indexOf("suspend fun upload(");
  assert.ok(at > 0, "CompanyLogo.upload is gone");
  const fn = kt.slice(at, kt.indexOf("suspend fun remove(", at));

  const put = fn.indexOf(".upload(path");
  const col = fn.indexOf('set("logo_path", path)');
  const delOld = fn.indexOf("delete(previous)");
  assert.ok(put > 0, "nothing uploads the object");
  assert.ok(col > put, "the column is written before the object exists");
  assert.ok(delOld > col, "the OLD object is deleted before the column points at the new one");

  // A new name every time, so a replaced logo is a new URL that caches and
  // inboxes cannot keep stale.
  assert.ok(/randomUUID\(\)/.test(fn), "the object name is reused, so a replacement would be cached stale");
  // A failed column write cleans up its own orphan.
  assert.ok(/delete\(path\)/.test(fn),
    "a failed column write leaves the uploaded object orphaned in the bucket");
  // And the write is judged on rows affected. companies_update is USING-only,
  // so a non-owner's UPDATE is zero rows with NO error.
  assert.ok(/rows\.isEmpty\(\)/.test(fn),
    "the column write is judged on the absence of an error, which a policy filter does not produce");
  assert.ok(/set_logo_owner_only/.test(fn),
    "a zero-row write no longer says what actually happened");
});

test("the phone clears the column before deleting the object on remove", () => {
  const kt = stripComments(read(KT_LOGO));
  const at = kt.indexOf("suspend fun remove(");
  assert.ok(at > 0, "CompanyLogo.remove is gone");
  const fn = kt.slice(at, at + 2000);
  const clear = fn.indexOf('set("logo_path", "")');
  const del = fn.indexOf("delete(gone)");
  assert.ok(clear > 0, "nothing clears the column");
  assert.ok(del > clear,
    "the object is deleted before the column is cleared -- a customer's quote would show a broken image");
});

test("the logo cache is forgotten when the phone stops belonging to the company", () => {
  const kt = stripComments(read(KT_SESSION));
  const calls = [...kt.matchAll(/CompanyLogo\.clearCache\(/g)];
  assert.ok(calls.length >= 2,
    `CompanyLogo.clearCache is called ${calls.length} times; the signed-out and no-company branches both need it`);
  // Beside the identity clear, which is the branch that already means "this
  // phone is not that company's any more".
  assert.ok(/CachedIdentity\.clear\(ctx\) \}[\s\S]{0,600}CompanyLogo\.clearCache/.test(kt),
    "the logo cache is not cleared alongside the cached identity");
});

test("the PDF header is byte-for-byte unchanged for a company with no logo", () => {
  const kt = stripComments(read(KT_PDF));
  const at = kt.indexOf("val logo = runCatching");
  assert.ok(at > 0, "the PDF no longer draws a logo");
  const header = kt.slice(at, kt.indexOf("canvas.drawLine(", at));

  // leftX starts at MARGIN and only moves when a bitmap really decoded, so a
  // company without a logo gets the header it always had.
  assert.ok(/var leftX = MARGIN/.test(header), "leftX no longer starts at the margin");
  assert.ok(/logoBitmap != null && logoBitmap\.width > 0/.test(header),
    "a file that will not decode is no longer checked before it is drawn");
  // Every line of the text block is placed at leftX, not at MARGIN -- a mix
  // would indent the name over the logo and leave the phone number under it.
  for (const field of ["business.phone", "business.email", "business.licenseNumber"]) {
    const line = header.split("\n").find((l) => l.includes(field));
    assert.ok(line, `the ${field} line is gone from the header`);
    assert.ok(/leftX/.test(line), `${field} is still drawn at MARGIN, so it would sit under the logo`);
  }
  assert.ok(/canvas\.drawText\(name, leftX/.test(header),
    "the business name is not drawn at leftX");
  // Scaled to fit, never stretched: one scale for both axes.
  assert.ok(/val scale = minOf\(/.test(header),
    "the logo is scaled per-axis, which stretches whatever shape it really is");
  // And no network on the PDF path.
  assert.ok(!/createSignedUrl|download/.test(header),
    "the PDF header fetches something -- it runs in the yard with no signal");
});

test("only an owner sees the phone's logo controls", () => {
  const kt = stripComments(read(KT_SETTINGS));
  const at = kt.indexOf("private fun CompanyLogoRow(");
  assert.ok(at > 0, "CompanyLogoRow is gone");
  const fn = kt.slice(at);
  assert.ok(/UserRole\.OWNER/.test(fn), "the role is no longer checked");
  assert.ok(/canChange = editable && isOwner/.test(fn),
    "the buttons are enabled without checking the role, or without the guest gate");
  assert.ok(/enabled = canChange/.test(fn), "a button no longer honours canChange");
  // The guest demo must not be able to write company settings -- same rule as
  // every other control on this screen.
  assert.ok(/editable/.test(fn), "the guest-demo gate is gone");
});

test("CANARY: a phone upload that moved the column first turns that check red", () => {
  const kt = stripComments(read(KT_LOGO));
  const at = kt.indexOf("suspend fun upload(");
  const fn = kt.slice(at, kt.indexOf("suspend fun remove(", at));
  // Move the column write above the upload.
  const colLine = fn.split("\n").find((l) => l.includes('set("logo_path", path)'));
  assert.ok(colLine, "the canary cannot find the column write");
  const sabotaged = colLine + "\n" + fn.replace(colLine, "");
  assert.ok(sabotaged.indexOf('set("logo_path", path)') < sabotaged.indexOf(".upload(path"),
    "THE CANARY DID NOT FAIL: a column write hoisted above the upload went unnoticed");
});
// ===========================================================================
// 7. WHERE IT IS SHOWN -- the two headers
// ===========================================================================

test("the office header shows it, starts hidden, and hides a broken one", () => {
  const src = read(DASH);
  const at = src.indexOf('id="hdrLogo"');
  assert.ok(at > 0, "the office header has no logo element");
  const wrapAt = src.indexOf('id="hdrLogoWrap"');
  assert.ok(wrapAt > 0, "the office header logo has no wrapper");
  const wrapTag = src.slice(src.lastIndexOf("<", wrapAt), src.indexOf(">", wrapAt));
  assert.ok(/display:none/.test(wrapTag),
    "the header logo does not start hidden, so a company without one gets a gap");

  const code = stripComments(src);
  const fn = code.slice(code.indexOf("async function renderHeaderLogo"), code.indexOf("async function renderHeaderLogo") + 900);
  assert.ok(/onerror/.test(fn),
    "an expired URL would leave a broken image frame in the office bar");
  // It must not replace the product's own name -- the brand link is still there.
  assert.ok(/class="logo" href="#" id="brandHome"/.test(src),
    "the company logo has replaced the FenceFlow wordmark rather than joining it");
});

test("the office header follows both an upload AND a removal", () => {
  // The removal path used to return early without touching the bar, so a logo
  // taken off in Settings stayed up there until the page was reloaded -- which
  // reads as the removal not having worked.
  const code = stripComments(read(DASH));
  const at = code.indexOf("async function renderCompanyLogo");
  assert.ok(at > 0, "renderCompanyLogo is gone");
  const fn = code.slice(at, code.indexOf("async function uploadCompanyLogo", at));
  const removalBranch = braced(fn, fn.indexOf("{", fn.indexOf("if (!companyLogoPath)")));
  assert.ok(removalBranch.length > 20, "the no-logo branch could not be lifted out");
  assert.ok(/renderHeaderLogo/.test(removalBranch),
    "removing the logo does not update the header");
  // And the upload path does too.
  assert.ok(fn.slice(fn.indexOf("box.style.display = 'flex'")).includes("renderHeaderLogo"),
    "uploading a logo does not update the header");
});

test("the app header reads the cache and never the network", () => {
  const kt = stripComments(read(KT_JOBS));
  const at = kt.indexOf("CompanyLogo.cachedFile");
  assert.ok(at > 0, "the app's header does not show the logo");
  const region = kt.slice(Math.max(0, at - 600), at + 2200);
  assert.ok(!/createSignedUrl|downloadAuthenticated|suspend|await/.test(region),
    "the app's header fetches something -- this is the screen the app opens on");
  // The name stays. A logo is often a mark with no words in it, and a bar
  // showing only that leaves a crew member nothing to read.
  assert.ok(/shownName/.test(region), "the logo has replaced the business name in the app bar");
  assert.ok(/logoBitmap != null/.test(region),
    "nothing checks whether there is a logo before making room for one");
});

test("both previews follow the cache, not something they happen to be keyed on", () => {
  // The app's header was keyed on the business NAME. A logo uploaded on this
  // phone changes the folder and nothing else, so the bar kept showing the old
  // one until something renamed the company or the app was restarted -- a
  // staleness that reads exactly like the upload not having worked.
  const logo = stripComments(read(KT_LOGO));
  assert.ok(/val generation = kotlinx\.coroutines\.flow\.MutableStateFlow/.test(logo),
    "CompanyLogo no longer publishes when its cache changes");
  // Every writer bumps it: the download, the clear-on-empty, and the sign-out.
  const bumps = [...logo.matchAll(/\bbump\(\)/g)];
  assert.ok(bumps.length >= 3,
    `only ${bumps.length} writers tell the screens the cache changed; the download, the clear and the sign-out all must`);

  for (const [file, what] of [[KT_JOBS, "the app's header"], [KT_SETTINGS, "the settings preview"]]) {
    const kt = stripComments(read(file));
    const at = kt.indexOf("CompanyLogo.generation");
    assert.ok(at > 0, `${what} does not follow the cache generation`);
    const region = kt.slice(at, at + 400);
    assert.ok(/collectAsState/.test(region), `${what} reads the generation without collecting it`);
    assert.ok(/remember\(\s*(logoGeneration|generation)\s*\)/.test(kt),
      `${what} re-reads the folder on something other than the generation`);
  }
  // And specifically NOT on the name any more.
  assert.ok(!/remember\(profile\.businessName\)/.test(stripComments(read(KT_JOBS))),
    "the app's header is keyed on the business name again");
});

// ===========================================================================
// 8. A NEW COMPANY
// ===========================================================================

test("onboarding uploads the logo only AFTER the details have saved", () => {
  // Both halves of the write are OWNER-only, and an invited owner only becomes
  // the owner once the claim has run. Doing it first is a write a policy
  // filters to zero rows with no error.
  const code = stripComments(read(WELCOME));
  const at = code.indexOf("$('saveDetails').addEventListener");
  assert.ok(at > 0, "the details handler is gone");
  const handler = code.slice(at, at + 1400);
  const rpc = handler.indexOf("complete_company_details");
  const upload = handler.indexOf("uploadWelcomeLogo");
  assert.ok(rpc > 0, "the details RPC is gone");
  assert.ok(upload > rpc, "the logo is uploaded before the company details exist");
});

test("a logo that will not upload never stops onboarding", () => {
  const code = stripComments(read(WELCOME));
  const at = code.indexOf("async function uploadWelcomeLogo");
  assert.ok(at > 0, "uploadWelcomeLogo is gone");
  const fn = braced(code, code.indexOf("{", at));
  assert.ok(fn.length > 100, "uploadWelcomeLogo could not be lifted out");
  // It returns a message; it does not throw and it does not reject the step.
  assert.ok(/try\s*\{/.test(fn) && /catch/.test(fn), "uploadWelcomeLogo can throw out of the handler");
  assert.ok(!/throw /.test(fn), "uploadWelcomeLogo throws");
  // And the handler marks the step done regardless of what it answered.
  const handler = code.slice(code.indexOf("$('saveDetails').addEventListener"));
  const done = handler.indexOf("state.details = true");
  const logo = handler.indexOf("uploadWelcomeLogo");
  assert.ok(done > logo,
    "the step is marked done before the logo is attempted, or not at all");
  const between = handler.slice(logo, done);
  assert.ok(!/\breturn\b/.test(between),
    "a failed logo upload returns out of the handler, leaving onboarding stuck on step 1");
  // It reads the rows back, like every other write on these pages.
  assert.ok(/\.select\('id'\)/.test(fn),
    "the column write is judged on error alone -- a policy-filtered UPDATE is zero rows with no error");
  assert.ok(/remove\(\[path\]\)/.test(fn),
    "a failed column write leaves the uploaded object orphaned in the bucket");
});

// ===========================================================================
// 9. THE CROP
// ===========================================================================

test("every picked file goes through the crop dialog", () => {
  // Not a nicety: the picker is asked for image/*, so a heic, a gif or a bmp
  // can be chosen. What the dialog hands back is a PNG this app encoded, so
  // the type sent to a bucket with an allow-list is known rather than taken
  // from whatever the picker claimed the file was.
  const kt = stripComments(read(KT_SETTINGS));
  const at = kt.indexOf("rememberLauncherForActivityResult");
  assert.ok(at > 0, "the picker is gone");
  const picker = kt.slice(at, kt.indexOf("Column(verticalArrangement", at));
  assert.ok(/decodeForLogo/.test(picker), "the picked file is no longer decoded for cropping");
  assert.ok(/cropping = bitmap/.test(picker), "the picked file no longer opens the crop dialog");
  assert.ok(!/CompanyLogo\.upload\(/.test(picker.slice(0, picker.indexOf("LogoCropDialog"))),
    "the picker uploads straight from the file, bypassing the crop");
  assert.ok(/mimeType = mime/.test(kt),
    "the upload no longer uses the type the dialog produced");
  assert.ok(/onUse = \{ bytes, mime/.test(kt), "the dialog's output is not what is uploaded");
});

test("the crop is decoded small, encoded as PNG, and capped", () => {
  const kt = stripComments(read(KT_CROP_UI));
  assert.ok(/inSampleSize/.test(kt),
    "a twelve-megapixel photo would be decoded whole -- 48 MB of bitmap");
  assert.ok(/CompressFormat\.PNG/.test(kt),
    "a logo encoded as JPEG loses its hard edges and gains a black background where it was transparent");
  assert.ok(/MAX_OUTPUT_SIDE/.test(kt), "the uploaded image is no longer capped");
  // And the decode answers null rather than throwing.
  assert.ok(/getOrNull\(\)/.test(kt), "a file that will not decode throws instead of being answered");
});

test("what is drawn and what is saved are the same rectangle", () => {
  // The alternative -- draw with a transform, then invert it to crop -- is
  // where the one-pixel slivers live.
  const kt = stripComments(read(KT_CROP_UI));
  const draw = kt.indexOf("drawImage(");
  assert.ok(draw > 0, "the preview no longer draws the image");
  const call = kt.slice(draw, draw + 500);
  assert.ok(/srcOffset = IntOffset\(rect\.left, rect\.top\)/.test(call),
    "the preview draws from somewhere other than the crop rectangle");
  assert.ok(/srcSize = IntSize\(rect\.width/.test(call),
    "the preview draws a different size from the crop rectangle");
  // The encode uses the same rect.
  assert.ok(/encodePng\(bmp, r\)/.test(kt), "the encode no longer uses the rectangle on screen");
});

test("the crop arithmetic clamps LAST, which is the only order that holds", () => {
  const kt = stripComments(read(KT_CROP));
  const at = kt.indexOf("fun transform(");
  assert.ok(at > 0, "LogoCrop.transform is gone");
  const fn = kt.slice(at, kt.indexOf("fun outputSize(", at));
  const pan = fn.indexOf("+ panX");
  const clamp = fn.indexOf("coerceIn(0f");
  assert.ok(pan > 0 && clamp > pan,
    "the rectangle is clamped before the pan is applied, so a drag at the edge escapes it");
  // And nothing is ever enlarged on the way out.
  const out = kt.slice(kt.indexOf("fun outputSize("));
  assert.ok(/longSide <= maxLongSide\) return width to height/.test(out),
    "a small logo would be enlarged to the cap, which makes it blurrier and bigger");
});
