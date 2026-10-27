'use strict';

// Ops as they cross between peers (a push, a `changes` page): packed — see
// below. The log itself keeps the keyed `{ seq, op }` JSON. No requires.

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

// The wire shape of a batch: one positional array per op, type as a
// single character, absent fields as null — no key names repeated per op. A
// slot may be appended (the writer's schema version was the 13th, the actor
// the 14th, the signature, its payload digest and the digest's nonce the
// 15th to 17th, a transaction's message the 18th, the fingerprint of the op
// before it in its stream the 19th): a reader of an older shape ignores slots
// it does not know,
// a reader of a newer one takes an absent slot as null. The codes are the
// protocol's, not a plugin's: a node without the plugin for a type still
// reads, logs and relays the op.
const TYPE_CODES = {
  write: 'w',
  set: 's',
  unset: 'u',
  inc: 'i',
  delete: 'd',
  merge: 'm',
  advance: 'a',
  purge: 'p',
  add: '+',
  remove: '-',
  splice: '/',
  assign: '=',
  move: '^',
  mark: '*',
  tree: '~',
};
const CODE_TYPES = {
  w: 'write',
  s: 'set',
  u: 'unset',
  i: 'inc',
  d: 'delete',
  m: 'merge',
  a: 'advance',
  p: 'purge',
  '+': 'add',
  '-': 'remove',
  '/': 'splice',
  '=': 'assign',
  '^': 'move',
  '*': 'mark',
  '~': 'tree',
};

const packOps = (ops) => {
  const packed = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    packed.push([
      op.origin,
      op.seq,
      op.ts,
      own(TYPE_CODES, op.type) ?? op.type,
      op.id,
      op.scope ?? null,
      op.data === undefined ? null : op.data,
      op.meta === undefined ? null : op.meta,
      op.key === undefined ? null : op.key,
      op.value === undefined ? null : op.value,
      op.vector === undefined ? null : op.vector,
      op.from === undefined ? null : op.from,
      op.v === undefined ? null : op.v,
      op.actor === undefined ? null : op.actor,
      op.sig === undefined ? null : op.sig,
      op.digest === undefined ? null : op.digest,
      op.nonce === undefined ? null : op.nonce,
      op.msg === undefined ? null : op.msg,
      op.prev === undefined ? null : op.prev,
    ]);
  }
  return packed;
};

const unpackOps = (packed) => {
  if (!Array.isArray(packed)) return [];
  const ops = [];
  for (const row of packed) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [
      origin,
      seq,
      ts,
      code,
      id,
      scope,
      data,
      meta,
      key,
      value,
      vector,
      from,
      v,
      actor,
      sig,
      digest,
      nonce,
      msg,
      prev,
    ] = row;
    const op = { origin, seq, ts, type: own(CODE_TYPES, code) ?? code };
    if (id !== null && id !== undefined) op.id = id;
    if (v !== null && v !== undefined) op.v = v;
    if (actor !== null && actor !== undefined) op.actor = actor;
    if (sig !== null && sig !== undefined) op.sig = sig;
    if (digest !== null && digest !== undefined) op.digest = digest;
    if (nonce !== null && nonce !== undefined) op.nonce = nonce;
    if (msg !== null && msg !== undefined) op.msg = msg;
    if (prev !== null && prev !== undefined) op.prev = prev;
    if (vector !== null && vector !== undefined) op.vector = vector;
    if (from !== null && from !== undefined) op.from = from;
    if (scope !== null && scope !== undefined) op.scope = scope;
    if (data !== null && data !== undefined) op.data = data;
    if (meta !== null && meta !== undefined) op.meta = meta;
    if (key !== null && key !== undefined) op.key = key;
    if (value !== null && value !== undefined) op.value = value;
    ops.push(op);
  }
  return ops;
};

module.exports = { TYPE_CODES, CODE_TYPES, packOps, unpackOps };
