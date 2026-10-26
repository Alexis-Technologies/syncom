'use strict';

// What a signature covers and how one is checked — shared by the places a
// node signs its own ops (src/commit.js, src/bootstrap.js) and the one place
// a peer's are verified (src/apply.js). The HEADER — origin, seq, ts, type,
// id, scope, from, v, actor, and the message of a transaction (`msg`) — is
// signed as a positional JSON array under a
// version number, together with a DIGEST of the payload: `data`, `meta`,
// `key`, `value`, `vector`, serialized canonically and salted with a nonce.
// The split is what lets a purge scrub the payload (and the nonce) and leave
// an op whose header still verifies; the nonce is what keeps a scrubbed op's
// digest from giving a low-entropy payload away by brute force. A signature
// binds authorship and content to the origin's key, through any relay — it
// proves nothing about delivery, and `actor` stays a claim the origin made.

const { calculateHash, sign, signAsync, verifyAsync } = require('./ed25519.js');
const { generateUUID } = require('../utils.js');
const { isKeyId, VERDICT, canonical } = require('../shape.js');

const HEADER_VERSION = 1;
const PAYLOAD = ['data', 'meta', 'key', 'value', 'vector'];

const { OK, UNSIGNED, FORGED } = VERDICT;

// JSON.stringify with every object's keys sorted — the text JSON.stringify
// would give were keys ordered — so the digest is a property of the value,
// not of the order prepareOp, unpackOps or the log left the keys in. An own
// `__proto__` key from JSON.parse is a key like any other here.

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

const digestOf = (nonce, payload) => calculateHash(`${nonce}\n${canonical(payload)}`);

// Positional, so the key order of the op object plays no part; `null` for
// an absent field, so a header with and without one differ in the text.
const signedMessage = (op) =>
  JSON.stringify([
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
  ]);

// Signs an op in place: `nonce` and `digest` when it carries a payload,
// `sig` always. Called once the op is final — after validation rewrote its
// data, after its seq was assigned — and before it is written: `later`
// signs on the thread pool (a write among others queued), else at once.
const signOp = async (op, privateKey, later = false) => {
  const payload = payloadOf(op);
  if (payload !== null) {
    op.nonce = generateUUID();
    op.digest = await digestOf(op.nonce, payload);
  }
  op.sig = await (later ? signAsync : sign)(signedMessage(op), privateKey);
  return op;
};

// The verdict on a peer's op: OK, UNSIGNED (no signature, under 'require')
// or FORGED — an origin that is no key, a payload its digest does not
// match, a digest with no nonce behind it, a nonce with no payload, or a
// signature that does not verify. A wellFormed op is the precondition: the
// shapes of `sig`, `digest` and `nonce` are checked there.
// The base64url alphabet's values, for the key check below.
const B64 = new Int8Array(128).fill(-1);
{
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (let i = 0; i < alphabet.length; i++) B64[alphabet.charCodeAt(i)] = i;
}

// The encodings no one holds the private key of: the points of small order
// (their y with the sign bit cleared — libsodium's list), and every y at or
// past the field's prime p = 2²⁵⁵ − 19 (a non-canonical name of a point). A
// signature under one verifies for a share of all messages, so an op signed
// "by" it would be anyone's.
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];
const weakKey = (value) => {
  // 43 base64url characters: 258 bits, the 32 bytes of the key and two zero bits.
  const bytes = [];
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < value.length; i++) {
    acc = (acc << 6) | B64[value.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  bytes[31] &= 0x7f;
  let hex = '';
  for (let i = 0; i < 32; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  for (let i = 0; i < SMALL_ORDER.length; i++) if (hex === SMALL_ORDER[i]) return true;
  // y ≥ p: the top byte 0x7f, the 30 below it 0xff, the lowest at least 0xed.
  if (bytes[31] !== 0x7f || bytes[0] < 0xed) return false;
  for (let i = 1; i < 31; i++) if (bytes[i] !== 0xff) return false;
  return true;
};

// A key someone can hold the private half of: the format, and none of the
// weak encodings above.
const isHeldKey = (value) => isKeyId(value) && !weakKey(value);

const verifyOp = async (op, mode) => {
  if (op.sig === undefined) return mode === 'require' ? UNSIGNED : OK;
  if (!isHeldKey(op.origin)) return FORGED;
  const payload = payloadOf(op);
  if (payload !== null) {
    if (op.digest === undefined || op.nonce === undefined) return FORGED;
    if ((await digestOf(op.nonce, payload)) !== op.digest) return FORGED;
  } else if (op.nonce !== undefined) {
    return FORGED;
  }
  return (await verifyAsync(signedMessage(op), op.sig, op.origin)) ? OK : FORGED;
};

module.exports = {
  HEADER_VERSION,
  OK,
  UNSIGNED,
  FORGED,
  canonical,
  payloadOf,
  signedMessage,
  signOp,
  verifyOp,
  isHeldKey,
};
