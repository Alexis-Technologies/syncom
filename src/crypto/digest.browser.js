'use strict';

// The browser twin of ./digest.js, wired in through package.json#browser:
// SHA-256 of a value's JSON through Web Crypto (`globalThis.crypto.subtle`)
// — a promise; `sha256` as lowercase hex, `hashOf` (what names an op) as
// base64url. No requires.

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const digestOf = async (data) =>
  new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data))));

const sha256 = async (data) => {
  const digest = await digestOf(data);
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += HEX[digest[i]];
  return hex;
};

// 32 bytes as 43 base64url characters, unpadded: ten groups of three bytes,
// then the last two as three characters.
const hashOf = async (data) => {
  const b = await digestOf(data);
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const n = (b[i] << 16) | (b[i + 1] << 8);
  out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  return out;
};

module.exports = { sha256, hashOf };
