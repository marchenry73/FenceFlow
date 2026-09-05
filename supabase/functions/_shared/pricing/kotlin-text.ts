/**
 * The handful of JVM string behaviours the engine leans on, reproduced
 * exactly rather than approximated with the nearest JavaScript built-in.
 *
 * Each one matters somewhere concrete: toFloatOrNull decides which drawn
 * points and gates survive decoding, isBlank decides whether a colour
 * preference applies, equalsIgnoreCase decides which catalog items that
 * preference keeps, and Float.toString is baked into every multi-width
 * line's sync id -- get that one wrong by a single character and every
 * regenerate duplicates the row in the cloud.
 */
import { f32 } from "./f32.ts";

/**
 * Kotlin's `Char.isWhitespace()` on the JVM is
 * `Character.isWhitespace(c) || Character.isSpaceChar(c)`: every Unicode
 * space separator (Zs), line separator (Zl) and paragraph separator (Zp),
 * plus the ASCII controls U+0009..U+000D and U+001C..U+001F. Not U+FEFF,
 * which JavaScript's \s includes.
 */
export function isJavaWhitespace(code: number): boolean {
  if (code === 0x20 || code === 0xa0 || code === 0x1680) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  if (code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000) return true;
  return (code >= 0x09 && code <= 0x0d) || (code >= 0x1c && code <= 0x1f);
}

/** Kotlin `String.isBlank()`. */
export function isBlank(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (!isJavaWhitespace(s.charCodeAt(i))) return false;
  }
  return true;
}

/** Kotlin `String.trim()`, which trims by Char.isWhitespace above, not by `<= ' '`. */
export function trim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isJavaWhitespace(s.charCodeAt(start))) start++;
  while (end > start && isJavaWhitespace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

/**
 * Kotlin `String.equals(other, ignoreCase = true)` on the JVM is
 * `String.equalsIgnoreCase`: same length, and each UTF-16 unit either equal,
 * equal after Character.toUpperCase, or equal after toLowerCase of that.
 * Per character -- Java never expands a character the way "ß".toUpperCase()
 * does in JavaScript, so a mapping that would change the length is ignored.
 */
export function equalsIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const c1 = a[i];
    const c2 = b[i];
    if (c1 === c2) continue;
    const u1 = upperChar(c1);
    const u2 = upperChar(c2);
    if (u1 === u2) continue;
    if (lowerChar(u1) === lowerChar(u2)) continue;
    return false;
  }
  return true;
}

function upperChar(c: string): string {
  const u = c.toUpperCase();
  return u.length === 1 ? u : c;
}

function lowerChar(c: string): string {
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
}

/**
 * The grammar Kotlin's `String.toFloatOrNull()` screens with before handing
 * the text to `java.lang.Float.parseFloat`: optional ASCII control/space
 * padding, an optional sign, NaN, Infinity, a decimal with optional exponent,
 * or a hexadecimal float, each with an optional f/F/d/D suffix.
 */
const JAVA_FLOAT_GRAMMAR =
  /^[\x00-\x20]*([+-]?)(NaN|Infinity|(?:(?:\d+\.?\d*(?:[eE][+-]?\d+)?)|(?:\.\d+(?:[eE][+-]?\d+)?)|(?:0[xX](?:[0-9a-fA-F]+\.?|[0-9a-fA-F]*\.[0-9a-fA-F]+)[pP][+-]?\d+))[fFdD]?)[\x00-\x20]*$/;

/**
 * Kotlin `String.toFloatOrNull()`: null for anything the grammar rejects,
 * otherwise the float32 nearest the exact decimal value.
 *
 * Nearest to the DECIMAL, not nearest to the double nearest the decimal.
 * JavaScript can only parse to a double, and rounding that double to a
 * float can land on the wrong side when the double happens to sit exactly
 * halfway between two floats. Java parses straight to the float. The
 * halfway case is detected and settled with exact integer arithmetic, so
 * the two agree on every string rather than on almost every string.
 */
export function toFloatOrNull(text: string): number | null {
  const m = JAVA_FLOAT_GRAMMAR.exec(text);
  if (m === null) return null;
  const negative = m[1] === "-";
  let body = m[2];
  if (body === "NaN") return NaN;
  if (body === "Infinity") return negative ? -Infinity : Infinity;
  if (/[fFdD]$/.test(body)) body = body.slice(0, -1);

  let magnitude: number;
  if (/^0[xX]/.test(body)) {
    magnitude = parseHexFloat(body);
  } else {
    magnitude = parseDecimalToFloat32(body);
  }
  return negative ? -magnitude : magnitude;
}

function parseHexFloat(body: string): number {
  const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)$/.exec(body)!;
  const intDigits = m[1] ?? "";
  const fracDigits = m[2] ?? "";
  const exp = parseInt(m[3], 10);
  let value = 0;
  for (const d of intDigits) value = value * 16 + parseInt(d, 16);
  let scale = 1 / 16;
  for (const d of fracDigits) {
    value += parseInt(d, 16) * scale;
    scale /= 16;
  }
  return f32(value * Math.pow(2, exp));
}

function parseDecimalToFloat32(body: string): number {
  const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(body)!;
  const intDigits = m[1] ?? "";
  const fracDigits = m[2] ?? "";
  const exp10 = m[3] === undefined ? 0 : parseInt(m[3], 10);

  const d = Number(body);
  const lo = f32(d);
  // Exact, or beyond float range either way: nothing to arbitrate.
  if (lo === d || !Number.isFinite(d) || !Number.isFinite(lo)) return lo;

  const other = d > lo ? nextFloat32Up(lo) : nextFloat32Down(lo);
  // Adjacent floats differ by one float ulp, a power of two; the midpoint
  // needs one more bit than a float has and a double has 29 to spare.
  const mid = lo + (other - lo) / 2;
  if (d !== mid) return lo;

  // The double landed exactly on the midpoint. Ask the decimal which side
  // it was really on.
  const digits = BigInt((intDigits + fracDigits).replace(/^0+(?=\d)/, "") || "0");
  const cmp = compareDecimalToDouble(digits, exp10 - fracDigits.length, mid);
  if (cmp === 0) return lo; // a true tie: fround already rounded it to even
  const above = Math.max(lo, other);
  const below = Math.min(lo, other);
  return cmp > 0 ? above : below;
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

function nextFloat32Up(x: number): number {
  if (x === 0) {
    U32[0] = 1;
    return F32[0];
  }
  F32[0] = x;
  U32[0] = x > 0 ? U32[0] + 1 : U32[0] - 1;
  return F32[0];
}

function nextFloat32Down(x: number): number {
  if (x === 0) {
    U32[0] = 0x80000001;
    return F32[0];
  }
  F32[0] = x;
  U32[0] = x > 0 ? U32[0] - 1 : U32[0] + 1;
  return F32[0];
}

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);

/** Sign of (digits * 10^exp10) - value, computed exactly. value must be finite and non-zero. */
function compareDecimalToDouble(digits: bigint, exp10: number, value: number): number {
  F64[0] = Math.abs(value);
  const bits = U64[0];
  const biased = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? frac : frac | (1n << 52n);
  const exp2 = biased === 0 ? -1074 : biased - 1075;

  // Compare digits * 10^exp10 with mantissa * 2^exp2 by clearing the
  // negative exponents onto the other side.
  let left = digits;
  let right = mantissa;
  if (exp10 >= 0) left *= 10n ** BigInt(exp10);
  else right *= 10n ** BigInt(-exp10);
  if (exp2 >= 0) right *= 1n << BigInt(exp2);
  else left *= 1n << BigInt(-exp2);
  return left === right ? 0 : left > right ? 1 : -1;
}

/**
 * `java.lang.Float.toString`, which is what a Kotlin string template renders
 * a Float with -- "4.0", "3.5", "12.0", "1.0E7", "1.0E-4". The line-item
 * sync id hashes this text, so it has to match to the character.
 *
 * This is NOT "the shortest decimal that round-trips". That is what the
 * javadoc promises and what JDK 19+ finally delivers, but the fixtures are
 * written by a JDK 17 JVM and the phone runs ART, and both still carry the
 * 1996 `FloatingDecimal.dtoa`: an integer-valued float prints its exact
 * digits (123456789f is "1.23456792E8", not "1.2345679E8"), and everything
 * else comes out of a digit loop with a symmetric half-ulp stopping test
 * run in int, long or big-integer arithmetic depending on the operand
 * sizes -- with the int and long paths wrapping on overflow, which the
 * original code half-anticipates. Float.MIN_VALUE prints "1.4E-45" because
 * of that loop, where the shortest form would be "1.0E-45". What follows is
 * that algorithm, step for step, with BigInt standing in for each width.
 */
export function kotlinFloatToString(value: number): string {
  const f = f32(value);
  if (Number.isNaN(f)) return "NaN";
  if (f === Infinity) return "Infinity";
  if (f === -Infinity) return "-Infinity";

  F32[0] = f;
  const fBits = U32[0];
  const isNegative = (fBits & 0x80000000) !== 0;
  let fractBits = fBits & 0x007fffff;
  let binExp = (fBits & 0x7f800000) >>> 23;
  if (binExp === 0 && fractBits === 0) return isNegative ? "-0.0" : "0.0";

  // Normalize denormalized numbers; insert the assumed high-order bit for
  // normalized ones. SINGLE_EXP_SHIFT is 23, EXP_BIAS 127.
  let nSignificantBits: number;
  if (binExp === 0) {
    const leadingZeros = Math.clz32(fractBits);
    const shift = leadingZeros - (31 - 23);
    fractBits = (fractBits << shift) >>> 0;
    binExp = 1 - shift;
    nSignificantBits = 32 - leadingZeros;
  } else {
    fractBits |= 0x00800000;
    nSignificantBits = 23 + 1;
  }
  binExp -= 127;

  // The float's mantissa is handed to the double converter shifted into the
  // double's 53-bit position (EXP_SHIFT - SINGLE_EXP_SHIFT = 29).
  const out = dtoa(binExp, BigInt(fractBits) << 29n, nSignificantBits);
  return (isNegative ? "-" : "") + formatJava(out.digits, out.decExponent);
}

interface Dtoa {
  digits: number[];
  /** value = 0.d1d2d3... * 10^decExponent */
  decExponent: number;
}

const EXP_SHIFT = 52;
const MAX_SMALL_BIN_EXP = 62;
const MIN_SMALL_BIN_EXP = -(63 / 3) | 0;

/** Bits in 5^i, for i in 0..26 -- FloatingDecimal.N_5_BITS. */
const N_5_BITS = [0, 3, 5, 7, 10, 12, 14, 17, 19, 21, 24, 26, 28, 31, 33, 35, 38, 40, 42, 45, 47, 49, 52, 54, 56, 59, 61];
const LONG_5_POW_LENGTH = 27;

/** FloatingDecimal.insignificantDigitsNumber: floor(log10(2^i)) for i in 0..63. */
const INSIGNIFICANT_DIGITS_NUMBER = [
  0, 0, 0, 0, 1, 1, 1, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 5, 5, 5,
  6, 6, 6, 6, 7, 7, 7, 8, 8, 8,
  9, 9, 9, 9, 10, 10, 10, 11, 11, 11,
  12, 12, 12, 12, 13, 13, 13, 14, 14, 14,
  15, 15, 15, 15, 16, 16, 16, 17, 17, 17,
  18, 18, 18, 19,
];

function insignificantDigitsForPow2(p2: number): number {
  if (p2 > 1 && p2 < INSIGNIFICANT_DIGITS_NUMBER.length) return INSIGNIFICANT_DIGITS_NUMBER[p2];
  return 0;
}

const pow5 = (n: number): bigint => 5n ** BigInt(n);

function numberOfTrailingZeros(x: bigint): number {
  let n = 0;
  while ((x & 1n) === 0n) {
    x >>= 1n;
    n++;
  }
  return n;
}

/**
 * FloatingDecimal.estimateDecExp: floor of a cheap log10 estimate, computed
 * in the same double arithmetic so it lands on the same integer.
 */
function estimateDecExp(fractBits: bigint, binExp: number): number {
  const d2 = 1 + Number(fractBits & ((1n << 52n) - 1n)) / 4503599627370496;
  const d = (d2 - 1.5) * 0.289529654 + 0.176091259 + binExp * 0.301029995663981;
  return Math.floor(d);
}

/** BinaryToASCIIBuffer.dtoa with isCompatibleFormat = true. */
function dtoa(binExp: number, fractBitsIn: bigint, nSignificantBits: number): Dtoa {
  let fractBits = fractBitsIn;
  const tailZeros = numberOfTrailingZeros(fractBits);
  // number of significant bits of fractBits;
  const nFractBits = EXP_SHIFT + 1 - tailZeros;
  // number of significant bits to the right of the point.
  const nTinyBits = Math.max(0, nFractBits - binExp - 1);
  if (binExp <= MAX_SMALL_BIN_EXP && binExp >= MIN_SMALL_BIN_EXP) {
    // Look more closely at the number to decide if, with scaling by
    // 10^nTinyBits, the result will fit in a long.
    if (nTinyBits < LONG_5_POW_LENGTH && nFractBits + N_5_BITS[nTinyBits] < 64) {
      // (a) nTinyBits == 0: shift to align the binary point at the extreme
      //     right, where a long int point is expected to be. The integer
      //     result is easily converted to a string.
      // (b) nTinyBits > 0: the original code's special case here was found
      //     to print excess digits for floats and is commented out; such
      //     values fall through to the hard case.
      if (nTinyBits === 0) {
        const insignificant = binExp > nSignificantBits
          ? insignificantDigitsForPow2(binExp - nSignificantBits - 1)
          : 0;
        if (binExp >= EXP_SHIFT) fractBits <<= BigInt(binExp - EXP_SHIFT);
        else fractBits >>= BigInt(EXP_SHIFT - binExp);
        return developLongDigits(0, fractBits, insignificant);
      }
    }
  }

  // This is the hard case. Compute large positive integers B and S and an
  // integer decExp such that d = (B / S) * 10^decExp with 1 <= B/S < 10,
  // and M = half an ulp of d scaled like B, to know when to stop.
  let decExp = estimateDecExp(fractBits, binExp);
  const B5 = Math.max(0, -decExp);
  let B2 = B5 + nTinyBits + binExp;
  const S5 = Math.max(0, decExp);
  let S2 = S5 + nTinyBits;
  const M5 = B5;
  let M2 = B2 - nSignificantBits;

  // Shift out the trailing zeros before turning fractBits into a big
  // integer; the whole number is then d * 2^(nFractBits-1-binExp).
  fractBits >>= BigInt(tailZeros);
  B2 -= nFractBits - 1;
  const common2factor = Math.min(B2, S2);
  B2 -= common2factor;
  S2 -= common2factor;
  M2 -= common2factor;

  // HACK!! For exact powers of two, the next smallest number is only half
  // as far away as we think (because the meaning of ULP changes at
  // power-of-two bounds); for this reason, M2 is hacked.
  if (nFractBits === 1) M2 -= 1;

  if (M2 < 0) {
    // since we cannot scale M down far enough, scale the other values up.
    B2 -= M2;
    S2 -= M2;
    M2 = 0;
  }

  const digits: number[] = [];
  let low: boolean;
  let high: boolean;
  let lowDigitDifference: bigint;
  let q: bigint;

  // Detect the special cases where all the numbers about to be computed
  // will fit in int or long integers. The same algorithm runs in each
  // width; the narrow ones wrap on overflow, and the wide one compares
  // with <= where the narrow ones compare with <.
  const Bbits = nFractBits + B2 + (B5 < N_5_BITS.length ? N_5_BITS[B5] : B5 * 3);
  const tenSbits = S2 + 1 + (S5 + 1 < N_5_BITS.length ? N_5_BITS[S5 + 1] : (S5 + 1) * 3);
  if (Bbits < 64 && tenSbits < 64) {
    const width = Bbits < 32 && tenSbits < 32 ? 32 : 64;
    const wrap = (x: bigint): bigint => BigInt.asIntN(width, x);
    let b = wrap(wrap(fractBits * pow5(B5)) << BigInt(B2));
    const s = wrap(pow5(S5) << BigInt(S2));
    let m = wrap(pow5(M5) << BigInt(M2));
    const tens = wrap(s * 10n);
    // Unroll the first iteration. If the decExp estimate was too high,
    // the first quotient will be zero: discard it and decrement decExp.
    q = b / s;
    b = wrap(10n * (b % s));
    m = wrap(m * 10n);
    low = b < m;
    high = wrap(b + m) > tens;
    if (q === 0n && !high) {
      decExp--;
    } else {
      digits.push(Number(q));
    }
    // HACK! Java spec sez that we always have at least one digit after
    // the . in either F- or E-form output. Thus we will need more than
    // one digit if we're using E-form.
    if (decExp < -3 || decExp >= 8) {
      high = low = false;
    }
    while (!low && !high) {
      q = b / s;
      b = wrap(10n * (b % s));
      m = wrap(m * 10n);
      if (m > 0n) {
        low = b < m;
        high = wrap(b + m) > tens;
      } else {
        // hack -- m might overflow! in this case, it is certainly > b,
        // and b+m > tens, too, since that has overflowed either!
        low = true;
        high = true;
      }
      digits.push(Number(q));
    }
    lowDigitDifference = wrap((b << 1n) - tens);
  } else {
    // FDBigInteger arithmetic. M and tenS are built already multiplied
    // by ten, matching the unrolled first iteration above.
    let B = (fractBits * pow5(B5)) << BigInt(B2);
    const S = pow5(S5) << BigInt(S2);
    let M = pow5(M5 + 1) << BigInt(M2 + 1);
    const tenS = pow5(S5 + 1) << BigInt(S2 + 1);
    q = B / S;
    B = 10n * (B % S);
    low = B < M;
    high = tenS <= B + M;
    if (q === 0n && !high) {
      decExp--;
    } else {
      digits.push(Number(q));
    }
    if (decExp < -3 || decExp >= 8) {
      high = low = false;
    }
    while (!low && !high) {
      q = B / S;
      B = 10n * (B % S);
      M *= 10n;
      low = B < M;
      high = tenS <= B + M;
      digits.push(Number(q));
    }
    if (high && low) {
      const doubled = B << 1n;
      lowDigitDifference = doubled === tenS ? 0n : doubled > tenS ? 1n : -1n;
    } else {
      lowDigitDifference = 0n;
    }
  }

  let decExponent = decExp + 1;
  // Last digit gets rounded based on stopping condition.
  if (high) {
    if (low) {
      if (lowDigitDifference === 0n) {
        // it's a tie! choose based on which digits we like.
        if ((digits[digits.length - 1] & 1) !== 0) decExponent = roundup(digits, decExponent);
      } else if (lowDigitDifference > 0n) {
        decExponent = roundup(digits, decExponent);
      }
    } else {
      decExponent = roundup(digits, decExponent);
    }
  }
  return { digits, decExponent };
}

/** BinaryToASCIIBuffer.roundup: carry through trailing nines; all nines become "1" followed by the zeros. */
function roundup(digits: number[], decExponent: number): number {
  let i = digits.length - 1;
  let q = digits[i];
  if (q === 9) {
    while (q === 9 && i > 0) {
      digits[i] = 0;
      q = digits[--i];
    }
    if (q === 9) {
      // carryout! High-order 1, rest 0s, larger exp.
      digits[0] = 1;
      return decExponent + 1;
    }
  }
  digits[i] = q + 1;
  return decExponent;
}

/** BinaryToASCIIBuffer.developLongDigits: the exact integer's digits, trailing zeros dropped into the exponent. */
function developLongDigits(decExponentIn: number, lvalueIn: bigint, insignificantDigits: number): Dtoa {
  let decExponent = decExponentIn;
  let lvalue = lvalueIn;
  if (insignificantDigits !== 0) {
    // Discard non-significant low-order bits, while rounding, up to insignificant value.
    const pow10 = pow5(insignificantDigits) << BigInt(insignificantDigits);
    const residue = lvalue % pow10;
    lvalue /= pow10;
    decExponent += insignificantDigits;
    if (residue >= pow10 >> 1n) lvalue++;
  }
  const reversed: number[] = [];
  let c = Number(lvalue % 10n);
  lvalue /= 10n;
  while (c === 0) {
    decExponent++;
    c = Number(lvalue % 10n);
    lvalue /= 10n;
  }
  while (lvalue !== 0n) {
    reversed.push(c);
    decExponent++;
    c = Number(lvalue % 10n);
    lvalue /= 10n;
  }
  reversed.push(c);
  return { digits: reversed.reverse(), decExponent: decExponent + 1 };
}

/** BinaryToASCIIBuffer.getChars: plain for [1e-3, 1e7), else d.dddE[-]n. */
function formatJava(digits: number[], decExponent: number): string {
  const text = digits.join("");
  const nDigits = digits.length;
  if (decExponent > 0 && decExponent < 8) {
    // print digits.digits.
    const charLength = Math.min(nDigits, decExponent);
    let s = text.slice(0, charLength);
    if (charLength < decExponent) {
      s += "0".repeat(decExponent - charLength) + ".0";
    } else {
      s += ".";
      s += charLength < nDigits ? text.slice(charLength) : "0";
    }
    return s;
  }
  if (decExponent <= 0 && decExponent > -3) {
    return "0." + "0".repeat(-decExponent) + text;
  }
  let s = text[0] + ".";
  s += nDigits > 1 ? text.slice(1) : "0";
  s += "E";
  if (decExponent <= 0) {
    s += "-" + String(-decExponent + 1);
  } else {
    s += String(decExponent - 1);
  }
  return s;
}
