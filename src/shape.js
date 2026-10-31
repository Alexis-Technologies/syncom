'use strict';

const { typed } = require('./errors.js');
// The shapes checked where something enters a storage — a caller's object, a
// record id, an origin or a scope, a peer's op — and the JSON copy taken at
// that boundary. No requires beyond ./errors.js: this file ships to the browser as it is.

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// A key's value when the object holds it as its own, else undefined: never
// what the prototype answers for `constructor` or `toString`.
const own = (object, key) => (object != null && Object.hasOwn(object, key) ? object[key] : undefined);

// Data crosses the boundary as JSON — what the disk, the log and the peers
// hold. A copy on the way in (a caller mutating its object after `set()`)
// and on the way out (a caller mutating what `get()` returned) keeps the
// cache, the log entries and the next op's base to themselves.
const asJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// A record id is a file name on three platforms, a key in every peer's
// catalog and a line in every peer's log: letters, digits, `.`, `_`, `-`,
// `@`, not starting with a dot, 128 characters at most. Checked where an id
// enters — the local write path, a peer's op, a snapshot record — so
// nothing below has to.
const RECORD_ID = /^[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}$/;
// The length first: a regular expression flattens a string built by
// concatenation (a text's reading) before it reads its first character.
const isRecordId = (id) => typeof id === 'string' && id.length <= 128 && RECORD_ID.test(id);
const invalidId = (id) => {
  const shown = typeof id === 'string' ? JSON.stringify(id) : typeof id;
  return typed(
    'INVALID_ID',
    `Invalid record id ${shown}: letters, digits, . _ - @, not starting with a dot, 128 at most`,
  );
};

// An origin or a scope ends up a vector key (`origin@scope`) and a room
// name: a non-empty string without `@` or control characters.
const hasControl = (value) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
};
const isStreamName = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('@') && !hasControl(value);

// A node id is its Ed25519 public key: 32 bytes as 43 base64url characters.
// The last character carries two bits of key and four of padding, so only
// sixteen of the sixty-four are canonical — a non-canonical one decodes to
// the same key, and would make one key four origins.
const KEY_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const isKeyId = (value) => typeof value === 'string' && KEY_ID.test(value);

const OP_TYPES = new Set([
  'write',
  'set',
  'unset',
  'inc',
  'delete',
  'merge',
  'advance',
  'purge',
  'add',
  'remove',
  'splice',
  'assign',
  'move',
  'mark',
  'tree',
]);

// The ops an entity's validator sees: the ones that leave a record for the
// application to read. A `merge` joins a peer's state as it is, a `delete`
// leaves nothing to validate.
const VALIDATED = new Set([
  'write',
  'set',
  'unset',
  'inc',
  'add',
  'remove',
  'splice',
  'assign',
  'move',
  'mark',
  'tree',
]);

// A signature's three fields, by shape alone — whether they check is
// src/signing/sign.js's business: 64 bytes base64url, 32 bytes base64url, a
// nonce. `prev`, the fingerprint of the op before it in its stream, is 32
// bytes base64url too (src/header.js). A transaction's message rides on each of its ops, in
// the signed header.
const MAX_MESSAGE = 1024;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
// SHA-256 as base64url: 43 characters, the last carrying four bits (one spelling per digest).
const DIGEST = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

// How deep what the write API takes may nest — a record's data, an array of
// elements, a value: every object or array on the deepest path is a level
// (`{ a: 1 }` is one, `{ a: [1] }` two). Deeper is a TypeError where the
// write is made (src/commit.js), so a node never logs what a peer refuses.
const MAX_JSON_DEPTH = 64;
// How deep a field of a peer's op — data, meta, key, value, vector, actor —
// or a snapshot record's data or meta may nest: room for what an op and a
// record's meta wrap around such a value (a block holds an element six
// levels down its meta). Deeper is malformed. The readers on the apply path
// that recurse — a digest's canonical form, a diff, JSON itself — then stay
// thousands of levels clear of the stack.
const MAX_WIRE_DEPTH = MAX_JSON_DEPTH + 16;

// Whether `value` nests at most `max` levels — walked with a stack of its
// own, never by recursion: the depth is what is in question.
const nestsWithin = (value, max) => {
  if (value === null || typeof value !== 'object') return true;
  if (max < 1) return false;
  const values = [value];
  const depths = [1];
  while (values.length > 0) {
    const current = values.pop();
    const next = depths.pop() + 1;
    const keys = Array.isArray(current) ? null : Object.keys(current);
    const count = keys === null ? current.length : keys.length;
    for (let i = 0; i < count; i++) {
      const item = keys === null ? current[i] : current[keys[i]];
      if (item === null || typeof item !== 'object') continue;
      if (next > max) return false;
      values.push(item);
      depths.push(next);
    }
  }
  return true;
};

// The fields the engine indexes a peer's op by, checked before anything here
// reads them, and how deep it nests (MAX_WIRE_DEPTH a field: the op itself
// is one level more). Payloads (`data`, `meta`, `key`, `value`, `vector`)
// are otherwise the business of applyOp and normalizeMeta, which take
// garbage as a no-op; `actor` and `from` are claims, carried as they are.
// `actor` and `from` are claims, carried as they are — but bounded: both are
// in the header every node hashes (in the browser at once, on the main
// thread), and a peer chooses their size.
const MAX_ACTOR = 256;
// Whatever a peer puts there is taken as it is — a claim, not a check — within the bound: a text by its
// length, a value of another shape by its JSON (nothing is read into it either way).
const isClaim = (value) => {
  if (value === undefined || value === null) return true;
  const type = typeof value;
  if (type === 'string') return value.length <= MAX_ACTOR;
  if (type === 'number' || type === 'boolean') return true;
  return type === 'object' && JSON.stringify(value).length <= MAX_ACTOR;
};

const wellFormed = (op) =>
  isPlainObject(op) &&
  isStreamName(op.origin) &&
  isClaim(op.actor) &&
  isClaim(op.from) &&
  Number.isSafeInteger(op.seq) &&
  op.seq > 0 &&
  Number.isSafeInteger(op.ts) &&
  op.ts > 0 &&
  OP_TYPES.has(op.type) &&
  (op.scope === undefined || isStreamName(op.scope)) &&
  (op.v === undefined || (Number.isInteger(op.v) && op.v >= 1)) &&
  (op.sig === undefined || (typeof op.sig === 'string' && SIGNATURE.test(op.sig))) &&
  (op.digest === undefined || (typeof op.digest === 'string' && DIGEST.test(op.digest))) &&
  (op.prev === undefined || (typeof op.prev === 'string' && DIGEST.test(op.prev))) &&
  (op.nonce === undefined || (typeof op.nonce === 'string' && NONCE.test(op.nonce))) &&
  (op.msg === undefined || (typeof op.msg === 'string' && op.msg.length <= MAX_MESSAGE)) &&
  (op.type === 'advance' ? isPlainObject(op.vector) : isRecordId(op.id)) &&
  nestsWithin(op, MAX_WIRE_DEPTH + 1);

// A value's JSON with the keys of every object sorted — what JSON.stringify
// would give were keys ordered — so a digest or a signature is a property of
// the value, not of the order the keys were left in. An own `__proto__` key
// from JSON.parse is a key like any other here; undefined, a function or a
// symbol is left out of an object and null in an array, as JSON would.
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

// Structural equality over JSON values — own keys, in any order.
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
};

// The verdict on a peer's op's signature (the signing plugin answers, the
// apply path reads): OK, UNSIGNED under 'require', FORGED.
const VERDICT = Object.freeze({ OK: 'ok', UNSIGNED: 'unsigned', FORGED: 'forged' });

module.exports = {
  VERDICT,
  MAX_MESSAGE,
  MAX_ACTOR,
  MAX_JSON_DEPTH,
  MAX_WIRE_DEPTH,
  nestsWithin,
  isPlainObject,
  own,
  asJson,
  isRecordId,
  invalidId,
  isStreamName,
  isKeyId,
  OP_TYPES,
  VALIDATED,
  wellFormed,
  deepEqual,
  canonical,
};
