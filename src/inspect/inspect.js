'use strict';

// Devtools — the `@alexify/syncom/inspect` subpath: what a record is made
// of, and a copy of anything with the names and words taken out.
// `inspect(storage, id)` reads the record raw — the data in the op model's
// terms, every field with its kind, what its metadata holds for it (a
// register's stamp, a counter's sums per origin, a set's slots, a block's
// runs and marks by count), whether it is reachable in the composed
// reading — and the log's entries of it, by seq. `anonymize(value)` hands
// back the same shape with every string replaced by a stable hash — ids,
// origins, actors, text — so a dump, a page or an op can leave the machine
// for a bug report without its words. No requires beyond the shapes, the
// composition, the symbols and the hash: nothing of the engine.

const { compose, decompose } = require('../compose.js');
const { asJson, isRecordId, invalidId, isPlainObject } = require('../shape.js');
const { SOURCE, PLUGINS } = require('../symbols.js');
const { checksum } = require('../hash.js');

const own = (object, key) =>
  object !== undefined && object !== null && Object.hasOwn(object, key) ? object[key] : undefined;
const count = (object) => (object ? Object.keys(object).length : 0);

// A field's kind from the metadata alone: a counter, a set, a block of a
// registered kind, else a register.
const kindOf = (meta, field, plugins) => {
  if (own(meta.counters, field) !== undefined) return 'counter';
  if (own(meta.sets, field) !== undefined) return 'set';
  const block = own(meta.blocks, field);
  if (block !== undefined) {
    const mod = own(plugins.byCode, block.k);
    return mod === undefined ? `block:${block.k}` : (own(mod.codes, block.k) ?? mod.name);
  }
  return 'register';
};

// What the metadata holds for a field, by kind — counts, stamps, sums.
const detail = (meta, field, kind) => {
  if (kind === 'register') return { stamp: own(meta.clock, field) ?? null };
  if (kind === 'counter') return { sums: asJson(meta.counters[field]) };
  if (kind === 'set') {
    const slots = meta.sets[field];
    const elements = Object.keys(slots);
    let live = 0;
    for (const element of elements) {
      const origins = slots[element];
      const keys = Object.keys(origins);
      for (let i = 0; i < keys.length; i++) {
        const slot = origins[keys[i]];
        if (slot[0] > slot[1]) {
          live++;
          break;
        }
      }
    }
    return { elements: elements.length, live };
  }
  const block = meta.blocks[field];
  const out = { k: block.k, ts: block.ts };
  if (block.runs !== undefined) out.runs = count(block.runs);
  if (block.moves !== undefined) {
    out.nodes = count(block.moves);
    let moves = 0;
    for (const node of Object.keys(block.moves)) moves += block.moves[node].length;
    out.moves = moves;
  }
  for (const map of ['cuts', 'ext', 'pos', 'vals', 'marks']) if (block[map] !== undefined) out[map] = count(block[map]);
  return out;
};

const isStorage = (value) =>
  Boolean(value) && typeof value.nodeId === 'string' && value.log !== undefined && value[SOURCE] !== undefined;

/**
 * What record `id` is made of, raw: `present`, `encrypted`, `alive`, the
 * `data` in the op model's terms (every path a field) and the composed
 * `reading`, the reset stamps (`base`, `deleted`, `purged`), the schema
 * version `v`, every field with its `kind`, what the metadata holds for it
 * and whether it is `reachable` in the reading, and the `log` entries of
 * the record this node retains, by seq. Reads nothing through the lens or
 * the hooks; nothing is written.
 */
const inspect = async (storage, id) => {
  if (!isStorage(storage)) throw new TypeError('inspect() takes a storage');
  if (!isRecordId(id)) throw invalidId(id);
  const { log } = storage;
  const logged = log.entriesOf(id);
  const entries = [];
  for (let i = 0; i < logged.length; i++) {
    const entry = logged[i];
    const { op } = entry;
    entries.push({
      seq: entry.seq,
      eventId: log.formatId(entry.seq),
      type: op.type,
      origin: op.origin,
      stream: op.seq,
      ts: op.ts,
      scope: op.scope ?? '*',
      field: typeof op.key === 'string' ? op.key : null,
      actor: op.actor ?? null,
      message: op.msg ?? null,
      signed: op.sig !== undefined,
      skipped: entry.skipped === true,
      scrubbed: entry.scrubbed === true,
    });
  }
  const entry = await storage[SOURCE].entry(id);
  const out = {
    id,
    present: entry !== null,
    encrypted: false,
    alive: false,
    data: null,
    reading: null,
    fields: [],
    log: entries,
  };
  if (entry === null) return out;
  if (entry.encrypted) {
    return { ...out, encrypted: true, alive: true, data: asJson(entry.data), reading: asJson(entry.data) };
  }
  const { meta } = entry;
  const plugins = storage[PLUGINS];
  out.alive = meta.deleted === null && meta.purged == null;
  out.data = asJson(entry.data);
  out.reading = out.alive ? asJson(compose(entry, plugins)) : null;
  out.base = meta.base;
  out.deleted = meta.deleted;
  out.purged = meta.purged ?? null;
  out.v = meta.v ?? null;
  const shown = out.alive ? decompose(out.reading, entry, plugins) : {};
  const names = new Set();
  const maps = [entry.data, meta.clock, meta.counters, meta.sets, meta.blocks];
  for (let i = 0; i < maps.length; i++) {
    const keys = Object.keys(maps[i]);
    for (let j = 0; j < keys.length; j++) names.add(keys[j]);
  }
  for (const field of [...names].sort()) {
    const kind = kindOf(meta, field, plugins);
    out.fields.push({ field, kind, reachable: Object.hasOwn(shown, field), ...detail(meta, field, kind) });
  }
  return out;
};

// A string's stand-in: stable for one salt, so the same id or word reads
// the same everywhere in the copy, and nothing of the word stays.
const hashed = (text, salt) => `~${checksum(`${salt}\n${text}`)}`;

/**
 * A copy of `value` — a dump, a snapshot page, an op, anything JSON — with
 * every string replaced by a stable hash of it under `salt` (the same
 * string reads the same throughout; nothing of it stays), the keys too
 * when `keys` is true; numbers, booleans and nulls as they are, so the
 * shape, the counts and the stamps survive for a bug report. A value JSON
 * cannot carry is a `TypeError`.
 */
const anonymize = (value, { salt = '', keys = false } = {}) => {
  if (typeof salt !== 'string') throw new TypeError('anonymize(): salt is a string');
  const walk = (item) => {
    if (typeof item === 'string') return hashed(item, salt);
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (Array.isArray(item)) {
      const out = [];
      for (let i = 0; i < item.length; i++) out.push(walk(item[i]));
      return out;
    }
    if (isPlainObject(item)) {
      const out = {};
      for (const key of Object.keys(item)) out[keys ? hashed(key, salt) : key] = walk(item[key]);
      return out;
    }
    throw new TypeError(`anonymize() takes a JSON value; got ${typeof item}`);
  };
  return walk(value);
};

module.exports = { inspect, anonymize };
