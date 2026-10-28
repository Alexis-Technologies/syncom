'use strict';

// A text's changes as Quill deltas and a delta as one transaction
// (src/text/text.js is the plugin): toDelta and applyDelta over the algebra
// of src/text/quill.js.

const S = require('./sequence.js');
const { spliceArgs, markArgs, jsonValue, fieldName, EMBED } = require('../args.js');
const { compose } = require('./quill.js');
const { isRecordId, invalidId, isPlainObject, deepEqual } = require('../shape.js');
const { floorOf } = require('../vector.js');
const { SyncomError } = require('../errors.js');
const { blockOf, render, revisionOf, marksAt, markerArgs } = require('./kind.js');

// ---------------------------------------------------------------------------
// Deltas (Quill's form): `[{ retain, attributes? }, { insert, attributes? },
// { delete }]` — what an editor binding exchanges. `toDelta` composes a
// text's changes into one; `applyDelta` makes a delta the field's edits, as
// one transaction. An embed slot travels as `{ insert: { embed: marker } }`,
// a marker changed as `{ retain: 1, attributes: { embed: marker } }`.

// The content of an insert as delta ops, pushed onto `out`: the text, its
// embed slots as `{ insert: { embed: marker } }`.
const insertsOf = (content, vals, marks, out) => {
  const markers = new Map(vals ?? []);
  const attributes = marks !== undefined && Object.keys(marks).length > 0 ? marks : undefined;
  const add = (insert) => void out.push(attributes === undefined ? { insert } : { insert, attributes });
  let from = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== EMBED) continue;
    if (i > from) add(content.slice(from, i));
    add({ embed: markers.get(i) ?? null });
    from = i + 1;
  }
  if (from < content.length) add(content.slice(from));
  return out;
};

// One change of a text as a delta, or null for a change a delta cannot say
// (a reset, an unset, a list's): the caller reads the field again.
const deltaOf = (change) => {
  const { action } = change;
  if (action === 'splice') {
    if (Array.isArray(change.content)) return null;
    const out = [];
    if (change.index > 0) out.push({ retain: change.index });
    if (change.count > 0) out.push({ delete: change.count });
    if (change.content !== undefined && change.content.length > 0) {
      insertsOf(change.content, change.vals, change.marks, out);
    }
    return out;
  }
  if (action === 'mark' || action === 'unmarkById') {
    const out = [];
    if (change.start > 0) out.push({ retain: change.start });
    const value = action === 'mark' ? change.value : null;
    out.push({ retain: change.end - change.start, attributes: { [change.name]: value } });
    return out;
  }
  if (action === 'setAt' && !Array.isArray(change.value)) {
    const out = [];
    if (change.index > 0) out.push({ retain: change.index });
    out.push({ retain: 1, attributes: { embed: change.value } });
    return out;
  }
  return null;
};

/**
 * The changes of text field `field` (every text change when `field` is not
 * given) composed into one delta — `[{ retain, attributes? }, { insert,
 * attributes? }, { delete }]`, Quill's form, over the reading before them:
 * a splice's cut and insert, a mark as attributes over its range (`null` to
 * remove), an embed slot as `{ insert: { embed: marker } }`, a marker
 * changed as `{ retain: 1, attributes: { embed } }`. `null` when a change
 * is no edit a delta can say — a reset, an unset, a list's — so the caller
 * reads the field again.
 */
const toDelta = (core, changes, field) => {
  if (!Array.isArray(changes)) throw new TypeError('toDelta() takes an array of changes');
  let delta = [];
  for (const change of changes) {
    const { action } = change;
    // The record gone, or the field reset from above (a prefix written or
    // unset): no delta says it — whichever field was asked for.
    if (action === 'delete' || action === 'purge') return null;
    if (change.field === undefined) continue;
    if (field !== undefined && change.field !== field) {
      if (field.startsWith(`${change.field}/`)) return null;
      continue;
    }
    if (field === undefined) {
      // Every text field at once: what is no text's edit is left out, a
      // text reset or a field gone makes the whole no delta.
      if (action === 'reset' && change.kind !== 'text') continue;
      if (action === 'unset' || action === 'reset') return null;
      if (action === 'splice' && Array.isArray(change.content)) continue;
      if (action !== 'splice' && action !== 'mark' && action !== 'unmarkById' && action !== 'setAt') continue;
    }
    const step = deltaOf(change);
    if (step === null) return null;
    delta = compose(delta, step);
  }
  return delta;
};

const isDeltaOp = (op) =>
  isPlainObject(op) &&
  ((Number.isInteger(op.retain) && op.retain > 0) ||
    (Number.isInteger(op.delete) && op.delete > 0) ||
    typeof op.insert === 'string' ||
    (isPlainObject(op.insert) && Object.hasOwn(op.insert, 'embed'))) &&
  (op.attributes === undefined || isPlainObject(op.attributes));

/**
 * Makes `delta` the edits of text field `key`, as one transaction: a
 * `retain` moves on (with `attributes`, a mark — or an unmark, for a null —
 * over what it retains; `{ embed }` sets the slot's marker), an `insert`
 * splices text in (an `{ embed: marker }` inserts a slot with it) and marks
 * it with its attributes, a `delete` cuts. Resolves to `{ ops, revision }`:
 * how many ops it took, and the field's revision after them.
 * `expect` is the field's text the delta was made over: a field that reads
 * otherwise inside the queue — a peer's edit landed first — rejects with
 * `STALE` before any op, so the caller rebases and sends again. `revision`,
 * a revision this call or `revision()` handed back for that text, spares
 * the comparison while the field still is at it (O(1) instead of the text).
 */
const applyDelta = async (core, id, key, delta, { actor, message, source, expect, revision } = {}) => {
  fieldName('applyDelta', key);
  const shape = 'applyDelta() takes a delta: [{ retain, attributes? } | { insert, attributes? } | { delete }]';
  if (!Array.isArray(delta)) throw new TypeError(shape);
  // A hole is no op.
  for (let i = 0; i < delta.length; i++) if (!isDeltaOp(delta[i])) throw new TypeError(shape);
  if (expect !== undefined && typeof expect !== 'string') {
    throw new TypeError('applyDelta() takes expect as the text the delta was made over');
  }
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw new TypeError('applyDelta() takes revision as what applyDelta() or revision() handed back');
  }
  if (!isRecordId(id)) throw invalidId(id);
  const { result, done } = await core.transact(
    async (tx) => {
      if (expect !== undefined) {
        const entry = await tx.current(id);
        // The field still at the revision the text was read at: it reads as
        // that text, and the comparison — O(n), a rope flattened — is spared.
        if (revision === undefined || revisionOf(entry, key) !== revision) {
          const shown = entry && !entry.encrypted && blockOf(entry, key) !== undefined ? render(entry, key) : '';
          const text = typeof shown === 'string' ? shown : '';
          if (text !== expect) {
            throw new SyncomError('STALE', `Field ${key} of ${id} changed under the delta`, { id, field: key });
          }
        }
      }
      let at = 0;
      let ops = 0;
      // The marks the inserted run reads with after its splice — the ones it
      // landed inside, the ones that grew over it: what the delta's
      // attributes replace, a name at a time.
      const inserted = async (start, length, attributes) => {
        const entry = await tx.current(id);
        const idx = entry === null ? null : S.indexOf(entry, key);
        const have = idx === null ? {} : marksAt(idx, start, floorOf(entry.meta, key));
        const want = { ...(attributes ?? {}) };
        for (const name of Object.keys(have)) {
          if (want[name] === undefined && name !== 'embed') want[name] = null;
        }
        for (const name of Object.keys(want)) {
          if (name !== 'embed' && deepEqual(have[name], want[name])) delete want[name];
        }
        if (Object.keys(want).length > 0) await marks(start, start + length, want);
      };
      const marks = async (start, end, attributes) => {
        for (const name of Object.keys(attributes)) {
          const value = attributes[name];
          if (name === 'embed') {
            // Every slot of the range takes the marker: two neighbours set
            // alike are one retain, as a delta composes them.
            const marker = value === null ? null : markerArgs('applyDelta', value, value.isEmbed ?? true);
            for (let index = start; index < end; index++) {
              ops += (await tx.commit('assign', id, { key, index, value: marker }, { actor })) ? 1 : 0;
            }
          } else {
            // A delta says every insert's attributes itself: a mark it lays
            // grows over nothing typed later (`expand: 'none'`), nor does
            // its removal.
            markArgs('applyDelta', key, start, end, name, 'none');
            const marked = value === null ? null : jsonValue('applyDelta', value);
            const payload = { key, start, end, name, value: marked, expand: 'none' };
            ops += (await tx.commit('mark', id, payload, { actor })) ? 1 : 0;
          }
        }
      };
      for (const op of delta) {
        if (op.delete !== undefined) {
          ops += (await tx.commit('splice', id, spliceArgs('applyDelta', key, at, op.delete), { actor })) ? 1 : 0;
        } else if (op.retain !== undefined) {
          if (op.attributes !== undefined) await marks(at, at + op.retain, op.attributes);
          at += op.retain;
        } else if (typeof op.insert === 'string') {
          if (op.insert.length === 0) continue;
          ops += (await tx.commit('splice', id, spliceArgs('applyDelta', key, at, 0, op.insert), { actor })) ? 1 : 0;
          await inserted(at, op.insert.length, op.attributes);
          at += op.insert.length;
        } else {
          const { embed } = op.insert;
          const marker = embed === null ? null : markerArgs('applyDelta', embed, embed.isEmbed ?? true);
          const payload = spliceArgs('applyDelta', key, at, 0, EMBED, { embeds: true });
          payload.vals = [[0, marker]];
          ops += (await tx.commit('splice', id, payload, { actor })) ? 1 : 0;
          await inserted(at, 1, op.attributes);
          at += 1;
        }
      }
      return { ops, revision: revisionOf(await tx.current(id), key) };
    },
    { actor, message, source },
  );
  if (done !== null) await done;
  return result;
};

module.exports = {
  toDelta,
  applyDelta,
};
