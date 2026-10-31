'use strict';

// CRC-32 (IEEE 802.3, the polynomial zlib uses) of a string's UTF-8 bytes,
// as 8 lowercase hex digits — the checksum every log line carries
// (src/log.js). The browser half of ./crc32.js, through package.json#browser,
// and its fallback where Node.js has no zlib.crc32 (before 22.2). No requires.

let TABLE = null;

const tableOf = () => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
};

const encoder = new TextEncoder();
// Grown to the text in hand (a UTF-16 unit is at most three UTF-8 bytes) and
// let go of past SCRATCH_MAX: a line of megabytes, once, pins no megabytes.
const SCRATCH = 1024;
const SCRATCH_MAX = 1 << 20;
let scratch = new Uint8Array(SCRATCH);

const crc32 = (text) => {
  TABLE ??= tableOf();
  if (scratch.length < text.length * 3) scratch = new Uint8Array(text.length * 3);
  const { written } = encoder.encodeInto(text, scratch);
  let c = -1;
  for (let i = 0; i < written; i++) c = TABLE[(c ^ scratch[i]) & 0xff] ^ (c >>> 8);
  if (scratch.length > SCRATCH_MAX) scratch = new Uint8Array(SCRATCH);
  return ((c ^ -1) >>> 0).toString(16).padStart(8, '0');
};

module.exports = { crc32 };
