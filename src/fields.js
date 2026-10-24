'use strict';

// The API of the field kinds beyond registers — counters, sets, lists,
// texts and trees — over the `core` Storage lends (Storage#lend). Every
// write is one op through the queued commit (`core.commit`, what
// `storage[COMMIT]` runs), its arguments checked first in src/args.js;
// `updateText` diffs inside the queue (`core.run`) and commits each hunk
// through the local write path (src/commit.js). The readers of a sequence
// (`spans`, `cursor`, `index`) read the record raw: no lens, no hooks.
// Storage keeps one delegate per method, so the public surface stays on
// the facade and the bodies live here.

const { commit } = require('./commit.js');
const { spliceArgs, treeArgs, markArgs, setElements, jsonValue } = require('./args.js');
const { isAlive, seqIndexOf } = require('./ops.js');
const { diff } = require('./myers.js');
const S = require('./sequence.js');
const { TRASH } = require('./tree.js');
const { isRecordId, invalidId } = require('./shape.js');

/** Adds `value` to counter field `key` — the commutative alternative to update(). */
const inc = async (core, id, key, value = 1, { actor } = {}) => {
  if (typeof key !== 'string') throw new TypeError('inc() takes a field name');
  if (!Number.isFinite(value)) throw new TypeError('inc() takes a finite number');
  await core.commit('inc', id, { key, value }, { actor });
};

/**
 * Adds `elements` to set field `key` — an observed-remove set: two nodes
 * that add concurrently both keep theirs, and an add a remove did not
 * observe survives it. Creates the field, and the record, when absent.
 */
const add = async (core, id, key, elements, { actor } = {}) => {
  await core.commit('add', id, { key, value: setElements('add', key, elements) }, { actor });
};

/** Removes from set field `key` the `elements` this node has seen added; one it never saw is left alone. */
const remove = async (core, id, key, elements, { actor } = {}) => {
  await core.commit('remove', id, { key, value: setElements('remove', key, elements) }, { actor });
};

/**
 * Splices list or text field `key` at `index`: removes `count` elements
 * and inserts `content` — an array for a list, a string for a text — in
 * their place (a `splice` op). The first write decides the kind. Elements
 * merge by position (Fugue): two nodes inserting at one spot both keep
 * theirs, each run whole, and a deleted element keeps its place for the
 * anchors into it. Creates the field, and the record, when absent;
 * rejects with `OUT_OF_RANGE` past the field's length.
 */
const splice = async (core, id, key, index, count = 0, content, { actor } = {}) => {
  await core.commit('splice', id, spliceArgs('splice', key, index, count, content), { actor });
};

/** Appends `content` to list or text field `key` — a `splice` at the end. */
const push = async (core, id, key, content, { actor } = {}) => {
  await core.commit('splice', id, spliceArgs('push', key, null, 0, content), { actor });
};

/**
 * Makes text field `key` read as `text`: the field is diffed against it
 * inside the mutation queue (Myers, over UTF-16 units) and each hunk is a
 * `splice`, last first, in one turn of the queue — what an editor hands
 * over as a whole string becomes the edits that merge. Returns how many
 * ops it took; a difference deeper than a thousand edit steps is one op
 * replacing the middle.
 */
const updateText = async (core, id, key, text, { actor } = {}) => {
  if (typeof key !== 'string') throw new TypeError('updateText() takes a field name');
  if (typeof text !== 'string') throw new TypeError('updateText() takes a string');
  if (!isRecordId(id)) throw invalidId(id);
  return core.run(async () => {
    const current = await core.entries.load(id);
    const before = current && !current.encrypted && isAlive(current) ? current.data[key] : undefined;
    // Another kind under the field: the first splice is refused for it.
    const hunks = diff(typeof before === 'string' ? before : '', text);
    let ops = 0;
    for (const [index, count, content] of hunks) {
      const payload = { key, index, count };
      if (content.length > 0) payload.content = content;
      if ((await commit(core, 'splice', id, payload, { actor })) !== null) ops++;
    }
    return ops;
  });
};

/**
 * Marks visible range `[start, end)` of text field `key` with `name: value`
 * (a `mark` op). `expand` says whether text typed at the range's edges
 * takes the style — `'after'` (the default: bold grows), `'before'`,
 * `'both'`, `'none'` (a link does not). Per name the newest mark wins;
 * `{ many: true }` makes a mark stack with every other of its name
 * (comments), removable only by id. Resolves to the mark's id.
 */
const mark = async (core, id, key, start, end, name, value, { expand = 'after', many = false, actor } = {}) => {
  markArgs('mark', key, start, end, name, expand);
  jsonValue('mark', value);
  const payload = { key, start, end, name, value, expand };
  if (many === true) payload.many = true;
  const op = await core.commit('mark', id, payload, { actor });
  return op ? `${op.ts}:${op.origin}` : null;
};

/**
 * Removes a style over `[start, end)` by `name`: a mark with a null value
 * under the reversed expand rule, so the removal grows where the style
 * would not. A `many` mark goes by its id alone (`unmarkById`).
 */
const unmark = async (core, id, key, start, end, name, { expand = 'after', actor } = {}) => {
  markArgs('unmark', key, start, end, name, expand);
  await core.commit('mark', id, { key, start, end, name, value: null, expand: S.REVERSED[expand] }, { actor });
};

/**
 * Switches one mark of text field `key` off by its id — what `mark()`
 * resolved to — the only way for a `many` mark.
 */
const unmarkById = async (core, id, key, markId, { actor } = {}) => {
  if (typeof key !== 'string') throw new TypeError('unmarkById() takes a field name');
  if (!S.isRunKey(markId)) throw new TypeError('unmarkById() takes a mark id');
  await core.commit('mark', id, { key, off: markId }, { actor });
};

// A sequence field as the record holds it — raw, no lens, no hooks — or null.
const held = async (core, method, id, key) => {
  if (!isRecordId(id)) throw invalidId(id);
  if (typeof key !== 'string') throw new TypeError(`${method}() takes a field name`);
  const entry = await core.entries.load(id);
  if (!entry || entry.encrypted || !isAlive(entry)) return null;
  const seq = Object.hasOwn(entry.meta.seqs ?? {}, key) ? entry.meta.seqs[key] : undefined;
  return seq === undefined ? null : { entry, seq, base: entry.meta.base };
};

/**
 * Text field `key` of record `id` as runs of equal style: `[{ text, marks }]`,
 * `marks` per name the winning value (a `many` name lists `{ id, value }`).
 * Raw: no lens, no read hooks. `null` when the record or the field is not
 * a text.
 */
const spans = async (core, id, key) => {
  const field = await held(core, 'spans', id, key);
  if (field === null || field.seq.k !== 't') return null;
  return S.spans(seqIndexOf(field.entry, key), field.seq, field.base);
};

/**
 * A cursor into list or text field `key`: a place that survives edits
 * around it — before the element at `index` (`side: 'before'`, the
 * default) or after the one before it (`'after'`), a string to keep or to
 * send. `index()` says where it is now. `null` out of range or when the
 * field is not a list or a text.
 */
const cursor = async (core, id, key, index, { side = 'before' } = {}) => {
  if (side !== 'before' && side !== 'after') throw new TypeError("cursor() takes side: 'before' or 'after'");
  const field = await held(core, 'cursor', id, key);
  return field === null ? null : S.cursorAt(seqIndexOf(field.entry, key), index, side);
};

/** Where `cursor` is now in list or text field `key`; `null` once its place is gone (a reset, a field no longer a sequence). */
const index = async (core, id, key, cursor) => {
  if (typeof cursor !== 'string' || !S.isAnchor(cursor)) throw new TypeError('index() takes a cursor');
  const field = await held(core, 'index', id, key);
  return field === null ? null : S.indexOfCursor(seqIndexOf(field.entry, key), cursor);
};

/**
 * Replaces the element at `index` of list field `key` with `value` (an
 * `assign` op): a register per element, last writer wins, and the value
 * follows the element through a concurrent move.
 */
const setAt = async (core, id, key, index, value, { actor } = {}) => {
  if (typeof key !== 'string') throw new TypeError('setAt() takes a field name');
  if (!Number.isInteger(index) || index < 0) throw new TypeError('setAt() takes a non-negative integer index');
  jsonValue('setAt', value);
  await core.commit('assign', id, { key, index, value }, { actor });
};

/**
 * Moves the element at `from` of list field `key` to `to` — its index once
 * it is out (a `move` op). Two nodes moving one element concurrently leave
 * it once, at the newer move's place; a move concurrent with a removal of
 * the element brings it back.
 */
const move = async (core, id, key, from, to, { actor } = {}) => {
  if (typeof key !== 'string') throw new TypeError('move() takes a field name');
  if (!Number.isInteger(from) || from < 0 || !Number.isInteger(to) || to < 0) {
    throw new TypeError('move() takes non-negative integer indices');
  }
  if (from === to) return;
  await core.commit('move', id, { key, index: from, to }, { actor });
};

/**
 * Puts node `node` of tree field `key` under `parent` (`null`: a root) —
 * after sibling `after`, before sibling `before`, or last (a `tree` op).
 * A node the tree has not is created there; the field, and the record,
 * when absent. Two nodes moving concurrently so that each would hang
 * under the other: the newer move loses, on every node, and a later move
 * can revive it. Rejects with `CYCLE` for a parent under the node itself
 * and with `NOT_FOUND` for a sibling not under `parent`; a move to where
 * the node already is makes no op.
 */
const treeMove = async (core, id, key, node, parent = null, { after, before, actor } = {}) => {
  treeArgs('treeMove', key, node, parent, { after, before });
  const payload = { key, node, parent };
  if (after !== undefined) payload.after = after;
  if (before !== undefined) payload.before = before;
  await core.commit('tree', id, payload, { actor });
};

/**
 * Removes node `node` of tree field `key` with everything under it — a
 * move under the trash, which no reading shows. A node not yet known here
 * is created there, so a creation of it elsewhere lands removed.
 */
const treeRemove = async (core, id, key, node, { actor } = {}) => {
  treeArgs('treeRemove', key, node, null);
  await core.commit('tree', id, { key, node, parent: TRASH }, { actor });
};

module.exports = {
  inc,
  add,
  remove,
  splice,
  push,
  updateText,
  mark,
  unmark,
  unmarkById,
  spans,
  cursor,
  index,
  setAt,
  move,
  treeMove,
  treeRemove,
};
