'use strict';

// SHA-256 of a value's JSON — what the chain hashes a block and a record's
// data by and what names a schema snapshot (`sha256`, lowercase hex), and
// what names an op: its payload's digest and its fingerprint (`hashOf`,
// src/header.js — base64url, 43 characters: an op carries two of them, and
// every log line its own). The Node.js half, over node:crypto's one-shot
// hash; the browser half (./digest.browser.js, through package.json#browser)
// hashes in JavaScript (./sha256.js) and through Web Crypto. `sha256` is
// async on both; `hashText` is at once on both — an op is named on the write
// path, which is made at once (LOG-9), and a hop to a thread pool per op
// would cost more than the hash; `hashOf` is at once here and a promise in
// the browser for a text past 64 KiB — shared code awaits it.

const crypto = require('node:crypto');

const hashOf = (data) => crypto.hash('sha256', JSON.stringify(data), 'base64url');
// The same of a JSON text the caller has made already (an op's header,
// src/header.js headerText): `hashText(JSON.stringify(x)) === hashOf(x)`.
const hashText = (text) => crypto.hash('sha256', text, 'base64url');
const sha256 = async (data) => crypto.hash('sha256', JSON.stringify(data), 'hex');

module.exports = { sha256, hashOf, hashText };
