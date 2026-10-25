'use strict';

// The `list` and `text` kinds as a plugin (@alexify/syncom/text): the Fugue
// sequence engine (./sequence.js, ./rle.js) behind a record's lists and
// texts — what the core calls to apply a splice, an assign, a move or a
// mark, to normalize and join a peer's block, to read the field, to resolve
// a local call's indices into anchors inside the queue, to diff two readings
// into patches and realize them — and the storage methods the plugin adds
// (splice, push, updateText, mark, unmark, unmarkById, spans, cursor, index,
// setAt, move). Registered per instance with `open({ plugins: [text] })`;
// src/plugin.js names the contract.
//
// The index of a field (buildIndex) is kept on the entry under
// `entry.cache[field]` — never persisted, carried by cloneEntry and by the
// entry cache — and reused while the block object and the base it was built
// against are the ones the entry holds; a block replaced by an op is a new
// object. When the op only appended to a run, the held index is extended
// instead of walked anew (the `hint` apply hands back).

const S = require('./sequence.js');
const { MAX_RUN } = require('./rle.js');
const { diff: myers } = require('./myers.js');
const { spliceArgs, markArgs, jsonValue } = require('../args.js');
const { isRecordId, invalidId } = require('../shape.js');
const { SyncomError } = require('../errors.js');

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

const KINDS = Object.freeze({ list: 3, text: 4 });
const CODES = Object.freeze({ l: 'list', t: 'text' });
const TAKES = Object.freeze({ splice: ['list', 'text'], assign: ['list'], move: ['list'], mark: ['text'] });
const HINTS = Object.freeze({
  list: 'a list; use splice(), push(), setAt() or move() (an array, not a string)',
  text: 'a text; use splice(), push(), updateText() or mark() (a string, not an array)',
});

const codeOf = (kind) => (kind === 'text' ? 't' : 'l');

// The sequence block under `field`, when the field is a list or a text.
const blockOf = (entry, field) => {
  const block = own(entry.meta.blocks, field);
  return block !== undefined && (block.k === 't' || block.k === 'l') ? block : undefined;
};

// ---------------------------------------------------------------------------
// The kind module: what the core calls (src/ops.js applyBlock, normalizeMeta,
// applyBase, mergeEntry; src/commit.js prepareOp; src/patch.js).

// A splice names its kind by its content — a string a text, an array a
// list — and one that only removes takes the field's.
const takes = (type, payload) =>
  type === 'splice' && payload.content !== undefined ? [Array.isArray(payload.content) ? 'list' : 'text'] : TAKES[type];

const kindOfOp = (op) => {
  if (op.type === 'splice') {
    const { content } = op.value;
    return typeof content === 'string' ? 'text' : Array.isArray(content) ? 'list' : null;
  }
  return op.type === 'mark' ? 'text' : 'list';
};

const normalize = (raw, base, limits) => S.normalizeSeq(raw, base, limits.pendingMax);

// A `splice` lands on the block (src/sequence.js), an `assign`, a `move` or
// a `mark` on its registers; a register or a mark for a field with no block
// yet names its kind and waits, like a cut that comes before its run. The
// block is pruned at once: what fell below the base must look the same as
// if it had never landed, whichever side of the reset it arrived on.
const apply = (entry, field, held, op, stamp, limits) => {
  const { base } = entry.meta;
  const payload = op.value;
  const block = held ?? S.createSeq(codeOf(kindOfOp(op)));
  const { pendingMax } = limits;
  const result =
    op.type === 'splice'
      ? S.applySplice(block, stamp, payload, base, pendingMax)
      : op.type === 'assign'
        ? S.applyAssign(block, stamp, payload, base, pendingMax)
        : op.type === 'move'
          ? S.applyMove(block, stamp, payload, base, pendingMax)
          : S.applyMark(block, stamp, payload, base, pendingMax);
  const out = { block: held ?? null, changed: result.changed };
  if (result.reason !== undefined) {
    Object.assign(out, { reason: result.reason, detail: result.detail, count: result.count, max: result.max });
  }
  if (!result.changed) return out;
  const seq = S.prune(result.seq, base);
  out.block = seq;
  // The held block's index is extended when the op only appended to a run
  // and the prune left the block as the op made it.
  if (seq !== null && result.extended && seq === result.seq) out.hint = { ...result.extended, held };
  return out;
};

const render = (entry, field, block, hint = null) => S.render(S.indexOf(entry, field, hint));
const prune = (block, base) => S.prune(block, base);
const join = (a, b) => S.join(a, b);

// A splice names an index and a count; what travels is the anchor of the
// new run (or the run of this origin to extend) and the ranges to cut, read
// here, inside the queue — read outside it, a concurrent apply would shift
// the indices. The content names the kind — a string for a text, an array
// for a list — and a call that only cuts takes the field's.
const resolveSplice = (core, id, payload, current) => {
  const { key, index, count, content } = payload;
  const held = current ? blockOf(current, key) : undefined;
  const marker = content ?? (held?.k === 'l' ? [] : '');
  const idx = held === undefined ? null : S.indexOf(current, key);
  const length = idx === null ? 0 : idx.length;
  const at = index === null ? length : index;
  if (at > length || at + count > length) {
    const span = count > 0 ? `${at}..${at + count}` : String(at);
    const message = `Index ${span} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: at, count, length });
  }
  const value = { content: marker };
  if (count > 0) value.cut = S.rangesOf(idx, at, count);
  if (marker.length > 0) {
    Object.assign(value, idx === null ? { at: S.HEAD } : S.placeInsert(idx, at, core.nodeId, marker.length));
  }
  return value;
};

// A list's element, by its index: the name it keeps across moves. A field
// with no block has no elements (OUT_OF_RANGE); another kind under the field
// was refused before this is read (kindClash).
const elementAt = (core, id, key, index, current) => {
  const held = current ? blockOf(current, key) : undefined;
  const idx = held === undefined ? null : S.indexOf(current, key);
  const length = idx === null ? 0 : idx.length;
  if (index >= length) {
    const message = `Index ${index} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index, count: 0, length });
  }
  return { idx, elem: S.elemAt(idx, index) };
};

const resolveAssign = (core, id, payload, current) => {
  const { key, index, value } = payload;
  return { elem: elementAt(core, id, key, index, current).elem, value };
};

// A move names two indices; what travels is the element, the slot it showed
// at and the anchor of its new position (`to` counts once it is out).
const resolveMove = (core, id, payload, current) => {
  const { key, index: from, to } = payload;
  const { idx, elem } = elementAt(core, id, key, from, current);
  if (to >= idx.length) {
    const message = `Index ${to} is out of range for field ${key} of record ${id} (length ${idx.length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: to, count: 0, length: idx.length });
  }
  const place = S.placeInsert(idx, to < from ? to : to + 1, core.nodeId);
  const at = place.at ?? `>${S.elemKey(place.run, place.from - 1)}`;
  return { elem, cut: S.slotAt(idx, from), at, value: S.valueAt(idx, from) };
};

// A mark names a visible range and an expand rule; what travels is the pair
// of anchors — an element and a side — the rule picks (src/sequence.js
// markAnchors), or the id of the mark to switch off.
const resolveMark = (core, id, payload, current) => {
  const { key, off } = payload;
  if (off !== undefined) return { off };
  const { start, end, name, value, expand, many } = payload;
  const held = current ? blockOf(current, key) : undefined;
  const idx = held === undefined ? null : S.indexOf(current, key);
  const length = idx === null ? 0 : idx.length;
  if (start > end || end > length) {
    const message = `Range ${start}..${end} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: start, count: end - start, length });
  }
  const [from, to] = idx === null ? [S.HEAD, S.END] : S.markAnchors(idx, start, end, expand);
  const out = { start: from, end: to, key: name, value };
  if (many) out.many = true;
  return out;
};

const resolve = (core, id, type, payload, current) => {
  if (type === 'splice') return resolveSplice(core, id, payload, current);
  if (type === 'assign') return resolveAssign(core, id, payload, current);
  if (type === 'move') return resolveMove(core, id, payload, current);
  return resolveMark(core, id, payload, current);
};

// ---------------------------------------------------------------------------
// Patches (src/patch.js diffViews / realize): a text's or a list's edits as
// splices (Myers), laid in runs of at most MAX_RUN elements — one splice is
// one run, and a run holds no more (src/rle.js).

const inRuns = (patches) =>
  patches.flatMap((patch) => {
    const { action, count, content } = patch;
    if (action !== 'splice' || count !== 0 || content === undefined || content.length <= MAX_RUN) return [patch];
    const runs = [];
    for (let at = 0; at < content.length; at += MAX_RUN) {
      runs.push({ ...patch, index: patch.index + at, content: content.slice(at, at + MAX_RUN) });
    }
    return runs;
  });

// A list's elements as one character each, so Myers runs over them as over
// a text; past the private-use plane it is one replacing splice.
const PRIVATE = 0xe000;
const MAX_DISTINCT = 0x1900;
const spliceList = (field, from, to) => {
  const codes = new Map();
  const items = [];
  const intern = (list) => {
    let text = '';
    for (const item of list) {
      const key = JSON.stringify(item);
      let code = codes.get(key);
      if (code === undefined) {
        if (items.length >= MAX_DISTINCT) return null;
        code = PRIVATE + items.length;
        codes.set(key, code);
        items.push(item);
      }
      text += String.fromCharCode(code);
    }
    return text;
  };
  const a = intern(from);
  const b = a === null ? null : intern(to);
  if (b === null) return [{ action: 'splice', field, index: 0, count: from.length, content: to }];
  return myers(a, b).map(([index, count, text]) => ({
    action: 'splice',
    field,
    index,
    count,
    content: Array.from(text, (ch) => items[ch.charCodeAt(0) - PRIVATE]),
  }));
};

const spliceText = (field, from, to) =>
  myers(from, to).map(([index, count, content]) => ({ action: 'splice', field, index, count, content }));

const diff = (field, kind, from, to) =>
  inRuns(kind === 'text' ? spliceText(field, from ?? '', to ?? '') : spliceList(field, from ?? [], to ?? []));

const recreate = (field, kind, value) =>
  value.length === 0 ? [] : inRuns([{ action: 'splice', field, index: 0, count: 0, content: value }]);

const realize = (action, patch, method) => {
  const { field } = patch;
  if (action === 'splice') {
    const { index, count = 0, content } = patch;
    const payload = spliceArgs(method, field, index, count, content);
    // A pure cut carries no content: the field's kind says what it is.
    if (payload.content !== undefined && payload.content.length === 0) delete payload.content;
    return ['splice', payload];
  }
  const { start, end, name, value = null, expand = 'after' } = patch;
  markArgs(method, field, start, end, name, expand);
  const payload = { key: field, start, end, name, value: jsonValue(method, value), expand };
  if (patch.many === true) payload.many = true;
  return ['mark', payload];
};

// A list or a text comes back as one run (a run per MAX_RUN elements); an
// empty one is dropped.
const migrate = (kind, key, value) =>
  value.length === 0
    ? []
    : inRuns([{ action: 'splice', field: key, index: 0, count: 0, content: value }]).map((patch) => [
        'splice',
        { key, index: patch.index, count: 0, content: patch.content },
      ]);

// A text's marks laid again over the field `compact()` makes anew: the ones
// in force, in stamp order, as `mark` patches (src/sequence.js marksIn).
const compact = (entry, field, kind) => {
  if (kind !== 'text') return [];
  const patches = [];
  const block = entry.meta.blocks[field];
  for (const m of S.marksIn(S.indexOf(entry, field), block, entry.meta.base)) {
    const patch = { action: 'mark', field, start: m.start, end: m.end, name: m.key, value: m.value };
    patch.expand = m.expand;
    if (m.many) patch.many = true;
    patches.push(patch);
  }
  return patches;
};

// ---------------------------------------------------------------------------
// The storage methods, over the `core` Storage lends. Every write is one op
// through the queued commit; `updateText` diffs inside the queue and commits
// each hunk through the local write path. The readers (`spans`, `cursor`,
// `index`) read the record raw: no lens, no hooks.

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
    const before = current && !current.encrypted && core.alive(current) ? current.data[key] : undefined;
    // Another kind under the field: the first splice is refused for it.
    const hunks = myers(typeof before === 'string' ? before : '', text);
    let ops = 0;
    for (const [index, count, content] of hunks) {
      const payload = { key, index, count };
      if (content.length > 0) payload.content = content;
      if ((await core.commitNow('splice', id, payload, { actor })) !== null) ops++;
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
  if (!entry || entry.encrypted || !core.alive(entry)) return null;
  const seq = blockOf(entry, key);
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
  return S.spans(S.indexOf(field.entry, key), field.seq, field.base);
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
  return field === null ? null : S.cursorAt(S.indexOf(field.entry, key), index, side);
};

/** Where `cursor` is now in list or text field `key`; `null` once its place is gone (a reset, a field no longer a sequence). */
const index = async (core, id, key, cursor) => {
  if (typeof cursor !== 'string' || !S.isAnchor(cursor)) throw new TypeError('index() takes a cursor');
  const field = await held(core, 'index', id, key);
  return field === null ? null : S.indexOfCursor(S.indexOf(field.entry, key), cursor);
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

/** The list and text kinds: register with `open({ plugins: [text] })`. */
const text = Object.freeze({
  name: 'text',
  kinds: KINDS,
  codes: CODES,
  types: Object.freeze(['splice', 'assign', 'move', 'mark']),
  actions: Object.freeze(['splice', 'mark']),
  hints: HINTS,
  takes,
  kindOfOp,
  normalize,
  apply,
  join,
  prune,
  render,
  resolve,
  diff,
  recreate,
  realize,
  migrate,
  compact,
  methods: Object.freeze({ splice, push, updateText, mark, unmark, unmarkById, spans, cursor, index, setAt, move }),
});

module.exports = { text };
