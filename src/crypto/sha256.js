'use strict';

// SHA-256 (FIPS 180-4) in JavaScript, at once: what the browser half of
// src/crypto/digest.js names an op by — Web Crypto answers only with a
// promise, and a write made at once (LOG-9) takes its fingerprint before it
// returns. A text's UTF-8 goes into a buffer kept between calls (ASCII by
// hand, the rest through TextEncoder), the padding after it; the digest is
// its 32 bytes. Checked against node:crypto (tests/digest.test.js). No
// requires.

// The constants are the standard's own definition, computed once: the
// first 32 bits of the fractional parts of the cube roots of the first 64
// primes (K) and of the square roots of the first 8 (IV) — exact in doubles.
const K = new Int32Array(64);
const IV = new Int32Array(8);
for (let n = 2, found = 0; found < 64; n++) {
  let prime = true;
  for (let d = 2; d * d <= n && prime; d++) prime = n % d !== 0;
  if (!prime) continue;
  if (found < 8) IV[found] = (Math.sqrt(n) % 1) * 2 ** 32;
  K[found++] = (Math.cbrt(n) % 1) * 2 ** 32;
}
const W = new Int32Array(64);
const V = new Int32Array(8);
const encoder = new TextEncoder();
let buffer = new Uint8Array(1024);

// The text as UTF-8 at the head of the buffer, padded to whole blocks: where the blocks end.
const padded = (text) => {
  // UTF-8 takes at most three bytes per UTF-16 unit; the padding at most 72.
  const room = text.length * 3 + 72;
  if (buffer.length < room) buffer = new Uint8Array(room);
  let n = 0;
  while (n < text.length) {
    const unit = text.charCodeAt(n);
    if (unit > 127) break;
    buffer[n++] = unit;
  }
  if (n < text.length) n += encoder.encodeInto(text.slice(n), buffer.subarray(n)).written;
  const end = (n + 72) & ~63;
  buffer.fill(0, n, end);
  buffer[n] = 0x80;
  // The length in bits, big-endian, in the last eight bytes: the high word, then the low.
  const high = Math.floor(n / 0x20000000);
  const low = (n * 8) >>> 0;
  for (let i = 0; i < 4; i++) {
    buffer[end - 5 - i] = high >>> (i * 8);
    buffer[end - 1 - i] = low >>> (i * 8);
  }
  return end;
};

/** The SHA-256 of `text`'s UTF-8, at once: 32 bytes. */
const sha256Now = (text) => {
  const end = padded(text);
  V.set(IV);
  for (let off = 0; off < end; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = (buffer[j] << 24) | (buffer[j + 1] << 16) | (buffer[j + 2] << 8) | buffer[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15];
      const y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = V[0];
    let b = V[1];
    let c = V[2];
    let d = V[3];
    let e = V[4];
    let f = V[5];
    let g = V[6];
    let h = V[7];
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + s1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    V[0] += a;
    V[1] += b;
    V[2] += c;
    V[3] += d;
    V[4] += e;
    V[5] += f;
    V[6] += g;
    V[7] += h;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = V[i >> 2] >>> (24 - (i & 3) * 8);
  return out;
};

module.exports = { sha256Now };
