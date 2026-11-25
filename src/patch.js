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
//   { action: 'splice', field, index, count, content, vals? }  a list's or a text's edit (@alexify/syncom/text);
//                                                   `vals` the markers of the embed slots (U+FFFC) the content holds
//   { action: 'setAt', field, index, value }        a list element's value, a text's block marker or embed (an `assign` op)
//   { action: 'mark', field, start, end, name, value, expand?, many? }  a text's style over [start, end)
//   { action: 'treeMove', field, node, parent, after? }  a tree node placed (@alexify/syncom/tree)
//   { action: 'treeRemove', field, node }
//   { action: 'delete' }, { action: 'purge' }
//
// `diffViews(from, fromKinds, to, toKinds, { plugins, context })` is the
// list that turns the record `from` (its data, and what kind each field is)
// into `to`: per field by kind — a register's new value, a counter's delta,
// a set's added and removed elements, and for a plugin's kind what its
// `diff` says (a text's or a list's splices, a tree's moves; `context.from`
// and `.to` hand it what the reading leaves out — the entries, or the
// `embeds` a commit event carries — so a text's markers travel) — a field gone is an
// `unset`, a field of another kind now an `unset` and the field made again
// whole as what it is now — a register too: its `put` — and a record that
// was not there a `write` of the registers with the other kinds made again.
// The `unset`s come first, whatever the fields' order: a removal frees a
// name for what is made under it or over it (a text at `profile` gone
// before `profile/city` is put), and an op of another kind is refused on a
// field until it is (`kindClash`: a register outranks every kind on the op
// path, but no local op lands on a field of another kind). The kinds are
// each side's own — a field may be a counter in `from` and a register in
// `to` — so a caller that knows one map alone (a merged one) has it wrong.
// A text's marks are not diffed; `compact()` lays them again itself,
// through the plugin. Pure over plain data in the
// op model's terms — flat, every path a field (src/paths.js `decompose`
// takes a composed reading back to that); the kinds come from ops.js
// (`kindsOf`) and the plugins from the storage's registry (src/plugin.js),
// so this module and the undo subpath on it ship without the op model.

const { deepEqual, isPlainObject, own } = require('./shape.js');
const { isJsonValue, jsonValue, fieldNames, setElements } = require('./args.js');
const { isPath } = require('./paths.js');
const { EMPTY, HOME, missing } = require('./plugin.js');
const { ArgumentError } = require('./argument-errors.js');

const asKeys = (elements) => {
  const keys = new Map();
  for (let i = 0; i < elements.length; i++) keys.set(JSON.stringify(elements[i]), elements[i]);
  return keys;
};

// A field's content made again from nothing, by kind.
const recreate = (field, kind, value, plugins, context) => {
  if (kind === 'register') return [{ action: 'put', field, value }];
  // An inc of 0 makes a counter that reads 0: the field stays a counter.
  if (kind === 'counter') return [{ action: 'inc', field, value }];
  if (kind === 'set') return value.length === 0 ? [] : [{ action: 'add', field, elements: value }];
  const mod = own(plugins.byName, kind);
  return mod === undefined ? [] : mod.recreate(field, kind, value, context);
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
const diffViews = (
  from,
  fromKinds,
  to,
  toKinds,
  { purged = false, exact = true, plugins = EMPTY, context = {} } = {},
) => {
  if (to === null) {
    if (purged) return [{ action: 'purge' }];
    return from === null ? [] : [{ action: 'delete' }];
  }
  const registers = {};
  for (const field of Object.keys(toKinds)) {
    if (toKinds[field] === 'register') registers[field] = to[field];
  }
  const patches = [];
  // A record that was not there: the registers written, the rest made again.
  if (from === null) {
    patches.push({ action: 'write', data: registers });
    for (const field of Object.keys(toKinds)) {
      if (toKinds[field] !== 'register') {
        const made = recreate(field, toKinds[field], to[field], plugins, context);
        for (let i = 0; i < made.length; i++) patches.push(made[i]);
      }
    }
    return patches;
  }
  const fields = new Set(Object.keys(toKinds));
  for (const field of Object.keys(fromKinds)) fields.add(field);
  // The removals, ahead of everything made.
  const unsets = [];
  for (const field of fields) {
    const was = fromKinds[field];
    const now = toKinds[field];
    const value = to[field];
    const previous = from[field];
    // Gone: removed — or, loosely, emptied when the kind allows it.
    if (now === undefined && (exact || was === 'register')) {
      unsets.push({ action: 'unset', field });
      continue;
    }
    // Another kind now, or not there before: what it held is removed and the
    // field made again from nothing, as the kind it is — a register by its
    // `put` (an unset alone left the value unwritten), a counter that reads 0
    // by an `inc` of 0.
    if (now !== undefined && was !== now) {
      if (was !== undefined) unsets.push({ action: 'unset', field });
      const made = recreate(field, now, value, plugins, context);
      for (let i = 0; i < made.length; i++) patches.push(made[i]);
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
      const added = [];
      for (const entry of after) {
        if (!before.has(entry[0])) added.push(entry[1]);
      }
      const removed = [];
      for (const entry of before) {
        if (!after.has(entry[0])) removed.push(entry[1]);
      }
      if (added.length > 0) patches.push({ action: 'add', field, elements: added });
      if (removed.length > 0) patches.push({ action: 'remove', field, elements: removed });
    } else {
      const mod = own(plugins.byName, kind);
      if (mod !== undefined) {
        const made = mod.diff(field, kind, previous, value, context);
        for (let i = 0; i < made.length; i++) patches.push(made[i]);
      }
    }
  }
  return unsets.length === 0 ? patches : unsets.concat(patches);
};

const isField = (value) => isPath(value);
// The actions the core realizes itself; a plugin's (`splice`, `mark`,
// `treeMove`, `treeRemove`) come from the registry.
const ACTIONS = new Set(['put', 'unset', 'write', 'inc', 'add', 'remove', 'delete', 'purge']);

// A caller's list without its holes: what a check that skipped them hands the write path, which copies it as JSON
// (a hole would come back as a null).
const dense = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i++) if (i in list) out.push(list[i]);
  return out;
};

// Exactly the tags a remove revokes: `[[element, { origin: addTs }]]`.
const isRemovals = (list) => {
  if (!Array.isArray(list)) return false;
  for (let i = 0; i < list.length; i++) {
    if (!(i in list)) continue; // a hole, skipped as the `every` this loop replaced skipped it
    const pair = list[i];
    if (!Array.isArray(pair) || pair.length !== 2 || !isJsonValue(pair[0]) || !isPlainObject(pair[1])) return false;
    const tags = pair[1];
    const origins = Object.keys(tags);
    for (let j = 0; j < origins.length; j++) {
      const ts = tags[origins[j]];
      if (!Number.isSafeInteger(ts) || ts <= 0) return false;
    }
  }
  return true;
};

/**
 * A patch as the op the write path takes: `[type, payload]`, checked as the
 * method of the same name checks its arguments (src/args.js). A patch of the
 * wrong shape is a TypeError — it is the caller's data; one of a plugin's
 * action with no plugin registered is ALX_ERR_PLUGIN_MISSING.
 */
const realize = (patch, plugins = EMPTY) => {
  if (patch === null || typeof patch !== 'object') throw new ArgumentError('applyPatches(): a patch is an object');
  const { action, field } = patch;
  const mod = typeof action === 'string' ? own(plugins.byAction, action) : undefined;
  if (!ACTIONS.has(action) && mod === undefined) {
    if (typeof action === 'string' && own(HOME, action) !== undefined) throw missing(`a ${action} patch`, HOME[action]);
    throw new ArgumentError(`applyPatches(): unknown action ${action}`);
  }
  const named = action !== 'write' && action !== 'delete' && action !== 'purge';
  if (named && !isField(field)) throw new ArgumentError(`applyPatches(): ${action} needs a field`);
  const method = 'applyPatches';
  if (mod !== undefined) return mod.realize(action, patch, method);
  switch (action) {
    case 'put':
      return ['set', { data: { [field]: jsonValue(method, patch.value) } }];
    case 'unset':
      return ['unset', { value: fieldNames(method, field) }];
    case 'write':
      if (!isPlainObject(patch.data)) throw new ArgumentError('applyPatches(): write needs data: a plain object');
      return ['write', { data: patch.data }];
    case 'inc':
      if (!Number.isFinite(patch.value)) throw new ArgumentError('applyPatches(): inc needs a finite value');
      return ['inc', { key: field, value: patch.value }];
    case 'add':
      return ['add', { key: field, value: setElements(method, field, patch.elements) }];
    case 'remove': {
      if (patch.removals !== undefined) {
        if (!isRemovals(patch.removals)) {
          throw new ArgumentError('applyPatches(): remove needs removals as [[element, { origin: addTs }]]');
        }
        return ['remove', { key: field, value: [], removals: dense(patch.removals) }];
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
