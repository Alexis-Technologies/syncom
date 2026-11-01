'use strict';

// `atRest(engine, options)`: the engine contract over another engine, every
// value a ciphertext — the records, their pieces, a tag's copies, every kv
// text (node.json, the lock, the keys, the catalog), every entry of the op
// log and the log's index — under the one key of src/encryption/encryption.js
// (AES-256-GCM, `enc1:`), bound to its place the way a file is bound to its
// name: `data/<id>.json`, `data/<piece>`, `tags/<tag>/data/<id>.json`,
// `<ns>/<key>`, `log/<seq>`, `log/index.json`. The keys stay in the clear
// — an id, a seq, a tag's name, a kv key — and so does the log index's
// `floor`, which the medium reads to tell a sealed seq from an open one; a
// native engine keeps no index of its own over it (`indexes: false` — the
// core's catalog is saved sealed, as kv). A record goes in as text (the
// medium keeps a text that is no JSON as it is, `raw(id)` hands it back),
// and the files engine is not wrapped this way: its journal reads the ops it
// writes, so it is the backend that is wrapped there — `filesEngine(atRest(fsi))`.
// Requires engine.js and errors.js only; the cipher is handed in.

const { checkEngine, capabilitiesOf } = require('../engine.js');
const { SyncomError } = require('../errors.js');

const INDEX = 'log/index.json';

const unreadable = (id) =>
  new SyncomError('INTEGRITY', `Storage record ${id} is unreadable`, { id, cause: null, reason: 'unreadable' });

// A record's text, decrypted: the object it parses to, or INTEGRITY.
const parsed = (id, text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw unreadable(id);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unreadable(id);
  return value;
};

const recordKey = (id) => `data/${id}.json`;
const pieceKey = (name) => `data/${name}`;
const copyKey = (tag, id) => `tags/${tag}/data/${id}.json`;
const kvKey = (ns, key) => (ns === '' ? key : `${ns}/${key}`);
const logKey = (seq) => `log/${seq}`;

/**
 * An engine whose every value is encrypted at rest under one key —
 * `atRest(engine, options)` from the encryption subpath makes one with the
 * cipher (`seal(name, text)`, `open(name, text)`) of the options given.
 */
const atRestEngine = (engine, cipher) => {
  const inner = checkEngine(engine, 'atRest()');
  if (inner.name === 'files') {
    throw new TypeError('atRest(): wrap the backend, not the files engine — filesEngine(atRest(fsi, options))');
  }
  const { seal, open } = cipher;
  const capabilities = capabilitiesOf({ ...inner.capabilities, indexes: false });

  const openDb = (db) => {
    const kv = {
      get: async (ns, key) => {
        const text = await db.kv.get(ns, key);
        return text === null ? null : open(kvKey(ns, key), text);
      },
      has: (ns, key) => db.kv.has(ns, key),
      list: (ns) => db.kv.list(ns),
      put: async (ns, key, value, options) => db.kv.put(ns, key, await seal(kvKey(ns, key), String(value)), options),
      remove: (ns, key) => db.kv.remove(ns, key),
    };
    if (typeof db.kv.create === 'function') {
      kv.create = async (ns, key, value) => db.kv.create(ns, key, await seal(kvKey(ns, key), String(value)));
    }

    const records = {
      get: async (id) => {
        const text = await db.records.raw(id);
        return text === null ? null : parsed(id, await open(recordKey(id), text));
      },
      raw: async (id) => {
        const text = await db.records.raw(id);
        return text === null ? null : open(recordKey(id), text);
      },
      has: (id) => db.records.has(id),
      getMany: async (ids) => {
        const found = new Map();
        for (let i = 0; i < ids.length; i++) {
          const stored = await records.get(ids[i]);
          if (stored !== null) found.set(ids[i], stored);
        }
        return found;
      },
      ids: (options) => db.records.ids(options),
    };

    const pieces = {
      get: async (id, name) => {
        const text = await db.pieces.get(id, name);
        return text === null ? null : open(pieceKey(name), text);
      },
      remove: (id, name) => db.pieces.remove(id, name),
    };

    const copies = {
      get: async (tag, id) => {
        const text = await db.copies.get(tag, id);
        return text === null ? null : open(copyKey(tag, id), text);
      },
      has: (tag, id) => db.copies.has(tag, id),
      ids: (tag) => db.copies.ids(tag),
      put: async (tag, id, text) => db.copies.put(tag, id, await seal(copyKey(tag, id), text)),
      remove: (tag, id) => db.copies.remove(tag, id),
      drop: (tag) => db.copies.drop(tag),
    };

    // An entry of the log as the medium holds it: its seq in the clear, the rest one ciphertext.
    const sealEntry = async (entry) => ({ seq: entry.seq, e: await seal(logKey(entry.seq), JSON.stringify(entry)) });
    const sealAll = async (entries) => {
      const out = [];
      for (let i = 0; i < entries.length; i++) out.push(await sealEntry(entries[i]));
      return out;
    };
    const openEntry = async (row) => JSON.parse(await open(logKey(row.seq), row.e));
    const log = {
      get journaled() {
        return db.log.journaled;
      },
      get sealedTo() {
        return db.log.sealedTo;
      },
      get open() {
        return db.log.open;
      },
      get segments() {
        return db.log.segments;
      },
      get corrupt() {
        return db.log.corrupt;
      },
      get health() {
        return db.log.health;
      },
      async load() {
        const loaded = await db.log.load();
        const entries = [];
        for (let i = 0; i < loaded.entries.length; i++) entries.push(await openEntry(loaded.entries[i]));
        const index = loaded.index === null ? null : JSON.parse(await open(INDEX, loaded.index.e));
        return { ...loaded, entries, index, floor: index !== null ? index.floor : loaded.floor };
      },
      // The medium takes what it can write; the entries it may ask for again (a
      // journal's rewrite) are a file medium's, which is not wrapped this way.
      async append(entries, _headers, { first, last, sealedTo, onFail }) {
        return db.log.append(await sealAll(entries), null, { first, last, sealedTo, onFail });
      },
      async seal(entries, from, to) {
        await db.log.seal(await sealAll(entries), from, to);
      },
      sealed: (to) => db.log.sealed(to),
      drop: (segment) => db.log.drop(segment),
      // The floor stays in the clear: the medium tells a sealed seq from an open one by it.
      async saveIndex(index) {
        await db.log.saveIndex({ floor: index.floor, e: await seal(INDEX, JSON.stringify(index)) });
      },
      // The entries at `seqs` as they are now, sealed before the medium writes them again.
      async scrub(seqs, { id, sealedTo, entriesBetween }) {
        const bySeq = new Map();
        for (let i = 0; i < seqs.length; i++) {
          const held = entriesBetween(seqs[i], seqs[i]);
          if (held.length === 1) bySeq.set(seqs[i], await sealEntry(held[0]));
        }
        const sealedBetween = (from, to) => {
          const out = [];
          for (let seq = from; seq <= to; seq++) if (bySeq.has(seq)) out.push(bySeq.get(seq));
          return out;
        };
        await db.log.scrub(seqs, { id, sealedTo, entriesBetween: sealedBetween });
      },
    };

    // One write set, every value sealed: a record as text, its pieces, the kv puts, the copies.
    const write = async (batch) => {
      const sealed = {};
      const puts = batch.kv?.put;
      const removals = batch.kv?.remove;
      if (puts !== undefined || removals !== undefined) {
        sealed.kv = {};
        if (puts !== undefined) {
          const out = [];
          for (let i = 0; i < puts.length; i++) {
            const [ns, key, value, options] = puts[i];
            out.push([ns, key, await seal(kvKey(ns, key), String(value)), options]);
          }
          sealed.kv.put = out;
        }
        if (removals !== undefined) sealed.kv.remove = removals;
      }
      const rows = batch.records;
      if (rows !== undefined) {
        const out = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const text = row.stored !== undefined ? JSON.stringify(row.stored) : row.text;
          const next = { id: row.id, text: await seal(recordKey(row.id), text) };
          if (row.pieces !== undefined) {
            next.pieces = {};
            const made = row.pieces.put;
            if (made !== undefined) {
              const list = [];
              for (let k = 0; k < made.length; k++) {
                list.push([made[k][0], await seal(pieceKey(made[k][0]), made[k][1])]);
              }
              next.pieces.put = list;
            }
            if (row.pieces.remove !== undefined) next.pieces.remove = row.pieces.remove;
          }
          out.push(next);
        }
        sealed.records = out;
      }
      if (batch.remove !== undefined) sealed.remove = batch.remove;
      const copied = batch.copies?.put;
      if (copied !== undefined || batch.copies?.remove !== undefined) {
        sealed.copies = {};
        if (copied !== undefined) {
          const out = [];
          for (let i = 0; i < copied.length; i++) {
            const [tag, id, text] = copied[i];
            out.push([tag, id, await seal(copyKey(tag, id), text)]);
          }
          sealed.copies.put = out;
        }
        if (batch.copies?.remove !== undefined) sealed.copies.remove = batch.copies.remove;
      }
      await db.write(sealed);
    };

    const wrapped = { path: db.path, capabilities, kv, records, pieces, copies, log, write, close: () => db.close() };
    if (db.changes !== undefined) wrapped.changes = db.changes;
    if (typeof db.lock === 'function') wrapped.lock = (options) => db.lock(options);
    return Object.freeze(wrapped);
  };

  const engineAtRest = {
    name: `at-rest:${inner.name}`,
    capabilities,
    open: async (path, options) => openDb(await inner.open(path, options)),
    remove: (path) => inner.remove(path),
    close: async () => {
      if (typeof inner.close === 'function') await inner.close();
    },
  };
  if (typeof inner.destroy === 'function') engineAtRest.destroy = () => inner.destroy();
  return Object.freeze(engineAtRest);
};

module.exports = { atRestEngine };
