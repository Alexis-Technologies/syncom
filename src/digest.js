'use strict';

// SHA-256 of a value's JSON — what the chain hashes a block and a record's
// data by and what names a schema snapshot (`sha256`, lowercase hex), and
// what names an op: its payload's digest and its fingerprint (`hashOf`,
// src/header.js — base64url, 43 characters: an op carries two of them, and
// every log line its own). The Node.js half, over node:crypto's one-shot
// hash; the browser half (./digest.browser.js, through package.json#browser)
// answers through Web Crypto. `sha256` is async on both; `hashOf` is at once
// here and a promise in the browser — shared code awaits it — since an op is
// named on the write path, where a hop to the thread pool per op would cost
// more than the hash.

const crypto = require('node:crypto');

const hashOf = (data) => crypto.hash('sha256', JSON.stringify(data), 'base64url');
const sha256 = async (data) => crypto.hash('sha256', JSON.stringify(data), 'hex');

module.exports = { sha256, hashOf };
