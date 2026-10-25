'use strict';

// xxHash32 (Yann Collet, BSD-2-Clause; the algorithm, written here from its
// specification — see THIRD_PARTY_NOTICES.md) over a string's UTF-8 bytes:
// the checksum a log segment and an open file carry, so a torn or altered
// file is told from a whole one at open. Pure JS, no requires: both halves
// run it, and it depends on no crypto, so a node without the signing plugin
// checks its log all the same. Not a digest: nothing is signed with it.

const P1 = 0x9e3779b1;
const P2 = 0x85ebca77;
const P3 = 0xc2b2ae3d;
const P4 = 0x27d4eb2f;
const P5 = 0x165667b1;

const rotl = (x, r) => ((x << r) | (x >>> (32 - r))) >>> 0;
const round = (acc, lane) => Math.imul(rotl((acc + Math.imul(lane, P2)) >>> 0, 13), P1) >>> 0;

// The string as UTF-8 bytes, as the fsi writes it.
const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const bytesOf = (text) => {
  if (encoder !== null) return encoder.encode(text);
  // A runtime without TextEncoder: the same bytes, by hand.
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
};

const readLE = (bytes, i) => (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;

/** xxHash32 of `input` — a string (its UTF-8 bytes) or bytes — under `seed`, as an unsigned 32-bit number. */
const xxh32 = (input, seed = 0) => {
  const bytes = typeof input === 'string' ? bytesOf(input) : input;
  const length = bytes.length;
  let i = 0;
  let hash;
  if (length >= 16) {
    let v1 = (seed + P1 + P2) >>> 0;
    let v2 = (seed + P2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - P1) >>> 0;
    const limit = length - 16;
    while (i <= limit) {
      v1 = round(v1, readLE(bytes, i));
      v2 = round(v2, readLE(bytes, i + 4));
      v3 = round(v3, readLE(bytes, i + 8));
      v4 = round(v4, readLE(bytes, i + 12));
      i += 16;
    }
    hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else hash = (seed + P5) >>> 0;
  hash = (hash + length) >>> 0;
  while (i + 4 <= length) {
    hash = Math.imul(rotl((hash + Math.imul(readLE(bytes, i), P3)) >>> 0, 17), P4) >>> 0;
    i += 4;
  }
  while (i < length) {
    hash = Math.imul(rotl((hash + Math.imul(bytes[i], P5)) >>> 0, 11), P1) >>> 0;
    i++;
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, P2) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, P3) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
};

/** `xxh32(text)` as eight hex digits — what a log file carries as `hash`. */
const checksum = (text) => xxh32(text).toString(16).padStart(8, '0');

module.exports = { xxh32, checksum };
