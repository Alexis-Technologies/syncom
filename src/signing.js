'use strict';

// What a signature covers and how one is checked — shared by the places a
// node signs its own ops (src/commit.js, src/bootstrap.js) and the one place
// a peer's are verified (src/apply.js). The HEADER — origin, seq, ts, type,
// id, scope, from, v, actor — is signed as a positional JSON array under a
// version number, together with a DIGEST of the payload: `data`, `meta`,
// `key`, `value`, `vector`, serialized canonically and salted with a nonce.
// The split is what lets a purge scrub the payload (and the nonce) and leave
// an op whose header still verifies; the nonce is what keeps a scrubbed op's
// digest from giving a low-entropy payload away by brute force. A signature
// binds authorship and content to the origin's key, through any relay — it
// proves nothing about delivery, and `actor` stays a claim the origin made.

const { calculateHash, sign, verify } = require('./crypto.js');
const { generateUUID } = require('./utils.js');
const { isKeyId } = require('./shape.js');

const HEADER_VERSION = 1;
const PAYLOAD = ['data', 'meta', 'key', 'value', 'vector'];

const OK = 'ok';
const UNSIGNED = 'unsigned';
const FORGED = 'forged';

// JSON.stringify with every object's keys sorted — the text JSON.stringify
// would give were keys ordered — so the digest is a property of the value,
// not of the order prepareOp, unpackOps or the log left the keys in. An own
// `__proto__` key from JSON.parse is a key like any other here.
const canonical = (value) => {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
    return JSON.stringify(value);
  }
  if (typeof value.toJSON === 'function') return canonical(value.toJSON());
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      const item = canonical(value[i]);
      out += item === undefined ? 'null' : item;
    }
    return `${out}]`;
  }
  const keys = Object.keys(value).sort();
  let out = '{';
  let first = true;
  for (let i = 0; i < keys.length; i++) {
    const item = canonical(value[keys[i]]);
    if (item === undefined) continue;
    if (!first) out += ',';
    first = false;
    out += `${JSON.stringify(keys[i])}:${item}`;
  }
  return `${out}}`;
};

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
  ]);

// Signs an op in place: `nonce` and `digest` when it carries a payload,
// `sig` always. Called once the op is final — after validation rewrote its
// data, after its seq was assigned — and before it is appended.
const signOp = async (op, privateKey) => {
  const payload = payloadOf(op);
  if (payload !== null) {
    op.nonce = generateUUID();
    op.digest = await digestOf(op.nonce, payload);
  }
  op.sig = await sign(signedMessage(op), privateKey);
  return op;
};

// The verdict on a peer's op: OK, UNSIGNED (no signature, under 'require')
// or FORGED — an origin that is no key, a payload its digest does not
// match, a digest with no nonce behind it, a nonce with no payload, or a
// signature that does not verify. A wellFormed op is the precondition: the
// shapes of `sig`, `digest` and `nonce` are checked there.
const verifyOp = async (op, mode) => {
  if (op.sig === undefined) return mode === 'require' ? UNSIGNED : OK;
  if (!isKeyId(op.origin)) return FORGED;
  const payload = payloadOf(op);
  if (payload !== null) {
    if (op.digest === undefined || op.nonce === undefined) return FORGED;
    if ((await digestOf(op.nonce, payload)) !== op.digest) return FORGED;
  } else if (op.nonce !== undefined) {
    return FORGED;
  }
  return (await verify(signedMessage(op), op.sig, op.origin)) ? OK : FORGED;
};

module.exports = { HEADER_VERSION, OK, UNSIGNED, FORGED, canonical, payloadOf, signedMessage, signOp, verifyOp };
