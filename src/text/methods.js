'use strict';

// The storage methods of the list and text kinds (src/text/text.js is the
// plugin), over the `core` Storage lends: every write one op through
// `core.commit`, every read the record as it is held.

const S = require('./sequence.js');
const { diff: myers } = require('./myers.js');
const { spliceArgs, markArgs, jsonValue, fieldName, EMBED } = require('../args.js');
const { isRecordId, invalidId } = require('../shape.js');
const { floorOf } = require('../vector.js');
const { blockOf, revisionOf, markerAt, markerArgs, wholeCharacters } = require('./kind.js');

/**
 * Who inserted the element at `index` of list or text field `key`:
 * `{ origin, ts }` of its run — the node, and the stamp of the splice —
 * or `null` out of range, or when the field is not a list or a text.
 */
const editorOf = async (core, id, key, index) => {
  if (!Number.isInteger(index) || index < 0) throw new TypeError('editorOf() takes a non-negative integer index');
  const field = await held(core, 'editorOf', id, key);
  if (field === null) return null;
  const elem = S.elemAt(S.indexOf(field.entry, key), index);
  if (elem === null) return null;
  const parsed = S.parseElem(elem);
  return parsed === null ? null : { origin: parsed.origin, ts: parsed.ts };
};

// ---------------------------------------------------------------------------
// The storage methods, over the `core` Storage lends. Every write is one op
// through the queued commit; `updateText` diffs inside the queue and commits
// each hunk through the local write path. The readers (`spans`, `cursor`,
// `index`) read the record raw: no lens, no hooks.

// The writes below return the commit's promise as it is (`core.write`, no
// async frame of their own): an argument they refuse is a throw, which the
// storage's delegate hands back as a rejection.
const RESOLVED = Promise.resolve();

/**
 * Splices list or text field `key` at `index`: removes `count` elements
 * and inserts `content` — an array for a list, a string for a text — in
 * their place (a `splice` op). The first write decides the kind. Elements
 * merge by position (Fugue): two nodes inserting at one spot both keep
 * theirs, each run whole, and a deleted element keeps its place for the
 * anchors into it. Creates the field, and the record, when absent;
 * rejects with `OUT_OF_RANGE` past the field's length.
 */
const splice = (core, id, key, index, count = 0, content, options) =>
  core.write('splice', id, spliceArgs('splice', key, index, count, content), { actor: options?.actor });

/** Appends `content` to list or text field `key` — a `splice` at the end. */
const push = (core, id, key, content, options) =>
  core.write('splice', id, spliceArgs('push', key, null, 0, content), { actor: options?.actor });

/**
 * Makes text field `key` read as `text`: the field is diffed against it
 * inside the mutation queue (Myers, over UTF-16 units) and each hunk is a
 * `splice`, last first, in one turn of the queue — what an editor hands
 * over as a whole string becomes the edits that merge. Returns how many
 * ops it took; a difference deeper than a thousand edit steps is one op
 * replacing the middle.
 */
const updateText = async (core, id, key, text, { actor } = {}) => {
  fieldName('updateText', key);
  if (typeof text !== 'string') throw new TypeError('updateText() takes a string');
  if (!isRecordId(id)) throw invalidId(id);
  return core.run(async () => {
    const current = await core.current(id);
    const before = current && !current.encrypted && core.alive(current) ? current.data[key] : undefined;
    // Another kind under the field: the first splice is refused for it.
    const hunks = myers(typeof before === 'string' ? before : '', text);
    // The slots the text keeps stay, markers and all; a new one has no marker to carry.
    for (const [, , content] of hunks) {
      if (content.includes(EMBED)) {
        throw new TypeError(
          'updateText() takes text; an embed (U+FFFC) is inserted with insertEmbed() or splitBlock()',
        );
      }
    }
    let ops = 0;
    const landings = [];
    try {
      for (const [index, count, content] of hunks) {
        const payload = { key, index, count };
        if (content.length > 0) payload.content = content;
        const { op, done } = await core.commitNow('splice', id, payload, { actor });
        if (op === null) continue;
        ops++;
        landings.push(done);
      }
    } finally {
      // What landed before a refusal has landed when the call rejects.
      await Promise.allSettled(landings);
    }
    await Promise.all(landings);
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
  fieldName('unmarkById', key);
  if (!S.isRunKey(markId)) throw new TypeError('unmarkById() takes a mark id');
  await core.commit('mark', id, { key, off: markId }, { actor });
};

// A sequence field as the record holds it — raw, no lens, no hooks — or null.
const held = async (core, method, id, key) => {
  if (!isRecordId(id)) throw invalidId(id);
  fieldName(method, key);
  const entry = await core.entries.load(id);
  if (!entry || entry.encrypted || !core.alive(entry)) return null;
  const seq = blockOf(entry, key);
  return seq === undefined ? null : { entry, seq, base: floorOf(entry.meta, key) };
};

// The engine's spans — runs of equal style — with the embed slots told
// apart: a text span, an embed (a marker with `isEmbed`, under the marks of
// its place) or a block marker.
const typedSpans = (field, key) => {
  const idx = S.indexOf(field.entry, key);
  const out = [];
  let i = 0;
  for (const { text, marks } of S.spans(idx, field.seq, field.base)) {
    let from = 0;
    for (let k = 0; k < text.length; k++) {
      if (text[k] !== EMBED) continue;
      if (k > from) out.push({ type: 'text', text: text.slice(from, k), marks });
      const marker = markerAt(idx, i + k);
      if (marker !== null && !marker.isEmbed) out.push({ type: 'block', value: marker });
      else out.push({ type: 'embed', value: marker, marks });
      from = k + 1;
    }
    if (from < text.length) out.push({ type: 'text', text: text.slice(from), marks });
    i += text.length;
  }
  return out;
};

/**
 * Text field `key` of record `id` as runs of equal style: `[{ type: 'text',
 * text, marks }]`, `marks` per name the winning value (a `many` name lists
 * `{ id, value }`); an embed slot as `{ type: 'embed', value, marks }` or,
 * for a block marker, `{ type: 'block', value }`. Raw: no lens, no read
 * hooks. `null` when the record or the field is not a text.
 */
const spans = async (core, id, key) => {
  const field = await held(core, 'spans', id, key);
  if (field === null || field.seq.k !== 't') return null;
  return typedSpans(field, key);
};

/**
 * What list or text field `key` of `id` reads as now, as a token (0 for no
 * such field): given to `applyDelta({ expect, revision })` with the text read
 * beside it, it spares comparing the text while the field is still there.
 */
const revision = async (core, id, key) => {
  const field = await held(core, 'revision', id, key);
  return field === null ? 0 : revisionOf(field.entry, key);
};

/**
 * The marker at `index` of text field `key` — `{ type, parents, attrs,
 * isEmbed }` — or `null` when the slot there is no block marker and no
 * embed, or the field is not a text.
 */
const block = async (core, id, key, index) => {
  if (!Number.isInteger(index) || index < 0) throw new TypeError('block() takes a non-negative integer index');
  const field = await held(core, 'block', id, key);
  if (field === null || field.seq.k !== 't') return null;
  const idx = S.indexOf(field.entry, key);
  return index < S.lengthOf(idx) ? markerAt(idx, index) : null;
};

/**
 * Text field `key` by block: per block marker, in order, its `index`,
 * `type`, `parents` and `attrs` and the `spans` up to the next marker; text
 * before the first marker is a block of `type` null at index null. `null`
 * when the field is not a text.
 */
const blocks = async (core, id, key) => {
  const field = await held(core, 'blocks', id, key);
  if (field === null || field.seq.k !== 't') return null;
  const out = [];
  let current = null;
  let index = 0;
  for (const span of typedSpans(field, key)) {
    if (span.type === 'block') {
      const { type, parents, attrs } = span.value;
      current = { index, type, parents, attrs, spans: [] };
      out.push(current);
      index++;
      continue;
    }
    if (current === null) {
      current = { index: null, type: null, parents: [], attrs: {}, spans: [] };
      out.push(current);
    }
    current.spans.push(span);
    index += span.type === 'text' ? span.text.length : 1;
  }
  return out;
};

/**
 * Inserts an embed — an inline object, `{ type, attrs }` — at `index` of
 * text field `key`: one slot (U+FFFC) a character wide, its marker
 * `{ type, parents: [], attrs, isEmbed: true }` set with it (a `splice`
 * op carrying `vals`). The field reads the slot as the character; `spans()`
 * reads it as `{ type: 'embed', value, marks }`.
 */
const insertEmbed = async (core, id, key, index, embed, { actor } = {}) => {
  const payload = spliceArgs('insertEmbed', key, index, 0, EMBED, { embeds: true });
  payload.vals = [[0, markerArgs('insertEmbed', embed, true)]];
  await core.commit('splice', id, payload, { actor });
};

/**
 * Starts a block at `index` of text field `key`: a block marker
 * `{ type, parents, attrs }` — a paragraph, a heading, a list item under
 * its `parents` — in one slot (U+FFFC), the text after it up to the next
 * marker its content. A `splice` op carrying the marker in `vals`.
 */
const splitBlock = async (core, id, key, index, block, { actor } = {}) => {
  const payload = spliceArgs('splitBlock', key, index, 0, EMBED, { embeds: true });
  payload.vals = [[0, markerArgs('splitBlock', block, false)]];
  await core.commit('splice', id, payload, { actor });
};

/**
 * Removes the block marker at `index` of text field `key`, joining its
 * content to the block before (a `splice` cutting the slot); rejects with
 * `NOT_FOUND` when the slot there is no marker.
 */
const joinBlock = async (core, id, key, index, { actor } = {}) => {
  if (!Number.isInteger(index) || index < 0) throw new TypeError('joinBlock() takes a non-negative integer index');
  const payload = spliceArgs('joinBlock', key, index, 1);
  payload.marker = true;
  await core.commit('splice', id, payload, { actor });
};

/**
 * Replaces the marker at `index` of text field `key` with `{ type, parents,
 * attrs, isEmbed? }` (an `assign` op: last writer wins); rejects with
 * `NOT_FOUND` when the slot there is no marker.
 */
const updateBlock = async (core, id, key, index, block, { actor } = {}) => {
  fieldName('updateBlock', key);
  if (!Number.isInteger(index) || index < 0) throw new TypeError('updateBlock() takes a non-negative integer index');
  await core.commit('assign', id, { key, index, value: markerArgs('updateBlock', block) }, { actor });
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
  if (field === null) return null;
  const idx = S.indexOf(field.entry, key);
  wholeCharacters(id, key, idx, index);
  return S.cursorAt(idx, index, side);
};

/**
 * The name of the element at `index` of list field `key` — what a path
 * under it is spelled with (`items/<name>/body`); a list element keeps its
 * name across moves. `null` out of range or when the field is not a list.
 */
const elementName = async (core, id, key, index) => {
  if (!Number.isInteger(index) || index < 0) throw new TypeError('elementAt() takes a non-negative integer index');
  const field = await held(core, 'elementAt', id, key);
  if (field === null || field.seq.k !== 'l') return null;
  return S.elemAt(S.indexOf(field.entry, key), index);
};

/** The names of the elements of list field `key`, in order; `[]` when the field is not a list. */
const elements = async (core, id, key) => {
  const field = await held(core, 'elements', id, key);
  return field === null || field.seq.k !== 'l' ? [] : [...S.elems(S.indexOf(field.entry, key))];
};

/** Where `cursor` is now in list or text field `key`; `null` once its place is gone (a reset, a field no longer a sequence). */
const index = async (core, id, key, cursor) => {
  if (typeof cursor !== 'string' || !S.isAnchor(cursor)) throw new TypeError('index() takes a cursor');
  const field = await held(core, 'index', id, key);
  return field === null ? null : S.indexOfCursor(S.indexOf(field.entry, key), cursor);
};

// A cursor token's side: the head keeps after nothing, the end before
// nothing, an anchor the side it names.
const sideOf = (cursor) => (cursor === S.HEAD || cursor.startsWith('>') ? 'after' : 'before');

/**
 * Where `cursor` is now and which side it keeps to: `{ index, side }` — what
 * a selection is restored from after edits around it — or `null` once its
 * place is gone.
 */
const position = async (core, id, key, cursor) => {
  if (typeof cursor !== 'string' || !S.isAnchor(cursor)) throw new TypeError('position() takes a cursor');
  const field = await held(core, 'position', id, key);
  if (field === null) return null;
  const at = S.indexOfCursor(S.indexOf(field.entry, key), cursor);
  return at === null ? null : { index: at, side: sideOf(cursor) };
};

/** `position()` of several cursors at once, in one read of the field: an array, `null` per cursor whose place is gone. */
const positions = async (core, id, key, cursors) => {
  if (!Array.isArray(cursors)) throw new TypeError('positions() takes an array of cursors');
  for (const cursor of cursors) {
    if (typeof cursor !== 'string' || !S.isAnchor(cursor)) throw new TypeError('positions() takes cursors');
  }
  const field = await held(core, 'positions', id, key);
  if (field === null) {
    const none = [];
    for (let i = 0; i < cursors.length; i++) none.push(null);
    return none;
  }
  const idx = S.indexOf(field.entry, key);
  const out = [];
  for (let i = 0; i < cursors.length; i++) {
    const at = S.indexOfCursor(idx, cursors[i]);
    out.push(at === null ? null : { index: at, side: sideOf(cursors[i]) });
  }
  return out;
};

/**
 * Replaces the element at `index` of list field `key` with `value` (an
 * `assign` op): a register per element, last writer wins, and the value
 * follows the element through a concurrent move. On a text, the marker of
 * the embed slot at `index` (`{ type, parents, attrs, isEmbed }`, or null);
 * rejects with `NOT_FOUND` for a slot that is no embed.
 */
const setAt = (core, id, key, index, value, options) => {
  fieldName('setAt', key);
  if (!Number.isInteger(index) || index < 0) throw new TypeError('setAt() takes a non-negative integer index');
  jsonValue('setAt', value);
  return core.write('assign', id, { key, index, value }, { actor: options?.actor });
};

/**
 * Moves the element at `from` of list field `key` to `to` — its index once
 * it is out (a `move` op). Two nodes moving one element concurrently leave
 * it once, at the newer move's place; a move concurrent with a removal of
 * the element brings it back.
 */
const move = (core, id, key, from, to, options) => {
  fieldName('move', key);
  if (!Number.isInteger(from) || from < 0 || !Number.isInteger(to) || to < 0) {
    throw new TypeError('move() takes non-negative integer indices');
  }
  if (from === to) return RESOLVED;
  return core.write('move', id, { key, index: from, to }, { actor: options?.actor });
};

module.exports = {
  editorOf,
  typedSpans,
  splice,
  push,
  updateText,
  mark,
  unmark,
  unmarkById,
  spans,
  revision,
  block,
  blocks,
  insertEmbed,
  splitBlock,
  joinBlock,
  updateBlock,
  cursor,
  elementName,
  elements,
  index,
  position,
  positions,
  setAt,
  move,
};
