'use strict';

// The list and text kinds' patches (src/text/text.js is the plugin): a
// text's embed markers, the diff of two readings as splice patches, a patch
// realized as an op, a field laid again (migrate, compact), and who wrote it.

const S = require('./sequence.js');
const { MAX_RUN } = require('./rle.js');
const { diff: myers } = require('./myers.js');
const { spliceArgs, markArgs, jsonValue, EMBED } = require('../args.js');
const { deepEqual } = require('../shape.js');
const { floorOf } = require('../vector.js');
const { blockOf, markerAt, valsArgs } = require('./kind.js');

// ---------------------------------------------------------------------------
// Patches (src/patch.js diffViews / realize): a text's or a list's edits as
// splices (Myers), laid in runs of at most MAX_RUN elements — one splice is
// one run, and a run holds no more (src/text/rle.js).

const inRuns = (patches) => {
  const out = [];
  for (let p = 0; p < patches.length; p++) {
    const patch = patches[p];
    const { action, count, content, vals } = patch;
    if (action !== 'splice' || count !== 0 || content === undefined || content.length <= MAX_RUN) {
      out.push(patch);
      continue;
    }
    for (let at = 0; at < content.length; at += MAX_RUN) {
      const run = { ...patch, index: patch.index + at, content: content.slice(at, at + MAX_RUN) };
      if (vals !== undefined) {
        // The markers of this run's slots, at its own offsets.
        const part = [];
        for (let i = 0; i < vals.length; i++) {
          const [offset, marker] = vals[i];
          if (offset >= at && offset < at + MAX_RUN) part.push([offset - at, marker]);
        }
        if (part.length > 0) run.vals = part;
        else delete run.vals;
      }
      out.push(run);
    }
  }
  return out;
};

// One side of a diff, for `markerIn`: its block when the side has an entry,
// else a Map of the markers of the `embeds` list a commit event carries, by
// index (the first one listed at an index); null when it has neither.
const markersOf = (side, field) => {
  if (side == null) return null;
  if (side.entry != null) {
    const held = blockOf(side.entry, field);
    return held === undefined || held.k !== 't' ? null : S.indexOf(side.entry, field);
  }
  const list = side.embeds?.[field];
  if (!Array.isArray(list)) return null;
  const byIndex = new Map();
  for (let i = 0; i < list.length; i++) {
    const [at, marker] = list[i];
    if (!byIndex.has(at)) byIndex.set(at, marker);
  }
  return byIndex;
};

// The marker at `index` of one side of a diff (`markersOf`).
const markerIn = (side, index) => {
  if (side === null) return null;
  if (!(side instanceof Map)) return markerAt(side, index);
  return side.has(index) ? side.get(index) : null;
};

// Myers' hunks as splice patches, the markers of the embed slots they
// insert riding on them (`vals`), and after them a `setAt` per slot both
// sides keep whose marker changed — the hunks are in the before string's
// coordinates, last first; the assigns in the after's.
const embedPatches = (field, hunks, a, b, context) => {
  const patches = [];
  for (let i = 0; i < hunks.length; i++) {
    const [index, count, content] = hunks[i];
    patches.push({ action: 'splice', field, index, count, content });
  }
  if (!a.includes(EMBED) && !b.includes(EMBED)) return patches;
  const from = markersOf(context?.from, field);
  const to = markersOf(context?.to, field);
  const assigns = [];
  let ai = 0;
  let bi = 0;
  const kept = (upTo) => {
    for (; ai < upTo; ai++, bi++) {
      if (a[ai] !== EMBED) continue;
      const now = markerIn(to, bi);
      if (!deepEqual(markerIn(from, ai), now)) assigns.push({ action: 'setAt', field, index: bi, value: now });
    }
  };
  // The hunks come last first: walked backwards, in the order of the text.
  for (let h = patches.length - 1; h >= 0; h--) {
    const patch = patches[h];
    kept(patch.index);
    const vals = [];
    for (let offset = 0; offset < patch.content.length; offset++) {
      if (patch.content[offset] === EMBED) vals.push([offset, markerIn(to, bi + offset)]);
    }
    if (vals.length > 0) patch.vals = vals;
    ai += patch.count;
    bi += patch.content.length;
  }
  kept(a.length);
  for (let i = 0; i < assigns.length; i++) patches.push(assigns[i]);
  return patches;
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
  const hunks = myers(a, b);
  const out = [];
  for (let h = 0; h < hunks.length; h++) {
    const [index, count, text] = hunks[h];
    // One private-use unit per element: no surrogate pairs to keep together.
    const content = [];
    for (let i = 0; i < text.length; i++) content.push(items[text.charCodeAt(i) - PRIVATE]);
    out.push({ action: 'splice', field, index, count, content });
  }
  return out;
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
const migrate = (kind, key, value) => {
  if (value.length === 0) return [];
  const runs = inRuns([{ action: 'splice', field: key, index: 0, count: 0, content: value }]);
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    out.push(['splice', { key, index: runs[i].index, count: 0, content: runs[i].content }]);
  }
  return out;
};

// A text's marks laid again over the field `compact()` makes anew: the ones
// in force, in stamp order, as `mark` patches (src/text/sequence.js marksIn).
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

module.exports = {
  diff,
  recreate,
  realize,
  migrate,
  compact,
  editors,
  values,
};
