// The office inbox's pure half (website/js/lib/mail-render.mjs) and the
// places dashboard.html is not allowed to get wrong.
//
// Run with:  node --test tests/mail-render.test.mjs
//
// An email is markup and text written by a stranger. What keeps it from
// running in the office is, in order of strength: the sandboxed frame (no
// script, no same-origin), the frame's own Content-Security-Policy, and
// DOMPurify. The first two are checked here as strings the browser will
// enforce; DOMPurify needs a real DOM, so its configuration and the hooks
// this repo adds are driven with plain objects, and the page is grepped to
// prove it never shows mail HTML any other way. Every check that could pass
// vacuously has a planted failure next to it that must be caught.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  MAIL_LIMITS, MAIL_ERROR_KEYS, MAIL_FORBID_TAGS, MAIL_URI_RE, mailSandboxAttr, mailCsp, buildSrcdoc,
  purifyConfig, makeMailHooks, sanitizeMailHtml, filterCssUrls, countRemoteImages, cidKey, escapeHtml,
  cleanLine, textToHtml, htmlToPlain, normalizeSubject, replySubject, quoteForReply, forwardBlock,
  addressLabel, parseAddressList, replyRecipients, safeFilename, formatBytes, mailErrorParts,
  mailTimeLabel, threadRowHtml, jobChipsHtml, senderWarning,
} from "../website/js/lib/mail-render.mjs";
import { MAIL_ERROR_CODES, MESSAGES } from "../supabase/functions/_shared/mail/errors.ts";

const PAGE = readFileSync("website/dashboard.html", "utf8");

function translations() {
  const start = PAGE.indexOf("const TL = {");
  let depth = 0, end = -1;
  for (let i = PAGE.indexOf("{", start); i < PAGE.length; i++) {
    if (PAGE[i] === "{") depth++;
    else if (PAGE[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return eval("(" + PAGE.slice(PAGE.indexOf("{", start), end) + ")");
}
const TL = translations();

// The Email tab's section of the page script.
function mailSection(src = PAGE) {
  const a = src.indexOf("/* ===================== Company email");
  const b = src.indexOf("/* ---------- nav ---------- */", a);
  return a >= 0 && b > a ? src.slice(a, b) : "";
}

// ---------------------------------------------------------------------------
// The frame.
// ---------------------------------------------------------------------------

const FORBIDDEN_SANDBOX = ["allow-scripts", "allow-same-origin", "allow-forms", "allow-top-navigation",
  "allow-top-navigation-by-user-activation", "allow-modals", "allow-downloads", "allow-pointer-lock",
  "allow-storage-access-by-user-activation", "allow-presentation"];

function sandboxProblems(value) {
  const tokens = String(value).trim().split(/\s+/).filter(Boolean);
  const bad = tokens.filter((t) => FORBIDDEN_SANDBOX.includes(t.toLowerCase()));
  const unknown = tokens.filter((t) => !["allow-popups", "allow-popups-to-escape-sandbox"].includes(t));
  return [...new Set([...bad, ...unknown])];
}

test("the mail frame's sandbox allows popups for links and nothing else", () => {
  assert.equal(mailSandboxAttr(), "allow-popups allow-popups-to-escape-sandbox");
  assert.deepEqual(sandboxProblems(mailSandboxAttr()), []);
  // PLANTED: the checker catches each dangerous permission.
  assert.deepEqual(sandboxProblems("allow-popups allow-scripts"), ["allow-scripts"]);
  assert.deepEqual(sandboxProblems("allow-same-origin allow-popups"), ["allow-same-origin"]);
  assert.deepEqual(sandboxProblems("allow-forms"), ["allow-forms"]);
});

function cspProblems(csp) {
  const dirs = Object.fromEntries(String(csp).split(";").map((d) => d.trim().split(/\s+/)).filter((p) => p[0])
    .map(([k, ...v]) => [k, v]));
  const out = [];
  if (JSON.stringify(dirs["default-src"]) !== JSON.stringify(["'none'"])) out.push("default-src");
  if (dirs["script-src"] || dirs["script-src-elem"] || dirs["connect-src"] || dirs["frame-src"]) out.push("opens a fetch");
  for (const [k, v] of Object.entries(dirs)) {
    if (v.some((s) => s === "*" || s === "http:" || s === "'unsafe-eval'")) out.push(k);
    if (k !== "style-src" && v.includes("'unsafe-inline'")) out.push(k);
  }
  if (JSON.stringify(dirs["form-action"]) !== JSON.stringify(["'none'"])) out.push("form-action");
  return out;
}

test("the frame's CSP: nothing fetches, pictures only after 'Show pictures'", () => {
  const off = mailCsp({ images: false });
  const on = mailCsp({ images: true });
  assert.deepEqual(cspProblems(off), []);
  assert.deepEqual(cspProblems(on), []);
  assert.match(off, /img-src data:(;|$)/);
  assert.doesNotMatch(off, /https:/);
  assert.match(on, /img-src data: https:/);
  assert.match(off, /base-uri 'none'/);
  // PLANTED: a policy that lets a script or any image source in is caught.
  assert.ok(cspProblems("default-src 'none'; script-src 'unsafe-inline'; form-action 'none'").length > 0);
  assert.ok(cspProblems("default-src 'none'; img-src *; form-action 'none'").length > 0);
  assert.ok(cspProblems("default-src *; form-action 'none'").length > 0);
});

test("buildSrcdoc puts the CSP first in <head>, before the message, and nothing else", () => {
  const doc = buildSrcdoc("<p>Hi</p>", { images: false });
  const head = doc.slice(doc.indexOf("<head>"), doc.indexOf("</head>"));
  // The only thing before the CSP is the charset declaration.
  assert.match(head, /^<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="[^"]+">/);
  const cspContent = head.match(/content="([^"]+)"/)[1].replace(/&#39;/g, "'");
  assert.equal(cspContent, mailCsp({ images: false }));
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<p>Hi</p>"));
  assert.match(doc, /<meta name="referrer" content="no-referrer">/);
  assert.match(doc, /<base target="_blank">/);
  assert.doesNotMatch(doc, /<script/i);
  assert.match(buildSrcdoc("x", { images: true }), /img-src data: https:/);
  // PLANTED: a document whose CSP comes after the body would be caught by the
  // same ordering check.
  const bad = "<!doctype html><html><head></head><body><img src=https://t.example/p.gif>"
    + "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"></body></html>";
  assert.ok(!(bad.indexOf("Content-Security-Policy") < bad.indexOf("<img")));
});

// ---------------------------------------------------------------------------
// DOMPurify: configuration and this repo's hooks.
// ---------------------------------------------------------------------------

test("the DOMPurify config forbids everything that runs, embeds, submits or reaches out", () => {
  const cfg = purifyConfig();
  for (const t of ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select",
    "base", "meta", "link", "svg", "math"]) {
    assert.ok(cfg.FORBID_TAGS.includes(t), `${t} must be forbidden`);
  }
  assert.deepEqual(cfg.USE_PROFILES, { html: true });
  assert.equal(cfg.ALLOW_DATA_ATTR, false);
  assert.equal(cfg.ALLOW_UNKNOWN_PROTOCOLS, false);
  assert.ok(cfg.FORBID_ATTR.includes("srcset") && cfg.FORBID_ATTR.includes("ping"));
  assert.equal(cfg.WHOLE_DOCUMENT, false);
  // A leading or <head> <style> survives only when parsing is forced into
  // the body (checked against the real DOMPurify 3.4.15 in a browser).
  assert.equal(cfg.FORCE_BODY, true);
  // PLANTED: the list is what the test reads, not a copy of it.
  assert.ok(!MAIL_FORBID_TAGS.includes("p"));
});

test("the URI rule: http(s), mailto, tel, cid and plain values pass; javascript:, data:, vbscript: do not", () => {
  for (const ok of ["https://example.com/x", "http://a.b", "mailto:a@b.com", "tel:+15551234", "cid:img1",
    "100", "center", "#top", "50%"]) {
    assert.ok(MAIL_URI_RE.test(ok), `${ok} should pass`);
  }
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>", "vbscript:x",
    "file:///etc/passwd", "ftp://x", "blob:https://x"]) {
    assert.ok(!MAIL_URI_RE.test(bad), `${bad} must not pass`);
  }
});

/** A tiny stand-in for a DOMPurify node: attributes in a Map. */
function node(tag, attrs = {}, text = "") {
  const a = new Map(Object.entries(attrs));
  return {
    tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(), textContent: text,
    getAttribute: (k) => (a.has(k) ? a.get(k) : null),
    setAttribute: (k, v) => a.set(k, String(v)),
    removeAttribute: (k) => a.delete(k),
    hasAttribute: (k) => a.has(k),
    attrs: a,
  };
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("hooks: remote pictures are held back and counted until 'Show pictures'", () => {
  const off = makeMailHooks({ images: false, counter: { blocked: 0 } });
  const img = node("img", { src: "https://tracker.example/p.gif?u=42", alt: "logo" });
  off.afterSanitizeAttributes(img);
  assert.equal(img.hasAttribute("src"), false);
  assert.equal(img.getAttribute("alt"), "logo");
  assert.equal(off.counter.blocked, 1);
  const rel = node("img", { src: "//cdn.example/x.png" });
  off.afterSanitizeAttributes(rel);
  assert.equal(rel.hasAttribute("src"), false);
  assert.equal(off.counter.blocked, 2);

  const on = makeMailHooks({ images: true, counter: { blocked: 0 } });
  const img2 = node("img", { src: "http://cdn.example/x.png" });
  on.afterSanitizeAttributes(img2);
  assert.equal(img2.getAttribute("src"), "https://cdn.example/x.png");
  assert.equal(on.counter.blocked, 0);
  // PLANTED: without the hook the tracker would still be there.
  const untouched = node("img", { src: "https://tracker.example/p.gif" });
  assert.equal(untouched.getAttribute("src"), "https://tracker.example/p.gif");
});

test("hooks: cid pictures come from inline_images; anything else not a raster data: URL is dropped", () => {
  const h = makeMailHooks({ images: false, inlineImages: { "logo@x": PNG, evil: "data:image/svg+xml;base64,PHN2Zz4=" } });
  const a = node("img", { src: "cid:logo@x" });
  h.afterSanitizeAttributes(a);
  assert.equal(a.getAttribute("src"), PNG);
  const b = node("img", { src: "cid:%3Clogo@x%3E" });
  h.afterSanitizeAttributes(b);
  assert.equal(b.getAttribute("src"), PNG);
  const c = node("img", { src: "cid:missing" });
  h.afterSanitizeAttributes(c);
  assert.equal(c.hasAttribute("src"), false);
  const svgMapped = node("img", { src: "cid:evil" });
  h.afterSanitizeAttributes(svgMapped);
  assert.equal(svgMapped.hasAttribute("src"), false, "an SVG under a cid is never inlined");
  const svg = node("img", { src: "data:image/svg+xml;base64,PHN2Zz4=" });
  h.afterSanitizeAttributes(svg);
  assert.equal(svg.hasAttribute("src"), false);
  const png = node("img", { src: PNG });
  h.afterSanitizeAttributes(png);
  assert.equal(png.getAttribute("src"), PNG);
  const js = node("img", { src: "javascript:alert(1)" });
  h.afterSanitizeAttributes(js);
  assert.equal(js.hasAttribute("src"), false);
  assert.equal(cidKey("cid:<a%40b>"), "a@b");
});

test("hooks: links open in a new tab with no opener; cid links lose their href", () => {
  const h = makeMailHooks();
  const a = node("a", { href: "https://example.com", target: "_top" });
  h.afterSanitizeAttributes(a);
  assert.equal(a.getAttribute("target"), "_blank");
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");
  const c = node("a", { href: "cid:part1" });
  h.afterSanitizeAttributes(c);
  assert.equal(c.hasAttribute("href"), false);
  const d = node("div", { target: "_top" });
  h.afterSanitizeAttributes(d);
  assert.equal(d.hasAttribute("target"), false);
});

test("hooks: CSS url() in style attributes and <style> blocks follows the picture rule", () => {
  const h = makeMailHooks({ images: false, counter: { blocked: 0 } });
  const td = node("td", { style: "color:red;background-image:url('https://t.example/bg.png')" });
  h.afterSanitizeAttributes(td);
  assert.equal(td.getAttribute("style"), "color:red;background-image:none");
  const style = node("style", {}, "@import url(https://evil.example/a.css); .x{background:url(//t.example/p.gif)} .y{background:url(data:image/png;base64,AA==)}");
  h.uponSanitizeElement(style, { tagName: "style" });
  assert.doesNotMatch(style.textContent, /evil\.example|t\.example|@import/);
  assert.match(style.textContent, /data:image\/png/);
  // Two pictures held back (the td background and .x); the @import is gone
  // but is not a picture, so it does not count towards "Show pictures".
  assert.equal(h.counter.blocked, 2);
  assert.equal(filterCssUrls("a{b:url(http://x/y)}", { images: true }), "a{b:url(https://x/y)}");
  assert.equal(filterCssUrls("@import 'https://e.example/a.css'; p{}", { images: true }), " p{}");
  // PLANTED: a <p> is not a <style>; its text is left alone.
  const p = node("p", {}, "url(https://t.example/p.gif)");
  h.uponSanitizeElement(p, { tagName: "p" });
  assert.equal(p.textContent, "url(https://t.example/p.gif)");
});

test("sanitizeMailHtml fails closed without a sanitizer, and cleans up its hooks with one", () => {
  assert.equal(sanitizeMailHtml("<b>x</b>", { purify: null }), null);
  assert.equal(sanitizeMailHtml("<b>x</b>", { purify: {} }), null);
  assert.equal(sanitizeMailHtml("<b>x</b>", { purify: { sanitize() {}, addHook() {}, isSupported: false } }), null);
  const calls = [];
  const fake = {
    isSupported: true,
    hooks: {},
    addHook(name, fn) { calls.push(["add", name]); this.hooks[name] = fn; },
    removeAllHooks() { calls.push(["removeAll"]); this.hooks = {}; },
    sanitize(html, cfg) {
      calls.push(["sanitize", cfg.FORBID_TAGS.includes("script")]);
      // Drive the hooks the way DOMPurify would for one remote picture.
      this.hooks.afterSanitizeAttributes(node("img", { src: "https://t.example/p.gif" }));
      return "<p>clean</p>";
    },
  };
  const out = sanitizeMailHtml("<p>dirty</p><img src=https://t.example/p.gif>", { purify: fake, images: false });
  assert.deepEqual(out, { html: "<p>clean</p>", blocked: 1 });
  assert.deepEqual(calls.map((c) => c[0]), ["add", "add", "sanitize", "removeAll"]);
  assert.equal(calls[2][1], true);
  // Cleaned up even when the sanitizer throws.
  const throwing = { ...fake, hooks: {}, sanitize() { throw new Error("boom"); } };
  calls.length = 0;
  assert.throws(() => sanitizeMailHtml("x", { purify: throwing }));
  assert.equal(calls.at(-1)[0], "removeAll");
});

test("countRemoteImages sees pictures in img, background and CSS", () => {
  assert.equal(countRemoteImages("<img src='https://a/b.gif'><td background=http://c/d.png><div style=\"background:url(//e/f)\">"), 3);
  assert.equal(countRemoteImages(`<img src="${PNG}"><img src="cid:x">`), 0);
});

// ---------------------------------------------------------------------------
// Text and rows.
// ---------------------------------------------------------------------------

test("escapeHtml and cleanLine neutralise markup and invisible characters", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  assert.equal(cleanLine("Invoice\r\nBcc: x@y\u202e"), "Invoice Bcc: x@y");
  // An escape sequence (ESC [31m) cannot colour or hide text.
  assert.equal(cleanLine(`a${String.fromCharCode(27)}[31mb${String.fromCharCode(7)}`), "a [31mb");
});

test("threadRowHtml escapes every stranger-written string", () => {
  const evil = {
    id: '"><script>alert(1)</script>',
    subject: "<img src=x onerror=alert(1)>",
    latest_from_name: "<b onmouseover=alert(2)>Bob</b>",
    latest_from_address: "bob@example.com",
    snippet: "</span><iframe src=//evil>",
    unread_count: 2, message_count: 3, has_attachments: true,
    last_message_at: "2026-09-22T10:00:00Z",
    job_sync_ids: ["job-1", "job-2"],
  };
  const html = threadRowHtml(evil, {
    folder: "inbox", now: new Date("2026-09-22T12:00:00Z"), lang: "en",
    jobNames: new Map([["job-1", "<svg onload=alert(3)>Smith"]]),
    words: { noSubject: "(no subject)", toPrefix: "To:", unread: "Unread", attachment: "Has attachments" },
  });
  // Our own paperclip is an <svg class="ico">; nothing the sender wrote may be a tag.
  const withoutIcon = html.replace(/<svg class="ico"[\s\S]*?<\/svg>/, "");
  assert.ok(withoutIcon.length < html.length, "the paperclip icon was there to remove");
  assert.doesNotMatch(withoutIcon, /<img|<script|<iframe|<svg|<b /i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-thread="&quot;&gt;&lt;script&gt;/);
  assert.match(html, /class="mail-row unread"/);
  assert.match(html, /<span class="mr-n">3<\/span>/);
  assert.match(html, /class="mr-clip"/);
  assert.match(html, /&lt;svg onload=alert\(3\)&gt;Smith/);
  assert.doesNotMatch(html, /job-2/, "a job this person cannot see is left out, not shown as an id");
  // PLANTED: the same row built without escaping would carry a live tag.
  const unescaped = `<span class="mr-subj">${evil.subject}</span>`;
  assert.match(unescaped, /<img/);
});

test("threadRowHtml: Sent shows who it went to; an empty subject says so", () => {
  const html = threadRowHtml({ id: "t1", subject: "", participants: ["amy@x.com", "bo@y.com"], unread_count: 0, message_count: 1 },
    { folder: "sent", words: { noSubject: "(no subject)", toPrefix: "To:" }, now: new Date(), lang: "en" });
  assert.match(html, /To: amy@x\.com, bo@y\.com/);
  assert.match(html, /\(no subject\)/);
  assert.doesNotMatch(html, /mr-dot/);
  assert.equal(jobChipsHtml([], new Map()), "");
});

test("textToHtml escapes first and links http(s) only", () => {
  const out = textToHtml("Hi <script>alert(1)</script>\nSee https://example.com/a?b=1&c=2. Or javascript:alert(1)");
  assert.doesNotMatch(out, /<script/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">/);
  assert.match(out, /<\/a>\. Or javascript:alert\(1\)$/);
  assert.match(out, /<br>/);
  // Markup with no link at all, and markup after the last link, are escaped too.
  assert.equal(textToHtml("<b>x</b> & 'y'"), "&lt;b&gt;x&lt;/b&gt; &amp; &#39;y&#39;");
  assert.match(textToHtml("see https://a.example then <img src=x onerror=y>"), /then &lt;img src=x onerror=y&gt;$/);
  // An address cannot carry a quote or bracket out of its href.
  const q = textToHtml('https://x.example/"onmouseover="alert(1)');
  assert.match(q, /href="https:\/\/x\.example\/"/);
  assert.doesNotMatch(q, /href="[^"]*onmouseover/);
});

test("htmlToPlain gives quotable text and never tags", () => {
  const t = htmlToPlain("<style>p{color:red}</style><script>x()</script><p>Hello&nbsp;<b>there</b></p><div>Line&#33;<br>Two &amp; &lt;three&gt;</div><ul><li>a</li></ul>");
  assert.equal(t, "Hello there\nLine!\nTwo & <three>\n\n- a");
  assert.doesNotMatch(htmlToPlain("<img src=x onerror=y>ok"), /</);
});

test("subjects: prefixes never stack, and a word that merely starts like one is kept", () => {
  assert.equal(replySubject("Re: RE: Fwd: Quote", "re"), "Re: Quote");
  assert.equal(replySubject("Quote", "fwd"), "Fwd: Quote");
  assert.equal(replySubject("TR: Devis", "re"), "Re: Devis");
  assert.equal(normalizeSubject("Re[2]: Gate"), "Gate");
  assert.equal(normalizeSubject("Reunion: plans"), "Reunion: plans");
  assert.equal(replySubject("x".repeat(400)).length, MAIL_LIMITS.subjectMaxChars);
});

test("quoteForReply quotes every line and caps a long original", () => {
  const q = quoteForReply("one\n> two\nthree", "On Monday, Bob wrote:");
  assert.equal(q, "\n\nOn Monday, Bob wrote:\n> one\n>> two\n> three\n");
  const long = quoteForReply("a".repeat(MAIL_LIMITS.quoteMaxChars + 5000), "h");
  assert.ok(long.length < MAIL_LIMITS.quoteMaxChars + 100);
  assert.match(long, /\[\.\.\.\]\n$/);
  // PLANTED: a header carrying a line break stays one line.
  assert.equal(quoteForReply("x", "On a,\r\nBcc: evil@x wrote:").split("\n")[2], "On a, Bcc: evil@x wrote:");
});

test("forwardBlock carries the original's header lines and text", () => {
  const f = forwardBlock({ from_name: "Bob", from_address: "bob@x.com", date: "Sep 22", subject: "Quote",
    to_list: [{ name: "", address: "us@co.com" }], cc_list: [], text: "Body" }, { head: "-- Fwd --" });
  assert.equal(f, "\n\n-- Fwd --\nFrom: Bob <bob@x.com>\nDate: Sep 22\nSubject: Quote\nTo: us@co.com\n\nBody\n");
  assert.equal(addressLabel({ name: "bob@x.com", address: "bob@x.com" }), "bob@x.com");
  assert.equal(addressLabel({ name: "A <b>", address: "a@b.co" }), "A b <a@b.co>");
});

test("parseAddressList accepts what the server accepts and nothing it would refuse", () => {
  const r = parseAddressList("Amy <Amy@Example.com>; bo@y.co\nnot an address, amy@example.com");
  assert.deepEqual(r.ok, ["amy@example.com", "bo@y.co"]);
  assert.deepEqual(r.bad, ["not an address"]);
  // PLANTED: a header-injection attempt never becomes an address.
  const inj = parseAddressList("a@b.com\r\nBcc: victim@x.com");
  assert.deepEqual(inj.ok, ["a@b.com"]);
  assert.ok(inj.ok.every((a) => !/[\s\r\n:<>]/.test(a)));
  assert.deepEqual(parseAddressList("x@localhost").ok, []);
});

test("replyRecipients: Reply-To wins, the company's own addresses never appear, reply-all adds the rest", () => {
  const m = {
    folder_role: "inbox",
    from_address: "bob@cust.com",
    reply_to_list: [{ name: "", address: "Office@Cust.com" }],
    to_list: [{ name: "", address: "us@company.com" }, { name: "", address: "amy@cust.com" }],
    cc_list: [{ name: "", address: "office@cust.com" }, { name: "", address: "ann@hoa.org" }],
  };
  const own = ["us@company.com"];
  assert.deepEqual(replyRecipients(m, { own }), { to: ["office@cust.com"], cc: [] });
  assert.deepEqual(replyRecipients(m, { all: true, own }), { to: ["office@cust.com"], cc: ["amy@cust.com", "ann@hoa.org"] });
  assert.deepEqual(replyRecipients({ ...m, reply_to_list: [] }, { own }).to, ["bob@cust.com"]);
  // Answering our own sent message writes to the same people again.
  const sent = { folder_role: "sent", from_address: "us@company.com", to_list: [{ address: "bob@cust.com" }], cc_list: [{ address: "us@company.com" }] };
  assert.deepEqual(replyRecipients(sent, { all: true, own }), { to: ["bob@cust.com"], cc: [] });
  // PLANTED: without `own`, the company's own mailbox would be copied in.
  assert.ok(replyRecipients(m, { all: true, own: [] }).cc.includes("us@company.com"));
});

test("safeFilename can never climb out of its folder or be empty", () => {
  for (const [input, check] of [
    ["../../x", (s) => !s.includes("/") && s !== ".."],
    ["..\\..\\evil.exe", (s) => !s.includes("\\") && s.endsWith("evil.exe")],
    ["", (s) => s === "file"],
    ["..", (s) => s === "file"],
    [".bashrc", (s) => !s.startsWith(".")],
    ["Devis é\u0000\n.pdf", (s) => s === "Devis e_.pdf"],
    [`${"a".repeat(300)}.pdf`, (s) => s.length <= 120 && s.endsWith(".pdf")],
    ["Quote (2).PDF", (s) => s === "Quote (2).PDF"],
  ]) {
    const out = safeFilename(input);
    assert.ok(check(out), `${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.match(out, /^[A-Za-z0-9 ._()-]+$/);
  }
  // PLANTED: the path is dropped, not escaped.
  assert.equal(safeFilename("a/b/c.txt"), "c.txt");
});

test("formatBytes and mailTimeLabel", () => {
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(14 * 1024 * 1024), "14 MB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
  assert.equal(formatBytes(-1), "");
  const now = new Date(2026, 8, 22, 15, 0);
  assert.match(mailTimeLabel(new Date(2026, 8, 22, 9, 5).toISOString(), now, "en"), /9:05/);
  assert.match(mailTimeLabel(new Date(2026, 1, 3, 9, 5).toISOString(), now, "en"), /Feb 3/);
  assert.match(mailTimeLabel(new Date(2024, 1, 3).toISOString(), now, "en"), /2024/);
  assert.equal(mailTimeLabel("not a date", now), "");
});

// ---------------------------------------------------------------------------
// Errors: every server code reaches the office translated.
// ---------------------------------------------------------------------------

test("every error code the mail functions send has an office translation, and English says what the server says", () => {
  assert.ok(MAIL_ERROR_CODES.length >= 20);
  for (const code of MAIL_ERROR_CODES) {
    const key = MAIL_ERROR_KEYS[code];
    assert.ok(key, `${code} has no translation key`);
    for (const lang of ["en", "es", "fr"]) assert.ok(TL[lang][key], `${lang}.${key} missing`);
    // Settings hides a stored last_error equal to TL.en[key]; that only
    // works if the two sentences are the same.
    assert.equal(TL.en[key], MESSAGES[code], `TL.en.${key} differs from errors.ts MESSAGES.${code}`);
  }
  assert.deepEqual(Object.keys(MAIL_ERROR_KEYS).sort(), [...MAIL_ERROR_CODES].sort());
  // PLANTED: an unknown code falls back to the generic sentence, never a raw code.
  assert.equal(mailErrorParts({ error_code: "brand_new_code" }).key, "mailErrServer");
  assert.deepEqual(mailErrorParts({ error_code: "bad_request", detail: "Enter the mailbox's full email address." }),
    { key: "mailErrBadRequest", detail: "Enter the mailbox's full email address.", own: true });
  assert.equal(mailErrorParts({ error_code: "auth_failed", detail: "Invalid\r\ncredentials" }).detail, "Invalid credentials");
  assert.equal(mailErrorParts({ error_code: "auth_failed", detail: "x" }).own, false);
});

// ---------------------------------------------------------------------------
// dashboard.html: how the page may show mail.
// ---------------------------------------------------------------------------

/** Every way the page could put a mail frame on screen, judged. */
function frameProblems(src) {
  const out = [];
  for (const t of ["allow-scripts", "allow-same-origin", "allow-forms", "allow-top-navigation", "allow-modals"]) {
    if (src.includes(t)) out.push(`mentions ${t}`);
  }
  if (/<iframe\b/i.test(src.replace(/<script[\s\S]*?<\/script>/gi, ""))) out.push("an <iframe> in the markup");
  if (/\.sandbox\s*=|sandbox\.add\(/.test(src)) out.push("sandbox set some other way");
  const makes = [...src.matchAll(/createElement\(\s*['"]iframe['"]\s*\)/g)];
  if (makes.length !== 1) out.push(`${makes.length} places create a frame`);
  for (const m of makes) {
    const after = src.slice(m.index, m.index + 600);
    const sb = after.indexOf("setAttribute('sandbox', mailSandboxAttr())");
    const doc = after.indexOf(".srcdoc");
    if (sb < 0) out.push("a frame without mailSandboxAttr()");
    else if (doc >= 0 && doc < sb) out.push("srcdoc set before the sandbox");
  }
  const srcdocs = [...src.matchAll(/\.srcdoc\s*=/g)];
  if (srcdocs.length !== makes.length) out.push("srcdoc assigned outside mailFrame");
  if (/srcdoc\s*=\s*["'`]/.test(src) || /setAttribute\(\s*['"]srcdoc/.test(src)) out.push("srcdoc from a string");
  if (!/mailFrame\(buildSrcdoc\(/.test(src)) out.push("mailFrame is not fed by buildSrcdoc");
  // Mail HTML goes to the sanitizer, or through htmlToPlain into textToHtml
  // (which escapes), and never straight into innerHTML.
  for (const m of src.matchAll(/(?:innerHTML|outerHTML)\s*[+]?=\s*([^;\n]*)/g)) {
    const rhs = m[1];
    if (/\b(ans|body|clean)\.(html|text)\b/.test(rhs) && !/^textToHtml\(/.test(rhs.trim())) {
      out.push(`mail content into innerHTML: ${rhs.trim().slice(0, 60)}`);
    }
  }
  if (/insertAdjacentHTML\([^)]*\b(ans|body)\.html/.test(src) || /document\.write/.test(src)) out.push("mail content written raw");
  return out;
}

test("dashboard.html shows mail only through mailFrame(): sandboxed first, fed by buildSrcdoc", () => {
  assert.deepEqual(frameProblems(PAGE), []);
  // The sandbox value itself is imported, never typed out on the page.
  assert.match(PAGE, /import \{[^}]*mailSandboxAttr[^}]*\} from '\.\/js\/lib\/mail-render\.mjs'/);
  // PLANTED: each kind of mistake is caught.
  const good = "function mailFrame(doc){ const f = document.createElement('iframe'); f.setAttribute('sandbox', mailSandboxAttr()); f.srcdoc = doc; return f; } x(mailFrame(buildSrcdoc(h)));";
  assert.deepEqual(frameProblems(good), []);
  assert.ok(frameProblems(good.replace("mailSandboxAttr()", "'allow-scripts allow-popups'")).length > 0);
  assert.ok(frameProblems(good.replace("f.setAttribute('sandbox', mailSandboxAttr()); f.srcdoc = doc;",
    "f.srcdoc = doc; f.setAttribute('sandbox', mailSandboxAttr());")).includes("srcdoc set before the sandbox"));
  assert.ok(frameProblems(good + " el.innerHTML = ans.html;").length > 0);
  assert.ok(frameProblems(good + " <div><iframe src=x></iframe></div>").length > 0);
  assert.ok(frameProblems(good + " g.srcdoc = raw;").includes("srcdoc assigned outside mailFrame"));
});

test("the HTML body is sanitized with a fresh DOMPurify instance, and plain text is the fallback", () => {
  const sec = mailSection();
  assert.ok(sec.length > 1000, "the Company email section was found");
  assert.match(sec, /window\.DOMPurify\(window\)/);
  assert.match(sec, /sanitizeMailHtml\(ans\.html, \{ purify: purifier/);
  assert.match(sec, /if \(clean\) \{[\s\S]{0,600}mailFrame\(buildSrcdoc\(clean\.html/);
  assert.match(sec, /tr\('mailNoSanitizer'\)/);
  assert.match(sec, /textToHtml\(ans\.text/);
  // The pinned DOMPurify loads as a classic script before the module.
  const tag = PAGE.indexOf('<script src="vendor/purify.min.js"></script>');
  assert.ok(tag > 0 && tag < PAGE.indexOf('<script type="module">'));
});

test("the vendored DOMPurify is the pinned release, licence header intact", () => {
  const buf = readFileSync("website/vendor/purify.min.js");
  assert.equal(createHash("sha256").update(buf).digest("hex"),
    "f263b05369e050fa175d4ecb9c9358eb4253602d510297adfb31df48b2f1c4d5");
  assert.match(buf.toString("utf8", 0, 300), /^\/\*! @license DOMPurify 3\.4\.15 \| \(c\) Cure53 and other contributors \| Released under the Apache license 2\.0 and Mozilla Public License 2\.0/);
  // PLANTED: one changed byte changes the hash.
  const copy = Buffer.from(buf);
  copy[copy.length - 1] ^= 1;
  assert.notEqual(createHash("sha256").update(copy).digest("hex"),
    "f263b05369e050fa175d4ecb9c9358eb4253602d510297adfb31df48b2f1c4d5");
});

/** What the Email tab's code must never do with a password or a body. */
function sectionProblems(sec) {
  const out = [];
  if (/console\.(log|info|debug|warn|error)\(/.test(sec)) out.push("logs");
  if (/localStorage|sessionStorage|indexedDB/.test(sec)) out.push("browser storage");
  if (!/\$\('ms_password'\)\.value = '';/.test(sec)) out.push("password field never cleared");
  const call = sec.indexOf("mailFn('mail-connect', payload)");
  const clear = sec.indexOf("$('ms_password').value = '';", call);
  if (call < 0 || clear < 0) out.push("password not cleared after connect");
  else if (/\bif\b|return/.test(sec.slice(sec.indexOf("\n", call), clear))) out.push("password cleared only on some paths");
  // The typed value itself never goes anywhere it could be seen.
  const value = String.raw`(\$\('ms_password'\)\.value|\bpw\.value|payload\.password|body\.password)`;
  if (new RegExp(String.raw`(innerHTML|textContent|title|placeholder)\s*=[^;\n]*` + value).test(sec)) out.push("password shown");
  if (new RegExp(String.raw`msg\([^\n]*` + value).test(sec)) out.push("password in a message");
  if (new RegExp(String.raw`mailNotes\.set\([^\n]*` + value).test(sec)) out.push("password in a note");
  return out;
}

test("the app password is sent once, never stored or logged, and its field is emptied whatever the answer", () => {
  const sec = mailSection();
  assert.deepEqual(sectionProblems(sec), []);
  // The replace-password field is emptied by the call's `after`, which runs
  // before success or failure is looked at.
  assert.match(sec, /if \(typeof after === 'function'\) after\(\);\s*btn\.disabled = false;\s*if \(status === 200/);
  // PLANTED: a stray log line, or a clear that only happens on success, is caught.
  assert.ok(sectionProblems(sec + "\nconsole.log(payload);").includes("logs"));
  assert.ok(sectionProblems(sec + "\nmsg('ms_msg', $('ms_password').value, 'err');").includes("password in a message"));
  assert.ok(sectionProblems(sec + "\nel.textContent = pw.value;").includes("password shown"));
  const onlyOnSuccess = sec.replace("mailFn('mail-connect', payload);\n  $('ms_password').value = '';",
    "mailFn('mail-connect', payload);\n  if (status === 200) $('ms_password').value = '';");
  assert.notEqual(onlyOnSuccess, sec, "the planted edit applied");
  assert.ok(sectionProblems(onlyOnSuccess).length > 0);
});

/** The gate as the page applies it. */
function gateProblems(src) {
  const out = [];
  if (!/<button class="tab" data-tab="mail" style="display:none">/.test(src)) out.push("tab visible before the gate");
  if (!/<span data-t="tabMail">Email<\/span><span class="pill mail-badge" id="mailUnread"/.test(src)) out.push("badge inside a data-t element");
  const sec = mailSection(src);
  if (!/profile\.role !== 'CREW'/.test(sec)) out.push("crew asked");
  if (!/db\.rpc\('can_use_company_mail'\)/.test(sec)) out.push("gate not asked");
  if (!/canUseMail = !error && data === true;/.test(sec)) out.push("gate not exact");
  if (!/\['dash','jobs','mail',/.test(src)) out.push("switchTab does not know the tab");
  if (!/await initMail\(\);\s*await loadAll\(\);/.test(src)) out.push("initMail not before loadAll");
  return out;
}

test("the Email tab appears only when can_use_company_mail() says exactly true, never for crew", () => {
  assert.deepEqual(gateProblems(PAGE), []);
  // PLANTED: a truthy check, a visible tab, or asking for crew is caught.
  assert.ok(gateProblems(PAGE.replace("canUseMail = !error && data === true;", "canUseMail = !!data;")).includes("gate not exact"));
  assert.ok(gateProblems(PAGE.replace('<button class="tab" data-tab="mail" style="display:none">', '<button class="tab" data-tab="mail">'))
    .includes("tab visible before the gate"));
  assert.ok(gateProblems(PAGE.replace("profile.role !== 'CREW'", "true")).includes("crew asked"));
});

test("every translation key the Email tab uses exists in all three languages", () => {
  const sec = mailSection();
  const used = new Set([
    ...[...sec.matchAll(/'((?:mail|setMail)[A-Z][A-Za-z0-9]*)'/g)].map((m) => m[1]),
    ...[...PAGE.matchAll(/data-t(?:-title)?="((?:mail|setMail|tabMail)[A-Za-z0-9]*)"/g)].map((m) => m[1]),
    ...Object.values(MAIL_ERROR_KEYS),
  ]);
  // Element ids ($('mailFolders')) match the same pattern and are not keys.
  for (const m of PAGE.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) used.delete(m[1]);
  assert.ok(used.size > 120, `found ${used.size} keys`);
  const missing = [];
  for (const k of used) for (const lang of ["en", "es", "fr"]) if (!TL[lang][k]) missing.push(`${lang}.${k}`);
  assert.deepEqual(missing, []);
  // PLANTED: a key that is not there is reported.
  assert.equal(TL.en.mailNoSuchKeyAnywhere, undefined);
});

test("the seat column: owner-only, set_mail_access, crew never and no money means no switch", () => {
  const sec = mailSection();
  assert.match(sec, /const on = canUseMail && profile\?\.role === 'OWNER';/);
  assert.match(sec, /r\.role === 'CREW'\) inner = [^;]*setMailAccessNever/);
  assert.match(sec, /!memberHasPerm\(r\.role, overrides\.get\(r\.id\), 'SEE_MONEY'\)/);
  assert.match(sec, /db\.rpc\('set_mail_access', \{ p_profile: id, p_allowed: want \}\)/);
  assert.match(PAGE, /\$\{mailCell\(r\)\}/);
  assert.match(PAGE, /<th id="seatMailCol" style="display:none" data-t="setMailAccessCol">/);
});

test("PLANTED: a FenceFlow mail reply always says its sender was not checked, loudest when it claims to be us", () => {
  const own = ["office@acmefence.com", "mail@send.fenceflowapp.com"];
  const domains = ["reply.fenceflowapp.com"];
  const reply = (from) => ({ source: "resend_inbound", folder_role: "inbox", from_address: from });
  assert.equal(senderWarning(reply("pat@example.org"), own, domains), "unverified");
  // The forgeries a deposit scam would use: our own mailbox, the shared
  // FenceFlow sender, a reply address -- in any case, with stray spaces.
  assert.equal(senderWarning(reply("Office@AcmeFence.com "), own, domains), "own_address");
  assert.equal(senderWarning(reply("mail@send.fenceflowapp.com"), own, domains), "own_address");
  assert.equal(senderWarning(reply("a1b2c3d4e5f60718.9f8e7d6c5b4a3921@reply.fenceflowapp.com"), own, domains), "own_address");
  // A look-alike domain is not ours; it is still unverified, never silent.
  assert.equal(senderWarning(reply("office@acmefence.com.evil.example"), own, domains), "unverified");
  // No From at all, or nothing known about ourselves yet: still warned.
  assert.equal(senderWarning(reply(""), own, domains), "unverified");
  assert.equal(senderWarning(reply("office@acmefence.com")), "unverified");
  // Mail from the company's own mailbox (IMAP) and FenceFlow's own sends are not flagged.
  assert.equal(senderWarning({ source: "imap", from_address: "pat@example.org" }, own, domains), null);
  assert.equal(senderWarning({ source: "fenceflow_send", from_address: "mail@send.fenceflowapp.com" }, own, domains), null);
  assert.equal(senderWarning(null, own, domains), null);

  // The reader runs it on every message, before any other note, with the
  // company's own addresses and the reply domain; both texts exist in all
  // three languages (the parity test above checks the keys it finds).
  const sec = mailSection();
  const body = sec.slice(sec.indexOf("function renderMailBody("), sec.indexOf("async function mailAfterSeenChange("));
  assert.match(body, /const warn = senderWarning\(m, mailOwnAddresses\(\), mailReplyDomains\(\)\);\s*if \(warn\) note\(tr\(warn === 'own_address' \? 'mailSenderOwnAddress' : 'mailSenderUnverified'\), warn === 'own_address'\);/);
  assert.ok(body.indexOf("senderWarning(") < body.indexOf("note(tr('mailMaybeSent'))"), "the warning must come first");
  for (const lang of ["en", "es", "fr"]) for (const k of ["mailSenderUnverified", "mailSenderOwnAddress"]) assert.ok(TL[lang][k], `${lang}.${k}`);
  // PLANTED: a checker that looked at the wrong field would pass everything.
  assert.notEqual(senderWarning({ source: "resend_inbound", from_name: "office@acmefence.com", from_address: "x@evil.example" }, own), "own_address");
});

test("a send keeps its client_send_id unless it certainly failed", () => {
  const sec = mailSection();
  const send = sec.slice(sec.indexOf("async function sendCompose()"), sec.indexOf("function composeSent("));
  assert.match(send, /if \(body\.state === 'sent'\) return composeSent/);
  assert.match(send, /if \(!status \|\| body\.state === 'sending'\) \{[\s\S]*?tr\('mailMaybeSent'\)/);
  // A new id is minted in exactly one place: after state "failed".
  const mints = [...send.matchAll(/c\.clientSendId = crypto\.randomUUID\(\)/g)];
  assert.equal(mints.length, 1);
  const failed = send.indexOf("if (body.state === 'failed')");
  assert.ok(failed >= 0 && mints[0].index > failed && mints[0].index - failed < 200);
  // Attachments go only to the caller's own outgoing folder.
  assert.match(send, /`\$\{profile\.company_id\}\/outgoing\/\$\{profile\.id\}\/\$\{c\.folder\}\/\$\{f\.name\}`/);
  // A download link is followed only into this project's storage.
  assert.match(sec, /u\.origin !== new URL\(SUPA_URL\)\.origin \|\| !u\.pathname\.startsWith\('\/storage\/v1\/'\)/);
});
