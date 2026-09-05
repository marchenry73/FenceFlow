/**
 * `java.util.UUID.nameUUIDFromBytes`, byte for byte.
 *
 * The phone mints every auto-generated line item's sync id by MD5-hashing a
 * name and stamping version 3 / variant 2 bits into the digest. That is NOT
 * RFC 4122 v5 (SHA-1) and not v3 with a namespace either -- it is the raw
 * MD5 of the bytes. The office has to land on the same id so that its line
 * and the phone's line are one cloud row, and so the phone's fingerprint
 * no-op check leaves the office's rows alone.
 *
 * WebCrypto refuses MD5, so the digest is written out here. It is the
 * textbook algorithm with the constants written down rather than derived
 * from Math.sin, because a transcendental function is not something to
 * bet a primary key on across engines.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

export function md5(input: Uint8Array): Uint8Array {
  const len = input.length;
  // Pad to 56 mod 64 with 0x80 then zeros, and close with the bit length as a 64-bit little-endian integer.
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(input);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bitLen = len * 8;
  view.setUint32(total - 8, bitLen >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Array<number>(16);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(offset + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0 >>> 0, true);
  outView.setUint32(4, b0 >>> 0, true);
  outView.setUint32(8, c0 >>> 0, true);
  outView.setUint32(12, d0 >>> 0, true);
  return out;
}

const HEX = "0123456789abcdef";

function hex(bytes: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  return s;
}

/** `UUID.nameUUIDFromBytes(bytes).toString()`. */
export function nameUUIDFromBytes(bytes: Uint8Array): string {
  const d = md5(bytes);
  d[6] = (d[6] & 0x0f) | 0x30; // version 3
  d[8] = (d[8] & 0x3f) | 0x80; // IETF variant
  return `${hex(d, 0, 4)}-${hex(d, 4, 6)}-${hex(d, 6, 8)}-${hex(d, 8, 10)}-${hex(d, 10, 16)}`;
}

/** `UUID.nameUUIDFromBytes(text.toByteArray()).toString()` -- Kotlin's toByteArray() is UTF-8. */
export function nameUUIDFromString(text: string): string {
  return nameUUIDFromBytes(new TextEncoder().encode(text));
}
