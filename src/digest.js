'use strict';

// SHA-256 of a value's JSON, as lowercase hex — what the chain hashes a
// block and a record's data by, and what names a schema snapshot. One
// function for both platforms through Web Crypto (`globalThis.crypto.subtle`,
// Node.js 20 and every browser), so the core needs no crypto half: the
// signing and sealing of records are plugins. Async on both. No requires.

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

const sha256 = async (data) => {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += HEX[digest[i]];
  return hex;
};

module.exports = { sha256 };
