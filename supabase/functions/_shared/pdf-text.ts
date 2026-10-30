/**
 * A plain-text PDF, written by hand.
 *
 * "I also want the scope of work to show on a PDF on the emails too."
 *
 * NO LIBRARY, on purpose. An edge function cannot pull a PDF package from the
 * allowlisted CDNs at runtime, and bundling one to lay out a page of text
 * would be a large dependency in the path of every outgoing email. A
 * single-font, text-only PDF is a few hundred bytes of structure, and the
 * structure is the whole format: a catalog, a pages node, one page object per
 * page, one content stream each, one font, and an xref table of byte offsets.
 *
 * THE BYTE OFFSETS ARE THE WHOLE RISK. The xref table has to give the exact
 * byte position of every object, so the file is assembled as bytes while the
 * offsets are recorded -- never as a string that something later re-encodes.
 * A UTF-8 multi-byte character anywhere ahead of an object would shift it and
 * the file would open as damaged, which is why text is folded to WinAnsi
 * before it goes near the stream (see toWinAnsi) and why the tests check the
 * offsets point at real objects rather than merely that the file starts with
 * %PDF.
 *
 * Pure: no Deno, no fetch, no clock. tests/pdf-text.test.mjs runs it in Node.
 */

/** US Letter, in points. */
export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
const MARGIN = 54; // 0.75in
const BODY_SIZE = 10;
const TITLE_SIZE = 15;
const LEADING = 14;

/**
 * Characters outside WinAnsi, folded to something that reads the same.
 *
 * The font is Helvetica with /WinAnsiEncoding, so one byte is one glyph and
 * anything above 0xff cannot be written at all. An em dash or a curly quote
 * from a customer's note would otherwise emit two raw UTF-8 bytes, which
 * shows up as mojibake AND shifts every byte offset after it.
 */
const FOLD: Record<string, string> = {
  "—": "-", "–": "-", "−": "-",
  "‘": "'", "’": "'", "‚": ",",
  "“": '"', "”": '"',
  "…": "...", " ": " ",
  "•": "-", "′": "'", "″": '"',
  "²": "2", "¹": "1", "³": "3",
};

export function toWinAnsi(s: string): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const folded = FOLD[ch] ?? ch;
    for (const c of folded) {
      const code = c.codePointAt(0) ?? 63;
      // Printable ASCII and the Latin-1 range go through; a tab becomes
      // spaces; anything else becomes '?' rather than a byte that would
      // corrupt the offsets.
      if (c === "\t") out += "    ";
      else if (code === 10 || code === 13) out += " ";
      else if (code >= 32 && code <= 255) out += c;
      else out += "?";
    }
  }
  return out;
}

/** ( ) and \ end or escape a PDF string literal. */
function escapeLiteral(s: string): string {
  return s.replace(/[\\()]/g, (c) => "\\" + c);
}

/**
 * Helvetica advance widths, in 1/1000 em, for the ASCII range.
 *
 * Needed because wrapping on a character count sets a 70-character line of
 * "WWWW..." and a 70-character line of "iiii..." to the same width, and the
 * first runs off the page. Only ASCII is tabulated; anything else is charged
 * the width of "n", which is close enough for a specification sheet and never
 * underestimates by much.
 */
const W: Record<string, number> = {};
{
  const put = (chars: string, w: number) => { for (const c of chars) W[c] = w; };
  put(" !", 278); put('"', 355); put("#$", 556); put("%", 889); put("&", 667);
  put("'", 191); put("()", 333); put("*", 389); put("+", 584); put(",.", 278);
  put("-", 333); put("/", 278); put("0123456789", 556); put(":;", 278);
  put("<=>", 584); put("?", 556); put("@", 1015);
  put("ABDEHKNOPQRSUVXY", 722); put("C", 722); put("FG", 667); put("I", 278);
  put("J", 500); put("L", 611); put("M", 833); put("T", 611); put("W", 944);
  put("Z", 611); put("[]", 278); put("\\", 278); put("^", 469); put("_", 556);
  put("`", 333); put("abcdeghknopqsu", 556); put("f", 278); put("ij", 222);
  put("l", 222); put("m", 833); put("r", 333); put("t", 278); put("vxy", 500);
  put("w", 722); put("z", 500); put("{}", 334); put("|", 260); put("~", 584);
}

function textWidth(s: string, size: number): number {
  let total = 0;
  for (const c of s) total += W[c] ?? 556;
  return (total * size) / 1000;
}

/** Breaks a line to fit, on spaces where it can and mid-word when it must. */
export function wrapLine(text: string, size: number, maxWidth: number): string[] {
  const words = toWinAnsi(text).split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size) <= maxWidth) { line = candidate; continue; }
    if (line) { lines.push(line); line = ""; }
    // A single word longer than the line (a URL, a long licence string) is
    // cut rather than allowed to run off the page edge.
    let rest = word;
    while (textWidth(rest, size) > maxWidth) {
      let cut = rest.length - 1;
      while (cut > 1 && textWidth(rest.slice(0, cut), size) > maxWidth) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

export interface PdfTextDoc {
  title: string;
  /** Each entry is a paragraph; "" is a blank line. */
  lines: readonly string[];
  /** Small grey line at the foot of every page. */
  footer?: string;
}

/**
 * Lays the text out and returns the PDF bytes.
 *
 * Multi-page: a specification with a dozen sides does not fit on one sheet,
 * and a PDF that silently drops the overflow would be worse than no PDF.
 */
export function pdfFromText(doc: PdfTextDoc): Uint8Array {
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const title = toWinAnsi(doc.title ?? "");
  const footer = toWinAnsi(doc.footer ?? "");

  // Lay out into pages first, so the object count is known before any byte
  // is written.
  const pages: string[][] = [];
  let current: string[] = [];
  let y = PAGE_HEIGHT - MARGIN - (title ? TITLE_SIZE + LEADING : 0);
  const bottom = MARGIN + (footer ? LEADING * 2 : LEADING);

  for (const para of doc.lines ?? []) {
    const wrapped = para === "" ? [""] : wrapLine(para, BODY_SIZE, maxWidth);
    for (const line of wrapped) {
      if (y - LEADING < bottom) {
        pages.push(current);
        current = [];
        y = PAGE_HEIGHT - MARGIN;
      }
      current.push(line);
      y -= LEADING;
    }
  }
  pages.push(current);

  // ---- objects ------------------------------------------------------------
  const FONT_OBJ = 3 + pages.length * 2; // catalog, pages, [page, stream]*, font
  const objects: string[] = [];

  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);

  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  pages.forEach((lines, i) => {
    const streamObj = 4 + i * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Contents ${streamObj} 0 R /Resources << /Font << /F1 ${FONT_OBJ} 0 R >> >> >>`,
    );

    const parts: string[] = [];
    let cy = PAGE_HEIGHT - MARGIN;
    if (i === 0 && title) {
      parts.push(
        `BT /F1 ${TITLE_SIZE} Tf 1 0 0 1 ${MARGIN} ${cy} Tm (${escapeLiteral(title)}) Tj ET`,
      );
      cy -= TITLE_SIZE + LEADING;
    }
    if (lines.length) {
      parts.push(`BT /F1 ${BODY_SIZE} Tf ${LEADING} TL 1 0 0 1 ${MARGIN} ${cy} Tm`);
      lines.forEach((line, n) => {
        // T* moves down one leading; the first line sits where Tm put it.
        if (n > 0) parts.push("T*");
        parts.push(`(${escapeLiteral(line)}) Tj`);
      });
      parts.push("ET");
    }
    if (footer) {
      const label = pages.length > 1 ? `${footer}  --  page ${i + 1} of ${pages.length}` : footer;
      parts.push(
        `BT /F1 8 Tf 0.55 0.55 0.55 rg 1 0 0 1 ${MARGIN} ${MARGIN - 12} Tm ` +
        `(${escapeLiteral(label)}) Tj ET`,
      );
    }
    const stream = parts.join("\n");
    objects.push(`<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });

  objects.push(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  );

  // ---- bytes, recording offsets as we go ----------------------------------
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (s: string) => {
    const b = latin1Bytes(s);
    chunks.push(b);
    offset += b.length;
  };

  push("%PDF-1.4\n");
  // A binary comment marks the file as not-plain-text for tools that sniff.
  chunks.push(new Uint8Array([0x25, 0xc2, 0xa5, 0xc2, 0xb1, 0xc3, 0xab, 0x0a]));
  offset += 8;

  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefAt = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  );

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** One byte per character: everything has been folded to WinAnsi already. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function byteLength(s: string): number {
  return s.length; // latin1: one byte per character
}

/** Base64, for a mail attachment. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (typeof g.btoa === "function") return g.btoa(binary);
  return g.Buffer.from(bytes).toString("base64");
}
