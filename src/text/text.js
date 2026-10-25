'use strict';

// The `list` and `text` kinds as a plugin (@alexify/syncom/text): the Fugue
// sequence engine (./sequence.js, ./rle.js) behind a record's lists and
// texts — what the core calls to apply a splice, an assign, a move or a
// mark, to normalize and join a peer's block, to read the field, to resolve
// a local call's indices into anchors inside the queue, to diff two readings
// into patches and realize them — and the storage methods the plugin adds
// (splice, push, updateText, mark, unmark, unmarkById, spans, cursor, index,
// setAt, move, insertEmbed, splitBlock, joinBlock, updateBlock, block,
// blocks). Registered per instance with `open({ plugins: [text] })`;
// src/plugin.js names the contract.
//
// A text's embeds and blocks (Automerge's model): a slot holding U+FFFC,
// the object replacement character, whose value — a MARKER `{ type,
// parents, attrs, isEmbed }` — is a register of the block (`vals`, as a
// list element's). `isEmbed: false` is a block marker: a paragraph or a
// heading boundary, the text after it up to the next marker its content,
// `parents` the nesting (a list item's `['ordered-list']`). `isEmbed: true`
// is an inline object — an image, a mention — a character wide. The field
// still reads as the plain string, slots and all; `spans()` tells them
// apart, `blocks()` reads the document by block. An editor's whole document
// is one text, one Fugue tree: cursors, marks and presence count the slots
// like any character.
//
// A block is its own index (the rope of ./sequence.js): a reading, a
// position or a place to insert is answered from it in O(log n), and an op
// hands back a new block that shares what it did not touch.

const S = require('./sequence.js');
const { MAX_RUN } = require('./rle.js');
const { diff: myers } = require('./myers.js');
const { spliceArgs, markArgs, jsonValue, isJsonValue, EMBED } = require('../args.js');
const { isRecordId, invalidId, isPlainObject, asJson, deepEqual } = require('../shape.js');
const { floorOf } = require('../vector.js');
const { SyncomError } = require('../errors.js');

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

const KINDS = Object.freeze({ list: 3, text: 4 });
const CODES = Object.freeze({ l: 'list', t: 'text' });
const TAKES = Object.freeze({ splice: ['list', 'text'], assign: ['list', 'text'], move: ['list'], mark: ['text'] });
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
  if (op.type === 'mark') return 'text';
  // An assign names its kind: `k: 't'` for a text's embed slot, a list's
  // element otherwise — read from the op alone, so the precedence commutes.
  if (op.type === 'assign') return op.value.k === 't' ? 'text' : 'list';
  return 'list';
};

const normalize = (raw, base, limits) => S.normalizeSeq(raw, base, limits.pendingMax);

// A `splice` lands on the block (src/sequence.js), an `assign`, a `move` or
// a `mark` on its registers; a register or a mark for a field with no block
// yet names its kind and waits, like a cut that comes before its run. The
// block is pruned at once: what fell below the base must look the same as
// if it had never landed, whichever side of the reset it arrived on.
const apply = (entry, field, held, op, stamp, limits) => {
  const base = floorOf(entry.meta, field);
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
  out.block = S.prune(result.seq, base);
  // What the reading shows of the op, in its indices — none when the field went.
  if (out.block !== null) out.change = changeOf(op, stamp, held, out.block);
  return out;
};

// An op as the reading shows it, in the write API's terms and the reading's
// indices (src/patch.js's vocabulary, a `move` and an `unmarkById` beside):
// a splice's cuts in the indices before it, last first, and its insert in
// the indices after, both read from the rope in O(log n); an assign as a
// `setAt`; a move by its index before and after; a mark over the indices
// its anchors fall at. What the reading does not show — a slot born dead,
// an element not placed here — is no change.
const changeOf = (op, stamp, held, block) => {
  const payload = op.value;
  const [ts, origin] = stamp;
  if (op.type === 'splice') {
    const out = [];
    if (held !== undefined && Array.isArray(payload.cut)) {
      const cuts = [];
      for (const [run, off, len] of payload.cut) {
        const span = S.spanOf(held, run, off, len);
        if (span !== null && span.count > 0) cuts.push(span);
      }
      cuts.sort((x, y) => y.index - x.index);
      for (const { index, count } of cuts) out.push({ action: 'splice', index, count });
    }
    const { content } = payload;
    if (content !== undefined && content.length > 0) {
      const run = payload.at !== undefined ? S.runKey(ts, origin) : payload.run;
      const span = S.spanOf(block, run, payload.at !== undefined ? 0 : payload.from, content.length);
      if (span !== null && span.count > 0) {
        const shown = S.render(block).slice(span.index, span.index + span.count);
        const last = out[out.length - 1];
        // One cut at the insertion point and the insert: one splice, as the call made it.
        if (out.length === 1 && last.index === span.index) last.content = shown;
        else out.push({ action: 'splice', index: span.index, count: 0, content: shown });
        if (payload.vals !== undefined && span.count === content.length) out[out.length - 1].vals = payload.vals;
      }
    }
    return out;
  }
  if (op.type === 'assign') {
    const { elem, value } = payload;
    let index = -1;
    if (block.k === 't') {
      const parsed = S.parseElem(elem);
      const span = parsed === null ? null : S.spanOf(block, parsed.run, parsed.offset, 1);
      if (span !== null && span.count === 1) index = span.index;
    } else index = S.elems(block).indexOf(elem);
    return index < 0 ? [] : [{ action: 'setAt', index, value }];
  }
  if (op.type === 'move') {
    const from = held === undefined ? -1 : S.elems(held).indexOf(payload.elem);
    const to = S.elems(block).indexOf(payload.elem);
    if (from === to) return [];
    if (from < 0) return [{ action: 'splice', index: to, count: 0, content: [S.render(block)[to]] }];
    if (to < 0) return [{ action: 'splice', index: from, count: 1 }];
    return [{ action: 'move', from, to }];
  }
  // A mark: over the indices its anchors fall at; switched off by id, with
  // the range it covered when the mark is here.
  if (payload.off !== undefined) {
    const mark = block.marks?.[payload.off];
    if (mark === undefined || S.isPlaceholder(mark)) return [];
    const start = S.indexOfCursor(block, mark[0]);
    const end = S.indexOfCursor(block, mark[1]);
    if (start === null || end === null) return [];
    return [{ action: 'unmarkById', markId: payload.off, start, end, name: mark[2] }];
  }
  const start = S.indexOfCursor(block, payload.start);
  const end = S.indexOfCursor(block, payload.end);
  if (start === null || end === null || start >= end) return [];
  const change = { action: 'mark', start, end, name: payload.key, value: payload.value, markId: S.runKey(ts, origin) };
  if (payload.many === true) change.many = true;
  return [change];
};

const render = (entry, field) => S.render(S.indexOf(entry, field));

// A list's elements may hold fields of their own — `items/<element>/body` —
// composed over the element's value for a reader (src/compose.js); a text's
// characters may not. `members` are the element names in order, `holds`
// whether one shows, `pick` the composed element the name reads as, `nest`
// the list read with each element's children laid over its value (a plain
// object spread, anything else giving way).
const NESTS = Object.freeze({ list: true, text: false });
const members = (entry, field) => {
  const block = blockOf(entry, field);
  return block === undefined || block.k !== 'l' ? [] : S.elems(S.indexOf(entry, field));
};
const holds = (entry, field, member) => {
  const block = blockOf(entry, field);
  return block !== undefined && block.k === 'l' && S.hasElem(S.indexOf(entry, field), member);
};
const pick = (entry, field, rendered, member) => {
  const index = members(entry, field).indexOf(member);
  return index === -1 || !Array.isArray(rendered) ? undefined : rendered[index];
};
const isPlain = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const nest = (entry, field, rendered, childrenOf) => {
  const keys = members(entry, field);
  return rendered.map((value, i) => {
    const children = childrenOf(keys[i]);
    if (children === undefined) return value;
    return isPlain(value) ? { ...value, ...children } : { ...children };
  });
};
const prune = (block, base) => S.prune(block, base);
const join = (a, b) => S.join(a, b);

// A splice names an index and a count; what travels is the anchor of the
// new run (or the run of this origin to extend) and the ranges to cut, read
// here, inside the queue — read outside it, a concurrent apply would shift
// the indices. The content names the kind — a string for a text, an array
// for a list — and a call that only cuts takes the field's.
// An index into a text between the two halves of a surrogate pair — a
// character outside the BMP — names no place a reader could show: refused
// here, inside the queue, against the text as it is.
const isHigh = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit) => unit >= 0xdc00 && unit <= 0xdfff;
const wholeCharacter = (id, key, text, index) => {
  if (index <= 0 || index >= text.length) return;
  if (!isHigh(text.charCodeAt(index - 1)) || !isLow(text.charCodeAt(index))) return;
  const message = `Index ${index} of field ${key} of record ${id} falls inside a surrogate pair`;
  throw new SyncomError('SURROGATE', message, { id, field: key, index });
};
const wholeCharacters = (id, key, idx, ...indexes) => {
  if (idx === null || idx.k !== 't') return;
  const text = S.render(idx);
  for (const index of indexes) wholeCharacter(id, key, text, index);
};

const resolveSplice = (core, id, payload, current) => {
  const { key, index, count, content, vals, marker } = payload;
  const held = current ? blockOf(current, key) : undefined;
  const fill = content ?? (held?.k === 'l' ? [] : '');
  const idx = held === undefined ? null : S.indexOf(current, key);
  const length = idx === null ? 0 : S.lengthOf(idx);
  const at = index === null ? length : index;
  if (at > length || at + count > length) {
    const span = count > 0 ? `${at}..${at + count}` : String(at);
    const message = `Index ${span} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: at, count, length });
  }
  wholeCharacters(id, key, idx, at, at + count);
  // joinBlock(): the one slot it cuts holds a block marker, or there is none to join.
  if (marker === true && !(held?.k === 't' && S.heldAt(idx, at) === EMBED)) throw noMarker(id, key, at);
  const value = { content: fill };
  if (count > 0) value.cut = S.rangesOf(idx, at, count);
  if (fill.length > 0) {
    Object.assign(value, idx === null ? { at: S.HEAD } : S.placeInsert(idx, at, core.nodeId, fill.length));
  }
  // The markers of the embed slots the content holds, each at its offset.
  if (vals !== undefined && vals.length > 0) value.vals = vals;
  return value;
};

// A text's slot that is no block marker and no embed: nothing to set or join there.
const noMarker = (id, field, index) => {
  const message = `Index ${index} of text field ${field} of record ${id} holds no block marker or embed`;
  return new SyncomError('NOT_FOUND', message, { id, field, index });
};

// A list's element, by its index: the name it keeps across moves. A field
// with no block has no elements (OUT_OF_RANGE); another kind under the field
// was refused before this is read (kindClash).
const elementAt = (core, id, key, index, current) => {
  const held = current ? blockOf(current, key) : undefined;
  const idx = held === undefined ? null : S.indexOf(current, key);
  const length = idx === null ? 0 : S.lengthOf(idx);
  if (index >= length) {
    const message = `Index ${index} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index, count: 0, length });
  }
  return { idx, elem: S.elemAt(idx, index) };
};

const resolveAssign = (core, id, payload, current) => {
  const { key, index, value } = payload;
  const held = current ? blockOf(current, key) : undefined;
  const { idx, elem } = elementAt(core, id, key, index, current);
  if (held?.k !== 't') return { elem, value };
  // A text: the slot is an embed slot, and what it takes is a marker (or none); the op names the kind.
  if (S.heldAt(idx, index) !== EMBED) throw noMarker(id, key, index);
  return { elem, value: value === null ? null : markerArgs('setAt', value), k: 't' };
};

// A move names two indices; what travels is the element, the slot it showed
// at and the anchor of its new position (`to` counts once it is out).
const resolveMove = (core, id, payload, current) => {
  const { key, index: from, to } = payload;
  const { idx, elem } = elementAt(core, id, key, from, current);
  const length = S.lengthOf(idx);
  if (to >= length) {
    const message = `Index ${to} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: to, count: 0, length });
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
  const length = idx === null ? 0 : S.lengthOf(idx);
  if (start > end || end > length) {
    const message = `Range ${start}..${end} is out of range for field ${key} of record ${id} (length ${length})`;
    throw new SyncomError('OUT_OF_RANGE', message, { id, field: key, index: start, count: end - start, length });
  }
  wholeCharacters(id, key, idx, start, end);
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
    const { action, count, content, vals } = patch;
    if (action !== 'splice' || count !== 0 || content === undefined || content.length <= MAX_RUN) return [patch];
    const runs = [];
    for (let at = 0; at < content.length; at += MAX_RUN) {
      const run = { ...patch, index: patch.index + at, content: content.slice(at, at + MAX_RUN) };
      if (vals !== undefined) {
        const part = vals.filter(([offset]) => offset >= at && offset < at + MAX_RUN);
        if (part.length > 0) run.vals = part.map(([offset, marker]) => [offset - at, marker]);
        else delete run.vals;
      }
      runs.push(run);
    }
    return runs;
  });

// ---------------------------------------------------------------------------
// Markers: what a text's embed slot holds, as the API spells it.

/** The marker a value is, if any — normalized: parents the strings, attrs the object, `isEmbed` the flag. */
const markerOf = (value) => {
  if (!isPlainObject(value) || typeof value.type !== 'string') return null;
  const { type, parents, attrs, isEmbed } = value;
  return {
    type,
    parents: Array.isArray(parents) ? parents.filter((parent) => typeof parent === 'string') : [],
    attrs: isPlainObject(attrs) ? asJson(attrs) : {},
    isEmbed: isEmbed === true,
  };
};

// A marker as a call gives it: a type, parents (block types, outermost
// first), attrs (a JSON object); `embed` forces the flag, else the value's.
const markerArgs = (method, given, embed) => {
  if (!isPlainObject(given) || typeof given.type !== 'string' || given.type.length === 0) {
    throw new TypeError(`${method}() takes a block marker: { type, parents?, attrs?, isEmbed? } with a type`);
  }
  const { type, parents = [], attrs = {}, isEmbed = false } = given;
  if (!Array.isArray(parents) || parents.some((parent) => typeof parent !== 'string')) {
    throw new TypeError(`${method}() takes parents as a list of block types`);
  }
  if (!isPlainObject(attrs) || !isJsonValue(attrs)) throw new TypeError(`${method}() takes attrs as a JSON object`);
  if (typeof isEmbed !== 'boolean') throw new TypeError(`${method}() takes isEmbed as a boolean`);
  return { type, parents: [...parents], attrs, isEmbed: embed ?? isEmbed };
};

// The markers riding on a splice patch: `[[offset, marker | null]]`, each
// offset an embed slot of the content.
const valsArgs = (method, vals, content) => {
  if (!Array.isArray(vals)) throw new TypeError(`${method}() takes vals as [[offset, marker]]`);
  for (const pair of vals) {
    const [offset, marker] = Array.isArray(pair) && pair.length === 2 ? pair : [];
    if (!Number.isInteger(offset) || offset < 0 || offset >= content.length || content[offset] !== EMBED) {
      throw new TypeError(`${method}() takes vals at the embed slots (U+FFFC) of the content`);
    }
    if (marker !== null && !isJsonValue(marker)) throw new TypeError(`${method}() takes a JSON value per embed`);
  }
  return vals;
};

// The marker at visible index `i` of a text's block — null for a slot that
// is no embed slot, or holds none the API can read.
const markerAt = (idx, i) => (S.heldAt(idx, i) === EMBED ? markerOf(S.valueAt(idx, i)) : null);

// The marker at `index` of one side of a diff: from the entry when the side
// has one, from the `embeds` lists a commit event carries otherwise.
const markerIn = (side, field, index) => {
  if (side == null) return null;
  if (side.entry != null) {
    const held = blockOf(side.entry, field);
    return held === undefined || held.k !== 't' ? null : markerAt(S.indexOf(side.entry, field), index);
  }
  const list = side.embeds?.[field];
  if (Array.isArray(list)) for (const [at, marker] of list) if (at === index) return marker;
  return null;
};

// Myers' hunks as splice patches, the markers of the embed slots they
// insert riding on them (`vals`), and after them a `setAt` per slot both
// sides keep whose marker changed — the hunks are in the before string's
// coordinates, last first; the assigns in the after's.
const embedPatches = (field, hunks, a, b, context) => {
  const patches = hunks.map(([index, count, content]) => ({ action: 'splice', field, index, count, content }));
  if (!a.includes(EMBED) && !b.includes(EMBED)) return patches;
  const { from, to } = context ?? {};
  const assigns = [];
  let ai = 0;
  let bi = 0;
  const kept = (upTo) => {
    for (; ai < upTo; ai++, bi++) {
      if (a[ai] !== EMBED) continue;
      const now = markerIn(to, field, bi);
      if (!deepEqual(markerIn(from, field, ai), now)) assigns.push({ action: 'setAt', field, index: bi, value: now });
    }
  };
  for (const patch of patches.slice().sort((x, y) => x.index - y.index)) {
    kept(patch.index);
    const vals = [];
    for (let offset = 0; offset < patch.content.length; offset++) {
      if (patch.content[offset] === EMBED) vals.push([offset, markerIn(to, field, bi + offset)]);
    }
    if (vals.length > 0) patch.vals = vals;
    ai += patch.count;
    bi += patch.content.length;
  }
  kept(a.length);
  return [...patches, ...assigns];
};

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

const spliceText = (field, from, to, context) => embedPatches(field, myers(from, to), from, to, context);

const diff = (field, kind, from, to, context) =>
  inRuns(kind === 'text' ? spliceText(field, from ?? '', to ?? '', context) : spliceList(field, from ?? [], to ?? []));

const recreate = (field, kind, value, context) => {
  if (value.length === 0) return [];
  const whole = [[0, 0, value]];
  if (kind === 'text') return inRuns(embedPatches(field, whole, '', value, context));
  return inRuns([{ action: 'splice', field, index: 0, count: 0, content: value }]);
};

const realize = (action, patch, method) => {
  const { field } = patch;
  if (action === 'splice') {
    const { index, count = 0, content, vals } = patch;
    const payload = spliceArgs(method, field, index, count, content, { embeds: vals !== undefined });
    if (vals !== undefined) payload.vals = valsArgs(method, vals, content);
    // A pure cut carries no content: the field's kind says what it is.
    if (payload.content !== undefined && payload.content.length === 0) delete payload.content;
    return ['splice', payload];
  }
  if (action === 'setAt') {
    const { index, value } = patch;
    if (typeof field !== 'string') throw new TypeError(`${method}() takes a field name`);
    if (!Number.isInteger(index) || index < 0) throw new TypeError(`${method}() takes a non-negative integer index`);
    return ['assign', { key: field, index, value: jsonValue(method, value) }];
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
  for (const m of S.marksIn(S.indexOf(entry, field), block, floorOf(entry.meta, field))) {
    const patch = { action: 'mark', field, start: m.start, end: m.end, name: m.key, value: m.value };
    patch.expand = m.expand;
    if (m.many) patch.many = true;
    patches.push(patch);
  }
  return patches;
};

// Who wrote the field: every run's, mark's and register's origin (the
// stamps the block keeps), the newest among them as `last`.
const editors = (entry, field) => {
  const block = blockOf(entry, field);
  const all = new Set();
  let last = null;
  const seen = (ts, origin) => {
    all.add(origin);
    if (last === null || ts > last.ts) last = { origin, ts };
  };
  if (block === undefined) return { last, all: [] };
  for (const key of Object.keys(block.runs)) {
    const run = S.parseRun(key);
    if (run !== null) seen(run.ts, run.origin);
  }
  for (const key of Object.keys(block.marks ?? {})) {
    const mark = S.parseRun(key);
    if (mark !== null) seen(mark.ts, mark.origin);
  }
  for (const map of [block.vals, block.pos]) {
    for (const key of Object.keys(map ?? {})) seen(map[key][0], map[key][1]);
  }
  return { last, all: [...all] };
};

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

// What a text holds beside its reading — the markers of its embed slots, by
// index — for the commit event (src/commit.js), so an undo can lay a cut
// marker again; null for a list and for a text without a slot.
const values = (entry, field) => {
  const held = blockOf(entry, field);
  const text = entry.data[field];
  if (held === undefined || held.k !== 't' || typeof text !== 'string' || !text.includes(EMBED)) return null;
  const idx = S.indexOf(entry, field);
  const out = [];
  for (let i = 0; i < text.length; i++) if (text[i] === EMBED) out.push([i, markerAt(idx, i)]);
  return out;
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
  if (typeof key !== 'string') throw new TypeError('updateBlock() takes a field name');
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
  if (field === null) return cursors.map(() => null);
  const idx = S.indexOf(field.entry, key);
  return cursors.map((cursor) => {
    const at = S.indexOfCursor(idx, cursor);
    return at === null ? null : { index: at, side: sideOf(cursor) };
  });
};

// ---------------------------------------------------------------------------
// Deltas (Quill's form): `[{ retain, attributes? }, { insert, attributes? },
// { delete }]` — what an editor binding exchanges. `toDelta` composes a
// text's changes into one; `applyDelta` makes a delta the field's edits, as
// one transaction. An embed slot travels as `{ insert: { embed: marker } }`,
// a marker changed as `{ retain: 1, attributes: { embed: marker } }`.

const lengthOfOp = (op) => op.delete ?? op.retain ?? (typeof op.insert === 'string' ? op.insert.length : 1);

// A cursor over a delta's ops: `peek()` the length left in the current op,
// `next(n)` the next `n` of it as an op of its own.
const walker = (ops) => {
  let i = 0;
  let used = 0;
  return {
    done: () => i >= ops.length,
    peekType: () => (ops[i].delete !== undefined ? 'delete' : ops[i].insert !== undefined ? 'insert' : 'retain'),
    peek: () => lengthOfOp(ops[i]) - used,
    next(n = Infinity) {
      const op = ops[i];
      const left = lengthOfOp(op) - used;
      const take = Math.min(n, left);
      let out;
      if (op.delete !== undefined) out = { delete: take };
      else if (typeof op.insert === 'string') out = { insert: op.insert.slice(used, used + take) };
      else if (op.insert !== undefined) out = { insert: op.insert };
      else out = { retain: take };
      if (op.attributes !== undefined && out.delete === undefined) out.attributes = op.attributes;
      used += take;
      if (used >= lengthOfOp(op)) {
        i++;
        used = 0;
      }
      return out;
    },
  };
};

const sameAttributes = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Pushes an op, joining it to the last of its kind with the same attributes.
const pushOp = (ops, op) => {
  const last = ops[ops.length - 1];
  if (last !== undefined) {
    if (op.delete !== undefined && last.delete !== undefined) return void (last.delete += op.delete);
    if (op.retain !== undefined && last.retain !== undefined && sameAttributes(op.attributes, last.attributes)) {
      return void (last.retain += op.retain);
    }
    if (
      typeof op.insert === 'string' &&
      typeof last.insert === 'string' &&
      sameAttributes(op.attributes, last.attributes)
    ) {
      return void (last.insert += op.insert);
    }
  }
  ops.push({ ...op });
};

// The attributes of a retain composed over an insert's or a retain's: the
// later ones win, a null one removes.
const composeAttributes = (a, b, keepNull) => {
  const out = { ...(a ?? {}), ...(b ?? {}) };
  if (!keepNull) for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  return Object.keys(out).length > 0 ? out : undefined;
};

/** `a` then `b` as one delta: Quill's compose, over retain, insert and delete. */
const compose = (a, b) => {
  const left = walker(a);
  const right = walker(b);
  const out = [];
  while (!left.done() || !right.done()) {
    if (!right.done() && right.peekType() === 'insert') {
      pushOp(out, right.next());
    } else if (!left.done() && left.peekType() === 'delete') {
      pushOp(out, left.next());
    } else if (left.done()) {
      pushOp(out, right.next());
    } else if (right.done()) {
      pushOp(out, left.next());
    } else {
      const n = Math.min(left.peek(), right.peek());
      const x = left.next(n);
      const y = right.next(n);
      if (y.retain !== undefined) {
        const op = x.insert !== undefined ? { insert: x.insert } : { retain: n };
        const attributes = composeAttributes(x.attributes, y.attributes, x.retain !== undefined);
        if (attributes !== undefined) op.attributes = attributes;
        pushOp(out, op);
      } else if (y.delete !== undefined && x.retain !== undefined) pushOp(out, y);
      // y deletes what x inserted: nothing of either stays.
    }
  }
  // A trailing plain retain says nothing.
  const last = out[out.length - 1];
  if (last !== undefined && last.retain !== undefined && last.attributes === undefined) out.pop();
  return out;
};

// The content of an insert as delta ops: the text, its embed slots as
// `{ insert: { embed: marker } }`.
const insertsOf = (content, vals) => {
  const out = [];
  const markers = new Map(vals ?? []);
  let from = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== EMBED) continue;
    if (i > from) out.push({ insert: content.slice(from, i) });
    out.push({ insert: { embed: markers.get(i) ?? null } });
    from = i + 1;
  }
  if (from < content.length) out.push({ insert: content.slice(from) });
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
    if (change.content !== undefined && change.content.length > 0) out.push(...insertsOf(change.content, change.vals));
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
    if (field !== undefined && change.field !== field) continue;
    const { action } = change;
    if (action === 'delete' || action === 'purge') return null;
    if (change.field === undefined) continue;
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
 * it with its attributes, a `delete` cuts. Resolves to how many ops it took.
 */
const applyDelta = async (core, id, key, delta, { actor, message } = {}) => {
  if (typeof key !== 'string') throw new TypeError('applyDelta() takes a field name');
  if (!Array.isArray(delta) || !delta.every(isDeltaOp)) {
    throw new TypeError('applyDelta() takes a delta: [{ retain, attributes? } | { insert, attributes? } | { delete }]');
  }
  if (!isRecordId(id)) throw invalidId(id);
  const { result, done } = await core.transact(
    async (tx) => {
      let at = 0;
      let ops = 0;
      const marks = async (start, end, attributes) => {
        for (const name of Object.keys(attributes)) {
          const value = attributes[name];
          if (name === 'embed') {
            if (end - start !== 1) throw new TypeError('applyDelta() sets an embed marker over one slot');
            const marker = value === null ? null : markerArgs('applyDelta', value, value.isEmbed ?? true);
            ops += (await tx.commit('assign', id, { key, index: start, value: marker }, { actor })) ? 1 : 0;
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
          if (op.attributes !== undefined) await marks(at, at + op.insert.length, op.attributes);
          at += op.insert.length;
        } else {
          const { embed } = op.insert;
          const marker = embed === null ? null : markerArgs('applyDelta', embed, embed.isEmbed ?? true);
          const payload = spliceArgs('applyDelta', key, at, 0, EMBED, { embeds: true });
          payload.vals = [[0, marker]];
          ops += (await tx.commit('splice', id, payload, { actor })) ? 1 : 0;
          if (op.attributes !== undefined) await marks(at, at + 1, op.attributes);
          at += 1;
        }
      }
      return ops;
    },
    { actor, message },
  );
  if (done !== null) await done;
  return result;
};

/**
 * Replaces the element at `index` of list field `key` with `value` (an
 * `assign` op): a register per element, last writer wins, and the value
 * follows the element through a concurrent move. On a text, the marker of
 * the embed slot at `index` (`{ type, parents, attrs, isEmbed }`, or null);
 * rejects with `NOT_FOUND` for a slot that is no embed.
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
  actions: Object.freeze(['splice', 'mark', 'setAt']),
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
  values,
  editors,
  nests: NESTS,
  members,
  holds,
  pick,
  nest,
  methods: Object.freeze({
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
    elementAt: elementName,
    elements,
    insertEmbed,
    splitBlock,
    joinBlock,
    updateBlock,
    block,
    blocks,
    position,
    positions,
    toDelta,
    applyDelta,
    editorOf,
  }),
});

module.exports = { text };
