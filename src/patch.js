'use strict';

// Patches: the one vocabulary for what turns one state of a record into
// another — what `diff()` hands out, what `restore()` and an undo manager
// hand back, what `applyPatches()` realizes as ops of this node's own. A
// patch is plain JSON, in the terms of the write API, never of the op model:
//
//   { action: 'put', field, value }                 a register's new value (a `set` op)
//   { action: 'write', data }                       the registers as a whole — a reset; the other kinds follow it
//   { action: 'inc', field, value }                 a counter moved by `value`
//   { action: 'add', field, elements }              set elements added
//   { action: 'remove', field, elements }           set elements removed, as this node observed them
//   { action: 'remove', field, elements, own: true } …only this node's adds of them (an undo: a peer's stay)
//   { action: 'remove', field, removals }           …or exactly these tags: `[[element, { origin: addTs }]]`
//   { action: 'splice', field, index, count, content }   a list's or a text's edit
//   { action: 'treeMove', field, node, parent, after? }  a tree node placed
//   { action: 'treeRemove', field, node }
//   { action: 'delete' }, { action: 'purge' }
//
// `diffViews(from, fromKinds, to, toKinds)` is the list that turns the
// record `from` (its data, and what kind each field is) into `to`: per
// field by kind — a register's new value, a counter's delta, a set's added
// and removed elements, a text's or a list's splices (Myers), a tree's
// moves and removals — and a reset when a register is gone or a field
// changed kind, since no op removes one field: a `write` of the registers,
// then the other kinds made again whole. A text's marks are not diffed.
// Pure over plain data; the kinds come from ops.js (`kindsOf`), so this
// module and the undo subpath on it ship without the op model.

const { deepEqual } = require('./shape.js');
const { diff: myers } = require('./myers.js');

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

// A tree's nodes in reading order with their parent and the sibling before.
const walk = (nodes, into = new Map(), parent = null) => {
  let prev = null;
  for (const { id, children } of nodes) {
    into.set(id, { parent, prev });
    walk(children, into, id);
    prev = id;
  }
  return into;
};

// Moves that make `from` read as `to`: every child of a parent whose
// children changed, in order — the first to the end, each next after the
// one before, so the emitted order is the final one — then the nodes gone.
const treePatches = (field, from, to) => {
  const before = walk(from);
  const after = walk(to);
  const patches = [];
  const changed = new Set();
  for (const [node, place] of after) {
    const was = before.get(node);
    if (was === undefined || was.parent !== place.parent || was.prev !== place.prev) changed.add(place.parent);
  }
  for (const [node, { parent, prev }] of after) {
    if (!changed.has(parent)) continue;
    const patch = { action: 'treeMove', field, node, parent };
    if (prev !== null) patch.after = prev;
    patches.push(patch);
  }
  for (const node of before.keys()) if (!after.has(node)) patches.push({ action: 'treeRemove', field, node });
  return patches;
};

const asKeys = (elements) => new Map(elements.map((element) => [JSON.stringify(element), element]));

// A field's content made again from nothing, by kind.
const recreate = (field, kind, value) => {
  if (kind === 'counter') return value === 0 ? [] : [{ action: 'inc', field, value }];
  if (kind === 'set') return value.length === 0 ? [] : [{ action: 'add', field, elements: value }];
  if (kind === 'text' || kind === 'list') {
    return value.length === 0 ? [] : [{ action: 'splice', field, index: 0, count: 0, content: value }];
  }
  if (kind === 'tree') return treePatches(field, [], value);
  return [];
};

/**
 * The patches that turn the record `from` — its data (`null` when it was
 * not there) and the kind of each of its fields — into `to`. `purged` says
 * `to` is a purged record. `exact` (the default) makes `to` read exactly:
 * a field `to` lacks is gone through a reset; without it a counter, a set,
 * a list, a text or a tree `to` lacks is emptied instead — what an undo
 * wants, since a reset would take a peer's concurrent change with it.
 */
const diffViews = (from, fromKinds, to, toKinds, { purged = false, exact = true } = {}) => {
  if (to === null) {
    if (purged) return [{ action: 'purge' }];
    return from === null ? [] : [{ action: 'delete' }];
  }
  const registers = {};
  for (const field of Object.keys(to)) if (toKinds[field] === 'register') registers[field] = to[field];
  // A reset: a register gone, or a field that is another kind now. No op
  // removes one field, so the registers are written whole and the rest made
  // again from nothing.
  let reset = from === null;
  if (!reset) {
    for (const field of Object.keys(fromKinds)) {
      const was = fromKinds[field];
      const now = toKinds[field];
      if (now === undefined ? exact || was === 'register' : was !== now) reset = true;
    }
  }
  const patches = [];
  if (reset) {
    patches.push({ action: 'write', data: registers });
    for (const field of Object.keys(toKinds)) {
      if (toKinds[field] !== 'register') patches.push(...recreate(field, toKinds[field], to[field]));
    }
    return patches;
  }
  for (const field of new Set([...Object.keys(toKinds), ...Object.keys(fromKinds)])) {
    const kind = toKinds[field] ?? fromKinds[field];
    const value = to[field];
    const previous = from[field];
    if (kind === 'register') {
      if (!deepEqual(previous, value)) patches.push({ action: 'put', field, value });
    } else if (kind === 'counter') {
      const delta = (value ?? 0) - (previous ?? 0);
      if (delta !== 0) patches.push({ action: 'inc', field, value: delta });
    } else if (kind === 'set') {
      const before = asKeys(previous ?? []);
      const after = asKeys(value ?? []);
      const added = [...after].filter(([key]) => !before.has(key)).map(([, element]) => element);
      const removed = [...before].filter(([key]) => !after.has(key)).map(([, element]) => element);
      if (added.length > 0) patches.push({ action: 'add', field, elements: added });
      if (removed.length > 0) patches.push({ action: 'remove', field, elements: removed });
    } else if (kind === 'text') {
      patches.push(...spliceText(field, previous ?? '', value ?? ''));
    } else if (kind === 'list') {
      patches.push(...spliceList(field, previous ?? [], value ?? []));
    } else if (kind === 'tree') {
      patches.push(...treePatches(field, previous ?? [], value ?? []));
    }
  }
  return patches;
};

const isField = (value) => typeof value === 'string' && value.length > 0;
const isIndex = (value) => Number.isInteger(value) && value >= 0;

/**
 * A patch as the op the write path takes: `[type, payload]`. A patch of the
 * wrong shape is a TypeError — it is the caller's data.
 */
const realize = (patch) => {
  if (patch === null || typeof patch !== 'object') throw new TypeError('applyPatches(): a patch is an object');
  const { action, field } = patch;
  const named = action !== 'write' && action !== 'delete' && action !== 'purge';
  if (named && !isField(field)) throw new TypeError(`applyPatches(): ${action} needs a field`);
  switch (action) {
    case 'put':
      if (patch.value === undefined) throw new TypeError('applyPatches(): put needs a value');
      return ['set', { data: { [field]: patch.value } }];
    case 'write':
      if (patch.data === null || typeof patch.data !== 'object') {
        throw new TypeError('applyPatches(): write needs data');
      }
      return ['write', { data: patch.data }];
    case 'inc':
      if (!Number.isFinite(patch.value)) throw new TypeError('applyPatches(): inc needs a finite value');
      return ['inc', { key: field, value: patch.value }];
    case 'add':
      if (!Array.isArray(patch.elements)) throw new TypeError('applyPatches(): add needs elements');
      return ['add', { key: field, value: patch.elements }];
    case 'remove': {
      if (Array.isArray(patch.removals)) return ['remove', { key: field, value: [], removals: patch.removals }];
      if (!Array.isArray(patch.elements)) throw new TypeError('applyPatches(): remove needs elements or removals');
      const payload = { key: field, value: patch.elements };
      if (patch.own === true) payload.own = true;
      return ['remove', payload];
    }
    case 'splice': {
      const { index, count = 0, content } = patch;
      if (!isIndex(index) || !isIndex(count)) throw new TypeError('applyPatches(): splice needs an index and a count');
      const payload = { key: field, index, count };
      if (content !== undefined && content.length > 0) payload.content = content;
      return ['splice', payload];
    }
    case 'treeMove': {
      const payload = { key: field, node: patch.node, parent: patch.parent ?? null };
      if (patch.after !== undefined) payload.after = patch.after;
      if (patch.before !== undefined) payload.before = patch.before;
      return ['tree', payload];
    }
    case 'treeRemove':
      return ['tree', { key: field, node: patch.node, parent: '$trash' }];
    case 'delete':
      return ['delete', {}];
    case 'purge':
      return ['purge', {}];
    default:
      throw new TypeError(`applyPatches(): unknown action ${action}`);
  }
};

module.exports = { diffViews, realize };
