'use strict';

// A storage's entries: the records in the engine's `records` store (the files
// engine: `data/<id>.json`), the bounded cache in
// front of them, and the catalog row each change leaves behind. An entry is
// `{ data, meta, encrypted, block }` — `meta` is the replication bookkeeping
// (see ops.js); an encrypted entry has none, it is stored as ciphertext for
// this node's key alone and is not replicated.
//
// This is the one seam where a record's file and its cached entry change,
// for the local write path, a peer's batch and a bootstrap page alike — so
// the catalog follows here, and nowhere else.
//
// A record file holding a large block holds its runs in PIECES: files
// `<id>~<n>.json` beside it, `n` counting up per record (`gen` in the
// record file), named in the block (`parts`, a slot a piece, null where
// none). A write makes the file of a piece whose object is new (the kind
// plugin's `pieces`: the newest one a keystroke), then the record file, then
// removes the pieces it no longer names — so a crash leaves the old file
// whole, or the new one. A crash before the record file leaves new pieces
// no file names, written over as `n` reaches them again; one after it, old
// ones, left on disk and never read. A read assembles the block whole;
// `file()` hands it whole too, so a copy of it (a tag's) stands alone.

const { isRecordId, isPlainObject } = require('./shape.js');
const { isAlive } = require('./ops.js');
const { SyncomError } = require('./errors.js');
const { now } = require('./telemetry/writer.js');

const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';

// How many of the oldest cached entries one write looks at for one to evict.
const EVICT_SCAN = 64;

class EntryStore {
  #db;
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
  #measure;
  #plugins;
  // Per record in pieces: the counter of its piece files and the names its
  // file holds now — what a write keeps or removes.
  #parts = new Map();
  // A piece's object (a child of a run map) → the file it was written to.
  #written = new WeakMap();
  // A block assembled from pieces at a read → the names it came from: one
  // written again unchanged keeps them.
  #plain = new WeakMap();

  // `pinned(id)` says whether the application holds a live Record of `id`
  // (its entry stays cached); `verify(id, data, block)` checks a cold read
  // against its chain block, or is null; `view(id, entry)` is the lensed
  // read the catalog indexes; `before(id, file)` runs ahead of every change
  // of a record's file with `file()` the file as it is (the tags' copy).
  constructor({
    db,
    max,
    logger,
    catalog,
    pinned,
    verify,
    decrypt,
    view,
    before = null,
    plugins = null,
    measure = null,
  }) {
    this.#db = db;
    this.#max = max;
    this.#logger = logger;
    this.#catalog = catalog;
    this.#pinned = pinned;
    this.#verify = verify;
    this.#decrypt = decrypt;
    this.#view = view;
    this.#before = before;
    this.#plugins = plugins;
    this.#measure = measure;
  }

  // One write set of the engine, its time told (`measure(ms, ok)`): what `stats().engine` and the engine's histogram count.
  async #write(batch) {
    if (this.#measure === null) return void (await this.#db.write(batch));
    const started = now();
    try {
      await this.#db.write(batch);
    } catch (error) {
      this.#measure(now() - started, false);
      throw error;
    }
    this.#measure(now() - started, true);
  }

  /** The record's file as it is — its text — or null when there is none. */
  async file(id) {
    const text = await this.#db.records.raw(id);
    if (text === null) return null;
    // A record in pieces is handed whole: a copy of it stands alone.
    if (!text.includes('"parts":')) return text;
    let stored = null;
    try {
      stored = JSON.parse(text);
    } catch {
      return text;
    }
    if (!isPlainObject(stored) || stored.encrypted) return text;
    const whole = { ...stored, meta: await this.#assemble(id, stored.meta, undefined, false) };
    delete whole.gen;
    return JSON.stringify(whole);
  }

  /** Whether `id` is held: logged, in the cache, its file behind. */
  held(id) {
    return this.#held.has(id);
  }

  /** The held ids. */
  heldIds() {
    return new Set(this.#held);
  }

  // What the newest tag keeps of the record before its file changes —
  // `{ copy: [tag, id, text], done }` or null: the copy rides in the write
  // set, ahead of the record, and `done()` marks it once the set is down.
  #changing(id) {
    if (this.#before === null) return null;
    return this.#before(id, () => this.file(id));
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

  // A cached entry, known at once (touched as a load touches it); undefined
  // when only the file can tell.
  peek(id) {
    const cached = this.#cache.get(id);
    if (cached !== undefined) this.remember(id, cached);
    return cached;
  }

  async load(id, stored = undefined) {
    if (!isRecordId(id)) return null;
    // `stored` given — read by a page's `getMany` — is taken as the record; the cache is asked otherwise.
    if (stored === undefined) {
      const cached = this.#cache.get(id);
      if (cached !== undefined) {
        this.remember(id, cached);
        return cached;
      }
      stored = await this.#db.records.get(id);
    }
    if (stored === null) return this.#folded(id);
    const entry = await this.#fromStored(id, stored);
    this.remember(id, entry);
    return entry;
  }

  // A tombstone whose file was folded into its catalog row (`fold`): the
  // entry rebuilt from the stamps the row keeps — dead, and what every op
  // below them is moot against — or null where the row holds none.
  #folded(id) {
    const row = this.#catalog.row(id);
    if (row === null || row.folded === undefined) return null;
    const { base, deleted, v } = row.folded;
    const meta = { clock: {}, base, deleted, counters: {}, sets: {}, blocks: {}, gone: {} };
    if (v !== null && v !== undefined) meta.v = v;
    const entry = { data: {}, meta, encrypted: false, block: null };
    this.remember(id, entry);
    return entry;
  }

  /**
   * Folds a tombstone's file into its catalog row (`@alexify/syncom/cleanup`):
   * the record's file and pieces removed, the stamps that keep it dead kept
   * on the row, from which a read rebuilds it. Only a tombstone that is not
   * purged; answers whether it did.
   */
  async fold(id) {
    const entry = await this.load(id);
    if (entry === null || entry.encrypted || isAlive(entry) || entry.meta.purged || entry.meta.deleted === null) {
      return false;
    }
    const row = this.#catalog.row(id);
    if (row === null || !row.gone || row.folded !== undefined) return false;
    const keeping = await this.#changing(id);
    const batch = { remove: [id] };
    if (keeping !== null) batch.copies = { put: [keeping.copy] };
    await this.#write(batch);
    keeping?.done();
    await this.#drop(id, new Set(), 0);
    this.#cache.delete(id);
    return this.#catalog.fold(id, { base: entry.meta.base, deleted: entry.meta.deleted, v: entry.meta.v });
  }

  /**
   * Several records as `load` gives them, a Map by id (null for one that is
   * not there): the cached ones at once, the rest in ONE read of the engine
   * (`records.getMany`). An id that is no id reads as absent; one that
   * fails to parse throws, as a load does.
   */
  async loadMany(ids) {
    const out = new Map();
    const wanted = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (out.has(id)) continue;
      if (!isRecordId(id)) {
        out.set(id, null);
        continue;
      }
      const cached = this.#cache.get(id);
      if (cached !== undefined) {
        this.remember(id, cached);
        out.set(id, cached);
      } else {
        out.set(id, null);
        wanted.push(id);
      }
    }
    if (wanted.length === 0) return out;
    const found = await this.#db.records.getMany(wanted);
    for (let i = 0; i < wanted.length; i++) {
      const stored = found.get(wanted[i]) ?? null;
      if (stored === null) {
        const folded = this.#folded(wanted[i]);
        if (folded !== null) out.set(wanted[i], folded);
        continue;
      }
      const entry = await this.#fromStored(wanted[i], stored);
      this.remember(wanted[i], entry);
      out.set(wanted[i], entry);
    }
    return out;
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
      throw new SyncomError('INTEGRITY', `Record ${id} is unreadable`, { id, cause });
    }
    return this.#fromStored(id, stored);
  }

  // A stored record (the engine's, parsed) as an entry: checked against its
  // chain block, decrypted when sealed, its pieces made whole.
  async #fromStored(id, stored) {
    const { data, meta, encrypted, block } = stored;
    if (this.#verify !== null) {
      const isValid = await this.#verify(id, data, block);
      if (!isValid) throw new SyncomError('INTEGRITY', `Record ${id} is invalid`, { id });
    }
    if (encrypted) return { data: await this.#decrypt(data), meta: null, encrypted: true, block };
    return { data, meta: await this.#assemble(id, meta, stored.gen, true), encrypted: false, block };
  }

  // A block in pieces made whole: each named piece read and its runs laid
  // into one map. The stored record is the engine's — a native engine hands
  // out the object it holds — so the meta is copied at its first block in
  // pieces, never changed in place. With `track`, the record's pieces are
  // what its file names now.
  async #assemble(id, stored, gen, track) {
    const blocks = stored?.blocks;
    if (!isPlainObject(blocks)) return stored;
    let meta = stored;
    let names = null;
    // Every piece the blocks name, read in ONE call of the engine: a round trip a piece was the cold read's cost.
    const wanted = [];
    for (const field of Object.keys(blocks)) {
      const held = blocks[field];
      if (!isPlainObject(held) || !Array.isArray(held.parts)) continue;
      for (let i = 0; i < held.parts.length; i++) {
        const name = held.parts[i];
        if (name === null) continue;
        if (typeof name !== 'string' || !name.startsWith(`${id}~`) || !name.endsWith('.json')) {
          throw new SyncomError('INTEGRITY', `Record ${id} names a piece not its own`, { id });
        }
        wanted.push(name);
      }
    }
    const texts = wanted.length > 0 ? await this.#db.pieces.getMany(id, wanted) : new Map();
    for (const field of Object.keys(blocks)) {
      const held = blocks[field];
      if (!isPlainObject(held) || !Array.isArray(held.parts)) continue;
      const runs = {};
      for (let i = 0; i < held.parts.length; i++) {
        const name = held.parts[i];
        if (name === null) continue;
        let piece;
        try {
          const text = texts.get(name) ?? null;
          if (text === null) throw new SyncomError('INTEGRITY', `piece ${name} is missing`, { id });
          piece = JSON.parse(text);
        } catch (cause) {
          throw new SyncomError('INTEGRITY', `Record ${id} is unreadable: its piece ${name}`, { id, cause });
        }
        if (!isPlainObject(piece)) throw new SyncomError('INTEGRITY', `Record ${id}: piece ${name}`, { id });
        const keys = Object.keys(piece);
        for (let k = 0; k < keys.length; k++) if (keys[k] !== '__proto__') runs[keys[k]] = piece[keys[k]];
        (names ??= new Set()).add(name);
      }
      const plain = {};
      const keys = Object.keys(held);
      for (let k = 0; k < keys.length; k++) if (keys[k] !== 'parts') plain[keys[k]] = held[keys[k]];
      plain.runs = runs;
      if (meta === stored) meta = { ...stored, blocks: { ...blocks } };
      meta.blocks[field] = plain;
      this.#plain.set(plain, held.parts);
    }
    if (track && (names !== null || Number.isSafeInteger(gen))) {
      this.#parts.set(id, { gen: Number.isSafeInteger(gen) ? gen : 0, names: names ?? new Set() });
    }
    return meta;
  }

  // The meta as the record file holds it: every large block in pieces, the
  // files of the new ones to write first, the names it keeps, the counter.
  #split(id, meta) {
    const known = this.#parts.get(id);
    let gen = known === undefined ? 0 : known.gen;
    const kept = new Set();
    const writes = [];
    const blocks = meta?.blocks;
    if (!isPlainObject(blocks) || this.#plugins === null) return { meta, writes, kept, gen };
    let out = meta;
    for (const field of Object.keys(blocks)) {
      const block = blocks[field];
      let names = this.#plain.get(block);
      let head = null;
      if (names !== undefined) {
        // Read in pieces and unchanged: the same files.
        head = {};
        const keys = Object.keys(block);
        for (let k = 0; k < keys.length; k++) if (keys[k] !== 'runs') head[keys[k]] = block[keys[k]];
        for (let i = 0; i < names.length; i++) if (names[i] !== null) kept.add(names[i]);
      } else {
        const code = isPlainObject(block) ? block.k : undefined;
        const mod =
          typeof code === 'string' && Object.hasOwn(this.#plugins.byCode, code)
            ? this.#plugins.byCode[code]
            : undefined;
        if (mod === undefined || typeof mod.pieces !== 'function') continue;
        const split = mod.pieces(block);
        if (split === null) continue;
        head = split.head;
        names = [];
        for (let i = 0; i < split.slots.length; i++) {
          const slot = split.slots[i];
          if (slot === null) {
            names.push(null);
            continue;
          }
          let name = this.#written.get(slot.key);
          if (name === undefined || known === undefined || !known.names.has(name)) {
            name = `${id}~${++gen}.json`;
            writes.push([name, slot.text()]);
            this.#written.set(slot.key, name);
          }
          names.push(name);
          kept.add(name);
        }
      }
      if (out === meta) out = { ...meta, blocks: { ...blocks } };
      out.blocks[field] = { ...head, parts: names };
    }
    // The pieces the record named and names no more: dropped in the write set, after its file.
    const dropped = [];
    if (known !== undefined) {
      for (const name of known.names) {
        if (!kept.has(name)) dropped.push(name);
      }
    }
    return { meta: out, writes, dropped, kept, gen };
  }

  // The pieces a record holds now, remembered — none, forgotten.
  #parted(id, kept, gen) {
    if (gen > 0) this.#parts.set(id, { gen, names: kept });
    else this.#parts.delete(id);
  }

  // The pieces of `id` its file no longer names, removed — after the file;
  // a sealed or a removed record's (a write set carries a record's own).
  async #drop(id, kept, gen) {
    const known = this.#parts.get(id);
    if (known !== undefined) {
      for (const name of known.names) {
        if (kept.has(name)) continue;
        try {
          await this.#db.pieces.remove(id, name);
        } catch (err) {
          this.#logger.warn({ event: 'storage.piece.unremoved', id, name, err });
        }
      }
    }
    this.#parted(id, kept, gen);
  }

  // The catalog's view of an entry: what `put` takes — at once, a promise
  // only where a lens runs. Derived state never fails a write: a lens that
  // throws (a migration returning no object) indexes the raw data here and
  // throws on the read, where it is reported.
  row(id, entry) {
    if (entry === null) return null;
    if (entry.encrypted) return { type: entry.data?.$type, v: null, encrypted: true };
    if (!isAlive(entry)) return { type: entry.data?.$type, v: entry.meta.v ?? null, gone: true };
    let data;
    try {
      data = this.#view(id, entry);
    } catch (error) {
      return this.#unlensed(id, entry, error);
    }
    if (isThenable(data)) {
      return data.then(
        (view) => ({ type: entry.data.$type, v: entry.meta.v ?? null, data: view }),
        (error) => this.#unlensed(id, entry, error),
      );
    }
    return { type: entry.data.$type, v: entry.meta.v ?? null, data };
  }

  #unlensed(id, entry, error) {
    this.#logger.warn({ event: 'catalog.lens', id, err: error });
    return { type: entry.data.$type, v: entry.meta.v ?? null, data: entry.data };
  }

  // Puts what the record `id` is now; a record that fails its integrity
  // check is left out, like a replay leaves it alone.
  async index(id, stored = undefined) {
    let entry;
    try {
      entry = await this.load(id, stored);
    } catch (error) {
      this.#logger.warn({ event: 'catalog.skipped', id, err: error });
      return;
    }
    this.#catalog.put(id, await this.row(id, entry));
  }

  // A replicated entry: the file, the cache, the catalog row — unless the
  // row is right already (the entry held by `hold` landing on its file: the
  // catalog read it then, and a watcher must not hear of it twice).
  async write(id, entry, blockHash, kv = null) {
    await this.writeMany(new Map([[id, entry]]), blockHash, kv);
  }

  /**
   * A batch of replicated entries landed as ONE write set of the engine
   * (atomic where the engine has transactions): each record's new pieces and
   * its stored form, in id order as given; then, per record, the pieces its
   * file no longer names dropped, the cache and the catalog row — unless the
   * row is right already (the entry held by `hold` landing on its file: the
   * catalog read it then, and a watcher must not hear of it twice).
   */
  async writeMany(touched, blockHash, kv = null) {
    const rows = [];
    const after = [];
    const copies = [];
    const marks = [];
    for (const [id, entry] of touched) {
      const keeping = await this.#changing(id);
      if (keeping !== null) {
        copies.push(keeping.copy);
        marks.push(keeping.done);
      }
      const { meta, writes, dropped, kept, gen } = this.#split(id, entry.meta);
      const stored = { data: entry.data, meta, encrypted: false, timestamp: Date.now(), block: blockHash };
      if (gen > 0) stored.gen = gen;
      const row = { id, stored };
      if (writes.length > 0 || dropped.length > 0) {
        row.pieces = {};
        if (writes.length > 0) row.pieces.put = writes;
        if (dropped.length > 0) row.pieces.remove = dropped;
      }
      rows.push(row);
      after.push([id, entry, kept, gen]);
    }
    // ONE write set: the kv puts — a chain block and its tail — the tags' copies of the records as they were,
    // the records with the pieces they make and drop. Atomic where the engine has transactions.
    const batch = { records: rows };
    if (kv !== null) batch.kv = kv;
    if (copies.length > 0) batch.copies = { put: copies };
    await this.#write(batch);
    for (let i = 0; i < marks.length; i++) marks[i]();
    for (let i = 0; i < after.length; i++) {
      const [id, entry, kept, gen] = after[i];
      this.#parted(id, kept, gen);
      const held = this.#held.has(id) ? this.#cache.get(id) : undefined;
      const indexed = held !== undefined && held.data === entry.data && held.meta === entry.meta;
      this.#held.delete(id);
      // The composed view rides along: it reads data and meta alone, and both are the same objects here.
      const cached = {
        data: entry.data,
        meta: entry.meta,
        encrypted: false,
        block: blockHash,
        composed: entry.composed,
      };
      this.remember(id, cached);
      if (!indexed) this.#catalog.put(id, await this.row(id, cached));
    }
  }

  // An entry whose op is logged but whose file (or chain block) could not be
  // written: the cache and the catalog hold what the log says, so reads see
  // the write; the file catches up when a later write of it lands, or when
  // the next open replays the log.
  // At once — a promise only where the row waits for a lens.
  hold(id, entry) {
    const cached = { data: entry.data, meta: entry.meta, encrypted: false, block: null, composed: entry.composed };
    this.#held.add(id);
    this.remember(id, cached);
    const row = this.row(id, cached);
    if (isThenable(row)) return row.then((value) => void this.#catalog.put(id, value));
    this.#catalog.put(id, row);
    return undefined;
  }

  // An entry sealed for this node's key: `record` is the ciphertext the
  // file holds, `data` what the cache (and so a read) holds.
  async writeSealed(id, record, data, blockHash, kv = null) {
    const keeping = await this.#changing(id);
    const stored = { data: record, meta: null, encrypted: true, timestamp: Date.now(), block: blockHash };
    const batch = { records: [{ id, stored }] };
    if (kv !== null) batch.kv = kv;
    if (keeping !== null) batch.copies = { put: [keeping.copy] };
    await this.#write(batch);
    keeping?.done();
    await this.#drop(id, new Set(), 0);
    this.remember(id, { data, meta: null, encrypted: true, block: blockHash });
    this.#catalog.put(id, { type: data?.$type, v: null, encrypted: true });
  }

  // A sealed entry removed: an encrypted record has no op, so no tombstone.
  async remove(id) {
    const keeping = await this.#changing(id);
    const batch = { remove: [id] };
    if (keeping !== null) batch.copies = { put: [keeping.copy] };
    await this.#write(batch);
    keeping?.done();
    await this.#drop(id, new Set(), 0);
    this.#cache.delete(id);
    this.#catalog.put(id, null);
  }
}

module.exports = { EntryStore };
