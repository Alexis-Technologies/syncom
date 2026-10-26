'use strict';

// Deltas in Quill's form — `[{ retain, attributes? }, { insert, attributes? },
// { delete }]`, an embed slot as `{ insert: { embed: marker } }`, a marker
// changed as `{ retain: 1, attributes: { embed: marker } }` — and their
// algebra, once: what the text plugin composes a turn's changes with
// (`toDelta`, src/text/text.js) and what the editor binding composes,
// transforms and maps indices through (src/editor/editor.js, which checks
// what it is handed). It follows quill-delta's (BSD-3-Clause; see
// THIRD_PARTY_NOTICES.md). No requires.

const lengthOf = (op) => op.delete ?? op.retain ?? (typeof op.insert === 'string' ? op.insert.length : 1);
const typeOf = (op) =>
  op === undefined ? 'retain' : op.delete !== undefined ? 'delete' : op.retain !== undefined ? 'retain' : 'insert';

// Two attribute sets alike whatever the order of their keys: `{ a, b }` and
// `{ b, a }` are one style (JSON.stringify told them apart, so two ops of
// one style stayed two). A value is compared as JSON.
const sameAttributes = (a, b) => {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Object.hasOwn(b, key)) return false;
    if (a[key] !== b[key] && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
};

// Hands a delta out in pieces: `next(n)` is the next op cut to `n` units,
// `{ retain: Infinity }` once the delta is spent.
const iterate = (ops) => {
  let i = 0;
  let offset = 0;
  const peekLength = () => (i < ops.length ? lengthOf(ops[i]) - offset : Infinity);
  const next = (length = Infinity) => {
    const op = ops[i];
    if (op === undefined) return { retain: Infinity };
    const left = lengthOf(op) - offset;
    const take = Math.min(length, left);
    const start = offset;
    if (take === left) {
      i++;
      offset = 0;
    } else offset += take;
    if (op.delete !== undefined) return { delete: take };
    const out = {};
    if (op.retain !== undefined) out.retain = take;
    else if (typeof op.insert === 'string') out.insert = op.insert.slice(start, start + take);
    else out.insert = op.insert;
    if (op.attributes !== undefined) out.attributes = op.attributes;
    return out;
  };
  return { hasNext: () => i < ops.length, peekLength, peekType: () => typeOf(ops[i]), next };
};

// Appends an op, merged into the last when the two are one piece.
const push = (ops, op) => {
  if (op.retain === Infinity || lengthOf(op) === 0) return ops;
  const last = ops[ops.length - 1];
  if (last !== undefined && sameAttributes(last.attributes, op.attributes)) {
    if (last.delete !== undefined && op.delete !== undefined) {
      last.delete += op.delete;
      return ops;
    }
    if (last.retain !== undefined && op.retain !== undefined) {
      last.retain += op.retain;
      return ops;
    }
    if (typeof last.insert === 'string' && typeof op.insert === 'string') {
      last.insert += op.insert;
      return ops;
    }
  }
  ops.push({ ...op });
  return ops;
};

// A trailing retain of no attributes says nothing.
const chop = (ops) => {
  const last = ops[ops.length - 1];
  if (last !== undefined && last.retain !== undefined && last.attributes === undefined) ops.pop();
  return ops;
};

// The attributes of a retain composed over an insert's or a retain's: the
// later ones win, a null one removes (kept over a retain: it says so).
const composeAttributes = (a, b, keepNull) => {
  const out = { ...(b ?? {}) };
  if (a !== undefined) for (const key of Object.keys(a)) if (out[key] === undefined) out[key] = a[key];
  if (!keepNull) for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  return Object.keys(out).length > 0 ? out : undefined;
};

/** The delta that does `a` then `b`, as one; a document (inserts alone) composed with a delta is the document after it. */
const compose = (a, b) => {
  const ia = iterate(a);
  const ib = iterate(b);
  const ops = [];
  while (ia.hasNext() || ib.hasNext()) {
    if (ib.peekType() === 'insert') {
      push(ops, ib.next());
    } else if (ia.peekType() === 'delete') {
      push(ops, ia.next());
    } else {
      const length = Math.min(ia.peekLength(), ib.peekLength());
      const aOp = ia.next(length);
      const bOp = ib.next(length);
      if (bOp.retain !== undefined) {
        const op = aOp.retain !== undefined ? { retain: length } : { insert: aOp.insert };
        let bAttributes = bOp.attributes;
        // A marker changed (`attributes.embed` over a slot) replaces the
        // document's embed rather than styling it: an `embed` attribute on an
        // insert would read as a mark, and the marker it was inserted with stay.
        if (bAttributes !== undefined && bAttributes.embed !== undefined && typeof aOp.insert === 'object') {
          op.insert = { embed: bAttributes.embed };
          const { embed, ...rest } = bAttributes;
          bAttributes = Object.keys(rest).length > 0 ? rest : undefined;
        }
        const attributes = composeAttributes(aOp.attributes, bAttributes, aOp.retain !== undefined);
        if (attributes !== undefined) op.attributes = attributes;
        push(ops, op);
      } else if (bOp.delete !== undefined && aOp.retain !== undefined) {
        push(ops, bOp);
      }
      // b deletes what a inserted: nothing of either stays.
    }
  }
  return chop(ops);
};

const transformAttributes = (a, b, priority) => {
  if (a === undefined || b === undefined || !priority) return b;
  const out = {};
  for (const key of Object.keys(b)) if (a[key] === undefined) out[key] = b[key];
  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * `b` rewritten to apply after `a`, the two made over one base: `a ∘
 * transform(a, b)` reads as `b ∘ transform(b, a, !priority)`. With
 * `priority`, `a`'s insert comes first where both insert at one index.
 */
const transform = (a, b, priority = false) => {
  const ia = iterate(a);
  const ib = iterate(b);
  const ops = [];
  while (ia.hasNext() || ib.hasNext()) {
    if (ia.peekType() === 'insert' && (priority || ib.peekType() !== 'insert')) {
      push(ops, { retain: lengthOf(ia.next()) });
    } else if (ib.peekType() === 'insert') {
      push(ops, ib.next());
    } else {
      const length = Math.min(ia.peekLength(), ib.peekLength());
      const aOp = ia.next(length);
      const bOp = ib.next(length);
      if (aOp.delete !== undefined) continue;
      if (bOp.delete !== undefined) {
        push(ops, bOp);
      } else {
        const op = { retain: length };
        const attributes = transformAttributes(aOp.attributes, bOp.attributes, priority);
        if (attributes !== undefined) op.attributes = attributes;
        push(ops, op);
      }
    }
  }
  return chop(ops);
};

/** Where `index` is once `delta` has applied; with `priority`, an insert at the index itself stays behind it. */
const transformIndex = (index, delta, priority = false) => {
  const it = iterate(delta);
  let offset = 0;
  let at = index;
  while (it.hasNext() && offset <= at) {
    const length = it.peekLength();
    const type = it.peekType();
    it.next();
    if (type === 'delete') {
      at -= Math.min(length, at - offset);
      continue;
    }
    if (type === 'insert' && (offset < at || !priority)) at += length;
    offset += length;
  }
  return at;
};

module.exports = { lengthOf, typeOf, sameAttributes, iterate, push, chop, compose, transform, transformIndex };
