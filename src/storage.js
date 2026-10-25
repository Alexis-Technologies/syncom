'use strict';

// The engine's front: a Storage opens a directory (through an injected
// backend), owns the mutation queue every write runs in, and lends its
// collaborators to the three write paths — the local one in src/commit.js,
// a peer's batch in src/apply.js, a bootstrap page in src/bootstrap.js.
// Records live in src/entries.js, what the application holds in
// src/record.js, the options in src/options.js. The API of the field kinds
// beyond registers is src/fields.js and the versions API src/versions.js,
// both over the same lent core: this file keeps a delegate per method.

const { Emitter, generateUUID, createLogger } = require('./utils.js');
const { sha256 } = require('./digest.js');
const { OpLog } = require('./log.js');
const { EntryStore } = require('./entries.js');
const { Record, Collection } = require('./record.js');
const { commit, MISMATCH } = require('./commit.js');
const F = require('./fields.js');
const V = require('./versions.js');
const { applyBatch } = require('./apply.js');
const { snapshotPage, mergeBatch, adopt } = require('./bootstrap.js');
const { applyOp, isAlive, kindOf } = require('./ops.js');
const { appliedHere } = require('./history.js');
const { Tags } = require('./tags.js');
const { Clock } = require('./vector.js');
const { notify, runHook, normalizeHooks } = require('./hooks.js');
const { project } = require('./entity.js');
const defaultFsi = require('./fsi.js');
const { checkFsi, withSync } = require('./backend.js');
const { acquireLock } = require('./lock.js');
const { Catalog, isTextIndex } = require('./catalog.js');
const { DISABLED, isWriter, traced, now } = require('./telemetry.js');
const { GLOBAL_SCOPE } = require('./scope.js');
const { normalizeStorageOptions } = require('./options.js');
const { isPlainObject, isRecordId, invalidId, isStreamName, isKeyId, VALIDATED } = require('./shape.js');
const { COMMIT, REFRESH, SOURCE, PLUGINS, CURSOR } = require('./symbols.js');
const { missing } = require('./plugin.js');
const { SyncomError, typed } = require('./errors.js');

const NODE_FILE = 'node.json';
const SCHEMA_FILE = 'schema.json';
// What a storage without the schema plugin runs with: no entities, version 1.
const NO_SCHEMA = Object.freeze({ version: 1, entities: new Map(), snapshot: undefined, ahead: 'apply', view: null });

// The hooks a storage accepts (`open({ hooks })`). Writes and reads run
// their hooks inside this storage; the apply pair runs per peer batch.
const STORAGE_HOOKS = ['beforeWrite', 'afterWrite', 'beforeRead', 'afterRead', 'beforeApply', 'afterApply'];

// The ops that leave a record's whole state behind them — where a repair
// can start replaying from. A purge counts even scrubbed; the others not.
const WHOLE = new Set(['write', 'merge', 'delete']);

// A service file this storage wrote itself and cannot read any more.
const corrupt = (file, cause) =>
  new SyncomError('CORRUPT', `${file} is unreadable (${cause?.message ?? cause}); restore it or remove the directory`, {
    cause,
  });

class Storage extends Emitter {
  #path;
  #identity = null;
  #seal = null;
  #chain = null;
  #schemaHook = null;
  #cursor = null;
  #settings;
  #log = null;
  #entries = null;
  #tags = null;
  #core = null;
  #records = null;
  #reaper = null;
  // Live Records refreshed as get() reads — the lens, the read hooks —
  // after the write that changed them, one after another.
  #refreshed = Promise.resolve();
  #refreshing = 0;
  #sync = null;
  #cacheMax;
  #verify;
  #catalog = null;
  #catalogSave = null;
  #flushEvery;
  #fsi;
  #lock = null;
  #lockOptions;
  #schema = null;
  #entities = null;
  #version = null;
  #snapshot = undefined;
  #schemaHash = null;
  #schemaPrevious = null;
  #lens = null;
  #ahead = 'apply';
  #held = null;
  #actor;
  #getId;
  #logger;
  #otel;
  #lockWait = 0;
  #options;
  #nodeId = null;
  #clock = new Clock();
  #scopeOf;
  #maxSkew;
  #limits;
  #plugins;
  // Local writes whose record files wait (`open({ defer })`): id → the
  // entry to write and the log positions it covers; one timer for the flush.
  #defer = 0;
  #deferred = new Map();
  #deferTimer = null;
  #signatures;
  #encrypted;
  #hooks;
  #inHook = 0;
  #queued = 0;
  #queue = Promise.resolve();
  #closed = false;

  // The default id generator, exposed so it stays reachable and stubbable.
  // `generateUUID` never touches `this`, so the reference is safe to store
  // unbound in `#getId`.
  static generateId() {
    return generateUUID();
  }

  constructor(options = {}) {
    const settings = normalizeStorageOptions(options);
    super({ maxListeners: settings.maxListeners });
    this.#options = options;
    this.#settings = settings;
    this.#path = settings.path;
    this.#lockOptions = settings.lock;
    this.#cacheMax = settings.cacheMax;
    this.#verify = settings.verify;
    this.#flushEvery = settings.flushEvery;
    this.#getId = settings.getId ?? Storage.generateId;
    this.#actor = settings.actor;
    this.#encrypted = settings.encrypted;
    this.#scopeOf = settings.scope ?? (() => GLOBAL_SCOPE);
    this.#maxSkew = settings.maxSkew;
    // What the op model is told to bound (src/ops.js applyOp): the pending
    // work of a list or text field. Every fold of the log runs under it too.
    this.#plugins = settings.plugins;
    this.#limits = { pendingMax: settings.pendingMax, plugins: settings.plugins };
    this.#defer = settings.defer;
    this.#signatures = settings.signatures;
    // Live Records, weakly: one the application still holds pins its cache
    // entry and follows the record; one it dropped is collected, and its
    // slot here with it.
    this.#records = new Map();
    this.#reaper = new FinalizationRegistry((id) => {
      const ref = this.#records.get(id);
      if (ref !== undefined && ref.deref() === undefined) this.#records.delete(id);
    });
    this.#logger = createLogger(options.logger);
    this.#otel = DISABLED;
    this.#fsi = this.#backend(options, settings.durable);
    this.#hooks = normalizeHooks(options.hooks, STORAGE_HOOKS, 'Storage');
    return this.#init();
  }

  // The backend: node:fs or OPFS by default, anything with the five
  // functions when injected. `durable` wraps every write with the
  // adapter's fsync, where it has one.
  #backend(options, durable) {
    const fsi = checkFsi(options.fsi === undefined ? defaultFsi : options.fsi, 'open({ fsi })');
    if (!durable) return fsi;
    if (typeof fsi.sync === 'function') return withSync(fsi);
    this.#logger.debug({ event: 'durable.noop' });
    return fsi;
  }

  // The schema is the plugin's to read (`open({ schema, validator })` into
  // the entity definitions the write path consults: validators, id fields,
  // indexes) and the core's to apply; without the plugin a schema or a
  // validator given is refused here, naming it, and records are untyped.
  #defineSchema(options, search) {
    const given = this.#schemaHook;
    if (given === null) {
      if (options.schema !== undefined && options.schema !== null) throw missing('open({ schema })', 'schema');
      if (options.validator !== undefined) throw missing('open({ validator })', 'schema');
    }
    const schema = given?.given ?? null;
    const normalized = given ?? NO_SCHEMA;
    // A collection becomes a property of the storage: a name the storage
    // already answers to — a method, a getter, anything up its prototype
    // chain — would replace it or break the open. Refused before anything
    // is opened.
    for (const name of normalized.entities.keys()) {
      if (name in this) throw new TypeError(`open({ schema }): entity name '${name}' is taken by the storage itself`);
    }
    this.#entities = normalized.entities;
    this.#schema = schema;
    // One text index per searchable entity, from the injected factory: the
    // core knows the contract, not the index — a node that never searches
    // ships none of it.
    const text = new Map();
    for (const def of normalized.entities.values()) {
      if (def.search.length === 0) continue;
      if (search === null) {
        const hint = 'give open() an index — createSearch() from @alexify/syncom/search';
        throw new TypeError(`open({ search }): entity ${def.name} declares search fields; ${hint}`);
      }
      const index = search(def.name);
      if (!isTextIndex(index)) {
        throw new TypeError(`open({ search }): the index for ${def.name} must have put(), remove() and query()`);
      }
      text.set(def.name, index);
    }
    const { logger } = this;
    this.#catalog = new Catalog({ fsi: this.#fsi, path: this.#path, entities: normalized.entities, text, logger });
    // A node with a schema stamps its version on every op it makes; one
    // without stamps nothing, and nothing in hello says what it runs.
    if (schema === null) return;
    this.#version = normalized.version;
    this.#snapshot = normalized.snapshot;
    this.#ahead = normalized.ahead;
    this.#lens = normalized.view;
    // A held op lives in the log until this node runs its version;
    // retention that would drop it first makes the hold a silent loss.
    const retained = options.sync?.retention?.ops;
    if (this.#ahead === 'hold' && retained !== undefined && retained > 0 && retained < 1000) {
      throw new TypeError("open({ schema }): ahead 'hold' needs sync.retention.ops of 1000 or more, or 0");
    }
  }

  async #init() {
    // One instance per directory, first: a second one would mint the seqs
    // this one is about to. `lock: false` is for a caller that coordinates.
    const lock = this.#lockOptions;
    if (lock !== null) {
      // Recorded once the writer is set up (a plugin's, after the lock).
      const started = now();
      this.#lock = await acquireLock({ fsi: this.#fsi, path: this.#path, ...lock });
      this.#lockWait = now() - started;
    }
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
    // The API plugins set up before the log opens — the identity (signing),
    // the sealing of records (encryption), the chain — each handing back the
    // hooks the core takes; what the options ask for and no plugin provides
    // is refused here, naming the subpath.
    const ctx = {
      fsi,
      path: this.#path,
      logger: this.#logger,
      options: this.#options,
      settings: this.#settings,
      storage: this,
    };
    let adapted = false;
    for (const mod of this.#plugins.apis) {
      const hooks = (await mod.setup?.(ctx)) ?? {};
      if (hooks.identity) this.#identity = hooks.identity;
      if (hooks.seal) this.#seal = hooks.seal;
      if (hooks.chain) this.#chain = hooks.chain;
      if (hooks.schema) this.#schemaHook = hooks.schema;
      if (hooks.query) this.#cursor = hooks.query.cursor;
      if (Object.hasOwn(hooks, 'telemetry')) {
        this.#otel = hooks.telemetry;
        adapted = true;
      }
    }
    // A writer given as it is (the contract: `enabled`, `withSpan`) the core
    // takes; an OpenTelemetry api or tracer needs the plugin to adapt it.
    const given = this.#options.telemetry;
    if (!adapted && given && typeof given === 'object') {
      if (isWriter(given)) this.#otel = given;
      else throw missing('open({ telemetry })', 'telemetry');
    }
    if (this.#lockWait > 0 && this.#otel.enabled) this.#otel.recordLockWait(this.#lockWait);
    if (this.#signatures === 'require' && this.#identity === null) {
      throw missing("sync.signatures 'require'", 'signing');
    }
    if (this.#options.chain === true && this.#chain === null) throw missing('open({ chain: true })', 'chain');
    if (this.#encrypted && this.#seal === null) throw missing('open({ encrypted: true })', 'encryption');
    this.#defineSchema(this.#options, this.#settings.search);
    this.#log = await new OpLog(this.#path, {
      ...this.#options.sync?.log,
      retention: this.#options.sync?.retention,
      logger: this.#logger,
      telemetry: this.#otel,
      fsi,
      // A roll seals only what the write paths marked applied — see
      // OpLog.applied: the tail a reopen replays must hold every batch whose
      // records may not have been written.
      sealApplied: true,
      // The floor moving is news to an operator: a peer below it bootstraps.
      onRoll: (roll) => notify(this, this.#logger, 'log', { kind: 'roll', ...roll }),
    });
    // The clock picks up where the log left off: every stamp this node ever
    // logged is below what it will stamp next, whatever the wall clock says.
    this.#clock.observe(this.#log.latestTs);
    this.#entries = new EntryStore({
      fsi,
      path: this.#path,
      max: this.#cacheMax,
      logger: this.#logger,
      catalog: this.#catalog,
      pinned: (id) => this.#live(id) !== undefined,
      verify: this.#verify && this.#chain !== null ? (id, data, block) => this.validate(id, data, block) : null,
      decrypt: (data) => this.#unseal(data),
      view: (id, entry) => this.#view(id, entry),
      before: (id, file) => this.#tags.copyBefore(id, file),
    });
    await this.#loadIdentity();
    await this.#loadSchema();
    await this.#loadCatalog();
    this.#tags = new Tags({
      fsi,
      path: this.#path,
      logger: this.#logger,
      catalogOf: (path) => new Catalog({ fsi, path, entities: this.#entities, logger: this.#logger }),
    });
    await this.#tags.load();
    this.#core = this.#lend();
    await this.#replayTail();
    await this.#replayHeld();
    // The API plugins that need the open log — the sync manager — come
    // after the replay, and hand back what the facade exposes.
    const opened = { storage: this, options: this.#options, settings: this.#settings, logger: this.#logger };
    for (const mod of this.#plugins.apis) {
      const hooks = (await mod.open?.(opened)) ?? {};
      if (hooks.sync) this.#sync = hooks.sync;
    }
    this.#initCollections();
    // What the observable gauges sample, when a meter was given.
    this.#otel.gauges(() => ({
      outbox: this.#sync === null ? 0 : this.#sync.pendingOps(),
      queue: this.#queued,
      cache: this.#entries.size,
      catalog: this.#catalog.size,
      log: this.#log.length,
    }));
  }

  // What the write paths (src/commit.js, src/apply.js, src/bootstrap.js)
  // reach of this storage: its collaborators, and the private readers they
  // share. Built once the log, the identity and the catalog are loaded;
  // every member is fixed from then on.
  #lend() {
    return {
      storage: this,
      logger: this.#logger,
      otel: this.#otel,
      log: this.#log,
      chain: this.#chain,
      // The hooks the plugins set up: the sealing of records, the hash
      // (SHA-256 of a value's JSON, Web Crypto), the signature of an op.
      seal: this.#seal,
      hash: sha256,
      identity: this.#identity,
      clock: this.#clock,
      entries: this.#entries,
      catalog: this.#catalog,
      nodeId: this.#nodeId,
      version: this.#version,
      ahead: this.#ahead,
      maxSkew: this.#maxSkew,
      limits: this.#limits,
      plugins: this.#plugins,
      defer: this.#defer,
      deferred: (id, entry, position) => this.#deferWrite(id, entry, position),
      signatures: this.#signatures,
      // Signs an op of this node's own, in place, once it is final.
      sign: this.#signatures === false || this.#identity === null ? null : (op) => this.#identity.sign(op),
      verify: this.#identity === null ? null : (op, mode) => this.#identity.verify(op, mode),
      hook: (name, ...args) => this.#hook(name, ...args),
      view: (id, entry) => this.#view(id, entry),
      scopeOf: (id, data) => this.#scope(id, data),
      actorOf: (given) => this.#actorOf(given),
      observe: (stamp) => {
        if (stamp) this.#clock.observe(stamp[0]);
      },
      definitionOf: (data) => this.#definitionOf(data),
      conflicts: (id, entry) => this.#conflicts(id, entry),
      invalid: (op, entry) => this.#invalid(op, entry),
      persist: (touched, from, to) => this.#land(touched, from, to),
      unpersisted: (touched, error) => this.#unpersisted(touched, error),
      flush: () => this.#flushCatalog(),
      refresh: (id, data, delta, source, entry) => this.#emitUpdate(id, data, delta, source, entry),
      // For the API modules (src/fields.js, src/versions.js), which stand
      // outside the queue: the hooks (their read hooks run outside it), the
      // tags, the entities, a task run in the queue, a local op committed
      // through it (`storage[COMMIT]`), a Record forgotten, the deferred
      // files landed. A write path is inside the queue already and calls
      // none of these.
      hooks: this.#hooks,
      tags: this.#tags,
      entities: this.#entities,
      run: (task) => this.#run(task),
      commit: (type, id, payload, options) => this[COMMIT](type, id, payload, options),
      // The same write from INSIDE a task of the queue (`core.run`), where
      // `commit` would wait for itself; and whether an entry is live.
      commitNow: (type, id, payload, options) => commit(this.#core, type, id, payload, options),
      cursor: (source, entity, query) => this[CURSOR](entity, query, source),
      alive: isAlive,
      forget: (id) => this.#records.delete(id),
      flushDeferred: () => this.#flushDeferred(),
      // A purge reaches the log and the tags alike.
      scrub: async (id) => {
        await this.#log.scrub(id);
        await this.#tags.scrub(id);
      },
    };
  }

  // The catalog is derived from the records: the persisted one is reused
  // when the log can say what changed since it was saved (those records are
  // re-read), rebuilt from a scan of `data/` otherwise — a first open, a
  // stamp from another epoch or below the floor, other indexes.
  async #loadCatalog() {
    const saved = await this.#catalog.load();
    const tail = saved === null ? null : this.#log.since(saved.stamp);
    if (tail === null) {
      const reason = saved === null ? 'no catalog' : 'stamp not resumable';
      this.#logger.debug({ event: 'catalog.rebuild', reason });
      const rebuild = async () => {
        let count = 0;
        for (const name of await this.#fsi.list(`${this.#path}/data`)) {
          if (!name.endsWith('.json')) continue;
          await this.#entries.index(name.slice(0, -5));
          count++;
        }
        await this.#catalog.save(this.#log.lastEventId);
        return count;
      };
      const otel = this.#otel;
      if (!otel.enabled) return void (await rebuild());
      await traced(otel, 'syncom.catalog.rebuild', {}, rebuild, (count) => ({ 'syncom.records': count }));
      return;
    }
    const touched = new Set();
    for (const { op } of tail) if (typeof op.id === 'string') touched.add(op.id);
    for (const id of touched) await this.#entries.index(id);
    if (touched.size > 0) await this.#catalog.save(this.#log.lastEventId);
  }

  // The persisted catalog is written at close and, in between, off the
  // mutation queue: the rows and the stamp are taken as the save starts and
  // the write runs while writes go on, one save at a time. What lands in
  // between is caught up from the log on the next open. A save writes every
  // row, so it comes every `flushEvery` puts while the catalog is small and
  // every sixteenth of its size as it grows — a sixteenth of a row per put
  // whatever the size, where a fixed interval made a write cost more as the
  // store grew — but never further apart than half what the log retains, so
  // a node stopped without close() still finds its stamp in the log and
  // catches up instead of rebuilding from a scan.
  #flushThreshold() {
    const grown = Math.min(this.#catalog.size >> 4, Math.floor(this.#log.retainedOps / 2));
    return Math.max(this.#flushEvery, grown);
  }

  #flushCatalog() {
    if (this.#catalogSave !== null || this.#catalog.dirty < this.#flushThreshold()) return;
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

  // `schema.json` remembers the version (and the snapshot's hash) this
  // directory last ran: a change since is reported as `schemaInfo.previous`
  // — a fact the caller reads after open, where an event at open would find
  // no listener yet. The hash is of the snapshot's JSON; metaschema's
  // `model.toJSON()` is deterministic, a hand-written one is as stable as
  // its author keeps it.
  async #loadSchema() {
    if (this.#version === null) return;
    if (this.#snapshot !== undefined) this.#schemaHash = await sha256(this.#snapshot);
    const version = this.#version;
    const hash = this.#schemaHash;
    let stored = null;
    if (await this.#fsi.exists(this.#path, SCHEMA_FILE)) {
      let raw;
      try {
        raw = JSON.parse(await this.#fsi.read(this.#path, SCHEMA_FILE));
      } catch (error) {
        throw corrupt(SCHEMA_FILE, error);
      }
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
        throw new SyncomError(
          'DOWNGRADE',
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
    const touched = await this.#fold(entries);
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
   * lens: a whole-record write of the view, then the counters and the sets
   * added back (a write resets them). One designated node runs it; peers receive
   * ordinary ops. Idempotent — a record already of this version is left
   * alone. `entities` limits it to those collections; `batch` is how many
   * records go between turns of the event loop.
   */
  async migrate({ entities = null, batch = 100, actor } = {}) {
    if (this.#schemaHook === null) throw missing('migrate()', 'schema');
    if (this.#version === null) throw new TypeError('migrate() needs open({ schema })');
    if (entities !== null && !(Array.isArray(entities) && entities.every((name) => typeof name === 'string'))) {
      throw new TypeError('migrate({ entities }) takes an array of entity names');
    }
    if (!Number.isInteger(batch) || batch < 1) throw new TypeError('migrate({ batch }) takes a positive integer');
    const result = { migrated: 0, counters: 0, sets: 0, lists: 0, texts: 0, trees: 0 };
    let since = 0;
    for (const id of await this.list()) {
      const entry = await this.#entries.load(id);
      if (!entry || entry.encrypted || (entry.meta.v ?? 1) >= this.#version) continue;
      if (entities !== null && !entities.includes(entry.data.$type)) continue;
      const view = await this.#view(id, entry);
      const data = {};
      const kinds = {};
      for (const key of Object.keys(view)) {
        const kind = kindOf(entry, key, this.#plugins);
        if (kind === undefined || kind === 'register') data[key] = view[key];
        else kinds[key] = kind;
      }
      await this[COMMIT]('write', id, { data }, { actor });
      for (const key of Object.keys(kinds)) {
        const kind = kinds[key];
        const value = entry.data[key];
        if (kind === 'counter') {
          await this[COMMIT]('inc', id, { key, value }, { actor });
          result.counters++;
        } else if (kind === 'set') {
          // A set with nothing live has nothing to add back: it is dropped.
          if (value.length === 0) continue;
          await this[COMMIT]('add', id, { key, value }, { actor });
          result.sets++;
        } else {
          // A plugin's field comes back as the ops its module lays — a list
          // or a text as one run, a tree as one move per node, parents first
          // — and one with nothing to read is dropped.
          const ops = this.#plugins.byName[kind].migrate(kind, key, value);
          if (ops.length === 0) continue;
          for (const [type, payload] of ops) await this[COMMIT](type, id, payload, { actor });
          result[`${kind}s`] = (result[`${kind}s`] ?? 0) + 1;
        }
      }
      result.migrated++;
      if (++since >= batch) {
        since = 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return result;
  }

  // The node id is the signing key — minted with the pair, never changed —
  // and node.json names it for the operator; the own sequence numbers (one
  // per scope) live in the log's vector, which survives compaction, so a seq
  // is durable the moment its op is appended, before anyone hears of it. A
  // directory from before signing (a UUID in node.json) is rekeyed once,
  // with a warning. node.json naming ANOTHER key is refused: an id that
  // changed in silence would break SELF detection and every peer's echo
  // filter, and a key pair restored from elsewhere is a thing to be told.
  // The node id is the signing key when the signing plugin is registered —
  // minted with the pair, never changed — and node.json names it for the
  // operator; without the plugin it is what the directory already names, or
  // what `open({ getId })` mints for a fresh one (a UUID by default; cuid,
  // ulid… as the application has it). The own sequence numbers live in the
  // log's vector, which survives compaction, so a seq is durable the moment
  // its op is appended, before anyone hears of it. A directory from before
  // signing (a UUID in node.json) is rekeyed once, with a warning, when the
  // plugin arrives. node.json naming ANOTHER key is refused: an id that
  // changed in silence would break SELF detection and every peer's echo
  // filter, and a key pair restored from elsewhere is a thing to be told.
  // node.json also names the kind plugins the directory has run with: a
  // reopen without one of them would hold records whose fields it cannot
  // apply and lose them at the next write, so it is refused (PLUGIN_MISSING,
  // naming the plugin); more plugins than before is fine and is recorded.
  async #loadIdentity() {
    const keyId = this.#identity?.id ?? null;
    const kinds = this.#plugins.kinds.map((mod) => mod.name);
    let stored = null;
    if (await this.#fsi.exists(this.#path, NODE_FILE)) {
      try {
        stored = JSON.parse(await this.#fsi.read(this.#path, NODE_FILE));
      } catch (error) {
        throw corrupt(NODE_FILE, error);
      }
      const { id } = stored;
      if (!isStreamName(id)) throw corrupt(NODE_FILE, 'no node id in it');
      const ran = Array.isArray(stored.plugins) ? stored.plugins.filter((name) => typeof name === 'string') : [];
      const lacking = ran.filter((name) => !kinds.includes(name));
      if (lacking.length > 0) {
        const [name] = lacking;
        const message = `${NODE_FILE} says this storage runs with the ${name} plugin: open({ plugins }) with it from '@alexify/syncom/${name}'`;
        throw typed('PLUGIN_MISSING', message);
      }
      const same = ran.length === kinds.length && ran.every((name) => kinds.includes(name));
      if (keyId === null || id === keyId) {
        this.#nodeId = id;
        if (same) return;
      } else if (isKeyId(id)) {
        const message = `${NODE_FILE} names node ${id}, but keys/sign-public.pem is ${keyId}`;
        throw new SyncomError('IDENTITY_MISMATCH', message, { id, key: keyId });
      } else {
        this.#logger.warn({ event: 'identity.rekeyed', from: id, to: keyId });
        this.#nodeId = keyId;
      }
    } else if (keyId !== null) {
      this.#nodeId = keyId;
    } else {
      const minted = await this.#getId();
      if (!isStreamName(minted)) {
        throw new TypeError(
          `open({ getId }): ${JSON.stringify(minted)} cannot be a node id (a short name without '@')`,
        );
      }
      this.#nodeId = minted;
    }
    await this.#fsi.write(this.#path, NODE_FILE, JSON.stringify({ id: this.#nodeId, plugins: kinds }));
  }

  // A sealed record's data, through the encryption plugin's key — or none.
  #unseal(text) {
    if (this.#seal === null) throw missing('an encrypted record', 'encryption');
    return this.#seal.decrypt(text);
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

  // Returns how many records the tail touched. An entry accepted but not
  // applied when it arrived (beforeApply said no, or it is held for a newer
  // schema) is left alone — that flag is what keeps it from landing here.
  async #replay(tail) {
    const touched = await this.#fold(tail.filter((entry) => !entry.skipped));
    if (touched.size > 0) await this.#persistBatch(touched, tail[0].seq, tail[tail.length - 1].seq);
    this.#log.applied(tail[0].seq, tail[tail.length - 1].seq);
    return touched.size;
  }

  // Log entries re-applied to the records they name, in order: the entries
  // touched, keyed by id, each carrying the seq that last changed it. A
  // record that fails its integrity check is left as it is — the next read
  // reports it, which is where the caller expects to hear about it.
  async #fold(entries) {
    const touched = new Map();
    for (const { seq, op } of entries) {
      this.#clock.observe(op.ts);
      let current;
      try {
        current = touched.get(op.id) ?? (await this.#entries.load(op.id));
      } catch (error) {
        this.#logger.warn({ event: 'replay.skipped', id: op.id, err: error });
        continue;
      }
      if (current?.encrypted) continue;
      const { entry, changed } = applyOp(current, op, this.#limits);
      if (changed) touched.set(op.id, { ...entry, seq });
    }
    return touched;
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

  // The cursor over a source seam (this storage's by default; a tag's for a
  // view at a tag): the query plugin's, PLUGIN_MISSING without it.
  get [CURSOR]() {
    return (entity, query, source = this[SOURCE]) => {
      if (this.#cursor === null) throw missing('select()');
      return this.#cursor(source, entity, query);
    };
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
      searches: (entity) => catalog.searches(entity),
      subscribe: (entity, fn) => catalog.subscribe(entity, fn),
      load: async (id) => {
        const entry = await this.#entries.load(id);
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

  /**
   * Runs `data` through an entity's validator the way a write would —
   * under its id field, without `$type` — and returns what the validator
   * gives back (defaults filled, aliases resolved). Rejects with a
   * ValidationError; the storage is untouched either way.
   */
  async check(entity, data) {
    if (this.#schemaHook === null) throw missing('check()', 'schema');
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

  /** `'verify'`, `'require'` or `false` — `open({ sync: { signatures } })`. */
  get signatures() {
    return this.#signatures;
  }

  /** The names of the plugins this storage was opened with (`open({ plugins })`). */
  get plugins() {
    return this.#plugins.names;
  }

  /** The names of the kind plugins among them — what hello tells a peer this node can hold. */
  get kinds() {
    return this.#plugins.kinds.map((mod) => mod.name);
  }

  // The registry itself, for the subpaths that fold patches or open a fork.
  get [PLUGINS]() {
    return this.#plugins;
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

  /** The sync manager — the `sync` plugin's; PLUGIN_MISSING without it. */
  get sync() {
    if (this.#sync === null) throw missing('storage.sync', 'sync');
    return this.#sync;
  }

  /** The highest per-origin seq applied here — what a peer compares against. */
  get vector() {
    return this.#log.vector;
  }

  /**
   * The node's health, as an operator reads it: what is queued, cached,
   * catalogued, retained and locked. No I/O — every number is in memory.
   */
  stats() {
    let pinned = 0;
    for (const id of Array.from(this.#records.keys())) if (this.#live(id) !== undefined) pinned++;
    const log = this.#log;
    return {
      closed: this.#closed,
      queue: this.#queued,
      cache: { size: this.#entries.size, max: this.#cacheMax, pinned },
      catalog: { entries: this.#catalog.size, dirty: this.#catalog.dirty },
      tags: { count: this.#tags.size, corrupt: this.#tags.corrupt },
      // Records whose files lag the log: deferred by `open({ defer })`, or
      // held after a write that failed (replayed at the next open).
      held: this.#entries.heldIds().size,
      deferred: this.#deferred.size,
      log: {
        length: log.length,
        floor: log.floor,
        next: log.next,
        epoch: log.epoch,
        segments: log.segments,
        latestTs: log.latestTs,
        droppedTs: log.droppedTs,
        pins: log.pins,
      },
      chain: this.#chain ? { tail: this.#chain.tailHash } : null,
      lock: this.#lock ? { mode: this.#lockOptions.mode } : null,
    };
  }

  // Every mutation passes through one queue: the chain's tail pointer, the
  // log's seq counter and a record's entry are all read-then-written, and two
  // interleaved writers would race all three.
  #run(task) {
    if (this.#closed) return Promise.reject(new SyncomError('CLOSED', 'Storage is closed'));
    // A write or apply hook runs inside the queue; a write it issues would
    // wait for the hook that waits for it. Refused here, where the deadlock
    // would otherwise begin. Read hooks run outside the queue and are not
    // counted — a write from one simply queues.
    if (this.#inHook > 0) {
      return Promise.reject(
        new SyncomError(
          'IN_HOOK',
          'Cannot write to the storage from inside a hook: the write would wait for the hook that waits for it',
        ),
      );
    }
    this.#queued++;
    const result = this.#queue.then(task, task);
    const settled = result.finally(() => {
      this.#queued--;
    });
    this.#queue = settled.catch(() => {});
    return result;
  }

  // Every hook that runs inside the mutation queue goes through here, so the
  // guard above knows one is running. Returns what the hook returns; a throw
  // is a HookError. The read hooks call runHook directly.
  async #hook(name, ...args) {
    if (!this.#hooks[name]) return undefined;
    const otel = this.#otel;
    const started = otel.enabled ? now() : 0;
    this.#inHook++;
    try {
      return await runHook(this.#hooks, name, ...args);
    } finally {
      this.#inHook--;
      if (started) otel.recordHook(name, now() - started);
    }
  }

  // A live Record reads what get() reads: through the lens and the read
  // hooks. Those run after the write, outside the mutation queue — a read
  // hook may write, and that write waits for the queue — in the order the
  // writes came; with neither, the Record is refreshed at once.
  #emitUpdate(id, data, delta, source = null, entry = null) {
    const record = this.#live(id);
    if (!record) return;
    const lensed =
      data !== null && entry !== null && !entry.encrypted && this.#lens !== null && (entry.meta.v ?? 1) < this.#version;
    const hooked = this.#hooks.beforeRead !== null || this.#hooks.afterRead !== null;
    if (!lensed && !hooked && this.#refreshing === 0) {
      record[REFRESH](data, delta, source);
      return;
    }
    this.#refreshing += 1;
    this.#refreshed = this.#refreshed.then(async () => {
      try {
        let view = lensed ? await this.#view(id, entry) : data;
        if (view !== null && hooked) {
          await runHook(this.#hooks, 'beforeRead', { id });
          const replaced = await runHook(this.#hooks, 'afterRead', { id }, view);
          if (replaced !== undefined) view = replaced;
        }
        record[REFRESH](view, delta, source);
      } catch (error) {
        // A read hook that refuses leaves the Record as it was.
        this.#logger.warn({ event: 'record.refresh', id, err: error });
      } finally {
        this.#refreshing -= 1;
      }
    });
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

  // One chain block per applied batch: `records` maps every touched id to
  // the hash of its data after the batch, `from`/`to` are the log positions.
  // A logged batch's records, written: true when they landed. The append
  // was the commit point — the ops are durable and replicate from the log —
  // so a backend that fails here (a full disk, a quota) does not undo them:
  // the entries are held in memory and the batch stays unapplied, replayed
  // onto the files at the next open. Reported, never thrown.
  async #land(touched, fromSeq, toSeq) {
    try {
      await this.#persistBatch(touched, fromSeq, toSeq);
    } catch (error) {
      await this.#unpersisted(touched, error);
      return false;
    }
    // A record written by this batch (a peer's page, a replay, a repair) was
    // written from the cache, which held its deferred local ops too: those
    // are on disk now, so their slot goes and their positions are applied —
    // a later flush must not lay the older deferred entry over this file.
    for (const id of touched.keys()) this.#settleDeferred(id);
    return true;
  }

  #settleDeferred(id) {
    const slot = this.#deferred.get(id);
    if (slot === undefined) return;
    this.#deferred.delete(id);
    for (const position of slot.positions) this.#log.applied(position);
  }

  // A local write under `open({ defer })`: the entry is held — the cache and
  // the catalog read it, the file and the block wait — and the flush is due
  // in `defer` ms, or at once ahead of tag() and close(). The log is durable
  // already; a crash before the flush replays the batch at the next open,
  // as it does after a file write that failed.
  async #deferWrite(id, entry, position) {
    await this.#entries.hold(id, entry);
    const slot = this.#deferred.get(id);
    if (slot !== undefined) {
      slot.entry = entry;
      slot.positions.push(position);
    } else this.#deferred.set(id, { entry, positions: [position] });
    if (this.#deferTimer === null) {
      this.#deferTimer = setTimeout(() => {
        this.#deferTimer = null;
        this.#run(() => this.#flushDeferred()).catch(() => {});
      }, this.#defer);
      this.#deferTimer.unref?.();
    }
  }

  // The deferred writes landed: one chain block, every file, the log told.
  // Inside the mutation queue, or after it drained (close).
  async #flushDeferred() {
    if (this.#deferTimer !== null) {
      clearTimeout(this.#deferTimer);
      this.#deferTimer = null;
    }
    if (this.#deferred.size === 0) return;
    const pending = this.#deferred;
    this.#deferred = new Map();
    const touched = new Map();
    const positions = [];
    for (const [id, slot] of pending) {
      touched.set(id, slot.entry);
      positions.push(...slot.positions);
    }
    if (await this.#land(touched, Math.min(...positions), Math.max(...positions))) {
      for (const position of positions) this.#log.applied(position);
    }
    this.#flushCatalog();
  }

  async #unpersisted(touched, error) {
    for (const [id, entry] of touched) await this.#entries.hold(id, entry);
    const ids = [...touched.keys()];
    this.#logger.warn({ event: 'storage.unpersisted', ids, err: error });
    const message = `${ids.join(', ')}: logged, but not written; held until the next open`;
    notify(this, this.#logger, 'error', new SyncomError('UNPERSISTED', message, { ids, cause: error }));
  }

  async #persistBatch(touched, fromSeq, toSeq) {
    let blockHash = null;
    if (this.#chain) {
      const records = {};
      for (const [id, entry] of touched) records[id] = await sha256(entry.data);
      const from = this.#log.formatId(fromSeq);
      const to = this.#log.formatId(toSeq);
      blockHash = await this.#chain.addBlock({ records, from, to });
    }
    for (const [id, entry] of touched) await this.#entries.write(id, entry, blockHash);
    return blockHash;
  }

  // ---------------------------------------------------------------------
  // The one local write path — src/commit.js, inside the queue.

  [COMMIT](type, id, payload, options = {}) {
    if (!isRecordId(id)) return Promise.reject(invalidId(id));
    return this.#run(() => commit(this.#core, type, id, payload, options));
  }

  // ---------------------------------------------------------------------
  // Public API

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
      const why = this.#plugins.names.includes('chain')
        ? 'open({ chain: false })'
        : "the chain plugin is not registered (open({ plugins: [chain] }) from '@alexify/syncom/chain')";
      throw typed('NO_CHAIN', `${why}: this storage keeps no chain to validate against`);
    }
    if (isChainValidation) {
      return await this.#chain.validate(idOrOptions);
    }
    const id = idOrOptions;
    try {
      const block = await this.#chain.readBlock(blockHash);
      const expectedHash = await sha256(data);
      if (!block) return false;
      // The block must be the one it is filed under: a file planted beside
      // the chain with the right `records` map is not a commit.
      if ((await sha256(block)) !== blockHash) return false;
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
    const entry = await this.#entries.load(id);
    return entry !== null && (entry.encrypted || isAlive(entry));
  }

  /** Whether `id` is a live record here — answered from the catalog, no I/O. */
  hasRecord(id) {
    return this.#catalog.has(id) || this.#live(id) !== undefined;
  }

  // The raw read, as a copy: what `get` returns before its hooks, what
  // `swap` compares against (so a redacting afterRead cannot break its CAS).
  // `getCachedData()` and `snapshot()` are the raw objects, for callers that
  // know not to touch them.
  async #read(id) {
    return V.reading(this.#core, id, await this.#entries.load(id));
  }

  async get(id, { at } = {}) {
    if (at !== undefined) return V.getAt(this.#core, id, at);
    await runHook(this.#hooks, 'beforeRead', { id });
    const data = await this.#read(id);
    const replaced = await runHook(this.#hooks, 'afterRead', { id }, data);
    return replaced === undefined ? data : replaced;
  }

  // ---------------------------------------------------------------------
  // Versions, patches and tags — src/versions.js, one delegate each.

  diff(id, from, to) {
    return V.diff(this.#core, id, from, to);
  }

  applyPatches(id, patches, options) {
    return V.applyPatches(this.#core, id, patches, options);
  }

  restore(id, at, options) {
    return V.restore(this.#core, id, at, options);
  }

  compact(id, options) {
    return V.compact(this.#core, id, options);
  }

  tag(name) {
    return V.tag(this.#core, name);
  }

  untag(name) {
    return V.untag(this.#core, name);
  }

  /** The tags, oldest first. */
  tags() {
    return this.#tags.list();
  }

  at(name) {
    return V.at(this.#core, name);
  }

  history(id, options) {
    return V.history(this.#core, id, options);
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
    await this.#core.scrub(id);
    this.#records.delete(id);
  }

  async update(id, delta, { actor } = {}) {
    if (!isRecordId(id)) throw invalidId(id);
    if (!(await this.has(id))) throw new SyncomError('NOT_FOUND', `Record ${id} not found`, { id });
    if (!isPlainObject(delta)) throw new TypeError('update() takes a plain object');
    await this[COMMIT]('set', id, { data: delta }, { actor });
  }

  // ---------------------------------------------------------------------
  // The field kinds beyond registers: counters and sets from src/fields.js,
  // one delegate each; a plugin's methods — lists, texts, trees — through
  // its module (src/plugin.js). A method of a plugin this storage was not
  // opened with rejects with PLUGIN_MISSING naming the subpath.

  #api(name) {
    const method = this.#plugins.methods[name];
    if (method === undefined) throw missing(`${name}()`);
    return method;
  }

  inc(id, key, value, options) {
    return F.inc(this.#core, id, key, value, options);
  }

  add(id, key, elements, options) {
    return F.add(this.#core, id, key, elements, options);
  }

  remove(id, key, elements, options) {
    return F.remove(this.#core, id, key, elements, options);
  }

  async splice(id, key, index, count, content, options) {
    return this.#api('splice')(this.#core, id, key, index, count, content, options);
  }

  async push(id, key, content, options) {
    return this.#api('push')(this.#core, id, key, content, options);
  }

  async updateText(id, key, text, options) {
    return this.#api('updateText')(this.#core, id, key, text, options);
  }

  async mark(id, key, start, end, name, value, options) {
    return this.#api('mark')(this.#core, id, key, start, end, name, value, options);
  }

  async unmark(id, key, start, end, name, options) {
    return this.#api('unmark')(this.#core, id, key, start, end, name, options);
  }

  async unmarkById(id, key, markId, options) {
    return this.#api('unmarkById')(this.#core, id, key, markId, options);
  }

  async spans(id, key) {
    return this.#api('spans')(this.#core, id, key);
  }

  async cursor(id, key, index, options) {
    return this.#api('cursor')(this.#core, id, key, index, options);
  }

  async index(id, key, cursor) {
    return this.#api('index')(this.#core, id, key, cursor);
  }

  async setAt(id, key, index, value, options) {
    return this.#api('setAt')(this.#core, id, key, index, value, options);
  }

  async move(id, key, from, to, options) {
    return this.#api('move')(this.#core, id, key, from, to, options);
  }

  async treeMove(id, key, node, parent, options) {
    return this.#api('treeMove')(this.#core, id, key, node, parent, options);
  }

  async treeRemove(id, key, node, options) {
    return this.#api('treeRemove')(this.#core, id, key, node, options);
  }

  /**
   * Rebuilds the record `id` from what this node's log holds of it — for a
   * file that fails its integrity check (`INTEGRITY`) or is torn. The
   * retained entries are replayed from the first whole-record op among
   * them (a `write`, `merge`, `delete` or `purge`; a scrubbed one is a
   * no-op), the result written through the usual seam with a chain block of
   * its own. What comes out is what a peer replaying this log from that op
   * would hold; an id with no such op retained — compacted away, never
   * written here, encrypted — rejects with `UNRECOVERABLE`. Returns how many
   * ops went in and whether the record is alive.
   */
  repair(id) {
    if (!isRecordId(id)) return Promise.reject(invalidId(id));
    return this.#run(() => this.#repair(id));
  }

  async #repair(id) {
    const entries = this.#log.entriesOf(id).filter((entry) => appliedHere(entry, this.#version));
    const whole = ({ op, scrubbed }) => op.type === 'purge' || (!scrubbed && WHOLE.has(op.type));
    const start = entries.findIndex(whole);
    if (start === -1) {
      const message = `Record ${id} cannot be rebuilt: the log holds no whole-record op for it`;
      throw new SyncomError('UNRECOVERABLE', message, { id });
    }
    let entry = null;
    for (let i = start; i < entries.length; i++) {
      this.#clock.observe(entries[i].op.ts);
      ({ entry } = applyOp(entry, entries[i].op, this.#limits));
    }
    this.#entries.forget(id);
    await this.#persistBatch(new Map([[id, entry]]), entries[start].seq, entries[entries.length - 1].seq);
    this.#flushCatalog();
    const ops = entries.length - start;
    const alive = isAlive(entry);
    this.#logger.info({ event: 'record.repaired', id, ops, alive });
    this.#emitUpdate(id, alive ? entry.data : null, alive ? { ...entry.data } : {});
    return { ops, alive };
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
    const entry = this.#entries.cached(id);
    if (!entry) return null;
    if (entry.encrypted) return entry.data;
    return isAlive(entry) ? entry.data : null;
  }

  // ---------------------------------------------------------------------
  // Replication — src/apply.js and src/bootstrap.js, inside the queue.

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
    return this.#run(() => applyBatch(this.#core, ops, options));
  }

  /**
   * One page of this node's state for a peer that cannot be resumed from
   * the log: live records AND tombstones, with their metadata, in id order.
   * `cursor` is the last id of the previous page; `null` back means done.
   */
  snapshot(options = {}) {
    return snapshotPage(this.#core, options);
  }

  /**
   * Joins snapshot records into this node's state. Each becomes a `merge` op
   * of this node's own, so the joined state also reaches the peers that
   * resume from THIS node's log — bootstrap is transitive. A page is joined
   * under one turn of the mutation queue: one log append, one chain block,
   * one catalog flush, rather than a full commit per record.
   */
  mergeSnapshot(records, { via = null, from = null } = {}) {
    return this.#run(() => mergeBatch(this.#core, records, via, from));
  }

  /**
   * Records that everything up to `vector` is reflected in this node's state
   * (a snapshot of it was just joined), as an `advance` op in this node's
   * own log — so a peer replaying the merges also learns which ops they cover.
   */
  adoptVector(vector, options = {}) {
    return this.#run(() => adopt(this.#core, vector, options));
  }

  /** Stops replication and seals the log. Further writes are refused — from the moment close() is called. */
  async close() {
    if (this.#closed) return;
    // Refused from here on: a write that landed while the links were
    // closing would be announced to nobody, after the final catalog save.
    // What was queued before this call still runs, ahead of the seal.
    this.#closed = true;
    if (this.#sync !== null) await this.#sync.stop();
    const seal = async () => {
      await this.#flushDeferred();
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
