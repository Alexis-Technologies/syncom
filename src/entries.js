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
const { SyncomError } = require('./errors.js');

// How many of the oldest cached entries one write looks at for one to evict.
const EVICT_SCAN = 64;

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
  // Records whose ops are logged but whose file could not be written: held
  // in the cache, never evicted, until a write of theirs lands (or the next
  // open replays the log onto the file).
  #held = new Set();

  #before;

  // `pinned(id)` says whether the application holds a live Record of `id`
  // (its entry stays cached); `verify(id, data, block)` checks a cold read
  // against its chain block, or is null; `view(id, entry)` is the lensed
  // read the catalog indexes; `before(id, file)` runs ahead of every change
  // of a record's file with `file()` the file as it is (the tags' copy).
  constructor({ fsi, path, max, logger, catalog, pinned, verify, decrypt, view, before = null }) {
    this.#fsi = fsi;
    this.#dir = `${path}/data`;
    this.#max = max;
    this.#logger = logger;
    this.#catalog = catalog;
    this.#pinned = pinned;
    this.#verify = verify;
    this.#decrypt = decrypt;
    this.#view = view;
    this.#before = before;
  }

  /** The record's file as it is — its text — or null when there is none. */
  async file(id) {
    if (!(await this.#fsi.exists(this.#dir, `${id}.json`))) return null;
    return this.#fsi.read(this.#dir, `${id}.json`);
  }

  /** Whether `id` is held: logged, in the cache, its file behind. */
  held(id) {
    return this.#held.has(id);
  }

  /** The held ids. */
  heldIds() {
    return new Set(this.#held);
  }

  async #changing(id) {
    if (this.#before !== null) await this.#before(id, () => this.file(id));
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

  // The newest entries stay; a live Record pins its own, a held one stays
  // until it lands. Absent ids are never cached — the catalog knows what
  // exists. The oldest are looked at a few at a time: what cannot go is
  // passed over, so a cache over its bound by what it must keep stays over
  // it, and a write never walks the whole cache.
  remember(id, entry) {
    this.#cache.delete(id);
    this.#cache.set(id, entry);
    if (this.#cache.size <= this.#max) return;
    let looked = 0;
    for (const key of this.#cache.keys()) {
      if (this.#cache.size <= this.#max || looked++ >= EVICT_SCAN) break;
      if (this.#pinned(key) || this.#held.has(key)) continue;
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
    const entry = await this.parse(id, raw);
    this.remember(id, entry);
    return entry;
  }

  /**
   * A record file's text as an entry: checked against its chain block,
   * decrypted when sealed. A file torn by a crash, or not ours, is evidence,
   * like a failed check — never a bare SyntaxError. `repair(id)` rebuilds
   * the record's own file from the log.
   */
  async parse(id, raw) {
    let stored = null;
    let cause;
    try {
      stored = JSON.parse(raw);
    } catch (error) {
      cause = error;
    }
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
      throw new SyncomError('INTEGRITY', `Storage record ${id} is unreadable`, { id, cause });
    }
    const { data, meta, encrypted, block } = stored;
    if (this.#verify !== null) {
      const isValid = await this.#verify(id, data, block);
      if (!isValid) throw new SyncomError('INTEGRITY', `Storage record ${id} is invalid`, { id });
    }
    return encrypted
      ? { data: await this.#decrypt(data), meta: null, encrypted: true, block }
      : { data, meta, encrypted: false, block };
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

  // A replicated entry: the file, the cache, the catalog row — unless the
  // row is right already (the entry held by `hold` landing on its file: the
  // catalog read it then, and a watcher must not hear of it twice).
  async write(id, entry, blockHash) {
    await this.#changing(id);
    const stored = { data: entry.data, meta: entry.meta, encrypted: false, timestamp: Date.now(), block: blockHash };
    await this.#fsi.write(this.#dir, `${id}.json`, JSON.stringify(stored));
    const held = this.#held.has(id) ? this.#cache.get(id) : undefined;
    const indexed = held !== undefined && held.data === entry.data && held.meta === entry.meta;
    this.#held.delete(id);
    const cached = { data: entry.data, meta: entry.meta, encrypted: false, block: blockHash };
    this.remember(id, cached);
    if (!indexed) this.#catalog.put(id, await this.row(id, cached));
  }

  // An entry whose op is logged but whose file (or chain block) could not be
  // written: the cache and the catalog hold what the log says, so reads see
  // the write; the file catches up when a later write of it lands, or when
  // the next open replays the log.
  async hold(id, entry) {
    const cached = { data: entry.data, meta: entry.meta, encrypted: false, block: null };
    this.#held.add(id);
    this.remember(id, cached);
    this.#catalog.put(id, await this.row(id, cached));
  }

  // An entry sealed for this node's key: `record` is the ciphertext the
  // file holds, `data` what the cache (and so a read) holds.
  async writeSealed(id, record, data, blockHash) {
    await this.#changing(id);
    const stored = { data: record, meta: null, encrypted: true, timestamp: Date.now(), block: blockHash };
    await this.#fsi.write(this.#dir, `${id}.json`, JSON.stringify(stored));
    this.remember(id, { data, meta: null, encrypted: true, block: blockHash });
    this.#catalog.put(id, { type: data?.$type, v: null, encrypted: true });
  }

  // A sealed entry removed: an encrypted record has no op, so no tombstone.
  async remove(id) {
    await this.#changing(id);
    await this.#fsi.remove(this.#dir, `${id}.json`);
    this.#cache.delete(id);
    this.#catalog.put(id, null);
  }
}

module.exports = { EntryStore };
