'use strict';

const { Emitter, generateUUID, createLogger } = require('./utils.js');
const { encrypt, decrypt, loadKeys, calculateHash } = require('./crypto.js');
const { Blockchain } = require('./chain.js');
const { SyncManager } = require('./sync.js');
const { OpLog } = require('./log.js');
const { applyOp, isAlive, isCounter, latestClock } = require('./ops.js');
const { Clock, opKey, keyScope, vectorHas, vectorNext, vectorAdvance } = require('./vector.js');
const { notify, runHook, normalizeHooks } = require('./hooks.js');
const { ValidationError, normalizeSchema, createLens, project, unproject, foldSet } = require('./schema.js');
const { Cursor } = require('./query.js');
const defaultFsi = require('./fsi.js');
const { checkFsi, withSync } = require('./backend.js');
const { acquireLock } = require('./lock.js');
const { Catalog } = require('./catalog.js');
const { createTelemetry, traced, now } = require('./telemetry.js');

const NODE_FILE = 'node.json';
const SCHEMA_FILE = 'schema.json';
const GLOBAL_SCOPE = '*';
const DEFAULT_CACHE = 5000;
const DEFAULT_FLUSH_EVERY = 64;

// The ops an entity's validator sees: the ones that leave a record for the
// application to read. A `merge` joins a peer's state as it is, a `delete`
// leaves nothing to validate.
const VALIDATED = new Set(['write', 'set', 'inc']);

// The hooks a storage accepts (`open({ hooks })`). Writes and reads run
// their hooks inside this storage; the apply pair runs per peer batch.
const STORAGE_HOOKS = ['beforeWrite', 'afterWrite', 'beforeRead', 'afterRead', 'beforeApply', 'afterApply'];

// Module-private entry points between Storage and Record: a Record commits
// through the same path every other write takes and is refreshed when the
// record changes underneath it. Symbols keep both off the public surface.
const COMMIT = Symbol('syncom.commit');
const REFRESH = Symbol('syncom.refresh');
const SOURCE = Symbol('syncom.source');

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// A record id is a file name on three platforms, a key in every peer's
// catalog and a line in every peer's log: letters, digits, `.`, `_`, `-`,
// `@`, not starting with a dot, 128 characters at most. Checked where an id
// enters — the local write path, a peer's op, a snapshot record — so
// nothing below has to.
const RECORD_ID = /^[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}$/;
const isRecordId = (id) => typeof id === 'string' && RECORD_ID.test(id);
const invalidId = (id) => {
  const shown = typeof id === 'string' ? JSON.stringify(id) : typeof id;
  const error = new TypeError(
    `Invalid record id ${shown}: letters, digits, . _ - @, not starting with a dot, 128 at most`,
  );
  error.code = 'INVALID_ID';
  return error;
};

// An origin or a scope ends up a vector key (`origin@scope`) and a room
// name: a non-empty string without `@` or control characters.
const hasControl = (value) => {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true;
  return false;
};
const isStreamName = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('@') && !hasControl(value);

const OP_TYPES = new Set(['write', 'set', 'inc', 'delete', 'merge', 'advance', 'purge']);

// A peer's stamp this far ahead of this node's wall clock is a broken clock,
// not a concurrent write: observing it would move every later stamp here —
// and, through replication, everywhere — into the future for good.
const DEFAULT_MAX_SKEW = 86_400_000;

// The fields the engine indexes a peer's op by, checked before anything here
// reads them. Payloads (`data`, `meta`, `key`, `value`, `vector`) are the
// business of applyOp and normalizeMeta, which take garbage as a no-op;
// `actor` and `from` are claims, carried as they are.
const wellFormed = (op) =>
  isPlainObject(op) &&
  isStreamName(op.origin) &&
  Number.isSafeInteger(op.seq) &&
  op.seq > 0 &&
  Number.isSafeInteger(op.ts) &&
  op.ts > 0 &&
  OP_TYPES.has(op.type) &&
  (op.scope === undefined || isStreamName(op.scope)) &&
  (op.v === undefined || (Number.isInteger(op.v) && op.v >= 1)) &&
  (op.type === 'advance' ? isPlainObject(op.vector) : isRecordId(op.id));

// What a commit came to: an op, `null` for a write that changed nothing,
// `undefined` for an encrypted record (saved locally, no op), and MISMATCH
// for a swap whose expectation no longer held.
const MISMATCH = Symbol('syncom.mismatch');
const commitResult = (op) => (op === undefined ? 'encrypted' : op === null || op === MISMATCH ? 'noop' : 'applied');

// Data crosses the boundary as JSON — what the disk, the log and the peers
// hold. A copy on the way in (a caller mutating its object after `set()`)
// and on the way out (a caller mutating what `get()` returned) keeps the
// cache, the log entries and the next op's base to themselves.
const asJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// `$type` names the collection a record belongs to and never changes: a
// whole-record write that does not name it keeps it, and neither a write nor
// a set may name another. A peer's op is applied as it is — it is already in
// the peer's log, and the collection membership it carries is theirs to keep.
const sameType = (type, id, data, current) => {
  const before = current?.$type;
  if (before === undefined) return data;
  if (data.$type === undefined) return type === 'write' ? { ...data, $type: before } : data;
  if (data.$type !== before) throw new TypeError(`Record ${id} is a ${before}; $type is immutable`);
  return data;
};

class Reference {
  #id;
  #storage = null;

  constructor(id, storage) {
    this.#id = id;
    this.#storage = storage;
  }

  async record() {
    return await this.#storage.record(this.#id);
  }
}

class Record extends Emitter {
  #id;
  #storage = null;
  #data = null;
  #changes = {};
  #shadowed = new Set();

  constructor(id, storage) {
    super();
    this.#id = id;
    this.#storage = storage;
    return this.#load();
  }

  async #load() {
    if (this.#data !== null) return this;
    const rawData = await this.#storage.get(this.#id);
    if (rawData) this.#adopt(rawData);
    return this;
  }

  #adopt(rawData) {
    this.#data = JSON.parse(JSON.stringify(rawData));
    this.#convertToReferences(this.#data);
    this.#defineProperties();
  }

  #convertToReferences(data) {
    if (!data || typeof data !== 'object') return;
    for (const key in data) {
      const value = data[key];
      if (typeof value === 'string') {
        if (this.#storage.hasRecord(value)) {
          data[key] = new Reference(value, this.#storage);
        }
      } else if (value && typeof value === 'object') {
        const isReference = value instanceof Reference;
        if (!isReference) {
          this.#convertToReferences(value);
        }
      }
    }
  }

  get id() {
    return this.#id;
  }

  #defineProperties() {
    for (const key in this.#data) {
      if (key === 'id') continue;
      if (key in this) {
        // An accessor from an earlier adopt reads #data live. A field named
        // like a member of the class (`save`, `delete`, `data`) stays
        // reachable through data() and never shadows the method.
        if (!Object.hasOwn(this, key) && !this.#shadowed.has(key)) {
          this.#shadowed.add(key);
          this.#storage.logger.warn({ event: 'record.shadowed', id: this.#id, key });
        }
        continue;
      }
      Object.defineProperty(this, key, {
        get() {
          return this.#data?.[key];
        },
        set(newValue) {
          const oldValue = this.#data?.[key];
          if (oldValue === newValue) return;
          this.#data[key] = newValue;
          this.#changes[key] = newValue;
          const delta = { [key]: newValue };
          notify(this, this.#storage.logger, 'update', this.#data, delta);
        },
        enumerable: true,
        configurable: true,
      });
    }
  }

  // The record changed in storage — a remote op, a `storage.update()`, or
  // its own save landing. The view is rebuilt from the authoritative data,
  // unsaved local edits are laid back on top (they are still pending), and
  // listeners hear about it unless the record itself caused the change.
  [REFRESH](data, delta, source) {
    if (data === null) {
      this.#data = null;
      this.#changes = {};
      if (source !== this) notify(this, this.#storage.logger, 'update', null, delta);
      return;
    }
    this.#adopt(data);
    for (const key in this.#changes) this.#data[key] = this.#changes[key];
    if (source !== this) notify(this, this.#storage.logger, 'update', this.#data, delta);
  }

  async data() {
    return this.#data;
  }

  delta() {
    return { ...this.#changes };
  }

  async save(options = {}) {
    if (Object.keys(this.#changes).length === 0) return;
    const delta = this.delta();
    await this.#storage[COMMIT]('set', this.#id, { data: delta }, { source: this, actor: options.actor });
    this.#changes = {};
  }

  /** Adds to a counter field; the storage-level `inc` with this record's id. */
  async inc(key, value = 1, options = {}) {
    await this.#storage.inc(this.#id, key, value, options);
  }

  async delete(options = {}) {
    await this.#storage.delete(this.#id, options);
    this.#data = null;
    this.#changes = {};
  }
}

class Collection {
  #storage;
  #name;

  constructor(storage, name) {
    this.#storage = storage;
    this.#name = name;
  }

  get name() {
    return this.#name;
  }

  async insert(data, options = {}) {
    const record = { ...data, $type: this.#name };
    const id = await this.#storage.insert(record, options);
    return this.#storage.record(id);
  }

  async get(id) {
    return this.#storage.get(id);
  }

  /** A cursor over this collection: `select(query).order(f).limit(n).fetch()`. */
  select(query) {
    return new Cursor(this.#storage[SOURCE], this.#name, query);
  }

  /** How many records of this collection match `query`. */
  count(query) {
    return this.select(query).count();
  }

  /** Replaces the record wholesale, stamped as this collection's. */
  async set(id, data, options) {
    if (!isPlainObject(data)) throw new TypeError('set() takes a plain object');
    return this.#storage.set(id, { ...data, $type: this.#name }, options);
  }

  async delete(id, options = {}) {
    return this.#storage.delete(id, options);
  }

  async update(id, delta, options = {}) {
    if (isPlainObject(delta) && Object.hasOwn(delta, '$type')) {
      throw new TypeError('$type is immutable; update() may not name it');
    }
    return this.#storage.update(id, delta, options);
  }

  async record(id) {
    return this.#storage.record(id);
  }
}

class Storage extends Emitter {
  #path;
  #keys = null;
  #chain = null;
  #log = null;
  #records = null;
  #reaper = null;
  #sync = null;
  #cache = new Map();
  #cacheMax = DEFAULT_CACHE;
  #verify = true;
  #chained = true;
  #catalog = null;
  #catalogSave = null;
  #flushEvery = DEFAULT_FLUSH_EVERY;
  #fsi;
  #lock = null;
  #schema = null;
  #entities = null;
  #version = null;
  #snapshot = undefined;
  #schemaHash = null;
  #schemaPrevious = null;
  #lens = null;
  #ahead = 'apply';
  #held = null;
  #actor = null;
  #getId = null;
  #logger;
  #otel;
  #options;
  #nodeId = null;
  #clock = new Clock();
  #scopeOf;
  #maxSkew = DEFAULT_MAX_SKEW;
  #encrypted = false;
  #hooks;
  #inHook = 0;
  #queue = Promise.resolve();
  #closed = false;

  // The default id generator, exposed so it stays reachable and stubbable.
  // `generateUUID` never touches `this`, so the reference is safe to store
  // unbound in `#getId`.
  static generateId() {
    return generateUUID();
  }

  constructor(options = {}) {
    super();
    this.#options = options;
    this.#getId = Storage.generateId;
    this.#path = options.path || options.name || 'syncom';
    // Live Records, weakly: one the application still holds pins its cache
    // entry and follows the record; one it dropped is collected, and its
    // slot here with it.
    this.#records = new Map();
    this.#reaper = new FinalizationRegistry((id) => {
      const ref = this.#records.get(id);
      if (ref !== undefined && ref.deref() === undefined) this.#records.delete(id);
    });
    this.#logger = createLogger(options.logger);
    this.#otel = createTelemetry(options.telemetry);
    // The backend: node:fs or OPFS by default, anything with the five
    // functions when injected. `durable` wraps every write with the
    // adapter's fsync, where it has one.
    const fsi = checkFsi(options.fsi === undefined ? defaultFsi : options.fsi, 'open({ fsi })');
    this.#fsi = fsi;
    if (options.lock !== undefined && options.lock !== false && options.lock !== 'fail' && options.lock !== 'wait') {
      throw new TypeError("open({ lock }): lock must be 'fail', 'wait' or false");
    }
    if (options.durable === true) {
      if (typeof fsi.sync === 'function') this.#fsi = withSync(fsi);
      else this.#logger.debug({ event: 'durable.noop' });
    }
    // The cache keeps the last `cache.max` entries read or written (a live
    // Record pins its own); `integrity: 'lazy'` trusts a record file on the
    // cold read instead of re-verifying it against its block.
    const max = options.cache?.max;
    if (max !== undefined) {
      if (!Number.isInteger(max) || max < 1) {
        throw new TypeError('open({ cache }): cache.max must be a positive integer');
      }
      this.#cacheMax = max;
    }
    const { integrity = 'verify' } = options;
    if (integrity !== 'verify' && integrity !== 'lazy') {
      throw new TypeError("open({ integrity }): integrity must be 'verify' or 'lazy'");
    }
    // `chain: false` keeps no hash-linked log of what this node applied —
    // a hub that only replicates has nothing to audit and saves two file
    // writes per record; with no block to check against, reads are lazy.
    if (options.chain !== undefined && typeof options.chain !== 'boolean') {
      throw new TypeError('open({ chain }): chain must be a boolean');
    }
    this.#chained = options.chain !== false;
    this.#verify = this.#chained && integrity === 'verify';
    const flushEvery = options.catalog?.flushEvery;
    if (flushEvery !== undefined) {
      if (!Number.isInteger(flushEvery) || flushEvery < 1) {
        throw new TypeError('open({ catalog }): catalog.flushEvery must be a positive integer');
      }
      this.#flushEvery = flushEvery;
    }
    // The schema is kept as given (`storage.schema`) and read once into the
    // entity definitions the write path consults: validators, id fields,
    // indexes. A malformed one is refused here, not at the first write.
    const schema = options.schema ?? null;
    const normalized = normalizeSchema(schema, { validator: options.validator });
    this.#entities = normalized.entities;
    this.#schema = schema;
    this.#catalog = new Catalog({ fsi: this.#fsi, path: this.#path, entities: normalized.entities });
    // A node with a schema stamps its version on every op it makes; one
    // without stamps nothing, and nothing in hello says what it runs.
    if (schema !== null) {
      this.#version = normalized.version;
      this.#snapshot = normalized.snapshot;
      this.#ahead = normalized.ahead;
      this.#lens = createLens(normalized, this.#logger);
      // A held op lives in the log until this node runs its version;
      // retention that would drop it first makes the hold a silent loss.
      const retained = options.sync?.retention?.ops;
      if (this.#ahead === 'hold' && retained !== undefined && retained < 1000) {
        throw new TypeError("open({ schema }): ahead 'hold' needs sync.retention.ops of 1000 or more");
      }
    }
    if (options.getId !== undefined) {
      if (typeof options.getId !== 'function') throw new TypeError('open({ getId }): getId must be a function');
      this.#getId = options.getId;
    }
    // Who writes: a string, or a function asked per write (the signed-in
    // user). It rides on the op as a claim — see `actorOf`.
    if (options.actor !== undefined && typeof options.actor !== 'string' && typeof options.actor !== 'function') {
      throw new TypeError('open({ actor }): actor must be a string or a function');
    }
    this.#actor = options.actor ?? null;
    // Encrypt every record at rest by default; a per-call `{ encrypted }`
    // still overrides. Encrypted records are local — see saveData().
    this.#encrypted = options.encrypted === true;
    this.#hooks = normalizeHooks(options.hooks, STORAGE_HOOKS, 'Storage');
    const scope = options.sync?.scope;
    this.#scopeOf = typeof scope === 'function' ? scope : () => GLOBAL_SCOPE;
    // How far ahead of this node's clock a peer's stamp may be before the op
    // is refused as malformed rather than observed — see applyRemote.
    const maxSkew = options.sync?.maxSkew;
    if (maxSkew !== undefined && !(typeof maxSkew === 'number' && maxSkew > 0)) {
      throw new TypeError('open({ sync }): maxSkew must be a positive number of milliseconds (Infinity to disable)');
    }
    if (maxSkew !== undefined) this.#maxSkew = maxSkew;
    return this.#init();
  }

  async #init() {
    // One instance per directory, first: a second one would mint the seqs
    // this one is about to. `lock: false` is for a caller that coordinates.
    const { lock = 'fail' } = this.#options;
    if (lock !== false) this.#lock = await acquireLock({ fsi: this.#fsi, path: this.#path, mode: lock });
    try {
      await this.#open();
    } catch (error) {
      await this.#lock?.release();
      throw error;
    }
    return this;
  }

  async #open() {
    const fsi = this.#fsi;
    this.#keys = await loadKeys(`${this.#path}/keys`, { fsi });
    this.#chain = this.#chained ? await new Blockchain(`${this.#path}/blockchain`, { fsi }) : null;
    this.#log = await new OpLog(this.#path, {
      ...this.#options.sync?.log,
      retention: this.#options.sync?.retention,
      logger: this.#logger,
      telemetry: this.#otel,
      fsi,
      // A roll seals only what #commit / #applyRemote marked applied — see
      // OpLog.applied: the tail a reopen replays must hold every batch whose
      // records may not have been written.
      sealApplied: true,
    });
    // The clock picks up where the log left off: every stamp this node ever
    // logged is below what it will stamp next, whatever the wall clock says.
    this.#clock.observe(this.#log.latestTs);
    await this.#loadIdentity();
    await this.#loadSchema();
    await this.#loadCatalog();
    await this.#replayTail();
    await this.#replayHeld();
    this.#sync = await new SyncManager(this, this.#options.sync);
    this.#initCollections();
  }

  // The catalog is derived from the records: the persisted one is reused
  // when the log can say what changed since it was saved (those records are
  // re-read), rebuilt from a scan of `data/` otherwise — a first open, a
  // stamp from another epoch or below the floor, other indexes.
  async #loadCatalog() {
    const saved = await this.#catalog.load();
    const tail = saved === null ? null : this.#log.since(saved.stamp);
    if (tail === null) {
      this.#logger.debug({ event: 'catalog.rebuild' });
      for (const name of await this.#fsi.list(`${this.#path}/data`)) {
        if (name.endsWith('.json')) await this.#index(name.slice(0, -5));
      }
      await this.#catalog.save(this.#log.lastEventId);
      return;
    }
    const touched = new Set();
    for (const { op } of tail) if (typeof op.id === 'string') touched.add(op.id);
    for (const id of touched) await this.#index(id);
    if (touched.size > 0) await this.#catalog.save(this.#log.lastEventId);
  }

  // Puts what the record `id` is now; a record that fails its integrity
  // check is left out, like a replay leaves it alone.
  async #index(id) {
    let entry;
    try {
      entry = await this.#load(id);
    } catch (error) {
      this.#logger.warn({ event: 'catalog.skipped', id, err: error });
      return;
    }
    this.#catalog.put(id, await this.#rowOf(id, entry));
  }

  // The catalog's view of an entry: what `put` takes. Derived state never
  // fails a write: a lens that throws (a migration returning no object)
  // indexes the raw data here and throws on the read, where it is reported.
  async #rowOf(id, entry) {
    if (entry === null) return null;
    if (entry.encrypted) return { type: entry.data?.$type, v: null, encrypted: true };
    if (!isAlive(entry)) return null;
    let data = entry.data;
    try {
      data = await this.#view(id, entry);
    } catch (error) {
      this.#logger.warn({ event: 'catalog.lens', id, err: error });
    }
    return { type: entry.data.$type, v: entry.meta.v ?? null, data };
  }

  // The persisted catalog is written every `flushEvery` puts and at close,
  // off the mutation queue: the rows and the stamp are taken as the save
  // starts and the write runs while writes go on, one save at a time. What
  // lands in between is caught up from the log on the next open.
  #flushCatalog() {
    if (this.#catalogSave !== null || this.#catalog.dirty < this.#flushEvery) return;
    this.#catalogSave = this.#catalog
      .save(this.#log.lastEventId)
      .catch((error) => this.#logger.warn({ event: 'catalog.save', err: error }))
      .finally(() => {
        this.#catalogSave = null;
      });
  }

  // The Record the application holds for `id`, if it still does.
  #live(id) {
    const ref = this.#records.get(id);
    if (ref === undefined) return undefined;
    const record = ref.deref();
    if (record === undefined) this.#records.delete(id);
    return record;
  }

  // The newest entries stay; a live Record pins its own. Absent ids are
  // never cached — the catalog knows what exists.
  #remember(id, entry) {
    this.#cache.delete(id);
    this.#cache.set(id, entry);
    if (this.#cache.size <= this.#cacheMax) return;
    for (const key of this.#cache.keys()) {
      if (this.#cache.size <= this.#cacheMax) break;
      if (this.#live(key) !== undefined) continue;
      this.#cache.delete(key);
    }
  }

  // `schema.json` remembers the version (and the snapshot's hash) this
  // directory last ran: a change since is reported as `schemaInfo.previous`
  // — a fact the caller reads after open, where an event at open would find
  // no listener yet. The hash is of the snapshot's JSON; metaschema's
  // `model.toJSON()` is deterministic, a hand-written one is as stable as
  // its author keeps it.
  async #loadSchema() {
    if (this.#version === null) return;
    if (this.#snapshot !== undefined) this.#schemaHash = await calculateHash(this.#snapshot);
    const version = this.#version;
    const hash = this.#schemaHash;
    let stored = null;
    if (await this.#fsi.exists(this.#path, SCHEMA_FILE)) {
      const raw = JSON.parse(await this.#fsi.read(this.#path, SCHEMA_FILE));
      if (isPlainObject(raw) && Number.isInteger(raw.version)) {
        stored = { version: raw.version, hash: typeof raw.hash === 'string' ? raw.hash : null, migrated: raw.migrated };
      }
    }
    if (stored && stored.version === version && stored.hash === hash) return;
    if (stored) {
      this.#schemaPrevious = { version: stored.version, hash: stored.hash };
      const event = stored.version === version ? 'schema.changed' : 'schema.upgrade';
      this.#logger[stored.version > version ? 'warn' : 'info']({ event, from: stored.version, to: version });
      // Holding ops from a version this directory already ran makes no
      // sense: its own records are of that version.
      if (stored.version > version && this.#ahead === 'hold') {
        throw new Error(
          `Schema version ${version} is below the ${stored.version} this directory ran; ahead 'hold' cannot downgrade`,
        );
      }
    }
    // `migrated`: when this version first ran here — kept across a snapshot
    // change of the same version.
    const migrated = stored?.version === version && Number.isInteger(stored.migrated) ? stored.migrated : Date.now();
    await this.#fsi.write(this.#path, SCHEMA_FILE, JSON.stringify({ version, migrated, hash }));
  }

  /**
   * The schema this node runs — `{ version, hash }`, what hello carries —
   * plus `previous`: what `schema.json` held before this open when that was
   * another version or hash (an upgrade to run migrations after), `null`
   * otherwise. `null` without a schema.
   */
  get schemaInfo() {
    if (this.#version === null) return null;
    return { version: this.#version, hash: this.#schemaHash, previous: this.#schemaPrevious, held: this.#held };
  }

  // Ops held for a newer schema version (`ahead: 'hold'`) that this node
  // now runs: applied in log order, as if they had just arrived. The log
  // keeps them flagged, so a later open applies them again as no-ops; what
  // compaction dropped before the upgrade is counted as lost, once.
  async #replayHeld() {
    if (this.#version === null) return;
    const lost = this.#log.droppedHeld;
    const entries = this.#log.held().filter((entry) => entry.held <= this.#version);
    if (entries.length === 0 && lost === 0) return;
    const touched = new Map();
    for (const { seq, op } of entries) {
      this.#clock.observe(op.ts);
      let current;
      try {
        current = touched.get(op.id) ?? (await this.#load(op.id));
      } catch (error) {
        this.#logger.warn({ event: 'replay.skipped', id: op.id, err: error });
        continue;
      }
      if (current?.encrypted) continue;
      const { entry, changed } = applyOp(current, op);
      if (changed) touched.set(op.id, { ...entry, seq });
    }
    if (touched.size > 0) {
      await this.#persistBatch(touched, entries[0].seq, entries[entries.length - 1].seq);
    }
    if (lost > 0) await this.#log.resetDroppedHeld();
    this.#held = { replayed: touched.size, lost };
    this.#logger.info({ event: 'schema.held', ...this.#held });
  }

  // What a record reads as: itself when it is of this node's version (or
  // newer, or there is no schema), the lens of it otherwise, computed once
  // per cached entry. Replication (`snapshot`, `applyOp`) reads the raw data.
  async #view(id, entry) {
    if (this.#lens === null || (entry.meta.v ?? 1) >= this.#version) return entry.data;
    return (entry.view ??= await this.#lens(id, entry.data, entry.meta.v ?? 1));
  }

  /**
   * Rewrites every record of an older version as this one, through the
   * lens: a whole-record write of the view, then the counters added back
   * (a write resets them). One designated node runs it; peers receive
   * ordinary ops. Idempotent — a record already of this version is left
   * alone. `entities` limits it to those collections; `batch` is how many
   * records go between turns of the event loop.
   */
  async migrate({ entities = null, batch = 100, actor } = {}) {
    if (this.#version === null) throw new TypeError('migrate() needs open({ schema })');
    if (entities !== null && !(Array.isArray(entities) && entities.every((name) => typeof name === 'string'))) {
      throw new TypeError('migrate({ entities }) takes an array of entity names');
    }
    if (!Number.isInteger(batch) || batch < 1) throw new TypeError('migrate({ batch }) takes a positive integer');
    const result = { migrated: 0, counters: 0 };
    let since = 0;
    for (const id of await this.list()) {
      const entry = await this.#load(id);
      if (!entry || entry.encrypted || (entry.meta.v ?? 1) >= this.#version) continue;
      if (entities !== null && !entities.includes(entry.data.$type)) continue;
      const view = await this.#view(id, entry);
      const data = {};
      const counters = {};
      for (const key of Object.keys(view)) {
        if (isCounter(entry.meta, key)) counters[key] = entry.data[key];
        else data[key] = view[key];
      }
      await this[COMMIT]('write', id, { data }, { actor });
      for (const key of Object.keys(counters)) {
        await this[COMMIT]('inc', id, { key, value: counters[key] }, { actor });
        result.counters++;
      }
      result.migrated++;
      if (++since >= batch) {
        since = 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return result;
  }

  // The node id is minted once and never changes; the own sequence numbers
  // (one per scope) live in the log's vector, which survives compaction — so
  // a seq is durable the moment its op is appended, before anyone hears of it.
  async #loadIdentity() {
    if (await this.#fsi.exists(this.#path, NODE_FILE)) {
      const raw = await this.#fsi.read(this.#path, NODE_FILE);
      this.#nodeId = JSON.parse(raw).id;
    } else {
      this.#nodeId = generateUUID();
      await this.#fsi.write(this.#path, NODE_FILE, JSON.stringify({ id: this.#nodeId }));
    }
  }

  // The log is written before the record files are: a crash in between
  // leaves ops the records do not reflect yet. Re-applying the unsealed tail
  // is idempotent, so replaying more than necessary costs only time.
  async #replayTail() {
    const tail = this.#log.tail();
    if (tail.length === 0) return;
    const otel = this.#otel;
    if (!otel.enabled) return void (await this.#replay(tail));
    const started = now();
    try {
      const attributes = { 'syncom.ops.count': tail.length };
      await traced(
        otel,
        'syncom.replay',
        attributes,
        () => this.#replay(tail),
        (records) => ({ 'syncom.records': records }),
      );
    } finally {
      otel.recordReplay(now() - started);
    }
  }

  // Returns how many records the tail touched.
  async #replay(tail) {
    const touched = new Map();
    for (const { seq, op, skipped } of tail) {
      // Accepted but not applied when it arrived (beforeApply said no).
      if (skipped) continue;
      this.#clock.observe(op.ts);
      let current;
      try {
        current = touched.get(op.id) ?? (await this.#load(op.id));
      } catch (error) {
        // A record that fails its integrity check is left as it is: the next
        // read reports it, which is where the caller expects to hear about it.
        this.#logger.warn({ event: 'replay.skipped', id: op.id, err: error });
        continue;
      }
      if (current?.encrypted) continue;
      const { entry, changed } = applyOp(current, op);
      if (changed) touched.set(op.id, { ...entry, seq });
    }
    if (touched.size > 0) await this.#persistBatch(touched, tail[0].seq, tail[tail.length - 1].seq);
    this.#log.applied(tail[0].seq, tail[tail.length - 1].seq);
    return touched.size;
  }

  #initCollections() {
    for (const name of this.#entities.keys()) this[name] = new Collection(this, name);
  }

  get schema() {
    return this.#schema;
  }

  /** The backend every file of this storage goes through — the adapter given to `open()`, or the platform's. */
  get fsi() {
    return this.#fsi;
  }

  // What a Cursor reads through: the catalog, and a record as it reads —
  // lensed, without the read hooks (like `snapshot` and `swap`).
  get [SOURCE]() {
    const catalog = this.#catalog;
    return {
      logger: this.#logger,
      candidates: (entity, query) => catalog.candidates(entity, query),
      ids: (entity) => catalog.ids(entity),
      row: (id) => catalog.row(id),
      indexed: (entity) => catalog.indexed(entity),
      subscribe: (entity, fn) => catalog.subscribe(entity, fn),
      load: async (id) => {
        const entry = await this.#load(id);
        if (entry === null || entry.encrypted || !isAlive(entry)) return null;
        return this.#view(id, entry);
      },
    };
  }

  // The unique keys `entry` would collide on, as the catalog knows them.
  async #conflicts(id, entry) {
    const def = this.#definitionOf(entry.data);
    if (!def || def.unique.length === 0) return [];
    return this.#catalog.uniqueConflicts(def.name, id, await this.#view(id, entry));
  }

  // The entity definition a record belongs to, by its `$type`.
  #definitionOf(data) {
    const type = data.$type;
    return typeof type === 'string' ? this.#entities.get(type) : undefined;
  }

  /**
   * Runs `data` through an entity's validator the way a write would —
   * under its id field, without `$type` — and returns what the validator
   * gives back (defaults filled, aliases resolved). Rejects with a
   * ValidationError; the storage is untouched either way.
   */
  async check(entity, data) {
    const def = this.#entities.get(entity);
    if (!def) throw new TypeError(`Unknown entity ${entity}`);
    if (!isPlainObject(data)) throw new TypeError('check() takes a plain object');
    if (!def.validator) return data;
    const id = def.idField !== false && typeof data[def.idField] === 'string' ? data[def.idField] : null;
    return def.validator(project(def, id, data));
  }

  /** This node's stable identity — the `origin` of every op it creates. */
  get nodeId() {
    return this.#nodeId;
  }

  get path() {
    return this.#path;
  }

  get log() {
    return this.#log;
  }

  get logger() {
    return this.#logger;
  }

  /**
   * The telemetry writer built from `options.telemetry` — what SyncManager
   * and OpLog record through. Opaque: its shape is an implementation detail.
   */
  get telemetry() {
    return this.#otel;
  }

  get sync() {
    return this.#sync;
  }

  /** The highest per-origin seq applied here — what a peer compares against. */
  get vector() {
    return this.#log.vector;
  }

  // Every mutation passes through one queue: the chain's tail pointer, the
  // log's seq counter and a record's entry are all read-then-written, and two
  // interleaved writers would race all three.
  #run(task) {
    if (this.#closed) return Promise.reject(new Error('Storage is closed'));
    // A write or apply hook runs inside the queue; a write it issues would
    // wait for the hook that waits for it. Refused here, where the deadlock
    // would otherwise begin. Read hooks run outside the queue and are not
    // counted — a write from one simply queues.
    if (this.#inHook > 0) {
      return Promise.reject(
        new Error(
          'Cannot write to the storage from inside a hook: the write would wait for the hook that waits for it',
        ),
      );
    }
    const result = this.#queue.then(task, task);
    this.#queue = result.catch(() => {});
    return result;
  }

  // Every hook that runs inside the mutation queue goes through here, so the
  // guard above knows one is running. Returns what the hook returns; a throw
  // is a HookError. The read hooks call runHook directly.
  async #hook(name, ...args) {
    if (!this.#hooks[name]) return undefined;
    this.#inHook++;
    try {
      return await runHook(this.#hooks, name, ...args);
    } finally {
      this.#inHook--;
    }
  }

  #emitUpdate(id, data, delta, source = null) {
    const record = this.#live(id);
    if (record) record[REFRESH](data, delta, source);
  }

  #scope(id, data) {
    const scope = this.#scopeOf(id, data);
    if (typeof scope !== 'string' || scope.length === 0 || scope === GLOBAL_SCOPE) return GLOBAL_SCOPE;
    if (!isStreamName(scope)) {
      throw new TypeError(`sync.scope(${id}) returned ${JSON.stringify(scope)}: a scope is a short name without '@'`);
    }
    return scope;
  }

  // The actor of one write: the call's own, else the storage's (asked when
  // it is a function), else none. A string on the op, never in the record.
  async #actorOf(given) {
    const actor = given !== undefined ? given : typeof this.#actor === 'function' ? await this.#actor() : this.#actor;
    return actor === null || actor === undefined ? null : String(actor);
  }

  // ---------------------------------------------------------------------
  // Entries on disk: `{ data, meta, encrypted, timestamp, block }`. `meta` is
  // the replication bookkeeping (see ops.js); an encrypted entry has none —
  // it is stored as ciphertext for this node's key alone and is not
  // replicated.

  async #load(id) {
    if (!isRecordId(id)) return null;
    const cached = this.#cache.get(id);
    if (cached !== undefined) {
      this.#remember(id, cached);
      return cached;
    }
    const dataDir = `${this.#path}/data`;
    const exists = await this.#fsi.exists(dataDir, `${id}.json`);
    if (!exists) return null;
    const raw = await this.#fsi.read(dataDir, `${id}.json`);
    const { data, meta, encrypted, block } = JSON.parse(raw);
    if (this.#verify) {
      const isValid = await this.validate(id, data, block);
      if (!isValid) throw new Error(`Storage record ${id} is invalid`);
    }
    const entry = encrypted
      ? { data: await decrypt(data, this.#keys.privateKey), meta: null, encrypted: true, block }
      : { data, meta, encrypted: false, block };
    this.#remember(id, entry);
    return entry;
  }

  // The one seam where a record's file and its cached entry change, for the
  // local path and a peer's batch alike — so the catalog follows here.
  async #writeEntry(id, entry, blockHash) {
    const stored = { data: entry.data, meta: entry.meta, encrypted: false, timestamp: Date.now(), block: blockHash };
    await this.#fsi.write(`${this.#path}/data`, `${id}.json`, JSON.stringify(stored));
    const cached = { data: entry.data, meta: entry.meta, encrypted: false, block: blockHash };
    this.#remember(id, cached);
    this.#catalog.put(id, await this.#rowOf(id, cached));
  }

  // One chain block per applied batch: `records` maps every touched id to
  // the hash of its data after the batch, `from`/`to` are the log positions.
  async #persistBatch(touched, fromSeq, toSeq) {
    let blockHash = null;
    if (this.#chain) {
      const records = {};
      for (const [id, entry] of touched) records[id] = await calculateHash(entry.data);
      const from = this.#log.formatId(fromSeq);
      const to = this.#log.formatId(toSeq);
      blockHash = await this.#chain.addBlock({ records, from, to });
    }
    for (const [id, entry] of touched) await this.#writeEntry(id, entry, blockHash);
    return blockHash;
  }

  #observe(stamp) {
    if (stamp) this.#clock.observe(stamp[0]);
  }

  // The register/counter rule, refused with a hint at the right call.
  #refuse(id, rejected) {
    if (rejected.length === 0) return;
    const [{ field, reason }] = rejected;
    const hint = reason === 'counter' ? 'a counter; use inc()' : 'a register; use update()';
    throw new Error(`Field ${field} of record ${id} is ${hint}`);
  }

  // A peer's op that would leave the record invalid under this node's
  // schema: `{ entity, issues }`, or null. The verdict is all this node takes
  // from its validator — the op is the peer's, already in its log, and is
  // never rewritten here; the same schema gives the same verdict everywhere.
  async #invalid(op, entry) {
    const def = this.#definitionOf(entry.data);
    if (!def?.validator || !VALIDATED.has(op.type)) return null;
    try {
      await def.validator(project(def, op.id, await this.#view(op.id, entry)));
      return null;
    } catch (error) {
      return { entity: def.name, issues: error.issues };
    }
  }

  // ---------------------------------------------------------------------
  // The one local write path. Builds the op, applies it, logs it (durable
  // seq), persists the entry, then announces it.

  [COMMIT](type, id, payload, options = {}) {
    if (!isRecordId(id)) return Promise.reject(invalidId(id));
    return this.#run(() => {
      const otel = this.#otel;
      if (!otel.enabled) return this.#commit(type, id, payload, options);
      return this.#tracedCommit(otel, type, id, payload, options);
    });
  }

  // The span starts when the write RUNS, not when it was queued: waiting on
  // `#run` is the caller's contention, not the write's cost. It ends after
  // the `change` listeners, because that is what the caller awaits. A merge
  // — one commit per snapshot record during a bootstrap — is counted but not
  // spanned, or a bootstrap would open thousands of spans.
  async #tracedCommit(otel, type, id, payload, options) {
    const started = now();
    let result = 'error';
    try {
      const task = () => this.#commit(type, id, payload, options);
      const op =
        type === 'merge'
          ? await task()
          : await traced(otel, 'syncom.commit', { 'syncom.op.type': type, 'syncom.record.id': id }, task, (op) => ({
              'syncom.result': commitResult(op),
              'syncom.scope': op ? (op.scope ?? GLOBAL_SCOPE) : undefined,
            }));
      result = commitResult(op);
      return op;
    } finally {
      otel.recordCommit(type, result, now() - started);
    }
  }

  async #commit(type, id, payload, options = {}) {
    const { source = null, via = null, from = null, encrypted = false, actor, expect = null } = options;
    const current = await this.#load(id);
    if (encrypted && current && !current.encrypted) {
      throw new Error(`Record ${id} is replicated and cannot become encrypted`);
    }
    // A swap's expectation, checked here — inside the queue — against the
    // record as it reads: a live one, or an encrypted one's data.
    if (expect !== null) {
      let seen = null;
      if (current?.encrypted) seen = current.data;
      else if (current && isAlive(current)) seen = await this.#view(id, current);
      if (!seen) throw new Error(`Record ${id} not found`);
      for (const key of Object.keys(expect)) if (seen[key] !== expect[key]) return MISMATCH;
    }
    // The payload is taken as JSON — a copy, like the disk and the peers
    // hold it — before anything keeps a reference to it.
    if (payload.data !== undefined || payload.meta !== undefined) {
      payload = { ...payload, data: asJson(payload.data), meta: asJson(payload.meta) };
      if (payload.data === undefined) delete payload.data;
      if (payload.meta === undefined) delete payload.meta;
    }
    // Sealed: this write is encrypted, or the record already is. An
    // encrypted record has no op log — writes to it stay local.
    const sealed = encrypted || current?.encrypted === true;
    const visible = current && (current.encrypted || isAlive(current)) ? current.data : null;
    const who = type === 'merge' ? null : await this.#actorOf(actor);
    const ctx = {
      type,
      id,
      ...payload,
      current: visible,
      encrypted: sealed,
      source,
      via,
      from,
      v: this.#version,
      actor: who,
    };
    const replacement = await this.#hook('beforeWrite', ctx);
    if (replacement !== undefined) {
      if (type !== 'write' && type !== 'set') {
        throw new TypeError('beforeWrite may only replace data for write and set');
      }
      if (!isPlainObject(replacement)) throw new TypeError('beforeWrite must return a plain object or undefined');
      payload = { ...payload, data: replacement };
      ctx.data = replacement;
    }
    if (sealed) {
      // Set and write map onto the encrypted save; a counter needs ops.
      let data;
      if (type === 'write') data = payload.data;
      else if (type === 'set') data = { ...(current?.data ?? {}), ...payload.data };
      else if (type === 'delete' || type === 'purge') data = null;
      else throw new Error(`Record ${id} is encrypted; ${type} needs a replicated record`);
      if (data === null) await this.#removeEncrypted(id);
      else await this.#writeEncrypted(id, data);
      try {
        await this.#hook('afterWrite', ctx, null);
      } finally {
        this.#emitUpdate(id, data, data === null ? {} : { ...data }, source);
      }
      return undefined;
    }
    if (type === 'write' || type === 'set') {
      ctx.data = sameType(type, id, payload.data, visible);
      payload = { ...payload, data: ctx.data };
    }
    const data = payload.data ?? current?.data ?? {};
    const scope = this.#scope(id, data);
    // Stamp above everything this node already holds for the record — its
    // entry and, for a merge, the one being joined — so a local write never
    // sorts below state the node knows about and is silently dropped. The
    // log seeds the clock at open; this covers what the log no longer has.
    this.#observe(latestClock(current?.meta));
    if (type === 'merge') this.#observe(latestClock(payload.meta));
    const op = { origin: this.#nodeId, seq: 0, ts: this.#clock.now(), type, id };
    if (scope !== GLOBAL_SCOPE) op.scope = scope;
    if (from) op.from = from;
    // The writer's schema version rides on the op: what a reader on another
    // version lenses the record through. A merge carries the joined entry's
    // own `meta.v` instead.
    if (this.#version !== null && type !== 'merge') op.v = this.#version;
    if (who !== null) op.actor = who;
    // Sequence numbers run per stream (see vector.js opKey): the scope's,
    // or the bootstrap stream for a merge.
    op.seq = this.#log.seqOf(opKey(op)) + 1;
    if (payload.data !== undefined) op.data = payload.data;
    if (payload.meta !== undefined) op.meta = payload.meta;
    if (payload.key !== undefined) op.key = payload.key;
    if (payload.value !== undefined) op.value = payload.value;

    let { entry, changed, delta, rejected } = applyOp(current, op);
    this.#refuse(id, rejected);
    if (!changed) return null;
    // Validated as the record will be after the op, and what the validator
    // gives back (defaults, aliases, stripped keys) becomes the op: the
    // peers receive the validated record, not the one that was typed. A
    // throw leaves nothing durable. An `inc` is checked but carries no data
    // to fold.
    const def = this.#definitionOf(entry.data);
    if (def?.validator && VALIDATED.has(type)) {
      // Through the lens: a record of an older version is validated as it
      // reads, and a set is folded against how it read before the write.
      const output = await def.validator(project(def, id, await this.#view(id, entry)));
      if (type !== 'inc') {
        const validated = unproject(def, output, entry.data.$type);
        if (type === 'write') op.data = validated;
        else op.data = foldSet(op.data, validated, visible ? project(def, id, await this.#view(id, current)) : {});
        ctx.data = op.data;
        ({ entry, changed, delta, rejected } = applyOp(current, op));
        this.#refuse(id, rejected);
        if (!changed) return null;
      }
    }
    // A unique key another record holds: refused here, where one writer
    // can be told. Two concurrent writers on two nodes cannot be — see the
    // `conflict` event on the apply path.
    if (VALIDATED.has(type)) {
      const conflicts = await this.#conflicts(id, entry);
      if (conflicts.length > 0) {
        const issues = conflicts.map(({ fields, other }) => ({
          path: fields,
          message: `is not unique (held by ${other})`,
          code: 'unique',
          conflict: other,
        }));
        throw new ValidationError(entry.data.$type, issues);
      }
    }

    const [{ seq: position }] = await this.#log.append([op]);
    let blockHash = null;
    if (this.#chain) {
      const hash = await calculateHash(entry.data);
      blockHash = await this.#chain.addBlock({ id, hash, from: this.#log.formatId(position) });
    }
    await this.#writeEntry(id, entry, blockHash);
    this.#log.applied(position);

    this.#flushCatalog();

    const alive = isAlive(entry);
    // afterWrite sees a durable op; whatever it does, the record views and
    // the `change` listeners (the relay among them) hear about the op.
    try {
      await this.#hook('afterWrite', ctx, op);
    } finally {
      this.#emitUpdate(id, alive ? entry.data : null, delta, source);
      // Announced after everything is durable. `via` is null for a local
      // write; a merge made from a peer's snapshot names that peer, so the
      // relay does not hand its own state straight back to it.
      notify(this, this.#logger, 'change', op, via);
    }
    return op;
  }

  // ---------------------------------------------------------------------
  // Public API

  // Encrypted at rest for THIS node's key: written directly, outside the op
  // log, because no peer could read it. Reached only through #commit.
  async #writeEncrypted(id, data) {
    const record = await encrypt(data, this.#keys.publicKey);
    const blockHash = this.#chain ? await this.#chain.addBlock({ id, hash: await calculateHash(record) }) : null;
    const entry = { data: record, meta: null, encrypted: true, timestamp: Date.now(), block: blockHash };
    await this.#fsi.write(`${this.#path}/data`, `${id}.json`, JSON.stringify(entry));
    this.#remember(id, { data, meta: null, encrypted: true, block: blockHash });
    this.#catalog.put(id, { type: data?.$type, v: null, encrypted: true });
    this.#flushCatalog();
  }

  async #removeEncrypted(id) {
    await this.#fsi.remove(`${this.#path}/data`, `${id}.json`);
    this.#cache.delete(id);
    this.#catalog.put(id, null);
    this.#flushCatalog();
  }

  async saveData(id, data, options = {}) {
    const { encrypted = this.#encrypted, actor } = options;
    await this[COMMIT]('write', id, { data }, { encrypted, actor });
  }

  async loadData(id) {
    return this.get(id);
  }

  async validate(idOrOptions = {}, data, blockHash) {
    // Two shapes share one method: `validate(id, data, blockHash)` checks a
    // single record against its block, anything else walks the chain. A record
    // id is always a string, so that is the discriminator.
    const isChainValidation = typeof idOrOptions !== 'string' && !data && !blockHash;
    if (this.#chain === null) {
      const error = new TypeError('open({ chain: false }): this storage keeps no chain to validate against');
      error.code = 'NO_CHAIN';
      throw error;
    }
    if (isChainValidation) {
      return await this.#chain.validate(idOrOptions);
    }
    const id = idOrOptions;
    try {
      const block = await this.#chain.readBlock(blockHash);
      const expectedHash = await calculateHash(data);
      if (!block) return false;
      // The block must be the one it is filed under: a file planted beside
      // the chain with the right `records` map is not a commit.
      if ((await calculateHash(block)) !== blockHash) return false;
      // A local write commits `{ id, hash }`; a replicated batch commits
      // `{ records: { [id]: hash } }` for every record it touched.
      if (block.data.records) return block.data.records[id] === expectedHash;
      return block.data.hash === expectedHash && block.data.id === id;
    } catch {
      return false;
    }
  }

  async insert(data, options = {}) {
    // `getId` may be sync or async — both call sites already await this.
    const id = await this.#getId();
    if (!isRecordId(id)) {
      const error = invalidId(id);
      error.message = `open({ getId }): ${error.message}`;
      throw error;
    }
    await this.saveData(id, data, options);
    return id;
  }

  async has(id) {
    const entry = await this.#load(id);
    return entry !== null && (entry.encrypted || isAlive(entry));
  }

  /** Whether `id` is a live record here — answered from the catalog, no I/O. */
  hasRecord(id) {
    return this.#catalog.has(id) || this.#live(id) !== undefined;
  }

  // The raw read: what `get` returns before its hooks. `swap` compares
  // against this, so a redacting afterRead cannot break its CAS.
  // The raw read, as a copy: what `get` returns before its hooks, what
  // `swap` compares against. `getCachedData()` and `snapshot()` are the raw
  // objects, for callers that know not to touch them.
  async #read(id) {
    const entry = await this.#load(id);
    if (entry === null) return null;
    if (entry.encrypted) return asJson(entry.data);
    return isAlive(entry) ? asJson(await this.#view(id, entry)) : null;
  }

  async get(id) {
    await runHook(this.#hooks, 'beforeRead', { id });
    const data = await this.#read(id);
    const replaced = await runHook(this.#hooks, 'afterRead', { id }, data);
    return replaced === undefined ? data : replaced;
  }

  /** Every live record id, sorted — tombstones excluded, encrypted records included. From the catalog: no I/O. */
  async list() {
    return this.#catalog.ids();
  }

  async set(id, data, options = {}) {
    if (!isPlainObject(data)) throw new TypeError('set() takes a plain object');
    await this.saveData(id, data, options);
  }

  async delete(id, { actor } = {}) {
    await this[COMMIT]('delete', id, {}, { actor });
    this.#records.delete(id);
  }

  /**
   * Forgets a record for good: a `purge` op (which no later write revives)
   * and a scrub of every entry of the id from this node's log — peers do
   * the same when it reaches them. The chain holds hashes only. Idempotent.
   */
  async purge(id, { actor } = {}) {
    await this[COMMIT]('purge', id, {}, { actor });
    await this.#log.scrub(id);
    this.#records.delete(id);
  }

  async update(id, delta, { actor } = {}) {
    if (!(await this.has(id))) throw new Error(`Record ${id} not found`);
    if (!isPlainObject(delta)) throw new TypeError('update() takes a plain object');
    await this[COMMIT]('set', id, { data: delta }, { actor });
  }

  /** Adds `value` to counter field `key` — the commutative alternative to update(). */
  async inc(id, key, value = 1, { actor } = {}) {
    if (typeof key !== 'string') throw new TypeError('inc() takes a field name');
    if (!Number.isFinite(value)) throw new TypeError('inc() takes a finite number');
    await this[COMMIT]('inc', id, { key, value }, { actor });
  }

  /**
   * Compare-and-swap: writes `changes` only if the fields of `prev` still
   * hold their values — compared inside the mutation queue, against the
   * record as it reads (the lens applied, the read hooks not run), so two
   * concurrent swaps on one expectation cannot both pass.
   */
  async swap(id, changes, prev, { actor } = {}) {
    if (!isPlainObject(changes) || !isPlainObject(prev)) throw new TypeError('swap() takes two plain objects');
    const op = await this[COMMIT]('set', id, { data: changes }, { actor, expect: prev });
    return op !== MISMATCH;
  }

  async record(id) {
    let record = this.#live(id);
    if (record === undefined) {
      record = await new Record(id, this);
      this.#records.set(id, new WeakRef(record));
      this.#reaper.register(record, id);
    }
    return record;
  }

  getCachedData(id) {
    const entry = this.#cache.get(id);
    if (!entry) return null;
    if (entry.encrypted) return entry.data;
    return isAlive(entry) ? entry.data : null;
  }

  // ---------------------------------------------------------------------
  // Replication

  /**
   * Applies ops received from a peer. Each origin's ops must arrive in seq
   * order: an op already covered by this node's vector is a duplicate and is
   * skipped, one that skips ahead is a gap and is skipped too (the peer will
   * be asked again from the last position). Accepted ops are logged, whether
   * or not they changed anything, so the vector advances and they are not
   * offered again; `via` names the link they arrived on, so the relay does
   * not echo them straight back.
   */
  applyRemote(ops, options = {}) {
    return this.#run(() => {
      const otel = this.#otel;
      if (!otel.enabled) return this.#applyRemote(ops, options);
      return this.#tracedApply(otel, ops, options);
    });
  }

  async #tracedApply(otel, ops, options) {
    const started = now();
    let result = null;
    try {
      const attributes = { 'syncom.ops.count': ops.length };
      result = await traced(
        otel,
        'syncom.apply',
        attributes,
        () => this.#applyRemote(ops, options),
        (r) => ({
          'syncom.ops.applied': r.applied,
          'syncom.ops.skipped': r.skipped,
          'syncom.ops.duplicates': r.duplicates,
          'syncom.ops.gaps': r.gaps,
          'syncom.ops.malformed': r.malformed,
        }),
      );
      return result;
    } finally {
      otel.recordApply(result ?? { applied: 0, skipped: 0, duplicates: 0, gaps: 0, malformed: 0 }, now() - started);
    }
  }

  async #applyRemote(ops, { via = null, scopes = null, peer = null, adoptFrom = null } = {}) {
    {
      const accepted = [];
      const touched = new Map();
      const deltas = new Map();
      const vector = this.#log.vector;
      const now = Date.now();
      const horizon = now + this.#maxSkew;
      let adopted = null;
      let skipped = null;
      let held = null;
      let purged = null;
      let duplicates = 0;
      let gaps = 0;
      let malformed = 0;
      for (const op of ops) {
        if (!wellFormed(op)) {
          const shape = isPlainObject(op) ? { origin: op.origin, seq: op.seq, type: op.type, id: op.id } : typeof op;
          this.#logger.warn({ event: 'sync.op.malformed', op: shape });
          this.#otel.recordMalformed();
          malformed++;
          continue;
        }
        if (op.ts > horizon) {
          // Refused, not observed: this node's clock stays where it is, and
          // the peer hears of it through the `error` event and the count.
          this.#logger.warn({ event: 'sync.op.skew', origin: op.origin, seq: op.seq, ts: op.ts, ahead: op.ts - now });
          this.#otel.recordMalformed();
          malformed++;
          const message = `Op ${op.origin}:${op.seq} is stamped ${op.ts - now} ms ahead of this node (maxSkew ${this.#maxSkew})`;
          notify(this, this.#logger, 'error', Object.assign(new Error(message), { op, code: 'SKEW' }));
          continue;
        }
        const isAdvance = op.type === 'advance';
        if (op.origin === this.#nodeId || vectorHas(vector, op)) {
          duplicates++;
          continue;
        }
        if (!vectorNext(vector, op)) {
          gaps++;
          continue;
        }
        if (isAdvance) {
          // The peer joined a snapshot covering these seqs; so, through its
          // merges, have we — when the op is that peer's own and came down
          // its feed (the merges came first), for the scopes we take from
          // it. Pushed or relayed, an advance is logged and passed on but
          // grants nothing: the vector is the one thing a peer must not be
          // able to move on another node's behalf.
          if (adoptFrom !== null && op.origin === adoptFrom) {
            for (const key of Object.keys(op.vector)) {
              const seq = op.vector[key];
              const scope = keyScope(key);
              const inScope = scope === null || !scopes || scopes.includes('*') || scopes.includes(scope);
              if (inScope && key !== '__proto__' && Number.isSafeInteger(seq) && (vector[key] ?? 0) < seq) {
                vector[key] = seq;
                (adopted ??= {})[key] = seq;
              }
            }
          }
          vectorAdvance(vector, op);
          accepted.push(op);
          continue;
        }
        // From a newer schema version than this node runs: applied as it is
        // (registers are forward-tolerant; the validator does not know the
        // shape), or held in the log until this node runs that version.
        const ahead = this.#version !== null && Number.isInteger(op.v) && op.v > this.#version;
        if (ahead && this.#ahead === 'hold') {
          vectorAdvance(vector, op);
          accepted.push(op);
          (skipped ??= new Set()).add(op);
          (held ??= new Map()).set(op, op.v);
          notify(this, this.#logger, 'schema', { kind: 'ahead', op, held: true });
          continue;
        }
        let current;
        try {
          current = touched.get(op.id) ?? (await this.#load(op.id));
        } catch (error) {
          // The record's file is torn or fails its integrity check: this op
          // cannot land here, and must not stop the page or the stream.
          // Skipped like a beforeApply `false` — logged, relayed, replay-safe
          // — and reported; the record stays as it is for a read to report.
          this.#logger.warn({ event: 'sync.op.unreadable', id: op.id, err: error });
          this.#otel.recordRejected('unreadable');
          const message = `Record ${op.id} is unreadable here; op ${op.origin}:${op.seq} skipped`;
          notify(
            this,
            this.#logger,
            'error',
            Object.assign(new Error(message, { cause: error }), { op, code: 'OP_UNREADABLE' }),
          );
          vectorAdvance(vector, op);
          accepted.push(op);
          (skipped ??= new Set()).add(op);
          continue;
        }
        if (current?.encrypted) {
          this.#logger.warn({ event: 'sync.op.encrypted', id: op.id });
          vectorAdvance(vector, op);
          accepted.push(op);
          continue;
        }
        // A `false` from beforeApply skips the op HERE only: it is still
        // logged and relayed (the vector must move, or the peer would offer
        // it forever, and a hole in this log would be a gap for everyone
        // resuming from it). A throw aborts the batch — nothing is durable
        // yet, so the peer sees a failed push and offers the page again.
        const visible = current && isAlive(current) ? current.data : null;
        const verdict = await this.#hook('beforeApply', { op, via, peer, current: visible });
        if (verdict === false) {
          vectorAdvance(vector, op);
          accepted.push(op);
          (skipped ??= new Set()).add(op);
          continue;
        }
        this.#clock.observe(op.ts);
        const { entry, changed, delta, rejected } = applyOp(current, op);
        if (rejected.length > 0) {
          this.#logger.warn({ event: 'sync.op.rejected', id: op.id, rejected });
          this.#otel.recordRejected(rejected[0].reason);
          const error = Object.assign(new Error(`Refused op on ${op.id}`), { op, code: 'OP_REFUSED', rejected });
          notify(this, this.#logger, 'error', error);
        }
        // Invalid under this node's schema: skipped like a beforeApply
        // `false` — logged, relayed, replay-safe — and reported.
        const invalid = changed && !ahead ? await this.#invalid(op, entry) : null;
        if (invalid) {
          this.#logger.warn({ event: 'sync.op.invalid', id: op.id, ...invalid });
          this.#otel.recordRejected('validation');
          const error = Object.assign(new Error(`Invalid op on ${op.id}`), { op, code: 'OP_INVALID', ...invalid });
          notify(this, this.#logger, 'error', error);
          vectorAdvance(vector, op);
          accepted.push(op);
          (skipped ??= new Set()).add(op);
          continue;
        }
        if (ahead) notify(this, this.#logger, 'schema', { kind: 'ahead', op, held: false });
        vectorAdvance(vector, op);
        accepted.push(op);
        this.#otel.recordLag(op.ts);
        // A purge, and anything that lands on a purged record, is scrubbed
        // from this log too, once the batch is durable.
        if (entry.meta.purged) (purged ??= new Set()).add(op.id);
        if (!changed) continue;
        // A unique key the op leaves shared with another record: applied —
        // the op is in the peer's log already — and reported; the
        // application decides which record yields.
        if (VALIDATED.has(op.type)) {
          let conflicts = [];
          try {
            conflicts = await this.#conflicts(op.id, entry);
          } catch (error) {
            // A lens that throws for this record: the op is applied as it
            // is (the record is the peer's); only the unique check is lost.
            this.#logger.warn({ event: 'sync.op.lens', id: op.id, err: error });
          }
          for (const { fields, other } of conflicts) {
            this.#otel.recordConflict('unique');
            const entity = entry.data.$type;
            notify(this, this.#logger, 'conflict', { kind: 'unique', entity, fields, id: op.id, other, op });
          }
        }
        touched.set(op.id, entry);
        deltas.set(op.id, { ...(deltas.get(op.id) ?? {}), ...delta });
      }
      const result = { applied: accepted.length, skipped: skipped?.size ?? 0, duplicates, gaps, malformed };
      if (accepted.length > 0) {
        const entries = await this.#log.append(accepted, { skipped, held });
        if (adopted) await this.#log.advance(adopted);
        if (touched.size > 0) {
          await this.#persistBatch(touched, entries[0].seq, entries[entries.length - 1].seq);
          this.#flushCatalog();
        }
        this.#log.applied(entries[0].seq, entries[entries.length - 1].seq);
        if (purged) for (const id of purged) await this.#log.scrub(id);
      }
      // afterApply sees a durable batch; whatever it does, the record views
      // and the listeners (the relay among them) hear about every op.
      try {
        await this.#hook('afterApply', { via, peer, ops: accepted, ...result });
      } finally {
        for (const [id, entry] of touched) {
          this.#emitUpdate(id, isAlive(entry) ? entry.data : null, deltas.get(id));
        }
        notify(this, this.#logger, 'apply', { via, peer, ops: accepted, ...result });
        for (const op of accepted) notify(this, this.#logger, 'change', op, via);
      }
      return result;
    }
  }

  /**
   * One page of this node's state for a peer that cannot be resumed from
   * the log: live records AND tombstones, with their metadata, in id order.
   * `cursor` is the last id of the previous page; `null` back means done.
   */
  async snapshot({ cursor = null, limit = 500, scopes = null } = {}) {
    const names = await this.#fsi.list(`${this.#path}/data`);
    const records = [];
    let last = cursor;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (cursor !== null && id <= cursor) continue;
      const entry = await this.#load(id);
      last = id;
      if (!entry || entry.encrypted) continue;
      const scope = this.#scope(id, entry.data);
      if (scopes && scope !== GLOBAL_SCOPE && !scopes.includes(GLOBAL_SCOPE) && !scopes.includes(scope)) continue;
      records.push({ id, data: entry.data, meta: entry.meta });
      if (records.length >= limit) {
        return { records, cursor: last, eventId: this.#log.lastEventId, vector: this.#log.vector };
      }
    }
    return { records, cursor: null, eventId: this.#log.lastEventId, vector: this.#log.vector };
  }

  /**
   * Joins snapshot records into this node's state. Each becomes a `merge` op
   * of this node's own, so the joined state also reaches the peers that
   * resume from THIS node's log — bootstrap is transitive.
   */
  async mergeSnapshot(records, { via = null, from = null } = {}) {
    const horizon = Date.now() + this.#maxSkew;
    for (const record of records) {
      if (!isPlainObject(record) || !isRecordId(record.id)) {
        this.#logger.warn({ event: 'sync.record.malformed', id: isPlainObject(record) ? record.id : typeof record });
        continue;
      }
      // A stamp beyond the skew allowed is refused here as an op's is in
      // applyRemote: a snapshot is the other way a clock reaches this node.
      const latest = latestClock(record.meta);
      if (latest !== null && latest[0] > horizon) {
        this.#logger.warn({ event: 'sync.record.skew', id: record.id, ts: latest[0], ahead: latest[0] - horizon });
        continue;
      }
      await this[COMMIT]('merge', record.id, { data: record.data, meta: record.meta }, { via, from });
    }
  }

  /**
   * Records that everything up to `vector` is reflected in this node's state
   * (a snapshot of it was just joined). It travels as an `advance` op in
   * this node's own log, so a peer replaying the merges that carried the
   * state also learns which ops they cover — and does not report the next
   * live op of those origins as a gap.
   */
  adoptVector(vector, { via = null, from = null } = {}) {
    return this.#run(async () => {
      const known = this.#log.vector;
      const news = {};
      for (const key in vector) {
        if (Number.isInteger(vector[key]) && (known[key] ?? 0) < vector[key]) news[key] = vector[key];
      }
      if (Object.keys(news).length === 0) return null;
      const op = { origin: this.#nodeId, seq: 0, ts: this.#clock.now(), type: 'advance', vector: news };
      if (from) op.from = from;
      op.seq = (known[opKey(op)] ?? 0) + 1;
      const [{ seq }] = await this.#log.append([op]);
      await this.#log.advance(news);
      this.#log.applied(seq);
      notify(this, this.#logger, 'change', op, via);
      return op;
    });
  }

  /** Stops replication and seals the log. Further writes are refused — from the moment close() is called. */
  async close() {
    if (this.#closed) return;
    // Refused from here on: a write that landed while the links were
    // closing would be announced to nobody, after the final catalog save.
    // What was queued before this call still runs, ahead of the seal.
    this.#closed = true;
    await this.#sync.stop();
    const seal = async () => {
      await this.#catalogSave;
      await this.#catalog.save(this.#log.lastEventId);
      await this.#log.close();
    };
    const done = this.#queue.then(seal, seal);
    this.#queue = done.catch(() => {});
    await done;
    await this.#lock?.release();
    notify(this, this.#logger, 'close');
  }
}

Storage.Collection = Collection;
Storage.Record = Record;

const open = (options) => new Storage(options);

module.exports = { Storage, open };
