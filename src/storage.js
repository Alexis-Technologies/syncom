'use strict';

const { Emitter, generateUUID, createLogger } = require('./utils.js');
const { encrypt, decrypt, loadKeys, calculateHash } = require('./crypto.js');
const { Blockchain } = require('./chain.js');
const { SyncManager } = require('./sync.js');
const { OpLog } = require('./log.js');
const { applyOp, isAlive, isCounter, latestClock } = require('./ops.js');
const { Clock, opKey, keyScope, vectorHas, vectorNext, vectorAdvance } = require('./vector.js');
const { notify, runHook, normalizeHooks } = require('./hooks.js');
const { normalizeSchema, createLens, project, unproject, foldSet } = require('./schema.js');
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

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// What a commit came to: an op, `null` for a write that changed nothing, and
// `undefined` for an encrypted record (saved locally, no op).
const commitResult = (op) => (op === undefined ? 'encrypted' : op === null ? 'noop' : 'applied');

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
      if (Object.prototype.hasOwnProperty.call(this, key)) continue;
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

  async save() {
    if (Object.keys(this.#changes).length === 0) return;
    const delta = this.delta();
    await this.#storage[COMMIT]('set', this.#id, { data: delta }, { source: this });
    this.#changes = {};
  }

  /** Adds to a counter field; the storage-level `inc` with this record's id. */
  async inc(key, value = 1) {
    await this.#storage.inc(this.#id, key, value);
  }

  async delete() {
    await this.#storage.delete(this.#id);
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

  async insert(data) {
    const record = { ...data, $type: this.#name };
    const id = await this.#storage.insert(record);
    return this.#storage.record(id);
  }

  async get(id) {
    return this.#storage.get(id);
  }

  /** Replaces the record wholesale, stamped as this collection's. */
  async set(id, data, options) {
    if (!isPlainObject(data)) throw new TypeError('set() takes a plain object');
    return this.#storage.set(id, { ...data, $type: this.#name }, options);
  }

  async delete(id) {
    return this.#storage.delete(id);
  }

  async update(id, delta) {
    if (isPlainObject(delta) && Object.hasOwn(delta, '$type')) {
      throw new TypeError('$type is immutable; update() may not name it');
    }
    return this.#storage.update(id, delta);
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
  #sync = null;
  #cache = new Map();
  #cacheMax = DEFAULT_CACHE;
  #verify = true;
  #catalog = null;
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
  #getId = null;
  #logger;
  #otel;
  #options;
  #nodeId = null;
  #clock = new Clock();
  #scopeOf;
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
    this.#records = new Map();
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
    this.#verify = integrity === 'verify';
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
    // Encrypt every record at rest by default; a per-call `{ encrypted }`
    // still overrides. Encrypted records are local — see saveData().
    this.#encrypted = options.encrypted === true;
    this.#hooks = normalizeHooks(options.hooks, STORAGE_HOOKS, 'Storage');
    const scope = options.sync?.scope;
    this.#scopeOf = typeof scope === 'function' ? scope : () => GLOBAL_SCOPE;
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
    this.#chain = await new Blockchain(`${this.#path}/blockchain`, { fsi });
    this.#log = await new OpLog(this.#path, {
      ...this.#options.sync?.log,
      retention: this.#options.sync?.retention,
      logger: this.#logger,
      telemetry: this.#otel,
      fsi,
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

  // The persisted catalog is written every `flushEvery` puts and at close;
  // what lands in between is caught up from the log on the next open.
  async #flushCatalog() {
    if (this.#catalog.dirty >= this.#flushEvery) await this.#catalog.save(this.#log.lastEventId);
  }

  // The newest entries stay; a live Record pins its own. Absent ids are
  // never cached — the catalog knows what exists.
  #remember(id, entry) {
    this.#cache.delete(id);
    this.#cache.set(id, entry);
    if (this.#cache.size <= this.#cacheMax) return;
    for (const key of this.#cache.keys()) {
      if (this.#cache.size <= this.#cacheMax) break;
      if (this.#records.has(key)) continue;
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
      const current = touched.get(op.id) ?? (await this.#load(op.id));
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
  async migrate({ entities = null, batch = 100 } = {}) {
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
      await this[COMMIT]('write', id, { data });
      for (const key of Object.keys(counters)) {
        await this[COMMIT]('inc', id, { key, value: counters[key] });
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
    // A hook runs inside the queue (or, for a read, while a queued hook may
    // be running); a write it issues would wait for the hook that waits for
    // it. Refused here, where the deadlock would otherwise begin.
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

  // Every hook of this storage goes through here, so the guard above knows
  // one is running. Returns what the hook returns; a throw is a HookError.
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
    const record = this.#records.get(id);
    if (record) record[REFRESH](data, delta, source);
  }

  #scope(id, data) {
    const scope = this.#scopeOf(id, data);
    return typeof scope === 'string' && scope.length > 0 ? scope : GLOBAL_SCOPE;
  }

  // ---------------------------------------------------------------------
  // Entries on disk: `{ data, meta, encrypted, timestamp, block }`. `meta` is
  // the replication bookkeeping (see ops.js); an encrypted entry has none —
  // it is stored as ciphertext for this node's key alone and is not
  // replicated.

  async #load(id) {
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
    const records = {};
    for (const [id, entry] of touched) records[id] = await calculateHash(entry.data);
    const from = this.#log.formatId(fromSeq);
    const to = this.#log.formatId(toSeq);
    const blockHash = await this.#chain.addBlock({ records, from, to });
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

  async #commit(type, id, payload, { source = null, via = null, from = null, encrypted = false } = {}) {
    const current = await this.#load(id);
    if (encrypted && current && !current.encrypted) {
      throw new Error(`Record ${id} is replicated and cannot become encrypted`);
    }
    // Sealed: this write is encrypted, or the record already is. An
    // encrypted record has no op log — writes to it stay local.
    const sealed = encrypted || current?.encrypted === true;
    const visible = current && (current.encrypted || isAlive(current)) ? current.data : null;
    const ctx = { type, id, ...payload, current: visible, encrypted: sealed, source, via, from, v: this.#version };
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
      else if (type === 'delete') data = null;
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
    // Sequence numbers run per stream (see vector.js opKey): the scope's,
    // or the bootstrap stream for a merge.
    op.seq = (this.#log.vector[opKey(op)] ?? 0) + 1;
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

    const [{ seq: position }] = await this.#log.append([op]);
    const hash = await calculateHash(entry.data);
    const blockHash = await this.#chain.addBlock({ id, hash, from: this.#log.formatId(position) });
    await this.#writeEntry(id, entry, blockHash);

    await this.#flushCatalog();

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
    const hash = await calculateHash(record);
    const blockHash = await this.#chain.addBlock({ id, hash });
    const entry = { data: record, meta: null, encrypted: true, timestamp: Date.now(), block: blockHash };
    await this.#fsi.write(`${this.#path}/data`, `${id}.json`, JSON.stringify(entry));
    this.#remember(id, { data, meta: null, encrypted: true, block: blockHash });
    this.#catalog.put(id, { type: data?.$type, v: null, encrypted: true });
    await this.#flushCatalog();
  }

  async #removeEncrypted(id) {
    await this.#fsi.remove(`${this.#path}/data`, `${id}.json`);
    this.#cache.delete(id);
    this.#catalog.put(id, null);
    await this.#flushCatalog();
  }

  async saveData(id, data, options = {}) {
    const { encrypted = this.#encrypted } = options;
    await this[COMMIT]('write', id, { data }, { encrypted });
  }

  async loadData(id) {
    return this.get(id);
  }

  async validate(idOrOptions = {}, data, blockHash) {
    // Two shapes share one method: `validate(id, data, blockHash)` checks a
    // single record against its block, anything else walks the chain. A record
    // id is always a string, so that is the discriminator.
    const isChainValidation = typeof idOrOptions !== 'string' && !data && !blockHash;
    if (isChainValidation) {
      return await this.#chain.validate(idOrOptions);
    }
    const id = idOrOptions;
    try {
      const block = await this.#chain.readBlock(blockHash);
      const expectedHash = await calculateHash(data);
      if (!block) return false;
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
    await this.saveData(id, data, options);
    return id;
  }

  async has(id) {
    const entry = await this.#load(id);
    return entry !== null && (entry.encrypted || isAlive(entry));
  }

  /** Whether `id` is a live record here — answered from the catalog, no I/O. */
  hasRecord(id) {
    return this.#catalog.has(id) || this.#records.has(id);
  }

  // The raw read: what `get` returns before its hooks. `swap` compares
  // against this, so a redacting afterRead cannot break its CAS.
  async #read(id) {
    const entry = await this.#load(id);
    if (entry === null) return null;
    if (entry.encrypted) return entry.data;
    return isAlive(entry) ? this.#view(id, entry) : null;
  }

  async get(id) {
    await this.#hook('beforeRead', { id });
    const data = await this.#read(id);
    const replaced = await this.#hook('afterRead', { id }, data);
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

  async delete(id) {
    await this[COMMIT]('delete', id, {});
    this.#records.delete(id);
  }

  async update(id, delta) {
    if (!(await this.has(id))) throw new Error(`Record ${id} not found`);
    if (!isPlainObject(delta)) throw new TypeError('update() takes a plain object');
    await this[COMMIT]('set', id, { data: delta });
  }

  /** Adds `value` to counter field `key` — the commutative alternative to update(). */
  async inc(id, key, value = 1) {
    if (typeof key !== 'string') throw new TypeError('inc() takes a field name');
    if (!Number.isFinite(value)) throw new TypeError('inc() takes a finite number');
    await this[COMMIT]('inc', id, { key, value });
  }

  async swap(id, changes, prev) {
    const data = await this.#read(id);
    if (!data) throw new Error(`Record ${id} not found`);
    const matches = Object.keys(prev).every((key) => data[key] === prev[key]);
    if (!matches) return false;
    await this[COMMIT]('set', id, { data: changes });
    return true;
  }

  async record(id) {
    if (!this.#records.has(id)) {
      const record = await new Record(id, this);
      this.#records.set(id, record);
    }
    return this.#records.get(id);
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
        }),
      );
      return result;
    } finally {
      otel.recordApply(result ?? { applied: 0, skipped: 0, duplicates: 0, gaps: 0 }, now() - started);
    }
  }

  async #applyRemote(ops, { via = null, scopes = null, peer = null } = {}) {
    {
      const accepted = [];
      const touched = new Map();
      const deltas = new Map();
      const vector = this.#log.vector;
      let adopted = null;
      let skipped = null;
      let held = null;
      let duplicates = 0;
      let gaps = 0;
      for (const op of ops) {
        const isAdvance = isPlainObject(op) && op.type === 'advance' && isPlainObject(op.vector);
        if (
          !isPlainObject(op) ||
          typeof op.origin !== 'string' ||
          !Number.isInteger(op.seq) ||
          (!isAdvance && typeof op.id !== 'string')
        ) {
          this.#logger.warn({ event: 'sync.op.malformed', op });
          this.#otel.recordMalformed();
          continue;
        }
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
          // merges, have we — for the scopes we take from it.
          for (const key in op.vector) {
            const scope = keyScope(key);
            const inScope = scope === null || !scopes || scopes.includes('*') || scopes.includes(scope);
            if (inScope && Number.isInteger(op.vector[key]) && (vector[key] ?? 0) < op.vector[key]) {
              vector[key] = op.vector[key];
              (adopted ??= {})[key] = op.vector[key];
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
        const current = touched.get(op.id) ?? (await this.#load(op.id));
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
          notify(this, this.#logger, 'error', Object.assign(new Error(`Refused op on ${op.id}`), { op, rejected }));
        }
        // Invalid under this node's schema: skipped like a beforeApply
        // `false` — logged, relayed, replay-safe — and reported.
        const invalid = changed && !ahead ? await this.#invalid(op, entry) : null;
        if (invalid) {
          this.#logger.warn({ event: 'sync.op.invalid', id: op.id, ...invalid });
          this.#otel.recordRejected('validation');
          notify(this, this.#logger, 'error', Object.assign(new Error(`Invalid op on ${op.id}`), { op, ...invalid }));
          vectorAdvance(vector, op);
          accepted.push(op);
          (skipped ??= new Set()).add(op);
          continue;
        }
        if (ahead) notify(this, this.#logger, 'schema', { kind: 'ahead', op, held: false });
        vectorAdvance(vector, op);
        accepted.push(op);
        this.#otel.recordLag(op.ts);
        if (!changed) continue;
        touched.set(op.id, entry);
        deltas.set(op.id, { ...(deltas.get(op.id) ?? {}), ...delta });
      }
      const result = { applied: accepted.length, skipped: skipped?.size ?? 0, duplicates, gaps };
      if (accepted.length > 0) {
        const entries = await this.#log.append(accepted, { skipped, held });
        if (adopted) await this.#log.advance(adopted);
        if (touched.size > 0) {
          await this.#persistBatch(touched, entries[0].seq, entries[entries.length - 1].seq);
          await this.#flushCatalog();
        }
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
    for (const record of records) {
      if (!isPlainObject(record) || typeof record.id !== 'string') continue;
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
      await this.#log.append([op]);
      await this.#log.advance(news);
      notify(this, this.#logger, 'change', op, via);
      return op;
    });
  }

  /** Stops replication and seals the log. Further writes are refused. */
  async close() {
    if (this.#closed) return;
    await this.#sync.stop();
    await this.#run(async () => {
      await this.#catalog.save(this.#log.lastEventId);
      await this.#log.close();
    });
    this.#closed = true;
    await this.#lock?.release();
    notify(this, this.#logger, 'close');
  }
}

Storage.Collection = Collection;
Storage.Record = Record;

const open = (options) => new Storage(options);

module.exports = { Storage, open };
