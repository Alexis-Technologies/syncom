'use strict';

// Who wrote what — read from the metadata a record carries, never from the
// log: a register's clock names the writer of its value, a counter's
// per-origin sums the contributors and their newest stamp, a set's slots
// the origins that added, a list's or a text's runs the writer of every
// element (the plugin's `editors`), a tree's moves the movers. `origin` is
// a node id — the signing key where ops are signed — not a user: who sat
// at the node is the application's map, as `actor` on the ops says.

const { kindOf, isAlive } = require('./ops.js');
const { fieldName } = require('./args.js');
const { isRecordId, invalidId } = require('./shape.js');

const own = (object, key) => (object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined);

const loaded = async (core, id) => {
  if (!isRecordId(id)) throw invalidId(id);
  const entry = await core.entries.load(id);
  return entry === null || entry.encrypted || !isAlive(entry) ? null : entry;
};

const newest = (a, b) => (a === null || (b !== null && b.ts > a.ts) ? b : a);

// The last editor of a field, by kind; null where the kind keeps no stamp
// (a set) or the field is not there.
const lastOf = (core, entry, field) => {
  const { meta } = entry;
  const kind = kindOf(entry, field, core.plugins);
  if (kind === 'register') {
    const stamp = own(meta.clock, field);
    return stamp === undefined ? null : { origin: stamp[1], ts: stamp[0] };
  }
  if (kind === 'counter') {
    let best = null;
    const sums = own(meta.counters, field) ?? {};
    for (const origin of Object.keys(sums)) best = newest(best, { origin, ts: sums[origin][2] });
    return best;
  }
  if (kind === undefined || kind === 'set') return null;
  const mod = own(core.plugins.byName, kind);
  return typeof mod?.editors === 'function' ? (mod.editors(entry, field).last ?? null) : null;
};

/**
 * Who last wrote field `field` of record `id`: `{ origin, ts }` — the node
 * and the stamp of its value (a register), its newest increment (a
 * counter), its newest run, mark or move (a list, a text, a tree); `null`
 * for a set (its slots carry counts, no stamps), for a field the record
 * has not, for a record that is not there.
 */
const lastEditorOf = async (core, id, field) => {
  fieldName('lastEditorOf', field);
  const entry = await loaded(core, id);
  return entry === null ? null : lastOf(core, entry, field);
};

/**
 * Every node that wrote something the record still carries: the writers
 * of its registers, the contributors of its counters, the adders of its
 * sets' live elements, the writers of every run, mark and value of its
 * lists and texts, the movers of its trees — sorted; `[]` for a record
 * that is not there.
 */
const editorsOf = async (core, id) => {
  const entry = await loaded(core, id);
  if (entry === null) return [];
  const { meta } = entry;
  const origins = new Set();
  for (const field of Object.keys(meta.clock)) origins.add(meta.clock[field][1]);
  for (const field of Object.keys(meta.counters)) {
    for (const origin of Object.keys(meta.counters[field])) origins.add(origin);
  }
  for (const field of Object.keys(meta.sets)) {
    const slots = meta.sets[field];
    for (const element of Object.keys(slots)) {
      for (const origin of Object.keys(slots[element])) {
        const [added, removed] = slots[element][origin];
        if (added > removed) origins.add(origin);
      }
    }
  }
  for (const field of Object.keys(meta.blocks)) {
    const kind = kindOf(entry, field, core.plugins);
    const mod = kind === undefined ? undefined : own(core.plugins.byName, kind);
    if (typeof mod?.editors !== 'function') continue;
    for (const origin of mod.editors(entry, field).all) origins.add(origin);
  }
  return [...origins].sort();
};

module.exports = { lastEditorOf, editorsOf };
