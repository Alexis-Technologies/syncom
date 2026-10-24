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
//   { action: 'mark', field, start, end, name, value, expand?, many? }  a text's style over [start, end)
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
// then the other kinds made again whole. A text's marks are not diffed;
// `compact()` lays them again itself, as `mark` patches.
// Pure over plain data; the kinds come from ops.js (`kindsOf`), so this
// module and the undo subpath on it ship without the op model.

const { deepEqual, isPlainObject } = require('./shape.js');
const { diff: myers } = require('./myers.js');
const { isJsonValue, jsonValue, spliceArgs, treeArgs, markArgs, setElements } = require('./args.js');

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
  // An inc of 0 makes a counter that reads 0: the field stays a counter.
  if (kind === 'counter') return [{ action: 'inc', field, value }];
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
const ACTIONS = new Set([
  'put',
  'write',
  'inc',
  'add',
  'remove',
  'splice',
  'mark',
  'treeMove',
  'treeRemove',
  'delete',
  'purge',
]);

// Exactly the tags a remove revokes: `[[element, { origin: addTs }]]`.
const isRemovals = (list) =>
  Array.isArray(list) &&
  list.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      isJsonValue(pair[0]) &&
      isPlainObject(pair[1]) &&
      Object.keys(pair[1]).every((origin) => Number.isSafeInteger(pair[1][origin]) && pair[1][origin] > 0),
  );

/**
 * A patch as the op the write path takes: `[type, payload]`, checked as the
 * method of the same name checks its arguments (src/args.js). A patch of the
 * wrong shape is a TypeError — it is the caller's data.
 */
const realize = (patch) => {
  if (patch === null || typeof patch !== 'object') throw new TypeError('applyPatches(): a patch is an object');
  const { action, field } = patch;
  if (!ACTIONS.has(action)) throw new TypeError(`applyPatches(): unknown action ${action}`);
  const named = action !== 'write' && action !== 'delete' && action !== 'purge';
  if (named && !isField(field)) throw new TypeError(`applyPatches(): ${action} needs a field`);
  const method = 'applyPatches';
  switch (action) {
    case 'put':
      return ['set', { data: { [field]: jsonValue(method, patch.value) } }];
    case 'write':
      if (!isPlainObject(patch.data)) throw new TypeError('applyPatches(): write needs data: a plain object');
      return ['write', { data: patch.data }];
    case 'inc':
      if (!Number.isFinite(patch.value)) throw new TypeError('applyPatches(): inc needs a finite value');
      return ['inc', { key: field, value: patch.value }];
    case 'add':
      return ['add', { key: field, value: setElements(method, field, patch.elements) }];
    case 'remove': {
      if (patch.removals !== undefined) {
        if (!isRemovals(patch.removals)) {
          throw new TypeError('applyPatches(): remove needs removals as [[element, { origin: addTs }]]');
        }
        return ['remove', { key: field, value: [], removals: patch.removals }];
      }
      const payload = { key: field, value: setElements(method, field, patch.elements) };
      if (patch.own === true) payload.own = true;
      return ['remove', payload];
    }
    case 'splice': {
      const { index, count = 0, content } = patch;
      const payload = spliceArgs(method, field, index, count, content);
      // A pure cut carries no content: the field's kind says what it is.
      if (payload.content !== undefined && payload.content.length === 0) delete payload.content;
      return ['splice', payload];
    }
    case 'mark': {
      const { start, end, name, value = null, expand = 'after' } = patch;
      markArgs(method, field, start, end, name, expand);
      const payload = { key: field, start, end, name, value: jsonValue(method, value), expand };
      if (patch.many === true) payload.many = true;
      return ['mark', payload];
    }
    case 'treeMove': {
      const parent = patch.parent ?? null;
      treeArgs(method, field, patch.node, parent, { after: patch.after, before: patch.before });
      const payload = { key: field, node: patch.node, parent };
      if (patch.after !== undefined) payload.after = patch.after;
      if (patch.before !== undefined) payload.before = patch.before;
      return ['tree', payload];
    }
    case 'treeRemove':
      treeArgs(method, field, patch.node, null);
      return ['tree', { key: field, node: patch.node, parent: '$trash' }];
    case 'delete':
      return ['delete', {}];
    case 'purge':
      return ['purge', {}];
  }
};

module.exports = { diffViews, realize };
