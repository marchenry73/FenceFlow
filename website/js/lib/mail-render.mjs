/* The office inbox's pure half: everything about showing and answering
   company email that can be decided without a DOM, a network or a clock.
   dashboard.html's Email tab imports it; tests/mail-render.test.mjs imports
   the same file under plain Node.

   WHY THIS FILE EXISTS. An email is text written by a stranger. Its HTML is
   untrusted markup, its subject and sender name are untrusted strings, and
   its attachments carry names chosen by whoever sent them. Every place the
   office turns one of those into something on screen is here, so the rules
   are written once and tested once:

     - Mail HTML never touches the office's own DOM. It is sanitized
       (DOMPurify, handed in by the caller as `purify`, because DOMPurify
       needs a real DOM that Node does not have) and then shown only inside
       a sandboxed srcdoc frame (mailSandboxAttr: popups for links and
       nothing else -- no script, no same-origin, no forms, no top-level
       navigation) whose own Content-Security-Policy (mailCsp) forbids every
       network fetch except, after "Show pictures", https images. The frame
       and its CSP are what the browser enforces; the sanitizer is the extra
       layer. If DOMPurify failed to load, sanitizeMailHtml answers null and
       the office shows the plain text instead -- it fails closed, never to
       raw HTML.
     - Remote pictures are off by default. They are how a sender learns that
       and when a message was opened (a tracking pixel), and from where.
     - Everything else a stranger wrote -- subject, name, address, snippet,
       file name -- goes through escapeHtml() in the row builders here, or is
       set with textContent by the page. Plain-text bodies become HTML only
       through textToHtml(), which escapes first and then links http(s)
       addresses and nothing else.

   No imports, no DOM, no Supabase, no Date.now(): "now" is always passed in. */

// ---------------------------------------------------------------------------
// Limits the office checks before asking the server. The server
// (supabase/functions/_shared/mail/limits.ts) enforces the same numbers; these
// only save a round trip and let the page say why before anything is sent.
// ---------------------------------------------------------------------------

export const MAIL_LIMITS = Object.freeze({
  maxAttachments: 5,
  attachmentsTotalBytes: 10 * 1024 * 1024,
  maxRecipientsSmtp: 20,
  maxRecipientsFenceflow: 10,
  subjectMaxChars: 300,
  textMaxBytes: 100 * 1024,
  // What a reply may quote of the original, so a long thread cannot push
  // the body past textMaxBytes before the person has typed a word.
  quoteMaxChars: 40 * 1024,
});

// ---------------------------------------------------------------------------
// Escaping.
// ---------------------------------------------------------------------------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Safe inside element content AND inside a quoted attribute. */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Control characters and the invisible direction overrides out. A subject
    carrying U+202E can render its words backwards; one carrying a newline
    can look like two lines of a different message. */
export function cleanLine(s) {
  // eslint-disable-next-line no-control-regex
  return String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// The frame.
// ---------------------------------------------------------------------------

/* Popups, so a link in a message opens in a new tab, and the popup escapes
   the sandbox, so the page it opens works like any page. Nothing else: no
   script, no same-origin (the frame gets an opaque origin, so even a script
   that somehow ran could not reach the office's session), no forms, no
   top-level navigation, no downloads, no modals. */
const MAIL_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/** The ONE sandbox value a mail frame may carry. dashboard.html sets it
    through this function and nowhere else, which the test checks. */
export function mailSandboxAttr() {
  return MAIL_SANDBOX;
}

/** The frame's own Content-Security-Policy. default-src 'none' refuses
    every fetch -- script, frame, font file, stylesheet link, beacon --
    and only what is listed after it is allowed back: inline styles (email
    is styled inline), pictures carried in the message itself (data:), and,
    once someone presses "Show pictures", https pictures. form-action and
    base-uri do not fall back to default-src, so they are named. */
export function mailCsp({ images = false } = {}) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    images ? "img-src data: https:" : "img-src data:",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** The whole document a mail frame shows. The CSP meta comes first in
    <head>, before anything that could fetch. `bodyHtml` must already be
    sanitized (sanitizeMailHtml) or escaped (textToHtml). A white page on
    purpose, whatever the office theme: senders design for white. */
export function buildSrcdoc(bodyHtml, { images = false } = {}) {
  return "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(mailCsp({ images }))}">` +
    "<meta name=\"referrer\" content=\"no-referrer\">" +
    "<meta name=\"color-scheme\" content=\"light\">" +
    "<base target=\"_blank\">" +
    "<style>html,body{margin:0;padding:0;background:#fff;color:#12151a}" +
    "body{padding:14px;font:14px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;" +
    "overflow-wrap:anywhere;word-wrap:break-word}" +
    "img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}" +
    "blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #d0d5dd;color:#444}</style>" +
    `</head><body>${String(bodyHtml ?? "")}</body></html>`;
}

// ---------------------------------------------------------------------------
// Sanitizing.
// ---------------------------------------------------------------------------

/* Anything that runs, embeds, submits or reaches out, and anything that
   changes how the frame's own document behaves. Most are not in
   DOMPurify's default allow-list anyway; naming them keeps them out even if
   a future DOMPurify widens that list. */
export const MAIL_FORBID_TAGS = Object.freeze([
  "script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "applet",
  "portal", "form", "input", "button", "textarea", "select", "option", "datalist", "keygen",
  "base", "meta", "link", "svg", "math", "audio", "video", "source", "track", "canvas", "dialog",
]);

/* srcset and background are picture sources the hook below would otherwise
   have to parse; ping reports a click to a third party; the rest belong to
   the forbidden tags above and are listed in case one slips through. */
export const MAIL_FORBID_ATTR = Object.freeze([
  "srcset", "ping", "background", "poster", "action", "formaction", "srcdoc", "xlink:href",
  "http-equiv", "autofocus",
]);

/* DOMPurify tests EVERY attribute value not on its short URI-safe list
   (style, class, alt, title and a few more are on it) against this, so the
   last two alternatives -- a value that does not start with a scheme at all
   ("100", "center", "50%") -- must stay or every width and align would be
   stripped. The schemes are http(s), mailto, tel
   and cid (rewritten or removed by the hook). Not javascript:, not data:
   (DOMPurify admits data: separately, for pictures only, and the hook
   narrows that to four raster types), not vbscript:, not file:. */
export const MAIL_URI_RE = /^(?:(?:https?|mailto|tel|cid):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

export function purifyConfig() {
  return {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [...MAIL_FORBID_TAGS],
    FORBID_ATTR: [...MAIL_FORBID_ATTR],
    ALLOWED_URI_REGEXP: MAIL_URI_RE,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ADD_ATTR: ["target"],
    KEEP_CONTENT: true,
    WHOLE_DOCUMENT: false,
    // Most HTML mail is a whole document whose look lives in <head><style>.
    // Without this the parser files that <style> under <head>, DOMPurify
    // hands back only <body>, and every such message loses its layout (seen
    // with the real DOMPurify in a browser). Forced into the body, the style
    // block is kept -- and passes through the uponSanitizeElement hook.
    FORCE_BODY: true,
  };
}

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const REMOTE_RE = /^\s*(?:https?:)?\/\//i;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** A cid: reference as the server keys inline_images: angle brackets off,
    percent-decoding undone. */
export function cidKey(src) {
  let v = String(src ?? "").trim().replace(/^cid:/i, "");
  try { v = decodeURIComponent(v); } catch { /* leave as is */ }
  return v.replace(/^<|>$/g, "").trim();
}

function lookupInline(inlineImages, src) {
  if (!inlineImages) return null;
  const key = cidKey(src);
  if (!key) return null;
  const has = (k) => Object.prototype.hasOwnProperty.call(inlineImages, k);
  const hit = has(key) ? inlineImages[key] : (has(key.toLowerCase()) ? inlineImages[key.toLowerCase()] : null);
  return typeof hit === "string" && SAFE_DATA_IMAGE_RE.test(hit) ? hit : null;
}

/** CSS with @import removed (a stylesheet fetch, which the frame's CSP
    refuses anyway) and remote url(...) replaced by `none` unless pictures
    are allowed (then only http is upgraded to https). data: and anything
    else passes; the frame's CSP still decides what loads. Counts the
    pictures it held back into `counter.blocked`, which is what offers
    "Show pictures" -- an @import is not one, since showing pictures would
    not bring it back. */
export function filterCssUrls(css, { images = false, counter = null } = {}) {
  const out = String(css ?? "").replace(/@import[^;]*;?/gi, "");
  return out.replace(CSS_URL_RE, (whole, _q, url) => {
    if (!REMOTE_RE.test(url)) return whole;
    if (images) return whole.replace(/url\(\s*(['"]?)\s*http:/i, "url($1https:");
    if (counter) counter.blocked++;
    return "none";
  });
}

/**
 * The DOMPurify hooks for one message. `afterSanitizeAttributes` runs on
 * every element DOMPurify kept, after it has already removed what its
 * config forbids, so what is left here is narrowing:
 *   - a link opens in a new tab with no opener and no referrer; a cid: link
 *     (meaningless outside a mail client) loses its href;
 *   - a picture keeps only: its inline copy (cid: -> the data: URL the
 *     server sent in inline_images), a data: PNG/JPEG/GIF/WebP, or -- only
 *     when pictures are allowed -- an http(s) address, upgraded to https;
 *     anything else loses its src, and a remote one is counted as blocked;
 *   - inline style url(...) goes through filterCssUrls.
 * `uponSanitizeElement` does the same for the text of <style> blocks.
 * Written against the few node methods DOMPurify's nodes have, so the test
 * drives it with plain objects.
 */
export function makeMailHooks({ images = false, inlineImages = null, counter = { blocked: 0 } } = {}) {
  const afterSanitizeAttributes = (node) => {
    if (!node || typeof node.getAttribute !== "function") return;
    const tag = String(node.tagName || node.nodeName || "").toUpperCase();
    if (node.hasAttribute && node.hasAttribute("href")) {
      const href = String(node.getAttribute("href") || "");
      if (/^\s*cid:/i.test(href)) node.removeAttribute("href");
      else {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    } else if (node.hasAttribute && node.hasAttribute("target")) {
      // A target on anything but a link does nothing useful.
      node.removeAttribute("target");
    }
    if (tag === "IMG" && node.hasAttribute("src")) {
      const src = String(node.getAttribute("src") || "").trim();
      if (/^cid:/i.test(src)) {
        const data = lookupInline(inlineImages, src);
        if (data) node.setAttribute("src", data);
        else node.removeAttribute("src");
      } else if (/^data:/i.test(src)) {
        if (!SAFE_DATA_IMAGE_RE.test(src)) node.removeAttribute("src");
      } else if (REMOTE_RE.test(src)) {
        if (images) node.setAttribute("src", src.replace(/^\s*(?:http:)?\/\//i, "https://"));
        else {
          node.removeAttribute("src");
          counter.blocked++;
        }
      } else {
        node.removeAttribute("src");
      }
    }
    if (node.hasAttribute && node.hasAttribute("style")) {
      const before = String(node.getAttribute("style") || "");
      const after = filterCssUrls(before, { images, counter });
      if (after !== before) node.setAttribute("style", after);
    }
  };
  const uponSanitizeElement = (node, data) => {
    const tag = String((data && data.tagName) || node?.nodeName || "").toLowerCase();
    if (tag !== "style" || !node) return;
    const before = String(node.textContent || "");
    const after = filterCssUrls(before, { images, counter });
    if (after !== before) node.textContent = after;
  };
  return { afterSanitizeAttributes, uponSanitizeElement, counter };
}

/**
 * A message's HTML, sanitized for the mail frame.
 *
 * `purify` is a DOMPurify INSTANCE of the caller's own (window.DOMPurify(window)
 * makes a fresh one), so the hooks added here belong to this call alone and
 * cannot leak into anything else on the page. Returns null when there is no
 * usable sanitizer -- the caller must then show the plain text, never the raw
 * HTML. `blocked` is how many remote pictures were held back, which is what
 * decides whether "Show pictures" is offered.
 */
export function sanitizeMailHtml(html, { purify = null, images = false, inlineImages = null } = {}) {
  if (!purify || typeof purify.sanitize !== "function" || typeof purify.addHook !== "function") return null;
  if (purify.isSupported === false) return null;
  const hooks = makeMailHooks({ images, inlineImages, counter: { blocked: 0 } });
  purify.addHook("uponSanitizeElement", hooks.uponSanitizeElement);
  purify.addHook("afterSanitizeAttributes", hooks.afterSanitizeAttributes);
  try {
    const out = purify.sanitize(String(html ?? ""), purifyConfig());
    return { html: String(out ?? ""), blocked: hooks.counter.blocked };
  } finally {
    if (typeof purify.removeAllHooks === "function") purify.removeAllHooks();
  }
}

/** A cheap look at raw HTML: does it ask for any remote picture at all?
    Used for a message whose HTML could not be sanitized, to decide nothing
    more than whether to say pictures exist. */
export function countRemoteImages(html) {
  const s = String(html ?? "");
  let n = 0;
  n += (s.match(/<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//gi) || []).length;
  n += (s.match(/\bbackground\s*=\s*["']?\s*(?:https?:)?\/\//gi) || []).length;
  n += (s.match(/url\(\s*['"]?\s*(?:https?:)?\/\//gi) || []).length;
  return n;
}

// ---------------------------------------------------------------------------
// Plain text.
// ---------------------------------------------------------------------------

const LINK_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Plain text as safe HTML: escaped first, line breaks kept, and http(s)
    addresses (only those) turned into links that open in a new tab with no
    opener. Trailing punctuation is left out of the link, as mail apps do. */
export function textToHtml(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  let out = "";
  let last = 0;
  for (const m of src.matchAll(LINK_RE)) {
    let url = m[0];
    const trail = url.match(/[.,;:!?)\]]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    out += escapeHtml(src.slice(last, m.index));
    out += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  out += escapeHtml(src.slice(last));
  return out.replace(/\n/g, "<br>");
}

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Rough plain text of an HTML body, for quoting it in a reply or a
    forward when the message had no text part. Never rendered as HTML. */
export function htmlToPlain(html) {
  return String(html ?? "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
      if (e[0] === "#") {
        const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
      }
      return Object.prototype.hasOwnProperty.call(ENTITY, e.toLowerCase()) ? ENTITY[e.toLowerCase()] : whole;
    })
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Answering.
// ---------------------------------------------------------------------------

// Re, Fwd, FW, TR (French), RV (Spanish), AW/WG (German), SV (Nordic), with
// an optional counter: "Re[2]:", "RE (3):".
const REPLY_PREFIX_RE = /^\s*((re|fw|fwd|tr|rv|aw|wg|sv)\s*(\[\d+\]|\(\d+\))?\s*:\s*)+/i;

/** A subject without its Re:/Fwd:/TR:/RV:/AW: prefixes, for display only.
    Threads are never merged by subject. */
export function normalizeSubject(subject) {
  return cleanLine(String(subject ?? "").replace(REPLY_PREFIX_RE, ""));
}

/** "Re: <subject>" or "Fwd: <subject>", without stacking prefixes. */
export function replySubject(subject, kind = "re") {
  const base = normalizeSubject(subject);
  const prefix = kind === "fwd" ? "Fwd: " : "Re: ";
  return (prefix + base).slice(0, MAIL_LIMITS.subjectMaxChars);
}

function capQuote(text) {
  const t = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return t.length > MAIL_LIMITS.quoteMaxChars ? t.slice(0, MAIL_LIMITS.quoteMaxChars) + "\n[...]" : t;
}

/** The original, quoted below a reply. `header` is the already-translated
    "On <date>, <name> wrote:" line. */
export function quoteForReply(text, header) {
  const body = capQuote(text).split("\n").map((l) => (l.startsWith(">") ? ">" + l : "> " + l)).join("\n");
  return `\n\n${cleanLine(header)}\n${body}\n`;
}

/** The standard forwarded-message block. `labels` carries the translated
    words; every value is one clean line. */
export function forwardBlock(m, labels) {
  const L = labels || {};
  const lines = [
    String(L.head || "---------- Forwarded message ---------"),
    `${L.from || "From"}: ${addressLabel({ name: m.from_name, address: m.from_address })}`,
    `${L.date || "Date"}: ${cleanLine(m.date || "")}`,
    `${L.subject || "Subject"}: ${cleanLine(m.subject || "")}`,
    `${L.to || "To"}: ${listLabel(m.to_list)}`,
  ];
  const cc = listLabel(m.cc_list);
  if (cc) lines.push(`${L.cc || "Cc"}: ${cc}`);
  return `\n\n${lines.join("\n")}\n\n${capQuote(m.text || "")}\n`;
}

/** "Name <address>", or just the address. */
export function addressLabel(a) {
  const address = cleanLine(a && a.address);
  const name = cleanLine(a && a.name).replace(/[<>]/g, "");
  if (!address) return name;
  return name && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address;
}

export function listLabel(list) {
  return (Array.isArray(list) ? list : []).map(addressLabel).filter(Boolean).join(", ");
}

/* The same address test the server applies (mime-build.ts refuses, never
   repairs): no spaces, no brackets, no line breaks, one @, a dotted domain. */
const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function isValidAddress(s) {
  const v = String(s ?? "");
  return v.length <= 254 && ADDRESS_RE.test(v);
}

/** What someone typed in To/Cc/Bcc, split on commas, semicolons and line
    breaks. "Name <addr>" is accepted and reduced to the address. Returns the
    good addresses (lower-cased, de-duplicated) and what could not be read. */
export function parseAddressList(input) {
  const ok = [];
  const bad = [];
  for (const raw of String(input ?? "").split(/[,;\n\r]+/)) {
    const piece = raw.trim();
    if (!piece) continue;
    const m = piece.match(/<([^<>]*)>\s*$/);
    const addr = (m ? m[1] : piece).trim().toLowerCase();
    if (isValidAddress(addr)) {
      if (!ok.includes(addr)) ok.push(addr);
    } else bad.push(piece);
  }
  return { ok, bad };
}

/**
 * Whether the reader warns that a message's sender was never checked, and
 * how loudly. A FenceFlow mail reply (source resend_inbound) comes in through
 * a reply address every customer has seen and anyone can write to, and
 * nothing Resend hands over proves who sent it: its From line is whatever
 * the sender typed. Mail fetched from the company's own mailbox has at least
 * been through that provider's filtering, so it gets no warning here.
 *   null           no warning
 *   "unverified"   every FenceFlow mail reply
 *   "own_address"  one whose From claims to be the company itself (one of
 *                  `own`, or an address at one of `domains`, the reply
 *                  domain) -- how a forged invoice or a "new bank details"
 *                  message would dress itself.
 */
export function senderWarning(m, own = [], domains = []) {
  if (!m || m.source !== "resend_inbound") return null;
  const from = String(m.from_address || "").trim().toLowerCase();
  const mine = new Set((own || []).map((a) => String(a || "").trim().toLowerCase()).filter(Boolean));
  const doms = (domains || []).map((d) => String(d || "").trim().toLowerCase()).filter(Boolean);
  const at = from.lastIndexOf("@");
  const claimsUs = !!from && (mine.has(from) || (at > 0 && doms.includes(from.slice(at + 1))));
  return claimsUs ? "own_address" : "unverified";
}

/**
 * Who a reply goes to. `own` is every address the company sends from (its
 * mailboxes and FenceFlow mail); none of them is ever a recipient.
 *   - An incoming message: Reply-To if it set one, else From.
 *   - A message we sent: its original To (answering our own message means
 *     writing to the same people again).
 *   - Reply all adds everyone else from To and Cc to Cc.
 */
export function replyRecipients(m, { all = false, own = [] } = {}) {
  const mine = new Set((own || []).map((a) => String(a || "").toLowerCase()));
  const addr = (a) => String((a && a.address) || "").trim().toLowerCase();
  const usable = (list) => (Array.isArray(list) ? list : []).map(addr).filter((a) => isValidAddress(a) && !mine.has(a));
  const to = [];
  const push = (arr, a) => { if (!arr.includes(a)) arr.push(a); };
  const fromSelf = m && m.folder_role === "sent";
  if (fromSelf) usable(m.to_list).forEach((a) => push(to, a));
  else {
    const rt = usable(m && m.reply_to_list);
    (rt.length ? rt : usable(m && m.from_address ? [{ address: m.from_address }] : [])).forEach((a) => push(to, a));
  }
  const cc = [];
  if (all) {
    const pool = fromSelf ? usable(m.cc_list) : [...usable(m && m.to_list), ...usable(m && m.cc_list)];
    for (const a of pool) if (!to.includes(a)) push(cc, a);
  }
  return { to, cc };
}

// ---------------------------------------------------------------------------
// Files.
// ---------------------------------------------------------------------------

/**
 * A file name that is safe as the last segment of a storage key and as an
 * attachment name: the path part dropped, then only ASCII letters, digits,
 * space, dot, dash, underscore and brackets kept (Supabase Storage refuses
 * most else), no leading dot, at most 120 characters with the extension
 * kept. Never contains / or \, never empty, never "." or "..".
 */
export function safeFilename(name) {
  let base = String(name ?? "").split(/[\\/]/).pop() || "";
  base = base.normalize ? base.normalize("NFKD").replace(/[\u0300-\u036f]/g, "") : base;
  base = base.replace(/[^A-Za-z0-9 ._()-]+/g, "_").replace(/\s+/g, " ").replace(/_+/g, "_");
  base = base.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (base.length > 120) {
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : "";
    base = base.slice(0, 120 - ext.length).replace(/[\s.]+$/, "") + ext;
  }
  return base && base !== "." && base !== ".." ? base : "file";
}

/** 14 MB, 512 KB, 900 bytes. */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${Math.max(1, Math.round(v / 1024))} KB`;
  const mb = v / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/* Every error_code the mail functions answer with (errors.ts MailErrorCode)
   -> the office's translation key. The test holds this against errors.ts,
   so a new server code cannot arrive at the office untranslated. */
export const MAIL_ERROR_KEYS = Object.freeze({
  no_session: "mailErrNoSession",
  mail_forbidden: "mailErrForbidden",
  owner_only: "mailErrOwnerOnly",
  bad_request: "mailErrBadRequest",
  too_large: "mailErrTooLarge",
  rate_limited: "mailRateLimited",
  not_found: "mailErrNotFound",
  not_configured: "mailErrNotConfigured",
  server_error: "mailErrServer",
  auth_failed: "mailErrAuth",
  imap_disabled_or_plan: "mailErrImapOffOrPlan",
  smtp_auth_failed: "mailErrSmtpAuth",
  recipient_rejected: "mailErrRecipient",
  send_rejected: "mailErrSendRejected",
  tls_failed: "mailErrTls",
  timeout: "mailErrTimeout",
  dns_failed: "mailErrDns",
  connect_failed: "mailErrConnect",
  smtp_587_only: "mailErrSmtp587Only",
  host_not_allowed: "mailErrHostNotAllowed",
  microsoft_oauth_only: "mailErrMicrosoft",
  server_busy: "mailErrBusy",
  protocol_error: "mailErrProtocol",
  folder_missing: "mailErrFolderMissing",
  session_limit: "mailErrSessionLimit",
});

/* Codes whose `detail` FenceFlow wrote itself for a person to read ("Enter
   the mailbox's full email address.") -- that sentence is more useful than
   the generic one. For every other code the detail is the mail server's own
   words (already redacted by the server), shown as "The server said: ...". */
const OWN_DETAIL_CODES = new Set(["bad_request", "not_found", "too_large", "owner_only"]);

/** How to describe a mail function's error answer: which key, and what
    extra text (if any) goes with it. Unknown codes fall back to the
    generic server error, never to a raw code on screen. */
export function mailErrorParts(body) {
  const code = String((body && body.error_code) || "");
  const key = MAIL_ERROR_KEYS[code] || "mailErrServer";
  const detail = cleanLine(body && body.detail).slice(0, 300);
  if (!detail) return { key, detail: "", own: false };
  return { key, detail, own: OWN_DETAIL_CODES.has(code) };
}

// ---------------------------------------------------------------------------
// The thread list.
// ---------------------------------------------------------------------------

/** When, the way a mail list says it: the time today, "Sep 3" this year,
    a short date before that. `now` is passed in. */
export function mailTimeLabel(iso, now, lang = "en") {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const n = now instanceof Date ? now : new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  try {
    if (sameDay) return new Intl.DateTimeFormat(lang, { hour: "numeric", minute: "2-digit" }).format(d);
    if (d.getFullYear() === n.getFullYear()) return new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" }).format(d);
    return new Intl.DateTimeFormat(lang, { year: "numeric", month: "numeric", day: "numeric" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const CLIP_SVG = '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path d="M10.5 4.5l-5 5a1.5 1.5 0 002 2l5.5-5.5a3 3 0 00-4.2-4.2L3.2 7.4a4.5 4.5 0 006.4 6.4L13 10.4"/></svg>';

/** Job chips for a thread: names looked up in `jobNames` (sync_id -> label).
    A link to a job this person cannot see (or that was deleted) is left out
    rather than shown as a bare id. */
export function jobChipsHtml(ids, jobNames) {
  const names = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const label = jobNames && typeof jobNames.get === "function" ? jobNames.get(id) : null;
    if (label) names.push(`<span class="mail-chip">${escapeHtml(cleanLine(label))}</span>`);
  }
  return names.length ? `<span class="mail-chips">${names.join("")}</span>` : "";
}

/**
 * One row of the thread list, every stranger-written string escaped.
 * t is a mail_list_threads row. ctx: { folder, selectedId, jobNames, now,
 * lang, words: { noSubject, toPrefix, unread, attachment } } -- the words
 * already translated.
 */
export function threadRowHtml(t, ctx = {}) {
  const w = ctx.words || {};
  const unread = Number(t && t.unread_count) > 0;
  const sent = ctx.folder === "sent";
  let who;
  if (sent) {
    const parts = (Array.isArray(t && t.participants) ? t.participants : []).slice(0, 3).map(cleanLine).filter(Boolean);
    who = `${w.toPrefix || "To:"} ${parts.join(", ")}`.trim();
  } else {
    who = cleanLine(t && t.latest_from_name) || cleanLine(t && t.latest_from_address) ||
      (Array.isArray(t && t.participants) ? cleanLine(t.participants[0]) : "");
  }
  const subject = cleanLine(t && t.subject) || w.noSubject || "(no subject)";
  const count = Number(t && t.message_count) || 0;
  const id = String((t && t.id) || "");
  return `<button type="button" class="mail-row${unread ? " unread" : ""}${ctx.selectedId === id ? " on" : ""}" data-thread="${escapeHtml(id)}">` +
    `<span class="mr-top">` +
    (unread ? `<span class="mr-dot" title="${escapeHtml(w.unread || "Unread")}"></span>` : "") +
    `<span class="mr-who">${escapeHtml(who)}</span>` +
    (count > 1 ? `<span class="mr-n">${count}</span>` : "") +
    `<span class="mr-time">${escapeHtml(mailTimeLabel(t && t.last_message_at, ctx.now || new Date(0), ctx.lang || "en"))}</span>` +
    `</span>` +
    `<span class="mr-subj">${t && t.has_attachments ? `<span class="mr-clip" title="${escapeHtml(w.attachment || "Attachment")}">${CLIP_SVG}</span>` : ""}${escapeHtml(subject)}</span>` +
    `<span class="mr-snip">${escapeHtml(cleanLine(t && t.snippet))}</span>` +
    jobChipsHtml(t && t.job_sync_ids, ctx.jobNames) +
    `</button>`;
}
