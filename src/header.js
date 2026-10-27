'use strict';

// What names an op: the core's, so that a node without the signing plugin
// names an op as one with it does (src/signing/sign.js signs what is here).
// The HEADER is a positional JSON array under a version number — origin, seq,
// ts, type, id, scope, from, v, actor, the DIGEST of the payload, the message
// of a transaction (`msg`) and `prev` — and, where the node that mints the
// op signs it, the payload (`data`, `meta`, `key`, `value`, `vector`) is
// digested in canonical JSON, salted with a nonce. The FINGERPRINT of an op
// is the SHA-256 of its header: the same on every node, whole after a purge
// scrubbed the payload and the nonce (the digest stays), covering the
// payload through the digest where there is one (an unsigned op's covers its
// header alone), and — through `prev`, the fingerprint of the op before it
// in its stream (`origin@scope`, vector.js opKey; `link` in src/commit.js
// sets it) — a hash of the whole stream up to it. Two ops at one seq of one stream have two
// fingerprints, and an op whose `prev` is not the one a node holds for the
// seq before it follows another branch: both are equivocation, refused at
// src/apply.js `admit`.

const { hashOf } = require('./digest.js');
const { canonical } = require('./shape.js');

const HEADER_VERSION = 1;
const PAYLOAD = ['data', 'meta', 'key', 'value', 'vector'];

// The fields a digest covers, as the op carries them; null when it carries
// none (a `delete`, a `purge`, a scrubbed op).
const payloadOf = (op) => {
  let payload = null;
  for (let i = 0; i < PAYLOAD.length; i++) {
    const name = PAYLOAD[i];
    if (op[name] === undefined) continue;
    if (payload === null) payload = {};
    payload[name] = op[name];
  }
  return payload;
};

// Positional, so the key order of the op object plays no part; `null` for
// an absent field, so a header with and without one differ in the text.
const headerOf = (op) => [
  HEADER_VERSION,
  op.origin,
  op.seq,
  op.ts,
  op.type,
  op.id ?? null,
  op.scope ?? null,
  op.from ?? null,
  op.v ?? null,
  op.actor ?? null,
  op.digest ?? null,
  op.msg ?? null,
  op.prev ?? null,
];

const signedMessage = (op) => JSON.stringify(headerOf(op));

// SHA-256 as hex — a string in Node.js, a promise in the browser: await it.
const digestOf = (nonce, payload) => hashOf(`${nonce}\n${canonical(payload)}`);
const fingerprintOf = (op) => hashOf(headerOf(op));

// What a scrub takes from an op, in place: its payload and the nonce that
// salted its digest. The header, the digest and the signature stay — a
// scrubbed op still verifies (src/log.js #scrub, and src/apply.js for an op
// that lands on a purged record).
const scrubOp = (op) => {
  delete op.data;
  delete op.meta;
  delete op.key;
  delete op.value;
  delete op.nonce;
};

// The op's payload digested under a fresh nonce, once: an op that has its
// digest keeps it.
const digest = async (op) => {
  if (op.digest !== undefined) return;
  const payload = payloadOf(op);
  if (payload === null) return;
  op.nonce = globalThis.crypto.randomUUID();
  op.digest = await digestOf(op.nonce, payload);
};

module.exports = { HEADER_VERSION, payloadOf, headerOf, signedMessage, digestOf, fingerprintOf, digest, scrubOp };
