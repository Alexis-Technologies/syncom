'use strict';

// The browser twin of ./digest.js, wired in through package.json#browser:
// SHA-256 of a value's JSON. `hashText` (what names an op: its header, a
// few hundred characters) at once, in JavaScript (./sha256.js), as
// node:crypto does it in Node.js — so a write is made at once here too
// (LOG-9); `hashOf` the same up to LARGE characters and through Web Crypto
// (`globalThis.crypto.subtle`, a promise) beyond, where native code is
// worth the turn; `sha256` (as hex: a chain block, a schema) through Web
// Crypto always — a promise.

const { sha256Now } = require('./sha256.js');

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LARGE = 1 << 16;

const digestOf = async (text) =>
  new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

const sha256 = async (data) => {
  const digest = await digestOf(JSON.stringify(data));
  let hex = '';
  for (let i = 0; i < digest.length; i++) hex += HEX[digest[i]];
  return hex;
};

// 32 bytes as 43 base64url characters, unpadded: ten groups of three bytes,
// then the last two as three characters.
const base64url = (b) => {
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

// `hashText` takes the JSON text made already: `hashText(JSON.stringify(x))` is `hashOf(x)`.
const hashText = (text) => base64url(sha256Now(text));
const hashOf = (data) => {
  const text = JSON.stringify(data);
  return text.length <= LARGE ? hashText(text) : digestOf(text).then(base64url);
};

module.exports = { sha256, hashOf, hashText };
