'use strict';

// Patches: the one vocabulary for what turns one state of a record into
// another — what `diff()` hands out, what `restore()` and an undo manager
// hand back, what `applyPatches()` realizes as ops of this node's own. A
// patch is plain JSON, in the terms of the write API, never of the op model:
//
//   { action: 'put', field, value }                 a register's new value (a `set` op)
//   { action: 'unset', field }                      a field removed, of any kind (an `unset` op)
//   { action: 'write', data }                       the registers as a whole — a reset; the other kinds follow it
//   { action: 'inc', field, value }                 a counter moved by `value`
//   { action: 'add', field, elements }              set elements added
//   { action: 'remove', field, elements }           set elements removed, as this node observed them
//   { action: 'remove', field, elements, own: true } …only this node's adds of them (an undo: a peer's stay)
//   { action: 'remove', field, removals }           …or exactly these tags: `[[element, { origin: addTs }]]`
//   { action: 'splice', field, index, count, content }   a list's or a text's edit (@alexify/syncom/text)
//   { action: 'mark', field, start, end, name, value, expand?, many? }  a text's style over [start, end)
//   { action: 'treeMove', field, node, parent, after? }  a tree node placed (@alexify/syncom/tree)
//   { action: 'treeRemove', field, node }
//   { action: 'delete' }, { action: 'purge' }
//
// `diffViews(from, fromKinds, to, toKinds, { plugins })` is the list that
// turns the record `from` (its data, and what kind each field is) into
// `to`: per field by kind — a register's new value, a counter's delta, a
// set's added and removed elements, and for a plugin's kind what its `diff`
// says (a text's or a list's splices, a tree's moves) — a field gone is an
// `unset`, a field of another kind now an `unset` and the kind made again
// whole, and a record that was not there a `write` of the registers with
// the other kinds made again. A text's marks are not diffed; `compact()`
// lays them again itself, through the plugin. Pure over plain data; the
// kinds come from ops.js (`kindsOf`) and the plugins from the storage's
// registry (src/plugin.js), so this module and the undo subpath on it ship
// without the op model.

const { deepEqual, isPlainObject } = require('./shape.js');
const { isJsonValue, jsonValue, fieldNames, setElements } = require('./args.js');
const { EMPTY, HOME, missing } = require('./plugin.js');

const asKeys = (elements) => new Map(elements.map((element) => [JSON.stringify(element), element]));

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);

// A field's content made again from nothing, by kind.
const recreate = (field, kind, value, plugins) => {
  // An inc of 0 makes a counter that reads 0: the field stays a counter.
  if (kind === 'counter') return [{ action: 'inc', field, value }];
  if (kind === 'set') return value.length === 0 ? [] : [{ action: 'add', field, elements: value }];
  const mod = own(plugins.byName, kind);
  return mod === undefined ? [] : mod.recreate(field, kind, value);
};

/**
 * The patches that turn the record `from` — its data (`null` when it was
 * not there) and the kind of each of its fields — into `to`. `purged` says
 * `to` is a purged record. `exact` (the default) makes `to` read exactly:
 * a field `to` lacks is removed (`unset`); without it a counter, a set or
 * a plugin's field `to` lacks is emptied instead — what an undo wants,
 * since an unset outranks a peer's concurrent increment or add and would
 * take it with it; a register gone is an unset either way (a peer's newer
 * `set` wins over it). `plugins` is the registry whose kinds the fields may
 * be of.
 */
const diffViews = (from, fromKinds, to, toKinds, { purged = false, exact = true, plugins = EMPTY } = {}) => {
  if (to === null) {
    if (purged) return [{ action: 'purge' }];
    return from === null ? [] : [{ action: 'delete' }];
  }
  const registers = {};
  for (const field of Object.keys(to)) if (toKinds[field] === 'register') registers[field] = to[field];
  const patches = [];
  // A record that was not there: the registers written, the rest made again.
  if (from === null) {
    patches.push({ action: 'write', data: registers });
    for (const field of Object.keys(toKinds)) {
      if (toKinds[field] !== 'register') patches.push(...recreate(field, toKinds[field], to[field], plugins));
    }
    return patches;
  }
  for (const field of new Set([...Object.keys(toKinds), ...Object.keys(fromKinds)])) {
    const was = fromKinds[field];
    const now = toKinds[field];
    const value = to[field];
    const previous = from[field];
    // Gone: removed — or, loosely, emptied when the kind allows it. Another
    // kind now: removed, then made again from nothing.
    if (now === undefined && (exact || was === 'register')) {
      patches.push({ action: 'unset', field });
      continue;
    }
    if (was !== undefined && now !== undefined && was !== now) {
      patches.push({ action: 'unset', field }, ...recreate(field, now, value, plugins));
      continue;
    }
    const kind = now ?? was;
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
    } else {
      const mod = own(plugins.byName, kind);
      if (mod !== undefined) patches.push(...mod.diff(field, kind, previous, value));
    }
  }
  return patches;
};

const isField = (value) => typeof value === 'string' && value.length > 0;
// The actions the core realizes itself; a plugin's (`splice`, `mark`,
// `treeMove`, `treeRemove`) come from the registry.
const ACTIONS = new Set(['put', 'unset', 'write', 'inc', 'add', 'remove', 'delete', 'purge']);

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
 * wrong shape is a TypeError — it is the caller's data; one of a plugin's
 * action with no plugin registered is PLUGIN_MISSING.
 */
const realize = (patch, plugins = EMPTY) => {
  if (patch === null || typeof patch !== 'object') throw new TypeError('applyPatches(): a patch is an object');
  const { action, field } = patch;
  const mod = typeof action === 'string' ? own(plugins.byAction, action) : undefined;
  if (!ACTIONS.has(action) && mod === undefined) {
    if (typeof action === 'string' && own(HOME, action) !== undefined) throw missing(`a ${action} patch`, HOME[action]);
    throw new TypeError(`applyPatches(): unknown action ${action}`);
  }
  const named = action !== 'write' && action !== 'delete' && action !== 'purge';
  if (named && !isField(field)) throw new TypeError(`applyPatches(): ${action} needs a field`);
  const method = 'applyPatches';
  if (mod !== undefined) return mod.realize(action, patch, method);
  switch (action) {
    case 'put':
      return ['set', { data: { [field]: jsonValue(method, patch.value) } }];
    case 'unset':
      return ['unset', { value: fieldNames(method, field) }];
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
    case 'delete':
      return ['delete', {}];
    case 'purge':
      return ['purge', {}];
  }
};

module.exports = { diffViews, realize };
