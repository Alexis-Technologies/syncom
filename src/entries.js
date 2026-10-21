'use strict';

// A storage's entries: the record files under `data/`, the bounded cache in
// front of them, and the catalog row each change leaves behind. An entry is
// `{ data, meta, encrypted, block }` — `meta` is the replication bookkeeping
// (see ops.js); an encrypted entry has none, it is stored as ciphertext for
// this node's key alone and is not replicated.
//
// This is the one seam where a record's file and its cached entry change,
// for the local write path, a peer's batch and a bootstrap page alike — so
// the catalog follows here, and nowhere else.

const { isRecordId } = require('./shape.js');
const { isAlive } = require('./ops.js');

class EntryStore {
  #fsi;
  #dir;
  #cache = new Map();
  #max;
  #logger;
  #catalog;
  #pinned;
  #verify;
  #decrypt;
  #view;

  // `pinned(id)` says whether the application holds a live Record of `id`
  // (its entry stays cached); `verify(id, data, block)` checks a cold read
  // against its chain block, or is null; `view(id, entry)` is the lensed
  // read the catalog indexes.
  constructor({ fsi, path, max, logger, catalog, pinned, verify, decrypt, view }) {
    this.#fsi = fsi;
    this.#dir = `${path}/data`;
    this.#max = max;
    this.#logger = logger;
    this.#catalog = catalog;
    this.#pinned = pinned;
    this.#verify = verify;
    this.#decrypt = decrypt;
    this.#view = view;
  }

  get size() {
    return this.#cache.size;
  }

  get max() {
    return this.#max;
  }

  /** The cached entry as it is, or undefined — raw, for callers that know not to touch it. */
  cached(id) {
    return this.#cache.get(id);
  }

  forget(id) {
    this.#cache.delete(id);
  }

  // The newest entries stay; a live Record pins its own. Absent ids are
  // never cached — the catalog knows what exists.
  remember(id, entry) {
    this.#cache.delete(id);
    this.#cache.set(id, entry);
    if (this.#cache.size <= this.#max) return;
    for (const key of this.#cache.keys()) {
      if (this.#cache.size <= this.#max) break;
      if (this.#pinned(key)) continue;
      this.#cache.delete(key);
    }
  }

  async load(id) {
    if (!isRecordId(id)) return null;
    const cached = this.#cache.get(id);
    if (cached !== undefined) {
      this.remember(id, cached);
      return cached;
    }
    const exists = await this.#fsi.exists(this.#dir, `${id}.json`);
    if (!exists) return null;
    const raw = await this.#fsi.read(this.#dir, `${id}.json`);
    const { data, meta, encrypted, block } = JSON.parse(raw);
    if (this.#verify !== null) {
      const isValid = await this.#verify(id, data, block);
      if (!isValid) throw new Error(`Storage record ${id} is invalid`);
    }
    const entry = encrypted
      ? { data: await this.#decrypt(data), meta: null, encrypted: true, block }
      : { data, meta, encrypted: false, block };
    this.remember(id, entry);
    return entry;
  }

  // The catalog's view of an entry: what `put` takes. Derived state never
  // fails a write: a lens that throws (a migration returning no object)
  // indexes the raw data here and throws on the read, where it is reported.
  async row(id, entry) {
    if (entry === null) return null;
    if (entry.encrypted) return { type: entry.data?.$type, v: null, encrypted: true };
    if (!isAlive(entry)) return { type: entry.data?.$type, v: entry.meta.v ?? null, gone: true };
    let data = entry.data;
    try {
      data = await this.#view(id, entry);
    } catch (error) {
      this.#logger.warn({ event: 'catalog.lens', id, err: error });
    }
    return { type: entry.data.$type, v: entry.meta.v ?? null, data };
  }

  // Puts what the record `id` is now; a record that fails its integrity
  // check is left out, like a replay leaves it alone.
  async index(id) {
    let entry;
    try {
      entry = await this.load(id);
    } catch (error) {
      this.#logger.warn({ event: 'catalog.skipped', id, err: error });
      return;
    }
    this.#catalog.put(id, await this.row(id, entry));
  }

  // A replicated entry: the file, the cache, the catalog row.
  async write(id, entry, blockHash) {
    const stored = { data: entry.data, meta: entry.meta, encrypted: false, timestamp: Date.now(), block: blockHash };
    await this.#fsi.write(this.#dir, `${id}.json`, JSON.stringify(stored));
    const cached = { data: entry.data, meta: entry.meta, encrypted: false, block: blockHash };
    this.remember(id, cached);
    this.#catalog.put(id, await this.row(id, cached));
  }

  // An entry sealed for this node's key: `record` is the ciphertext the
  // file holds, `data` what the cache (and so a read) holds.
  async writeSealed(id, record, data, blockHash) {
    const stored = { data: record, meta: null, encrypted: true, timestamp: Date.now(), block: blockHash };
    await this.#fsi.write(this.#dir, `${id}.json`, JSON.stringify(stored));
    this.remember(id, { data, meta: null, encrypted: true, block: blockHash });
    this.#catalog.put(id, { type: data?.$type, v: null, encrypted: true });
  }

  // A sealed entry removed: an encrypted record has no op, so no tombstone.
  async remove(id) {
    await this.#fsi.remove(this.#dir, `${id}.json`);
    this.#cache.delete(id);
    this.#catalog.put(id, null);
  }
}

module.exports = { EntryStore };
