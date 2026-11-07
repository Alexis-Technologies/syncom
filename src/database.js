'use strict';

// The engine's front: a Database opens a directory (through an injected
// backend), owns the mutation queue every write runs in, and lends its
// collaborators to the three write paths — the local one in src/commit.js,
// a peer's batch in src/apply.js, a bootstrap page in src/bootstrap.js.
// Records live in src/entries.js, what the application holds in
// src/document.js and src/collection.js, the options in src/options.js. The API of the field kinds
// beyond registers is src/fields.js and the versions API src/versions/api.js,
// both over the same lent core: this file keeps a delegate per method.

const { Emitter, generateUUID, createLogger, taskScope, estimateStorage, persistStorage } = require('./utils.js');
const { sha256 } = require('./crypto/digest.js');
const { OpLog, appliedHere } = require('./log.js');
const { EntryStore } = require('./entries.js');
const { Document } = require('./document.js');
const { Collection } = require('./collection.js');
const { commit, commitAtOnce, transact, prepareOp, applyLocal, MISMATCH, ABSENT } = require('./commit.js');
const F = require('./fields.js');
const P = require('./patches.js');
const B = require('./blame.js');
const { applyBatch } = require('./apply.js');
const { snapshotPage, mergeBatch, adopt } = require('./bootstrap.js');
const { applyOp, isAlive, kindOf } = require('./ops.js');
const { Clock } = require('./vector.js');
const { notify, runHook, normalizeHooks } = require('./hooks.js');
const { project, namedId, idReason } = require('./schema/entity.js');
const defaultFsi = require('./fsi.js');
const { checkFsi, withSync } = require('./backend.js');
const { checkEngine, checkEngineDb, kvNamespace } = require('./engine.js');
const { readOnlyDb } = require('./readonly.js');
const { filesEngine } = require('./files/files.js');
const { acquireLock } = require('./lock.js');
const { Catalog, isTextIndex } = require('./catalog.js');
const { DISABLED, isWriter, writerOf, traced, now } = require('./telemetry/writer.js');
const { GLOBAL_SCOPE } = require('./scope.js');
const { normalizeStorageOptions } = require('./options.js');
const { isPlainObject, isRecordId, invalidId, isStreamName, VALIDATED, MAX_ACTOR, asJson } = require('./shape.js');
const { isOperators } = require('./operators.js');
const { checkOrm, tombstone, operate, modifyIn } = require('./writes.js');
const { dropDatabase } = require('./drop.js');
const { Observers } = require('./observe.js');
const { DeferredWindow } = require('./defer.js');
const { fieldName } = require('./args.js');
const { compose, composeData } = require('./compose.js');

// The ids a `storage.unpersisted` line names; past them it says how many.
const UNPERSISTED_NAMED = 32;
const { COMMIT, REFRESH, SOURCE, PLUGINS, CURSOR, SIGNER, REWIND, DB } = require('./symbols.js');
const { missing, HOME } = require('./plugin.js');
const { SyncomError, typed, isQuotaError } = require('./errors.js');
const { loadIdentity } = require('./identity.js');

// What a storage without the schema plugin runs with: no entities, version 1.
const NO_SCHEMA = Object.freeze({ version: 1, entities: new Map(), snapshot: undefined, ahead: 'apply', view: null });

// The hooks a storage accepts (`createDatabase({ hooks })`). Writes and reads run
// their hooks inside this storage; the apply pair runs per peer batch.
const STORAGE_HOOKS = ['beforeWrite', 'afterWrite', 'beforeRead', 'afterRead', 'beforeApply', 'afterApply'];

// A method's refusal of its arguments is a rejection, never a throw (the method delegates have no async
// frame): what the write API's methods wrap their call in.
const attempt = (fn) => {
  try {
    return fn();
  } catch (error) {
    return Promise.reject(error);
  }
};

// Who an op says made it: a string of MAX_ACTOR characters at most (it rides in the signed header
// every node hashes; a peer's past the bound is malformed), null for nobody.
const actorName = (actor) => {
  if (actor === null || actor === undefined) return null;
  const name = String(actor);
  if (name.length > MAX_ACTOR) throw new TypeError(`actor must be at most ${MAX_ACTOR} characters`);
  return name;
};

// The ops that leave a record's whole state behind them — where a repair
// can start replaying from. A purge counts even scrubbed; the others not.
const WHOLE = new Set(['write', 'merge', 'delete']);

const NOOP = () => {};

// How many records a collection defined after the open indexes at a time, inside the queue.
const REINDEX_PAGE = 500;
// How many chain blocks a cold read verified are kept parsed: the records of a batch are read close together.
const VERIFIED_BLOCKS = 8;

class Database extends Emitter {
  #path;
  #identity = null;
  #seal = null;
  #chain = null;
  #schemaHook = null;
  #cursor = null;
  // A Mango query as a predicate over `{ id, ...record }` — the query plugin's (`ifMatch`).
  #matches = null;
  // The `[SOURCE]` seam, built once at the first access and frozen: its members read the database's state as it is.
  #source = null;
  // The query plugin's `stats()`, for `stats().query`; null without the plugin.
  #queryStats = null;
  // The local documents (`db.local`) — the local plugin's.
  #local = null;
  // The attachments (`db.attachments`) — the attachments plugin's.
  #attachments = null;
  #settings;
  #log = null;
  #entries = null;
  #tags = null;
  #core = null;
  #records = null;
  #reaper = null;
  // The observers of records (`observe()`, src/observe.js).
  #observers = new Observers(this, () => this.#logger);
  // Live Records refreshed as get() reads — the lens, the read hooks —
  // after the write that changed them, one after another.
  #refreshed = Promise.resolve();
  #refreshing = 0;
  #sync = null;
  #cacheMax;
  #verify;
  // The chain blocks cold reads verified lately, by hash — each parsed and hashed ONCE: a batch of N records is one
  // block N long, and N reads of its records parsed and hashed it N times (10 000 records read in 19 s).
  #blocks = new Map();
  #catalog = null;
  #catalogSave = null;
  #flushEvery;
  // The engine the database stores its bytes through, and its database of stores (src/engine.js).
  #engine;
  #db = null;
  #lock = null;
  #lockOptions;
  // How the database is held: through a lock key, or the engine's own lease — and the lease's renewals heard.
  #lockKind = 'kv';
  #unleash = null;
  // A follower (`readOnly: true`), or a writer whose lease was lost: every write is READ_ONLY.
  #readOnly = false;
  #leaseLost = false;
  // What another instance wrote, heard through the engine's change stream (a
  // follower): read one message after another; what came before the
  // collections were up waits.
  #heard = Promise.resolve();
  #unhear = null;
  #hearing = false;
  #heardEarly = [];
  #schema = null;
  #entities = null;
  // The collections, by name, as one frozen object (`db.collections`); made again when one is added or removed.
  #collections = Object.freeze({});
  // Who hears of every plan a cursor makes (`indexAdvisor` of @alexify/syncom/inspect).
  #advisors = new Set();
  // The text index factory (`createDatabase({ search })`), kept for a collection defined after the open.
  #search = null;
  #version = null;
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
  // The engine's write sets: how many, how many failed, the time they took (ms) — `stats().engine`.
  #engineStats = { writes: 0, failures: 0, ms: 0 };
  // A follower's: the records heard through the change stream, the re-reads that failed, the catch-ups run.
  #followStats = { heard: 0, failed: 0, caughtUp: 0 };
  #options;
  #nodeId = null;
  #clock = new Clock();
  #scopeOf;
  #maxSkew;
  // The records whose held stamp ran past the skew allowed, told once each.
  #skewed = new Set();
  #limits;
  #plugins;
  // What a transaction's `tx` carries (#transaction): `[name, method]`, the
  // field methods and the plugins' — a plugin's in place of a field's.
  #txMethods = [];
  // Local writes whose record files wait (`createDatabase({ defer })`, src/defer.js).
  #defer = 0;
  #window = null;
  // Local writes appended but not yet on disk: id → the entries the record's
  // in-flight ops leave it as, oldest first, each with its log position —
  // what the write paths build on while the disk is waited for outside the
  // queue. The landings — the disk, the file, the hooks, the listeners —
  // run one after another, in log order.
  #inflight = new Map();
  #inflightCount = 0;
  // The unique keys the records in flight hold — `entity\0fields\0key` → the ids, and per record its pairs — kept
  // as a record takes off and settles, so `#conflicts` checks an op against them at once: a scan of every record in
  // flight per op was N² views while a batch of N landed behind another (two batches of 4 000 rows, 7 s).
  #inflightKeys = new Map();
  #inflightPairs = new Map();
  // The ids in flight whose view the lens has not composed yet: checked by hand.
  #inflightUnkeyed = new Set();
  #landings = Promise.resolve();
  // Landing steps queued and not yet done: while there is one, a write
  // lands behind it, through the chain — never at once, ahead of it.
  #slowSteps = 0;
  // The editors' handles open on this storage (src/text/handle.js): flushed
  // before a flush(), a tag() and a close() — what they hold is not logged yet.
  #edits = new Set();
  // What the handles follow the `transaction` event with, by record id, under
  // ONE listener of the storage's (as src/observe.js does for observe()): a
  // handle never counts against maxListeners, and a turn reaches the handles
  // of the records it touched alone.
  #followers = new Map();
  #following = null;
  // The run offsets reserved while a handle is open, per field (src/text/kind.js extendsRun).
  #extents = new Map();
  // How the local writes went: made at once (src/commit.js commitAtOnce), through the queue, or
  // folded into the write before them (coalesced) — `stats().commits`.
  #commits = { fast: 0, queued: 0, coalesced: 0 };
  // The one close, once called: a second call waits for it, never seals twice.
  #closing = null;
  // Whether a write may be made at once (#fastCommit): set at open, once the
  // plugins have set up — nothing asynchronous on the write path.
  #fastIssue = false;
  #signatures;
  #encrypted;
  #hooks;
  #inHook = 0;
  // The async context a transaction's (or a `modify()`'s) function runs in: a write made through the
  // database from inside it would wait for the queue the function holds (IN_TRANSACTION); one made
  // meanwhile by anyone else queues. Node's async context; the browser half tells neither apart.
  #task = taskScope();
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
    this.#readOnly = settings.readOnly;
    this.#cacheMax = settings.cacheMax;
    this.#verify = settings.verify;
    this.#flushEvery = settings.flushEvery;
    this.#getId = settings.getId ?? Database.generateId;
    this.#actor = settings.actor;
    this.#encrypted = settings.encrypted;
    this.#scopeOf = settings.scope ?? (() => GLOBAL_SCOPE);
    this.#maxSkew = settings.maxSkew;
    // What the op model is told to bound (src/ops.js applyOp): the pending
    // work of a list or text field. Every fold of the log runs under it too.
    this.#plugins = settings.plugins;
    const methods = { ...F, ...settings.plugins.methods };
    for (const name of Object.keys(methods)) this.#txMethods.push([name, methods[name]]);
    this.#limits = { pendingMax: settings.pendingMax, plugins: settings.plugins };
    this.#defer = settings.defer;
    this.#window = new DeferredWindow(settings.defer, {
      hold: (id, entry) => this.#entries.hold(id, entry),
      landing: (task) => this.#landing(task),
      land: (touched, from, to) => this.#land(touched, from, to),
      applied: (position) => this.#log.applied(position),
      saveCatalog: () => this.#flushCatalog(),
      recordFlush: (elapsed, records) => this.#otel.recordFlush(elapsed, records),
    });
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
    this.#engine = this.#engineOf(options, settings.durable);
    this.#hooks = normalizeHooks(options.hooks, STORAGE_HOOKS, 'Storage');
    return this.#init();
  }

  // The engine: the one given, or the files engine over the backend —
  // node:fs or OPFS by default, anything with the five functions when
  // injected (`durable` wraps every write with the adapter's fsync, where it
  // has one). An engine and a backend together make no sense: refused.
  #engineOf(options, durable) {
    if (options.engine !== undefined) {
      if (options.fsi !== undefined) {
        throw new TypeError('createDatabase({ engine, fsi }): an engine or a backend, not both');
      }
      return checkEngine(options.engine, 'createDatabase({ engine })');
    }
    return filesEngine(this.#backend(options, durable));
  }

  #backend(options, durable) {
    const fsi = checkFsi(options.fsi === undefined ? defaultFsi : options.fsi, 'createDatabase({ fsi })');
    if (!durable) return fsi;
    if (typeof fsi.sync === 'function') return withSync(fsi);
    this.#logger.debug({ event: 'durable.noop' });
    return fsi;
  }

  // The schema is the plugin's to read (`createDatabase({ schema, validator })` into
  // the entity definitions the write path consults: validators, id fields,
  // indexes) and the core's to apply; without the plugin a schema or a
  // validator given is refused here, naming it, and records are untyped.
  #defineSchema(options, search) {
    const given = this.#schemaHook;
    if (given === null) {
      if (options.schema !== undefined && options.schema !== null) {
        throw missing('createDatabase({ schema })', 'schema');
      }
      if (options.validator !== undefined) throw missing('createDatabase({ validator })', 'schema');
    }
    const schema = given?.given ?? null;
    const normalized = given ?? NO_SCHEMA;
    // A collection becomes a property of the storage: a name the storage
    // already answers to — a method, a getter, anything up its prototype
    // chain — would replace it or break the open. Refused before anything
    // is opened; so is a method or a static named like a member.
    for (const [name, def] of normalized.entities) {
      if (name in this) {
        throw new TypeError(`createDatabase({ schema }): entity name '${name}' is taken by the storage itself`);
      }
      checkOrm(def, 'createDatabase({ schema })');
    }
    this.#entities = normalized.entities;
    this.#schema = schema;
    this.#search = search;
    // One text index per searchable entity, from the injected factory: the
    // core knows the contract, not the index — a node that never searches
    // ships none of it.
    const text = new Map();
    for (const def of normalized.entities.values()) {
      const index = this.#textIndexOf(def);
      if (index !== null) text.set(def.name, index);
    }
    const { logger } = this;
    // Persisted through the engine's catalog store where it has one (a native
    // engine keeps the rows as they are), else as catalog.json in the `index` namespace.
    const where = this.#db.catalog ? { rows: this.#db.catalog } : { store: kvNamespace(this.#db.kv, 'index') };
    this.#catalog = new Catalog({ ...where, entities: normalized.entities, text, logger });
    // A node with a schema stamps its version on every op it makes; one
    // without stamps nothing, and nothing in hello says what it runs.
    if (schema === null) return;
    this.#version = normalized.version;
    this.#ahead = normalized.ahead;
    this.#lens = normalized.view;
    // A held op lives in the log until this node runs its version;
    // retention that would drop it first makes the hold a silent loss.
    const retention = options.sync?.retention;
    const retained = retention === 'all' ? Infinity : retention?.ops;
    if (this.#ahead === 'hold' && retained !== undefined && retained > 0 && retained < 1000) {
      throw new TypeError("createDatabase({ schema }): ahead 'hold' needs sync.retention.ops of 1000 or more, or 0");
    }
  }

  // The text index of a searchable entity, from the injected factory; null for one without search fields.
  #textIndexOf(def) {
    if (def.search.length === 0) return null;
    if (this.#search === null) {
      const hint = 'give createDatabase() an index — createSearch() from @alexify/syncom/search';
      throw new TypeError(`createDatabase({ search }): entity ${def.name} declares search fields; ${hint}`);
    }
    const index = this.#search(def.name);
    if (!isTextIndex(index)) {
      throw new TypeError(
        `createDatabase({ search }): the index for ${def.name} must have put(), remove() and query()`,
      );
    }
    return index;
  }

  async #init() {
    // A follower opens beside the writer: only an engine whose databases
    // several instances may open at once (`shared` — memory, IndexedDB,
    // MongoDB) serves one. The files engine's journal and SQLite's connection
    // are one instance's: a second reader there would load a group the
    // writer is still writing.
    if (this.#readOnly && this.#engine.capabilities.shared !== true) {
      throw new TypeError(
        `createDatabase({ readOnly }): the ${this.#engine.name} engine is not shared — one instance per database`,
      );
    }
    // The engine's database: every store the open reads and writes through.
    const opened = await this.#engine.open(this.#path, { logger: this.#logger, durable: this.#settings.durable });
    const db = checkEngineDb(opened, 'createDatabase({ engine })');
    // A follower reads through the engine and writes nothing — not even the
    // log's index — so it holds no lock: the writer does.
    this.#db = this.#readOnly ? readOnlyDb(db, (what) => this.#refused(what)) : db;
    // One instance per directory, first: a second one would mint the seqs
    // this one is about to. `lock: false` is for a caller that coordinates.
    const lock = this.#readOnly ? null : this.#lockOptions;
    try {
      // A follower hears what the writer lands from before it loads anything:
      // a record landed between the load and the subscription would be
      // missed for good. What comes while the open runs waits for the
      // collections (`#heardEarly`).
      if (this.#readOnly && db.changes !== undefined) this.#subscribeChanges();
      if (lock !== null) {
        // Recorded once the writer is set up (a plugin's, after the lock).
        const started = now();
        // The engine's own lease where it has one (MongoDB), the lock key of the root namespace otherwise.
        const native = db.capabilities.lock === 'native' && typeof db.lock === 'function';
        this.#lock = native
          ? await db.lock({ ...lock, onLost: (error) => this.#lostLease(error) })
          : await acquireLock({ store: kvNamespace(db.kv, ''), path: this.#path, ...lock });
        this.#lockKind = native ? 'native' : 'kv';
        // A lease that tells of its renewals (an engine's own; one served over a port does not): the `lease` events.
        this.#unleash = this.#lock.subscribe?.((event) => this.#leaseState(event)) ?? null;
        this.#lockWait = now() - started;
      }
      await this.#open();
    } catch (error) {
      this.#unhear?.();
      await this.#lock?.release();
      await this.#db.close();
      throw error;
    }
    return this;
  }

  async #open() {
    const db = this.#db;
    // The backend behind the files engine, for what still speaks fsi; null under a native engine.
    const fsi = db.fsi ?? null;
    // The API plugins set up before the log opens — the identity (signing),
    // the sealing of records (encryption), the chain — each handing back the
    // hooks the core takes; what the options ask for and no plugin provides
    // is refused here, naming the subpath. They reach the stores through `db`.
    if (this.#readOnly && typeof this.#options.sync?.connect === 'function') {
      throw new TypeError('createDatabase({ readOnly }): a read-only database does not dial — it reads and serves');
    }
    const ctx = {
      fsi,
      db,
      path: this.#path,
      logger: this.#logger,
      options: this.#options,
      settings: this.#settings,
      storage: this,
      // SHA-256 of a value's JSON (src/crypto/digest.js), the core's: a plugin
      // hashes with it rather than bundle a digest of its own.
      hash: sha256,
      // A catalog of a tag (the versions plugin's), over the tag's own kv
      // namespace: the entities are read when it is made, after the schema is defined.
      catalogOf: (name) =>
        new Catalog({
          store: kvNamespace(db.kv, `tags/${name}/index`),
          entities: this.#entities,
          logger: this.#logger,
        }),
    };
    let adapted = false;
    for (const mod of this.#plugins.apis) {
      const hooks = (await mod.setup?.(ctx)) ?? {};
      if (hooks.identity) this.#identity = hooks.identity;
      if (hooks.seal) this.#seal = hooks.seal;
      if (hooks.chain) this.#chain = hooks.chain;
      if (hooks.schema) this.#schemaHook = hooks.schema;
      if (hooks.query) {
        this.#cursor = hooks.query.cursor;
        this.#matches = hooks.query.matches ?? null;
        this.#queryStats = hooks.query.stats ?? null;
      }
      if (hooks.versions) this.#tags = hooks.versions.tags;
      if (hooks.local) this.#local = hooks.local;
      if (hooks.attachments) this.#attachments = hooks.attachments;
      if (Object.hasOwn(hooks, 'telemetry')) {
        this.#otel = writerOf(hooks.telemetry);
        adapted = true;
      }
    }
    // A writer given as it is (the contract: `enabled`, `withSpan`) the core
    // takes; an OpenTelemetry api or tracer needs the plugin to adapt it.
    const given = this.#options.telemetry;
    if (!adapted && given && typeof given === 'object') {
      if (isWriter(given)) this.#otel = writerOf(given);
      else throw missing('createDatabase({ telemetry })', 'telemetry');
    }
    if (this.#lockWait > 0 && this.#otel.enabled) this.#otel.recordLockWait(this.#lockWait);
    if (this.#signatures === 'require' && this.#identity === null) {
      throw missing("sync.signatures 'require'", 'signing');
    }
    if (this.#options.chain === true && this.#chain === null) throw missing('createDatabase({ chain: true })', 'chain');
    if (this.#encrypted && this.#seal === null) throw missing('createDatabase({ encrypted: true })', 'encryption');
    this.#defineSchema(this.#options, this.#settings.search);
    this.#installMethods();
    // A directory with tags needs the plugin that keeps their copies: opened
    // without it, the next change would leave a tag reading what it was not.
    if (this.#tags === null && (await this.#hasTags())) throw missing('a storage with tags', 'versions');
    this.#log = await new OpLog(this.#path, {
      ...this.#options.sync?.log,
      retention: this.#options.sync?.retention,
      logger: this.#logger,
      telemetry: this.#otel,
      // The log's medium: the engine's (the files engine's journal under log/).
      store: db.log,
      // A roll seals only what the write paths marked applied — see
      // OpLog.applied: the tail a reopen replays must hold every batch whose
      // records may not have been written.
      sealApplied: true,
      // The floor moving is news to an operator: a peer below it bootstraps.
      onRoll: (roll) => notify(this, this.#logger, 'log', { kind: 'roll', ...roll }),
      // A group that did not reach the disk: what was built on its seqs is
      // dropped before the tickets reject, so the next write starts over.
      onFail: (_error, from) => this.#takenBack(from),
    });
    // The clock picks up where the log left off: every stamp this node ever
    // logged is below what it will stamp next, whatever the wall clock says.
    this.#clock.observe(this.#log.latestTs);
    this.#entries = new EntryStore({
      db,
      max: this.#cacheMax,
      logger: this.#logger,
      catalog: this.#catalog,
      pinned: (id) => this.#live(id) !== undefined,
      verify: this.#verify && this.#chain !== null ? (id, data, block) => this.validate(id, data, block) : null,
      decrypt: (data) => this.#unseal(data),
      view: (id, entry) => this.#view(id, entry),
      before: this.#tags === null ? null : (id, file) => this.#tags.copyBefore(id, file),
      plugins: this.#plugins,
      measure: (ms, ok) => this.#engineWrote(ms, ok),
    });
    await this.#loadIdentity();
    await this.#loadSchema();
    // The folded tombstones listed before the catalog loads: what a read of a gone row falls back to.
    await this.#entries.open();
    await this.#loadCatalog();
    if (this.#tags !== null) await this.#tags.load();
    this.#core = this.#lend();
    this.#fastIssue =
      this.#hooks.beforeWrite === null &&
      this.#hooks.afterWrite === null &&
      this.#core.sign === null &&
      typeof this.#actor !== 'function' &&
      this.#defer > 0 &&
      this.#lens === null;
    // The writer lands the log's tail; a follower reads what it landed.
    if (!this.#readOnly) {
      await this.#replayTail();
      await this.#replayHeld();
    }
    // The API plugins that need the open log — the sync manager — come
    // after the replay, and hand back what the facade exposes.
    const opened = { storage: this, db, options: this.#options, settings: this.#settings, logger: this.#logger };
    for (const mod of this.#plugins.apis) {
      const hooks = (await mod.open?.(opened)) ?? {};
      if (hooks.sync) this.#sync = hooks.sync;
    }
    this.#initCollections();
    // A follower's collections are up: what the change stream brought while
    // the open ran is read now, in order, and what comes next as it comes.
    if (this.#unhear !== null) {
      this.#hearing = true;
      const early = this.#heardEarly;
      this.#heardEarly = [];
      for (let i = 0; i < early.length; i++) this.#hearChange(early[i]);
    }
    // What the observable gauges sample, when a meter was given.
    this.#otel.gauges(() => ({
      outbox: this.#sync === null ? 0 : this.#sync.pendingOps(),
      queue: this.#queued,
      cache: this.#entries.size,
      catalog: this.#catalog.size,
      log: this.#log.length,
      inflight: this.#inflightCount,
      deferred: this.#window.size,
      held: this.#entries.heldIds().size,
    }));
  }

  // What the write paths (src/commit.js, src/apply.js, src/bootstrap.js)
  // reach of this storage: its collaborators, and the private readers they
  // share. Built once the log, the identity and the catalog are loaded;
  // every member is fixed from then on.
  #lend() {
    // Frozen: a path module reads what it is lent and changes none of it
    // (tests/package/core-surface.test.js names every member).
    return Object.freeze({
      // An event of the storage's, contained like every one (src/hooks.js
      // notify), and whether anything listens — a commit event is built only then.
      emit: (event, ...args) => notify(this, this.#logger, event, ...args),
      listening: (event) => this.listenerCount(event) > 0,
      // A listener of the storage's events, for a plugin that follows them (an
      // editor's handle): answers the function that takes it off.
      on: (event, listener) => {
        this.on(event, listener);
        return () => this.off(event, listener);
      },
      // What an editor's handle (src/text/handle.js) makes its edits with,
      // outside the queue, over a reading of its own: an op made and stamped
      // over an entry (`makeOp`), applied as a local write would be — a
      // refusal thrown (`applyLocal`) — or as an op from elsewhere is
      // (`applyTo`); and the open handles, which flush(), tag() and close()
      // flush first.
      editing: Object.freeze({
        handles: this.#edits,
        // A handle's listener of the record's turns (the `transaction` event); answers what takes it off.
        follow: (id, listener) => this.#follow(id, listener),
        // While a handle is open: the next offset of each run of this node's
        // a writer extended, reserved per field (src/text/kind.js extendsRun).
        extents: this.#extents,
        makeOp: (type, id, payload, current, who) => prepareOp(this.#core, type, id, payload, current, who, null),
        applyLocal: (op, current) => applyLocal(this.#core, op, current),
        applyTo: (entry, op) => applyOp(entry, op, this.#limits),
      }),
      logger: this.#logger,
      otel: this.#otel,
      log: this.#log,
      chain: this.#chain,
      // The hooks the plugins set up: the sealing of records, the hash
      // (SHA-256 of a value's JSON, Web Crypto), the signature of an op.
      seal: this.#seal,
      hash: sha256,
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
      deferred: (id, entry, position) => this.#window.write(id, entry, position),
      // The record as the write paths see it: its newest in-flight entry,
      // else the cache or the file; an op issued, its landing settled.
      current: (id) => this.#current(id),
      inflight: (id, entry, position) => this.#takeOff(id, entry, position),
      settled: (id, position) => this.#settle(id, position),
      landing: (step) => this.#landing(step),
      drain: () => this.#drained(),
      // A stream's last seq in the log, the fingerprint the log holds at a
      // seq of it (what an op of this node's chains to), and a batch landed
      // from inside a landing step (a transaction's: the chain block, the
      // files, the slots).
      seqOf: (key) => this.#log.seqOf(key),
      fingerprintOf: (key, seq) => this.#log.fingerprintOf(key, seq),
      land: (touched, from, to) => this.#land(touched, from, to),
      // Several writes as one, from outside the queue (a plugin's method).
      transact: (fn, options) => this.#run(() => transact(this.#core, fn, options)),
      signatures: this.#signatures,
      // Signs an op of this node's own, in place, once it is final —
      // `later` on the thread pool, for a write with others queued behind it.
      sign:
        this.#signatures === false || this.#identity === null
          ? null
          : (op, later = false) => this.#identity.sign(op, later),
      // Whether other writes wait on the queue behind the one running.
      pipelined: () => this.#queued > 1,
      verify: this.#identity === null ? null : (op, mode) => this.#identity.verify(op, mode),
      hook: (name, ...args) => this.#hook(name, ...args),
      view: (id, entry) => this.#view(id, entry),
      scopeOf: (id, data) => this.#scope(id, data),
      // Whether a scope function was given: without one every record is in
      // the global scope, and no write path composes a record to ask.
      scoped: this.#settings.scope !== null,
      actorOf: (given) => this.#actorOf(given),
      observe: (stamp, id) => this.#observeHeld(stamp, id),
      definitionOf: (data) => this.#definitionOf(data),
      // The fields a record's composite id is derived from (its entity's `id.fields`), or null: immutable.
      idFields: (data) => this.#definitionOf(data)?.id?.fields ?? null,
      conflicts: (id, entry) => this.#conflicts(id, entry),
      invalid: (op, entry) => this.#invalid(op, entry),
      persist: (touched, from, to) => this.#landing(() => this.#land(touched, from, to)),
      unpersisted: (touched, error) => this.#unpersisted(touched, error),
      // The catalog saved off the queue (one save in flight at a time).
      saveCatalog: () => this.#flushCatalog(),
      refresh: (id, data, delta, source, entry) => this.#emitUpdate(id, data, delta, source, entry),
      // For the API modules (src/fields.js, src/versions/api.js), which stand
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
      // The same commit for a method that answers nothing: resolves once the
      // write is announced, to undefined.
      write: (type, id, payload, options) => this.#write(type, id, payload, options),
      // A write made at once (src/commit.js commitAtOnce): the landings that
      // come after it wait for its group, which lands it.
      landed: (done) => {
        this.#landings = done;
      },
      // The same write from INSIDE a task of the queue (`core.run`), where
      // `commit` would wait for itself; and whether an entry is live.
      commitNow: (type, id, payload, options) => commit(this.#core, type, id, payload, options),
      cursor: (source, entity, query) => this[CURSOR](entity, query, { source }),
      alive: isAlive,
      // A field's kind in an entry, under this storage's registry (src/ops.js kindOf).
      kindOf: (entry, field) => kindOf(entry, field, this.#plugins),
      forget: (id) => this.#records.delete(id),
      flushDeferred: () => this.#flushDeferred(),
      // A purge reaches the log and the tags alike; the ids of a batch together, every file holding them rewritten once.
      scrub: async (ids) => {
        await this.#log.scrub(ids);
        if (this.#tags !== null) await this.#tags.scrub(ids);
      },
    });
  }

  // The catalog is derived from the records and the folded tombstones: the
  // persisted one is reused when the log can say what changed since it was
  // saved (those records are re-read), rebuilt from a scan of the records and
  // the `tombstones` namespace otherwise — a first open, a stamp from another
  // epoch or below the floor, other indexes.
  async #loadCatalog() {
    const saved = await this.#catalog.load();
    const tail = saved === null ? null : this.#log.since(saved.stamp);
    if (tail === null) {
      const reason = saved === null ? 'no catalog' : 'stamp not resumable';
      this.#logger.debug({ event: 'catalog.rebuild', reason });
      const rebuild = async () => {
        // A page of ids and ONE read of the page's records, not a read a record.
        let count = 0;
        const page = 500;
        let after = null;
        for (;;) {
          const ids = await this.#db.records.ids({ after, limit: page });
          if (ids.length === 0) break;
          const found = await this.#db.records.getMany(ids);
          for (let i = 0; i < ids.length; i++) {
            await this.#entries.index(ids[i], found.get(ids[i]) ?? null);
            count++;
          }
          if (ids.length < page) break;
          after = ids[ids.length - 1];
        }
        // The folded tombstones — the ids the `tombstones` namespace listed at open — that no record file
        // answered for: indexed from the namespace. An id with a file AND an entry (a fold torn between its two
        // halves on files) keeps the file; the entry is taken away.
        const folded = this.#entries.foldedIds();
        const orphans = [];
        for (let i = 0; i < folded.length; i++) {
          if (this.#catalog.row(folded[i]) !== null) {
            orphans.push(folded[i]);
            continue;
          }
          await this.#entries.index(folded[i]);
          count++;
        }
        if (orphans.length > 0 && !this.#readOnly) await this.#entries.dropMany(orphans, { keepRows: true });
        if (!this.#readOnly) await this.#catalog.save(this.#log.lastEventId);
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
    if (touched.size > 0 && !this.#readOnly) await this.#catalog.save(this.#log.lastEventId);
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
    if (this.#readOnly || this.#catalogSave !== null || this.#catalog.dirty < this.#flushThreshold()) return;
    this.#catalogSave = this.#catalog
      .save(this.#log.lastEventId)
      .catch((error) => this.#logger.warn({ event: 'catalog.save', err: error }))
      .finally(() => {
        this.#catalogSave = null;
      });
  }

  // The error a write meets on a read-only database: a follower's, or a
  // writer's whose lease was lost (nothing of it is written any more: what
  // was logged but not landed is held as UNPERSISTED).
  #refused(what) {
    const why = this.#leaseLost ? 'its lease was lost' : 'it was opened with readOnly: true';
    return new SyncomError('READ_ONLY', `Database at ${this.#path} is read-only (${why}): ${what} refused`, {
      path: this.#path,
      lease: this.#leaseLost,
    });
  }

  // The engine's lease on this database went to another instance (not
  // renewed in time, or taken): from here on every write is READ_ONLY, and
  // the application hears it once.
  #lostLease(cause) {
    if (this.#closed || this.#leaseLost) return;
    this.#leaseLost = true;
    this.#readOnly = true;
    // Nothing of this instance reaches the engine from here on: the stores
    // refuse as a follower's do, the log's medium with them (a group fails,
    // a seal, a drop and the index are nothing, close() seals nothing), and
    // every landing — in flight or deferred — is held, UNPERSISTED. The
    // engine's own fence refuses what is already on its way.
    this.#db = readOnlyDb(this.#db, (what) => this.#refused(what));
    this.#log?.readOnly(this.#db.log);
    this.#logger.error({ event: 'storage.lease.lost', path: this.#path, err: cause });
    const message = `Database at ${this.#path} lost its lease: read-only from here on`;
    notify(this, this.#logger, 'error', new SyncomError('LEASE_LOST', message, { path: this.#path, cause }));
    notify(this, this.#logger, 'lease', { state: 'lost', path: this.#path });
  }

  // The lease's life, as the engine tells it: every renewal, and the first
  // failed one of a run (`late`: retried until a third of `staleAfter` is
  // left, then lost) — the `lease` event, contained like every event.
  #leaseState({ state, error }) {
    if (this.#closed || this.#leaseLost) return;
    if (state === 'late') this.#logger.warn({ event: 'storage.lease.late', path: this.#path, err: error });
    notify(this, this.#logger, 'lease', { state, path: this.#path });
  }

  // The engine's change stream, subscribed: what it brings goes to #hearChange.
  #subscribeChanges() {
    this.#unhear = this.#db.changes.subscribe((message) => this.#hearChange(message));
  }

  // A record another instance wrote, heard through the engine's change
  // stream: read again, its catalog row and a live Document with it. In
  // order, one at a time; the log's news is the writer's to apply. The
  // stream's end (`{ error }`) is a loss: subscribed again, read again whole.
  #hearChange(message) {
    if (this.#closed || message === null || typeof message !== 'object') return;
    if (!this.#hearing) return void this.#heardEarly.push(message);
    if (message.error !== undefined) return void this.#followLost(message.error);
    if (!Array.isArray(message.records)) return;
    const ids = message.records;
    this.#followStats.heard += ids.length;
    this.#heard = this.#heard.then(async () => {
      // The records heard, read in one call; one by one where the engine cannot (a record gone reads as null).
      let found = null;
      try {
        found = await this.#db.records.getMany(ids);
      } catch (error) {
        this.#logger.warn({ event: 'follow.failed', id: null, err: error });
      }
      for (let i = 0; i < ids.length; i++) {
        if (this.#closed) return;
        await this.#reread(ids[i], found === null ? undefined : (found.get(ids[i]) ?? null));
      }
    });
  }

  // One record as the engine holds it now: the cache dropped, the row made
  // again (a record gone loses it), a live Document refreshed.
  async #reread(id, stored = undefined) {
    try {
      this.#entries.forget(id);
      await this.#entries.index(id, stored);
      const entry = this.#entries.peek(id) ?? null;
      const alive = entry !== null && isAlive(entry);
      this.#emitUpdate(id, alive ? entry.data : null, alive ? { ...entry.data } : {}, null, entry);
    } catch (error) {
      this.#followStats.failed++;
      this.#logger.warn({ event: 'follow.failed', id, err: error });
    }
  }

  // The change stream ended — an error, a close — and what the writer landed
  // meanwhile was not heard: the application is told once (FOLLOW_LOST),
  // the stream is subscribed again FIRST (so nothing landed from here on is
  // missed), and every record is read again, after what was heard before.
  #followLost(cause) {
    if (this.#closed) return;
    this.#unhear?.();
    this.#unhear = null;
    this.#logger.warn({ event: 'follow.lost', path: this.#path, err: cause });
    const message = `Database at ${this.#path} lost the writer's change stream: every record is read again`;
    notify(this, this.#logger, 'error', new SyncomError('FOLLOW_LOST', message, { path: this.#path, cause }));
    try {
      this.#subscribeChanges();
    } catch (error) {
      // No stream to be had: the follower reads as of this catch-up.
      this.#logger.warn({ event: 'follow.lost', path: this.#path, err: error });
    }
    this.#heard = this.#heard.then(() => this.#catchUp());
  }

  // Every record read again, a page of ids at a time — the loop a catalog
  // rebuild runs — and the row of every record gone meanwhile taken.
  async #catchUp() {
    const page = 500;
    const seen = new Set();
    let after = null;
    for (;;) {
      if (this.#closed) return;
      let ids;
      let found;
      try {
        ids = await this.#db.records.ids({ after, limit: page });
        found = await this.#db.records.getMany(ids);
      } catch (error) {
        this.#logger.warn({ event: 'follow.failed', id: null, err: error });
        return;
      }
      for (let i = 0; i < ids.length; i++) {
        seen.add(ids[i]);
        await this.#reread(ids[i], found.get(ids[i]) ?? null);
      }
      if (ids.length < page) break;
      after = ids[ids.length - 1];
    }
    // The catalog's ids are shared: taken before any row goes.
    const held = this.#catalog.all();
    const gone = [];
    for (let i = 0; i < held.length; i++) if (!seen.has(held[i])) gone.push(held[i]);
    for (let i = 0; i < gone.length; i++) await this.#reread(gone[i]);
    this.#followStats.caughtUp++;
  }

  // The Record the application holds for `id`, if it still does.
  #live(id) {
    const ref = this.#records.get(id);
    if (ref === undefined) return undefined;
    const record = ref.deref();
    if (record === undefined) this.#records.delete(id);
    return record;
  }

  // The version this directory last ran, read and written by the schema
  // plugin (src/schema/api.js loadVersion) once the definitions are checked:
  // the snapshot's hash, and what ran before when it differs.
  async #loadSchema() {
    if (this.#version === null) return;
    const { hash, previous } = await this.#schemaHook.load();
    this.#schemaHash = hash;
    this.#schemaPrevious = previous;
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
    const held = this.#log.held();
    const entries = [];
    for (let i = 0; i < held.length; i++) if (held[i].held <= this.#version) entries.push(held[i]);
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
  // A value at once — a promise only where a lens runs (a record of an older
  // version): every caller awaits it or hands it on from an async function.
  #view(id, entry) {
    // The paths composed into nested objects, once per cached entry (the
    // data itself when it holds none); the lens over that.
    const composed = (entry.composed ??= compose(entry, this.#plugins));
    if (this.#lens === null || (entry.meta.v ?? 1) >= this.#version) return composed;
    return entry.view ?? this.#lensed(id, entry, composed);
  }

  async #lensed(id, entry, composed) {
    return (entry.view ??= await this.#lens(id, composed, entry.meta.v ?? 1));
  }

  /** Rewrites every record of an older version as this one, through the lens — the schema plugin's (src/schema/api.js). */
  async migrate(options) {
    return this.#api('migrate')(this.#core, options);
  }

  // Which node this directory is (src/identity.js: the signing key, node.json, or getId).
  async #loadIdentity() {
    this.#nodeId = await loadIdentity({
      store: kvNamespace(this.#db.kv, ''),
      keyId: this.#identity?.id ?? null,
      kinds: this.kinds,
      getId: this.#getId,
      logger: this.#logger,
    });
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
    const applied = [];
    for (let i = 0; i < tail.length; i++) if (!tail[i].skipped) applied.push(tail[i]);
    const touched = await this.#fold(applied);
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
    this.#collected();
  }

  // `collections` made again: one frozen object of the collections by name.
  #collected() {
    const collections = {};
    for (const name of this.#entities.keys()) collections[name] = this[name];
    this.#collections = Object.freeze(collections);
  }

  /** The collections by name, frozen — the same objects as `db.<Name>`; made again by `addCollections()` and `removeCollection()`. */
  get collections() {
    return this.#collections;
  }

  /** The local documents of this database (`get`, `set`, `delete`, `list`, `observe`, `scoped`) — the `local` plugin's. */
  get local() {
    if (this.#local === null) throw missing('db.local', 'local');
    return this.#local;
  }

  /** The attachments of this database (`put`, `get`, `has`, `list`, `remove`) — the `attachments` plugin's. */
  get attachments() {
    if (this.#attachments === null) throw missing('db.attachments', 'attachments');
    return this.#attachments;
  }

  /**
   * Defines collections after the open: `{ [name]: definition }` (or a Map),
   * each as an entity of `createDatabase({ schema })` would be — its validator,
   * indexes, unique keys and search fields in force from here, the records
   * of the type the catalog holds indexed under them. Nothing is persisted:
   * the application adds them after every open, and the schema's hash in
   * hello does not move. Every definition is checked before any is taken —
   * a name defined already or taken by the database, a malformed definition
   * — and that is a TypeError. The schema plugin's (`PLUGIN_MISSING` without it).
   */
  async addCollections(defs) {
    if (this.#schemaHook === null) throw missing('addCollections()', 'schema');
    const given = defs instanceof Map ? defs : isPlainObject(defs) ? new Map(Object.entries(defs)) : null;
    if (given === null) throw new TypeError('addCollections() takes an object or a Map of definitions');
    const added = [];
    for (const [name, def] of given) {
      if (this.#entities.has(name)) throw new TypeError(`addCollections(): collection '${name}' is defined already`);
      if (name in this) {
        throw new TypeError(`addCollections(): collection name '${name}' is taken by the database itself`);
      }
      const defined = this.#schemaHook.define(name, def, this.#entities.keys());
      checkOrm(defined, 'addCollections()');
      // The text index too, before anything is taken: a definition that needs one the database has not is refused whole.
      added.push([defined, this.#textIndexOf(defined)]);
    }
    for (let i = 0; i < added.length; i++) {
      const [def, index] = added[i];
      this.#entities.set(def.name, def);
      this.#catalog.define(def.name, def, index);
      this[def.name] = new Collection(this, def.name);
      // The records of the type the catalog holds, indexed under the definition: pages of 500, each read in one
      // call of the engine, inside the queue behind the landings — a record in flight lands first, so no stale row
      // is laid over it; the queue is free between the pages.
      const ids = this.#catalog.ids(def.name).slice();
      for (let k = 0; k < ids.length; k += REINDEX_PAGE) {
        const page = ids.slice(k, k + REINDEX_PAGE);
        await this.#run(() => this.#landing(() => this.#entries.indexMany(page)));
      }
    }
    this.#collected();
    this.#flushCatalog();
  }

  /**
   * Forgets a collection's definition: the records stay (a collection's
   * `remove()` deletes them), untyped by any definition from here. An
   * unknown name is a TypeError.
   */
  removeCollection(name) {
    if (!this.#entities.has(name)) throw new TypeError(`removeCollection(): no collection '${name}'`);
    this.#entities.delete(name);
    this.#catalog.define(name, null);
    delete this[name];
    this.#collected();
    this.#flushCatalog();
    this.#logger.info({ event: 'collection.removed', entity: name });
  }

  get schema() {
    return this.#schema;
  }

  /** The backend every file of this storage goes through — the adapter given to `createDatabase()`, or the platform's. */
  get fsi() {
    return this.#db.fsi ?? null;
  }

  /** The engine this database stores its bytes through — the one given, or the files engine over the backend. */
  get engine() {
    return this.#engine;
  }

  // The engine's database of stores: what a subpath that keeps side files
  // (the sync registry, a branch) reaches, never the application.
  get [DB]() {
    return this.#db;
  }

  // A Mango query as a predicate over `{ id, ...record }`: the query plugin's (`ifMatch`).
  #predicate(query) {
    if (this.#matches === null) throw missing('update(id, delta, { ifMatch })', 'query');
    return this.#matches(query);
  }

  // The cursor over a source seam (this storage's by default; a tag's for a
  // view at a tag): the query plugin's, PLUGIN_MISSING without it. Sealed records are left out unless asked
  // (`sealed: true`): the facade's collections ask — the key holder reads its own — while a host's query, an
  // agent's tool and a connector read through the seam as it is, and no sealed record leaves the key holder by them.
  get [CURSOR]() {
    return (entity, query, { source = this[SOURCE], sealed = false } = {}) => {
      if (this.#cursor === null) throw missing('select()');
      return this.#cursor(source, entity, query, { sealed: sealed === true });
    };
  }

  // What a Cursor reads through: the catalog, and a record as it reads —
  // lensed, without the read hooks (like `snapshot` and `swap`).
  get [SOURCE]() {
    if (this.#source !== null) return this.#source;
    const catalog = this.#catalog;
    this.#source = Object.freeze({
      logger: this.#logger,
      // The telemetry writer (the disabled one without the plugin): what a block counts its work through.
      otel: this.#otel,
      candidates: (entity, query) => catalog.candidates(entity, query),
      ids: (entity) => catalog.ids(entity),
      row: (id) => catalog.row(id),
      indexed: (entity) => catalog.indexed(entity),
      indexes: (entity) => catalog.indexes(entity),
      scan: (entity, plan, after) => catalog.scan(entity, plan, after),
      // The catalog's counts, for the planner: a scan's entries, a posting list's size, the collection's live rows, the
      // posting lists' union a scan is narrowed through.
      estimate: (entity, plan) => catalog.estimate(entity, plan),
      cardinality: (entity, field, values) => catalog.cardinality(entity, field, values),
      live: (entity) => catalog.live(entity),
      posting: (entity, field, values) => catalog.posting(entity, field, values),
      // Every plan a cursor makes, told to the advisors; `advise(fn)` adds one and answers what takes it off.
      planned: (entity, plan) => {
        for (const fn of this.#advisors) {
          try {
            fn(entity, plan);
          } catch (err) {
            // An advisor is a listener: its throw is its own, never the cursor's.
            this.#logger.warn({ event: 'listener.error', name: 'advise', err });
          }
        }
      },
      // A plugin's own write (a local document) refused as the queue would refuse a write: closed, or read-only.
      guard: (what) => {
        if (this.#closed) throw new SyncomError('CLOSED', 'Storage is closed');
        if (this.#readOnly || this.#leaseLost) throw this.#refused(what);
      },
      advise: (fn) => {
        this.#advisors.add(fn);
        return () => this.#advisors.delete(fn);
      },
      searches: (entity) => catalog.searches(entity),
      subscribe: (entity, fn) => catalog.subscribe(entity, fn),
      // What a query result of `entity` is current as of: moves with every change of a record of the collection
      // the catalog heard of (its row, or the one it left), with its redefinition, and with a load or an adopt.
      generation: (entity) => catalog.generationOf(entity),
      // What the definitions are as of: moves with addCollections()/removeCollection(); a plan made under another is made again.
      definitions: () => catalog.definitions,
      // The entity definition of a collection (null for none): its id rule, its references, its methods.
      definition: (entity) => this.#entities.get(entity) ?? null,
      // A transaction over this database's write API: what a cursor's write terminals run (a view at a
      // tag reads alone: its source has none).
      transact: (fn, options) => this.transact(fn, options),
      // Several records purged as one turn of the queue — one append, one landing — then scrubbed
      // from the log one by one: what a collection's `remove({ purge: true })` runs a page through.
      purgeMany: (ids, options) => this.#purgeMany(ids, options),
      // Every id the catalog holds a row for — live, encrypted, a tombstone — sorted (shared: read it).
      all: () => catalog.all(),
      // Whether an entry — `{ meta }` is enough — reads as alive (the op model's `isAlive`; a dump's `deleted`).
      alive: (entry) => isAlive(entry),
      // Whether `id` is a folded tombstone: its entry in the `tombstones` kv namespace, no record file.
      folded: (id) => this.#entries.folded(id),
      // Tombstones folded into the `tombstones` kv namespace (@alexify/syncom/cleanup), one write set: inside the
      // queue, behind the landings, so nothing of the records is in flight meanwhile.
      foldMany: (ids) => this.#run(() => this.#landing(() => this.#entries.foldMany(ids))),
      // The log's retained entries of a record, and the registered nodes' acked vectors (the sync plugin's).
      entriesOf: (id) => this.#log.entriesOf(id),
      // Folded tombstones taken away with their rows (`cleanup({ drop: true })`): the catalog forgets the ids.
      forgetMany: (ids) => this.#run(() => this.#landing(() => this.#entries.dropMany(ids))),
      nodes: () => (this.#sync === null ? [] : this.#sync.listNodes()),
      // A record as a reader of data sees it: the lensed view, or a sealed record's data as the key here opens
      // it (a copy: registers alone, no meta to compose) — a query over sealed records is answered from the
      // record at the key holder, never from the catalog.
      load: async (id) => {
        const entry = await this.#entries.load(id);
        if (entry === null) return null;
        if (entry.encrypted) return entry.data === null ? null : asJson(entry.data);
        return isAlive(entry) ? this.#view(id, entry) : null;
      },
      // Several records as `load` reads them, in ONE read of the engine for the ones not cached: a
      // Map by id, null for one absent or gone (a cursor's `populate`, `findByIds`).
      loadMany: async (ids) => {
        const entries = await this.#entries.loadMany(ids);
        const out = new Map();
        for (const [id, entry] of entries) {
          if (entry === null) out.set(id, null);
          else if (entry.encrypted) out.set(id, entry.data === null ? null : asJson(entry.data));
          else out.set(id, isAlive(entry) ? await this.#view(id, entry) : null);
        }
        return out;
      },
      // The sealed records of a collection, by id: what a query reads whole at the key holder.
      sealed: (entity) => catalog.sealed(entity),
      // The entry as it is — data and meta, a tombstone too — for the
      // inspector (@alexify/syncom/inspect); never for a reader of data.
      entry: (id) => this.#entries.load(id),
    });
    return this.#source;
  }

  // The unique keys `entry` would collide on, as the catalog knows them.
  async #conflicts(id, entry) {
    const def = this.#definitionOf(entry.data);
    if (!def || def.unique.length === 0) return [];
    const view = await this.#view(id, entry);
    const conflicts = this.#catalog.uniqueConflicts(def.name, id, view);
    if (this.#inflight.size === 0) return conflicts;
    // Each (holder, key) once.
    const seen = new Set();
    for (let i = 0; i < conflicts.length; i++) seen.add(`${conflicts[i].other}\0${conflicts[i].fields.join(',')}`);
    const collide = (other, key) => {
      const pair = `${other}\0${key.join(',')}`;
      if (seen.has(pair)) return;
      seen.add(pair);
      conflicts.push({ fields: [...key], other });
    };
    // The records in flight are not in the catalog yet: their newest entries
    // hold their keys in `#inflightKeys`, read once each.
    const mine = [];
    for (let k = 0; k < def.unique.length; k++) {
      const key = def.unique[k];
      const text = this.#catalog.uniqueKey(view, key);
      mine.push(text);
      if (text === null) continue;
      const ids = this.#inflightKeys.get(`${def.name}\0${key.join(',')}\0${text}`);
      if (ids === undefined) continue;
      for (const other of ids) if (other !== id) collide(other, key);
    }
    // The few a lens has not composed yet: by hand, as the catalog would.
    for (const other of this.#inflightUnkeyed) {
      if (other === id) continue;
      const held = this.#inflightTop(other);
      if (held === undefined || held.data.$type !== entry.data.$type) continue;
      const theirs = await this.#view(other, held);
      for (let k = 0; k < def.unique.length; k++) {
        const key = def.unique[k];
        if (mine[k] !== null && mine[k] === this.#catalog.uniqueKey(theirs, key)) collide(other, key);
      }
    }
    return conflicts;
  }

  // A record's view as `#view` composes it, where it needs no await: at once without a lens or for a record of
  // this version, the lens's once it ran (`entry.view`); undefined before that.
  #viewNow(entry) {
    if (this.#lens === null || (entry.meta.v ?? 1) >= this.#version) {
      return (entry.composed ??= compose(entry, this.#plugins));
    }
    return entry.view;
  }

  // The unique keys the entry a record is in flight as holds, standing for it until it settles or takes off again.
  #keyInflight(id, entry) {
    this.#unkeyInflight(id);
    if (!isAlive(entry)) return;
    const def = this.#definitionOf(entry.data);
    if (!def || def.unique.length === 0) return;
    const view = this.#viewNow(entry);
    if (view === undefined) {
      this.#inflightUnkeyed.add(id);
      return;
    }
    const pairs = [];
    for (let k = 0; k < def.unique.length; k++) {
      const key = def.unique[k];
      const text = this.#catalog.uniqueKey(view, key);
      if (text === null) continue;
      const pair = `${def.name}\0${key.join(',')}\0${text}`;
      let ids = this.#inflightKeys.get(pair);
      if (ids === undefined) this.#inflightKeys.set(pair, (ids = new Set()));
      ids.add(id);
      pairs.push(pair);
    }
    if (pairs.length > 0) this.#inflightPairs.set(id, pairs);
  }

  #unkeyInflight(id) {
    this.#inflightUnkeyed.delete(id);
    const pairs = this.#inflightPairs.get(id);
    if (pairs === undefined) return;
    this.#inflightPairs.delete(id);
    for (let i = 0; i < pairs.length; i++) {
      const ids = this.#inflightKeys.get(pairs[i]);
      if (ids === undefined) continue;
      ids.delete(id);
      if (ids.size === 0) this.#inflightKeys.delete(pairs[i]);
    }
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
    return this.#api('check')(this.#core, entity, data);
  }

  /** This node's stable identity — the `origin` of every op it creates. */
  get nodeId() {
    return this.#nodeId;
  }

  /** `'verify'`, `'require'` or `false` — `createDatabase({ sync: { signatures } })`. */
  get signatures() {
    return this.#signatures;
  }

  /** The names of the plugins this storage was opened with (`createDatabase({ plugins })`). */
  get plugins() {
    return this.#plugins.names;
  }

  /** The names of the kind plugins among them — what hello tells a peer this node can hold. */
  get kinds() {
    const mods = this.#plugins.kinds;
    const names = [];
    for (let i = 0; i < mods.length; i++) names.push(mods[i].name);
    return names;
  }

  // The registry itself, for the subpaths that fold patches or open a fork.
  get [PLUGINS]() {
    return this.#plugins;
  }

  // The node's identity for a subpath that signs what is not an op
  // (presence): `{ id, signMessage, verifyMessage }`, or null without the
  // signing plugin. Never the keys.
  get [SIGNER]() {
    return this.#identity;
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

  /** Whether every write is refused: opened with `readOnly: true` (a follower), or a writer whose lease was lost. */
  get readOnly() {
    return this.#readOnly;
  }

  /**
   * The room the medium has: `{ usage, quota }` in bytes — the engine's own estimate where it has one (memory: what
   * it holds; SQLite: the file and its volume; IndexedDB: the browser's Storage API), the files engine's volume
   * under the path (`usage` null; the browser's Storage API over OPFS); null where the medium says nothing (MongoDB,
   * an engine over a port).
   */
  quota() {
    const db = this.#db;
    if (db !== null && typeof db.estimate === 'function') return db.estimate();
    if (this.#engine.name === 'files') return estimateStorage(this.#path);
    return Promise.resolve({ usage: null, quota: null });
  }

  /** Asks the browser to keep this origin's storage out of eviction (`navigator.storage.persist()`); true where nothing need be asked. */
  persist() {
    return persistStorage();
  }

  /**
   * The node's health, as an operator reads it: what is queued, cached,
   * catalogued, retained and locked. No I/O — every number is in memory.
   */
  stats() {
    let pinned = 0;
    // #live deletes the slot it reads when its Record is gone: safe mid-walk.
    for (const id of this.#records.keys()) if (this.#live(id) !== undefined) pinned++;
    const observers = this.#observers.count;
    const log = this.#log;
    const health = log.health;
    return {
      closed: this.#closed,
      plugins: this.plugins,
      queue: this.#queued,
      cache: { size: this.#entries.size, max: this.#cacheMax, pinned },
      catalog: { entries: this.#catalog.size, dirty: this.#catalog.dirty },
      tags: this.#tags === null ? null : { count: this.#tags.size, corrupt: this.#tags.corrupt },
      // Records whose files lag the log: deferred by `createDatabase({ defer })`, or
      // held after a write that failed (replayed at the next open).
      held: this.#entries.heldIds().size,
      deferred: this.#window.size,
      inflight: this.#inflightCount,
      // The local writes so far: made at once, through the queue, folded into the one before (LOG-9, LOG-11).
      commits: { fast: this.#commits.fast, queued: this.#commits.queued, coalesced: this.#commits.coalesced },
      // The text handles open (src/text/handle.js): how many, how many hold edits not logged yet, and the
      // run offsets reserved for them over every field.
      handles: this.#handleStats(),
      // The window `createDatabase({ defer })` gave, what the last deferred landing
      // took (the next window is at least that), and the positions waiting.
      defer: { window: this.#defer, flushCost: this.#window.cost, positions: this.#window.positions },
      observers,
      // The collections defined, the advisors watching the plans, the tombstones folded into their namespace, and
      // the query plugin's cache (entries, the rows they hold) and live runs — null without the plugin.
      collections: this.#entities.size,
      advisors: this.#advisors.size,
      tombstones: this.#entries.foldedCount,
      query: this.#queryStats === null ? null : this.#queryStats(),
      log: {
        length: log.length,
        floor: log.floor,
        next: log.next,
        epoch: log.epoch,
        segments: log.segments,
        latestTs: log.latestTs,
        droppedTs: log.droppedTs,
        corrupt: log.corrupt,
        rollFailures: log.rollFailures,
        pins: log.pins,
        journaled: health.journaled,
        open: health.open,
        unapplied: health.unapplied,
        torn: health.torn,
        lost: health.lost,
        appendFailures: health.appendFailures,
      },
      chain: this.#chain ? { tail: this.#chain.tailHash } : null,
      // How the database is held: the lock key or the engine's lease, when the lease lapses unless renewed
      // (`null` for a lock key, or once lost) and whether it was lost.
      lock: this.#lock
        ? {
            kind: this.#lockKind,
            mode: this.#lockOptions.mode,
            expiresAt: this.#lock.expiresAt ?? null,
            lost: this.#leaseLost,
          }
        : null,
      readOnly: this.#readOnly,
      // A follower's count of what it heard; null on a writer.
      follow: this.#readOnly ? { ...this.#followStats } : null,
      // The engine and what its write sets cost so far.
      engine: {
        name: this.#engine.name,
        capabilities: this.#engine.capabilities,
        writes: this.#engineStats.writes,
        failures: this.#engineStats.failures,
        ms: Math.round(this.#engineStats.ms),
      },
    };
  }

  // One write set of the engine done, in `ms`, or failed: counted, and told to the meter where there is one.
  #engineWrote(ms, ok) {
    const stats = this.#engineStats;
    stats.writes++;
    if (!ok) stats.failures++;
    stats.ms += ms;
    if (this.#otel.enabled) this.#otel.recordEngineWrite(this.#engine.name, ms, ok);
  }

  // The record as a write path reads it: the entry its newest in-flight op
  // leaves it as, else what the cache or the file holds.
  // A record's ops in flight: `{ items, head }` — the entries at `items[head..]`,
  // oldest first. They land in log order, so a settle takes the head in O(1)
  // (the array compacted once the head passes half of it); N writes to one
  // record that cannot fold were N splices from the bottom, O(N²).
  #current(id) {
    return this.#inflightTop(id) ?? this.#entries.load(id);
  }

  // The same, where it is known at once: undefined when only the file knows
  // (an entry not cached, a record never written here).
  #currentNow(id) {
    return this.#inflightTop(id) ?? this.#entries.peek(id);
  }

  // The entry a record's newest op in flight leaves it as, or undefined.
  #inflightTop(id) {
    const stack = this.#inflight.get(id);
    if (stack === undefined || stack.items.length === stack.head) return undefined;
    return stack.items[stack.items.length - 1].entry;
  }

  // A record's entry in flight at `position`: on the stack, or — the newest
  // there at that position already — in its place (a write grown by the one
  // after it, src/commit.js coalesced).
  #takeOff(id, entry, position) {
    let stack = this.#inflight.get(id);
    if (stack === undefined) this.#inflight.set(id, (stack = { items: [], head: 0 }));
    const { items } = stack;
    const top = items.length > stack.head ? items[items.length - 1] : null;
    if (top !== null && top.position === position) top.entry = entry;
    else {
      items.push({ entry, position });
      this.#inflightCount++;
    }
    this.#keyInflight(id, entry);
  }

  // The op at `position` landed (or failed): its entry is no longer in flight.
  #settle(id, position) {
    const stack = this.#inflight.get(id);
    if (stack === undefined) return;
    const { items } = stack;
    let i = stack.head;
    while (i < items.length && items[i].position !== position) i++;
    if (i === items.length) return;
    if (i === stack.head) {
      stack.head++;
      if (stack.head > 64 && stack.head * 2 > items.length) {
        stack.items = items.slice(stack.head);
        stack.head = 0;
      }
    } else items.splice(i, 1);
    this.#inflightCount--;
    if (stack.items.length === stack.head) {
      this.#inflight.delete(id);
      this.#unkeyInflight(id);
    }
  }

  // A group of appends failed: every in-flight entry at or past `from` was
  // built on seqs taken back, and goes before any ticket rejects.
  #takenBack(from) {
    for (const [id, stack] of this.#inflight) {
      const { items } = stack;
      let taken = 0;
      while (items.length > stack.head && items[items.length - 1].position >= from) {
        items.pop();
        this.#inflightCount--;
        taken++;
      }
      if (items.length === stack.head) {
        this.#inflight.delete(id);
        this.#unkeyInflight(id);
      } else if (taken > 0) this.#keyInflight(id, items[items.length - 1].entry);
    }
  }

  // The landings go one after another, in log order, outside the queue; a
  // failed one fails its own write alone.
  // The chain may end in a write made at once (`core.landed`): its group's
  // promise, which rejects when the group failed — a step runs after it
  // either way, and a reader that waits for the landings waits for this.
  #drained() {
    return this.#landings.then(NOOP, NOOP);
  }

  #landing(step) {
    this.#slowSteps++;
    const done = this.#landings.then(step, step);
    const settled = () => {
      this.#slowSteps--;
    };
    this.#landings = done.then(settled, settled);
    return done;
  }

  // Every mutation passes through one queue — or is made at once on an idle
  // queue (#fastCommit), which is a turn of its own: the chain's tail pointer, the
  // log's seq counter and a record's entry are all read-then-written, and two
  // interleaved writers would race all three.
  #run(task) {
    if (this.#closed) return Promise.reject(new SyncomError('CLOSED', 'Storage is closed'));
    if (this.#readOnly) return Promise.reject(this.#refused('a write'));
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
    if (this.#task.inside()) {
      return Promise.reject(
        new SyncomError(
          'IN_TRANSACTION',
          'Cannot write to the database from inside a transaction or modify(): write through tx, or return the record',
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
    // The Record reads as get() does: the paths composed (`profile/city` under
    // `profile`, a list element's fields on it), never the fields apart.
    const shown =
      data === null
        ? null
        : entry !== null && !entry.encrypted
          ? (entry.composed ??= compose(entry, this.#plugins))
          : composeData(data);
    if (!lensed && !hooked && this.#refreshing === 0) {
      // The reading itself: the Record may lay the delta's fields over what it
      // holds rather than copy the whole record again.
      record[REFRESH](shown, delta, source, entry !== null && !entry.encrypted);
      return;
    }
    this.#refreshing += 1;
    this.#refreshed = this.#refreshed.then(async () => {
      try {
        let view = lensed ? await this.#view(id, entry) : shown;
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
    const scope = this.#scopeOf(id, composeData(data));
    if (typeof scope !== 'string' || scope.length === 0 || scope === GLOBAL_SCOPE) return GLOBAL_SCOPE;
    if (!isStreamName(scope)) {
      throw new TypeError(`sync.scope(${id}) returned ${JSON.stringify(scope)}: a scope is a short name without '@'`);
    }
    return scope;
  }

  // What a write path observes of a record it holds before it stamps — the
  // newest stamp there — unless it lies beyond the skew allowed: a peer's
  // meta taken before merge metas were checked, or under `maxSkew: Infinity`.
  // Observed, it would carry every later stamp of this node, on any record,
  // past what its peers take (SKEW everywhere, for good: the log seeds the
  // clock at the next open). Left out, a write to that record stamps below
  // it and loses the fields it holds until the wall clock gets there. Told
  // once per record.
  #observeHeld(stamp, id) {
    if (!stamp) return;
    const at = Date.now();
    if (stamp[0] <= at + this.#maxSkew) return void this.#clock.observe(stamp[0]);
    if (this.#skewed.has(id)) return;
    this.#skewed.add(id);
    this.#logger.warn({ event: 'clock.skew.ignored', id, ts: stamp[0], ahead: stamp[0] - at });
  }

  // The actor of one write: the call's own, else the storage's (asked when
  // it is a function), else none. A string on the op, never in the record.
  // Who a write says made it: the given actor, else the configured one — a
  // string or null at once, a promise only where the actor is a function.
  #actorOf(given) {
    if (given === undefined && typeof this.#actor === 'function') return this.#awaitActor();
    const actor = given !== undefined ? given : this.#actor;
    return actorName(actor);
  }

  async #awaitActor() {
    return actorName(await this.#actor());
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
      // After a lost lease nothing of this instance is written: what was
      // logged stays in the log for the next holder's replay, held here.
      if (this.#leaseLost) throw this.#refused('a landing');
      await this.#persistBatch(touched, fromSeq, toSeq);
    } catch (error) {
      await this.#unpersisted(touched, error);
      return false;
    }
    // A record written by this batch (a peer's page, a replay, a repair) was
    // written from the cache, which held its deferred local ops too: those
    // are on disk now, so their slot goes and their positions are applied —
    // a later flush must not lay the older deferred entry over this file.
    // A slot made while this batch was landing (a later local write, its
    // position past the batch) is not covered and stays.
    for (const id of touched.keys()) this.#window.settle(id, toSeq);
    return true;
  }

  // The deferred window lands every slot now (tag(), close(), flush()).
  #flushDeferred() {
    return this.#window.flush();
  }

  async #unpersisted(touched, error) {
    for (const [id, entry] of touched) await this.#entries.hold(id, entry);
    const ids = [...touched.keys()];
    // The ids by name up to a bound, and how many: a batch of thousands is one line, not a page.
    const named = ids.length > UNPERSISTED_NAMED ? ids.slice(0, UNPERSISTED_NAMED) : ids;
    this.#logger.error({ event: 'storage.unpersisted', ids: named, count: ids.length, err: error });
    const message = `${ids.join(', ')}: logged, but not written; held until the next open`;
    const fields = { ids, cause: error };
    // A medium that is full: said on the error, so the application can ask for room (`quota()`, `persist()`).
    if (isQuotaError(error)) fields.quota = true;
    notify(this, this.#logger, 'error', new SyncomError('UNPERSISTED', message, fields));
  }

  async #persistBatch(touched, fromSeq, toSeq) {
    if (this.#chain) {
      const records = {};
      for (const [id, entry] of touched) records[id] = await sha256(entry.data);
      const from = this.#log.formatId(fromSeq);
      const to = this.#log.formatId(toSeq);
      const block = await this.#chain.block({ records, from, to });
      // One write set for the batch — the block, its tail and the records: atomic where the engine has transactions.
      await this.#entries.writeMany(touched, block.hash, { put: block.puts });
      this.#chain.committed(block.hash);
      return block.hash;
    }
    await this.#entries.writeMany(touched, null);
    return null;
  }

  // ---------------------------------------------------------------------
  // The one local write path — src/commit.js, inside the queue.

  [COMMIT](type, id, payload, options = {}) {
    if (!isRecordId(id)) return Promise.reject(invalidId(id));
    return this.#fastCommit(type, id, payload, options, true) ?? this.#queuedCommit(type, id, payload, options);
  }

  // A write whose caller takes no answer (the methods that resolve to
  // nothing): the commit, resolving to undefined.
  #write(type, id, payload, options = {}) {
    if (!isRecordId(id)) return Promise.reject(invalidId(id));
    return (
      this.#fastCommit(type, id, payload, options, false) ?? this.#queuedCommit(type, id, payload, options).then(NOOP)
    );
  }

  async #queuedCommit(type, id, payload, options) {
    this.#commits.queued++;
    const { op, done } = await this.#run(() => commit(this.#core, type, id, payload, options));
    // The queue is free once the op is appended; the caller waits for the
    // landing — the disk, the file, the hooks, the listeners.
    if (done !== null) await done;
    return op;
  }

  // A write made at once (src/commit.js commitAtOnce) — or null, and the
  // queue takes it. At once is what a queue turn of its own would be: the
  // queue idle and no hook running, so nothing interleaves (the op is
  // appended before this returns); no landing step pending, so it never
  // lands ahead of one; the record live and held here, of an entity with no
  // validator and no unique key; nothing encrypted, nothing expected.
  #fastCommit(type, id, payload, options, answer) {
    if (!this.#fastIssue || this.#queued !== 0 || this.#inHook !== 0 || this.#slowSteps !== 0 || this.#closed) {
      return null;
    }
    if (this.#readOnly) return null;
    if (options.encrypted === true || (options.expect !== undefined && options.expect !== null)) return null;
    const current = this.#currentNow(id);
    if (current === undefined || current === null || current.encrypted || !isAlive(current)) return null;
    // The entity the record is of — and the one the write makes it (a `$type` a
    // set or a write adds; a schema sets the lens, so this is never reached
    // with one, but the queue is what validates and it is not left to that).
    const def = this.#definitionOf(current.data);
    if (def !== undefined && def !== null && (def.validator || def.unique.length > 0)) return null;
    const data = payload?.data;
    if (data !== null && typeof data === 'object' && typeof data.$type === 'string') {
      const after = this.#entities.get(data.$type);
      if (after !== undefined && after !== null && (after.validator || after.unique.length > 0)) return null;
    }
    this.#queued++;
    try {
      return commitAtOnce(this.#core, type, id, payload, options, current, answer, this.#commits);
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#queued--;
    }
  }

  // ---------------------------------------------------------------------
  // Public API

  async saveData(id, data, options = {}) {
    const { encrypted = this.#encrypted, actor, expect = null } = options;
    await this[COMMIT]('write', id, { data }, { encrypted, actor, expect });
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
        ? 'createDatabase({ chain: false })'
        : "the chain plugin is not registered (createDatabase({ plugins: [chain] }) from '@alexify/syncom/chain')";
      throw typed('NO_CHAIN', `${why}: this storage keeps no chain to validate against`);
    }
    if (isChainValidation) {
      return await this.#chain.validate(idOrOptions);
    }
    const id = idOrOptions;
    try {
      const block = await this.#blockOf(blockHash);
      if (block === null) return false;
      const expectedHash = await sha256(data);
      // A local write commits `{ id, hash }`; a replicated batch commits
      // `{ records: { [id]: hash } }` for every record it touched.
      if (block.data.records) return block.data.records[id] === expectedHash;
      return block.data.hash === expectedHash && block.data.id === id;
    } catch {
      return false;
    }
  }

  // The block filed under `blockHash`, verified — it must hash to the name it is filed under: a file planted beside
  // the chain with the right `records` map is not a commit — and kept, the last VERIFIED_BLOCKS of them; null for
  // one that is not there or is not what it claims.
  async #blockOf(blockHash) {
    const kept = this.#blocks.get(blockHash);
    if (kept !== undefined) return kept;
    const block = await this.#chain.readBlock(blockHash);
    if (!block || (await sha256(block)) !== blockHash) return null;
    if (this.#blocks.size >= VERIFIED_BLOCKS) this.#blocks.delete(this.#blocks.keys().next().value);
    this.#blocks.set(blockHash, block);
    return block;
  }

  // The id a record's data names under its entity's definition — a composite
  // id from the declared fields, the id field's value — with the data the
  // record is written as (the id field leaves it); null when the data names
  // none, and the id is minted. A derived id outside the id class, or a
  // composite with a field missing, is INVALID_ID.
  #named(data) {
    const def = this.#definitionOf(data);
    if (def === undefined) return null;
    const named = namedId(def, data);
    if (named === null) return null;
    if (named.id === null) {
      throw typed('INVALID_ID', `A ${def.name} ${idReason(named)}`, { entity: def.name, field: named.field });
    }
    if (!isRecordId(named.id)) throw invalidId(named.id);
    return named;
  }

  // A minted id: `getId` may be sync or async — every call site awaits this.
  async #mint() {
    const id = await this.#getId();
    if (!isRecordId(id)) {
      const error = invalidId(id);
      error.message = `createDatabase({ getId }): ${error.message}`;
      throw error;
    }
    return id;
  }

  /**
   * Writes a new record: under the id its data names — its entity's
   * composite id, or the id field's value — when it names one (a live record
   * there already is `EXISTS`, decided inside the queue), else under a
   * minted one. Resolves to the id.
   */
  async insert(data, options = {}) {
    if (!isPlainObject(data)) throw new TypeError('insert() takes a plain object');
    const named = this.#named(data);
    if (named === null) {
      const id = await this.#mint();
      await this.saveData(id, data, options);
      return id;
    }
    const { id } = named;
    // A live record there already is EXISTS, decided inside the queue (`expect: ABSENT`) — an encrypted write too.
    try {
      await this.saveData(id, named.data, { ...options, expect: ABSENT });
    } catch (error) {
      if (error?.code === 'EXISTS' && this.#otel.enabled) this.#otel.recordInsertNamed('exists');
      throw error;
    }
    if (this.#otel.enabled) this.#otel.recordInsertNamed('ok');
    return id;
  }

  async has(id) {
    const entry = await this.#entries.load(id);
    return entry !== null && (entry.encrypted || isAlive(entry));
  }

  /** Whether `id` is a live record here — answered from the catalog, no I/O. */
  hasRecord(id) {
    // A string that is no id never is one: a live Record asks this of every
    // string field it holds, and a long text hashed into two maps cost the
    // text on every keystroke.
    return isRecordId(id) && (this.#catalog.has(id) || this.#live(id) !== undefined);
  }

  // The raw read, as a copy: what `get` returns before its hooks, what
  // `swap` compares against (so a redacting afterRead cannot break its CAS).
  // `getCachedData()` and `snapshot()` are the raw objects, for callers that
  // know not to touch them.
  async #read(id) {
    return P.reading(this.#core, id, await this.#entries.load(id));
  }

  async get(id, { at } = {}) {
    if (at !== undefined) return this.#api('getAt', 'get(id, { at })', 'versions')(this.#core, id, at);
    await runHook(this.#hooks, 'beforeRead', { id });
    const data = await this.#read(id);
    const replaced = await runHook(this.#hooks, 'afterRead', { id }, data);
    return replaced === undefined ? data : replaced;
  }

  // ---------------------------------------------------------------------
  // Versions, patches and tags — src/versions/api.js, one delegate each.

  async diff(id, from, to) {
    return this.#api('diff')(this.#core, id, from, to);
  }

  // A patch, a restore and a compaction write the record as it reads: what an
  // open handle on it holds is logged first, or it would be stamped below the
  // reset and dropped unsaid (src/text/handle.js). Without a handle on the
  // record the call takes its turn of the queue at once, as it always did.
  async applyPatches(id, patches, options) {
    const flushed = this.#flushEditsOf(id);
    if (flushed !== null) await flushed;
    return P.applyPatches(this.#core, id, patches, options);
  }

  async restore(id, at, options) {
    const flushed = this.#flushEditsOf(id);
    if (flushed !== null) await flushed;
    return this.#api('restore')(this.#core, id, at, options);
  }

  async compact(id, options) {
    const flushed = this.#flushEditsOf(id);
    if (flushed !== null) await flushed;
    return P.compact(this.#core, id, options);
  }

  #handleStats() {
    let pending = 0;
    for (const handle of this.#edits) if (handle.pending) pending++;
    let extents = 0;
    for (const runs of this.#extents.values()) extents += runs.size;
    return { open: this.#edits.size, pending, extents };
  }

  // The handles open on `id` flushed, or null where there is none.
  #flushEditsOf(id) {
    let any = false;
    for (const handle of this.#edits) if (handle.id === id) any = true;
    return any ? this.#flushEdits(id) : null;
  }

  async tag(name) {
    await this.#flushEdits();
    return this.#api('tag')(this.#core, name);
  }

  // Every open handle's edits logged (src/text/handle.js), every handle tried
  // whatever another's flush did; one UNLOGGED for them all, naming how many
  // handles and edits were not logged, with the first cause.
  async #flushEdits(id = null) {
    let handles = 0;
    let edits = 0;
    let cause = null;
    for (const handle of this.#edits) {
      if (id !== null && handle.id !== id) continue;
      try {
        await handle.flush();
      } catch (error) {
        handles++;
        edits += typeof error?.edits === 'number' ? error.edits : 0;
        cause ??= error;
      }
    }
    if (cause === null) return;
    const message = `Edits of ${handles} text handle${handles === 1 ? '' : 's'} could not be logged`;
    throw new SyncomError('UNLOGGED', message, { handles, edits, cause });
  }

  // A handle's listener of the `transaction` event, kept by record id; the
  // storage's one listener is attached with the first and taken off with the
  // last. A turn is handed to each listener of a record it touched, once.
  #follow(id, listener) {
    let listeners = this.#followers.get(id);
    if (listeners === undefined) this.#followers.set(id, (listeners = new Set()));
    listeners.add(listener);
    if (this.#following === null) {
      this.#following = (event) => this.#followed(event);
      this.on('transaction', this.#following);
    }
    return () => {
      const current = this.#followers.get(id);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.#followers.delete(id);
      if (this.#followers.size === 0 && this.#following !== null) {
        this.off('transaction', this.#following);
        this.#following = null;
      }
    };
  }

  #followed(event) {
    const { ops } = event;
    // A record made again from the log (`repair`): its followers alone, with the entry it reads as now.
    if (event.repaired !== undefined) {
      const listeners = this.#followers.get(event.repaired);
      if (listeners === undefined) return;
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          this.#logger.warn({ event: 'listener.error', name: 'handle', err: error });
        }
      }
      return;
    }
    let told = null;
    for (let i = 0; i < ops.length; i++) {
      const listeners = this.#followers.get(ops[i].id);
      if (listeners === undefined) continue;
      for (const listener of listeners) {
        if (told !== null && told.has(listener)) continue;
        (told ??= new Set()).add(listener);
        try {
          listener(event);
        } catch (error) {
          this.#logger.warn({ event: 'listener.error', name: 'handle', err: error });
        }
      }
    }
  }

  async untag(name) {
    return this.#api('untag')(this.#core, name);
  }

  /** The tags, oldest first. */
  tags() {
    return this.#api('tags')(this.#core);
  }

  at(name) {
    return this.#api('at')(this.#core, name);
  }

  atVersion(at) {
    return this.#api('atVersion')(this.#core, at);
  }

  /** Who last wrote a field: `{ origin, ts }`, or null — see src/blame.js. */
  lastEditorOf(id, field) {
    return B.lastEditorOf(this.#core, id, field);
  }

  /** Every node that wrote something the record still carries, sorted. */
  editorsOf(id) {
    return B.editorsOf(this.#core, id);
  }

  async editorOf(id, key, index) {
    return this.#api('editorOf')(this.#core, id, key, index);
  }

  async history(id, options) {
    return this.#api('history')(this.#core, id, options);
  }

  /** Every live record id, sorted — tombstones excluded, encrypted records included. From the catalog: no I/O. */
  async list() {
    return this.#catalog.ids();
  }

  async set(id, data, options = {}) {
    if (!isPlainObject(data)) throw new TypeError('set() takes a plain object');
    await this.saveData(id, data, options);
  }

  /**
   * Leaves a tombstone; with `data`, the fields it carries lie on the
   * tombstone — read by whoever reads it (a `change` of `action: 'delete'`
   * with `data`, a peer's hook), never by `get()`, which answers null.
   */
  async delete(id, { actor, data } = {}) {
    await this[COMMIT]('delete', id, tombstone(data), { actor });
    this.#records.delete(id);
  }

  // `purge()` over several ids: the ops as one transaction, the scrubs after.
  async #purgeMany(ids, { actor } = {}) {
    const run = () =>
      transact(
        this.#core,
        async (tx) => {
          for (let i = 0; i < ids.length; i++) await tx.commit('purge', ids[i], {}, { actor });
        },
        { actor },
      );
    const { done } = await this.#run(run);
    if (done !== null) await done;
    await this.#core.scrub(ids);
    for (let i = 0; i < ids.length; i++) this.#records.delete(ids[i]);
  }

  /**
   * Drops the database: closed, and every store of it removed from the
   * engine — the identity, the records, the log, the tags, the chain
   * (`engine.remove(path)`) — under the lock, before it is let go of, so
   * nothing opens the directory meanwhile. A follower, or a writer whose
   * lease was lost, is refused (READ_ONLY): the database is another
   * instance's to drop. A node opened at the path again is a new node.
   * `dropDatabase(path, { engine })` does the same for a closed one — and is
   * what a database closed already drops through.
   */
  async drop() {
    if (this.#readOnly || this.#leaseLost) throw this.#refused('drop()');
    this.#logger.info({ event: 'database.drop', path: this.#path });
    if (this.#closing !== null) {
      await this.#closing;
      return dropDatabase(this.#path, { engine: this.#engine });
    }
    this.#closing = this.#close(true);
    return this.#closing;
  }

  /**
   * Forgets a record HERE, with no op: its file and pieces removed, its
   * catalog row with them, every entry of it in this node's log scrubbed and
   * flagged skipped (a replay applies none of them again; the stream keeps
   * its headers, so no peer sees a gap). Nothing reaches a peer: what a node
   * does with the records of a scope a host took back (`REVOKED`), where a
   * `delete` would be an op the host refuses. A later op of the record from
   * a peer makes it again. Idempotent.
   */
  async forget(id) {
    if (!isRecordId(id)) throw typed('INVALID_ID', `forget(): ${String(id)} is not a record id`);
    await this.#run(() => this.#landing(() => this.#entries.remove(id)));
    await this.#log.scrub([id], { skip: true });
    this.#records.delete(id);
    this.#emitUpdate(id, null, {}, null, null);
  }

  /**
   * Forgets a record for good: a `purge` op (which no later write revives)
   * and a scrub of every entry of the id from this node's log — peers do
   * the same when it reaches them. The chain holds hashes only. Idempotent.
   */
  async purge(id, { actor } = {}) {
    await this[COMMIT]('purge', id, {}, { actor });
    await this.#core.scrub([id]);
    this.#records.delete(id);
  }

  /**
   * Sets the listed fields (a `set` op) — or, written in operators (`$set`,
   * `$unset`, `$inc`, `$addToSet`, `$pull`, `$push`, `$pop`, `$min`, `$max`,
   * `$rename`), the ops each one means by the kind of its field, as one
   * transaction. With `ifMatch` (a Mango query, the query plugin's) the
   * write is made only where the record matches it, inside the queue, and
   * resolves to whether it was.
   */
  update(id, delta, options) {
    const ifMatch = options?.ifMatch ?? null;
    if (isRecordId(id) && isPlainObject(delta)) {
      let operators;
      try {
        operators = isOperators(delta);
      } catch (error) {
        return Promise.reject(error);
      }
      // The operators and a condition are decided inside the queue, over the record as it is: a transaction.
      if (ifMatch !== null || operators) {
        return this.transact((tx) => tx.update(id, delta, options), { actor: options?.actor });
      }
      // A record held here and live is there: no file to ask.
      const current = this.#currentNow(id);
      if (current !== undefined && current !== null && (current.encrypted || isAlive(current))) {
        return this.#write('set', id, { data: delta }, { actor: options?.actor });
      }
    }
    return this.#update(id, delta, options?.actor);
  }

  /**
   * Changes record `id` by a function: `fn(copy)` runs inside the mutation
   * queue over a copy of the record as it reads, and what it leaves — what
   * it returns, or the copy when it returns nothing — is written as the ops
   * that take the record there (a field changed, a field gone; `null`
   * deletes). Two `modify()` calls on one record compose: each reads what
   * the one before it left. A write through the database from inside `fn`
   * is IN_TRANSACTION. Resolves to the record as it reads after, or null.
   */
  modify(id, fn, options = {}) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('modify() takes a function'));
    const { actor, message, source } = options;
    return this.transact((tx) => modifyIn(tx, id, fn, { actor }), { actor, message, source });
  }

  async #update(id, delta, actor) {
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

  // A plugin's method the facade has no stub for (a plugin of the
  // application's) goes on this storage as it is on a transaction's: called
  // with the lent core first. One named like a member of the storage (or
  // `then`, which would make it a thenable) is refused at open.
  #installMethods() {
    const { methods } = this.#plugins;
    for (const name of Object.keys(methods)) {
      // A stub of the facade reaches the registry already.
      if (Object.hasOwn(HOME, name) && name in this) continue;
      if (name in this || name === 'then') {
        throw new TypeError(`createDatabase(): a plugin's method ${name}() is a member of the storage already`);
      }
      const method = methods[name];
      Object.defineProperty(this, name, {
        value: (...args) => method(this.#core, ...args),
        configurable: true,
        enumerable: false,
        writable: false,
      });
    }
  }

  #api(name, what = `${name}()`, home = undefined) {
    const method = this.#plugins.methods[name];
    if (method === undefined) throw missing(what, home);
    return method;
  }

  // Whether the directory holds tags (tags.json with a tag, or unreadable).
  async #hasTags() {
    const text = await this.#db.kv.get('', 'tags.json');
    if (text === null) return false;
    try {
      const parsed = JSON.parse(text);
      return !Array.isArray(parsed?.tags) || parsed.tags.length > 0;
    } catch {
      return true;
    }
  }

  inc(id, key, value, options) {
    return attempt(() => F.inc(this.#core, id, key, value, options));
  }

  add(id, key, elements, options) {
    return attempt(() => F.add(this.#core, id, key, elements, options));
  }

  remove(id, key, elements, options) {
    return attempt(() => F.remove(this.#core, id, key, elements, options));
  }

  /** Removes fields of any kind from a record — one name or an array; a field it does not hold is no op. */
  unset(id, fields, options) {
    return attempt(() => F.unset(this.#core, id, fields, options));
  }

  // The hot writes call their method at once, without an async frame of
  // their own: a refusal of the arguments — or PLUGIN_MISSING — is a
  // rejection all the same.
  splice(id, key, index, count, content, options) {
    return attempt(() => this.#api('splice')(this.#core, id, key, index, count, content, options));
  }

  push(id, key, content, options) {
    return attempt(() => this.#api('push')(this.#core, id, key, content, options));
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

  async revision(id, key) {
    return this.#api('revision')(this.#core, id, key);
  }

  async cursor(id, key, index, options) {
    return this.#api('cursor')(this.#core, id, key, index, options);
  }

  async elementAt(id, key, index) {
    return this.#api('elementAt')(this.#core, id, key, index);
  }

  async elements(id, key) {
    return this.#api('elements')(this.#core, id, key);
  }

  async insertEmbed(id, key, index, embed, options) {
    await this.#api('insertEmbed')(this.#core, id, key, index, embed, options);
  }

  async splitBlock(id, key, index, block, options) {
    await this.#api('splitBlock')(this.#core, id, key, index, block, options);
  }

  async joinBlock(id, key, index, options) {
    await this.#api('joinBlock')(this.#core, id, key, index, options);
  }

  async updateBlock(id, key, index, block, options) {
    await this.#api('updateBlock')(this.#core, id, key, index, block, options);
  }

  async block(id, key, index) {
    return this.#api('block')(this.#core, id, key, index);
  }

  async position(id, key, cursor) {
    return this.#api('position')(this.#core, id, key, cursor);
  }

  async positions(id, key, cursors) {
    return this.#api('positions')(this.#core, id, key, cursors);
  }

  toDelta(changes, field) {
    return this.#api('toDelta')(this.#core, changes, field);
  }

  async applyDelta(id, key, delta, options) {
    return this.#api('applyDelta')(this.#core, id, key, delta, options);
  }

  async blocks(id, key) {
    return this.#api('blocks')(this.#core, id, key);
  }

  async index(id, key, cursor) {
    return this.#api('index')(this.#core, id, key, cursor);
  }

  setAt(id, key, index, value, options) {
    return attempt(() => this.#api('setAt')(this.#core, id, key, index, value, options));
  }

  move(id, key, from, to, options) {
    return attempt(() => this.#api('move')(this.#core, id, key, from, to, options));
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
    // The entries applied here, and the first whole-record op among them.
    const retained = this.#log.entriesOf(id);
    const entries = [];
    let start = -1;
    for (let i = 0; i < retained.length; i++) {
      const held = retained[i];
      if (!appliedHere(held, this.#version)) continue;
      const { type } = held.op;
      if (start === -1 && (type === 'purge' || (!held.scrubbed && WHOLE.has(type)))) start = entries.length;
      entries.push(held);
    }
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
    // Through the landing chain, like every file write: never beside a deferred flush of the same record.
    const from = entries[start].seq;
    const to = entries[entries.length - 1].seq;
    await this.#landing(() => this.#persistBatch(new Map([[id, entry]]), from, to));
    this.#flushCatalog();
    const ops = entries.length - start;
    const alive = isAlive(entry);
    this.#logger.info({ event: 'record.repaired', id, ops, alive });
    this.#emitUpdate(id, alive ? entry.data : null, alive ? { ...entry.data } : {}, null, entry);
    // The handles open on the record read it as it is now (src/text/handle.js).
    if (this.#following !== null) this.#followed({ ops: [], repaired: id, entry });
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

  /**
   * Runs `fn(tx)` as one transaction: every write made through `tx` — the
   * write API less `purge()`, plus `get()`/`has()` reading the records as
   * the transaction left them — is one op, prepared in one turn of the
   * mutation queue and appended with the others as one group once `fn`
   * returns: all durable or none, one chain block, each record's file
   * written once, the `commit` events after. `message` rides on every op
   * (signed, logged, listed by `history()`), `source` on their `commit`
   * events. A throw from `fn` or a refused write leaves nothing appended.
   * Resolves to what `fn` returned once the transaction has landed.
   */
  async transact(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('transact() takes a function');
    // While `fn` runs the queue is this transaction's: a write made through the database meanwhile is
    // refused (IN_TRANSACTION) where it would otherwise wait for itself.
    const guarded = (tx) => this.#task.run(() => fn(this.#transaction(tx)));
    const run = () => transact(this.#core, guarded, options);
    const otel = this.#otel;
    const { result, done } = await this.#run(
      otel.enabled ? () => traced(otel, 'syncom.transact', {}, run, ({ ops }) => ({ 'syncom.ops.count': ops })) : run,
    );
    if (done !== null) await done;
    return result;
  }

  /**
   * Watches record `id`: `listener(changes, event)` after every turn that
   * changed it — a local write, a transaction, a peer's page, a joined
   * snapshot — with the record's changes of that turn and the `transaction`
   * event they came in. With a `path`, the changes of that field, of what
   * hangs under it and of a prefix of it (a reset above it), and the whole
   * record's (a delete, a purge). Returns the function that stops watching.
   */
  observe(id, path, listener) {
    if (typeof path === 'function' && listener === undefined) [path, listener] = [null, path];
    if (!isRecordId(id)) throw invalidId(id);
    if (path !== null && path !== undefined) fieldName('observe', path);
    if (typeof listener !== 'function') throw new TypeError('observe() takes a listener');
    return this.#observers.add(id, path ?? null, listener);
  }

  // The write API over a transaction's core (src/commit.js transact): the
  // facade's own methods bound to it, the field and plugin methods handed it
  // as their core. Reads see the transaction's own writes, through the lens,
  // without the read hooks (a hook that writes would wait for the queue).
  #transaction(tx) {
    const api = {};
    const methods = this.#txMethods;
    for (let i = 0; i < methods.length; i++) {
      const method = methods[i][1];
      // A method that refuses its arguments throws: a rejection, as from the storage.
      api[methods[i][0]] = (...args) => {
        return attempt(() => method(tx, ...args));
      };
    }
    const current = async (id) => {
      if (!isRecordId(id)) throw invalidId(id);
      return tx.current(id);
    };
    api.get = async (id) => P.reading(tx, id, await current(id));
    api.has = async (id) => {
      const entry = await current(id);
      return entry !== null && (entry.encrypted || isAlive(entry));
    };
    api.insert = async (data, options = {}) => {
      if (!isPlainObject(data)) throw new TypeError('insert() takes a plain object');
      const named = this.#named(data);
      if (named === null) {
        const id = await this.#mint();
        await tx.commit('write', id, { data }, { actor: options.actor });
        return id;
      }
      try {
        await tx.commit('write', named.id, { data: named.data }, { actor: options.actor, expect: ABSENT });
      } catch (error) {
        if (error?.code === 'EXISTS' && this.#otel.enabled) this.#otel.recordInsertNamed('exists');
        throw error;
      }
      if (this.#otel.enabled) this.#otel.recordInsertNamed('ok');
      return named.id;
    };
    api.set = async (id, data, options = {}) => {
      if (!isPlainObject(data)) throw new TypeError('set() takes a plain object');
      await tx.commit('write', id, { data }, { actor: options.actor });
    };
    api.update = async (id, delta, options = {}) => {
      if (!isPlainObject(delta)) throw new TypeError('update() takes a plain object');
      const operators = isOperators(delta);
      const ifMatch = options.ifMatch ?? null;
      // The condition compiled first: a malformed query is a TypeError before anything is read.
      const test = ifMatch === null ? null : this.#predicate(ifMatch);
      // Fields without a condition: the record's presence alone is read, never its view composed.
      if (test === null && !operators) {
        if (!(await api.has(id))) throw new SyncomError('NOT_FOUND', `Record ${id} not found`, { id });
        await tx.commit('set', id, { data: delta }, { actor: options.actor });
        return undefined;
      }
      const view = await api.get(id);
      if (view === null) throw new SyncomError('NOT_FOUND', `Record ${id} not found`, { id });
      // The record's id laid last: a data field named `id` is not the record's.
      if (test !== null && !test({ ...view, id })) return false;
      // The operators decided over the view read once here.
      if (operators) await operate(api, tx, id, delta, options, view);
      else await tx.commit('set', id, { data: delta }, { actor: options.actor });
      return test === null ? undefined : true;
    };
    api.swap = async (id, changes, prev, options = {}) => {
      if (!isPlainObject(changes) || !isPlainObject(prev)) throw new TypeError('swap() takes two plain objects');
      const op = await tx.commit('set', id, { data: changes }, { actor: options.actor, expect: prev });
      return op !== MISMATCH;
    };
    api.delete = async (id, options = {}) => {
      await tx.commit('delete', id, tombstone(options.data), { actor: options.actor });
      this.#records.delete(id);
    };
    api.modify = (id, fn, options = {}) => {
      if (typeof fn !== 'function') throw new TypeError('modify() takes a function');
      return modifyIn(api, id, fn, { actor: options.actor });
    };
    api.purge = () => {
      throw new TypeError('purge() is not transactional: it scrubs the log; call it on the storage');
    };
    return Object.freeze(api);
  }

  /** The live Document of `id`: one object per id while the application holds it. */
  async document(id) {
    let document = this.#live(id);
    if (document === undefined) {
      document = await new Document(id, this);
      this.#records.set(id, new WeakRef(document));
      this.#reaper.register(document, id);
    }
    return document;
  }

  /** @deprecated `document()` — the name before the rename. */
  record(id) {
    return this.document(id);
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
   * The keys of this node's own streams are left out, and any seq that is
   * not a positive safe integer.
   */
  adoptVector(vector, options = {}) {
    return this.#run(() => adopt(this.#core, vector, { via: options.via, from: options.from }));
  }

  // The streams of this node's own a host holds more of (REWOUND), moved
  // past it — for the sync manager alone, once the host proved it or the
  // application said to take its word (`sync.rewind`), with the ops the
  // proof carried (`proofs`): what each stream chains on from. The advance
  // op it logs, or null; its `vector` is what moved.
  [REWIND](vector, options = {}) {
    const { via, from, proofs = null } = options;
    return this.#run(() => adopt(this.#core, vector, { via, from, own: true, proofs }));
  }

  /**
   * Lands what waits: the writes in flight (their disk, their files), then
   * the record files deferred under `createDatabase({ defer })` — one block, every
   * file — so what was written is on disk when this resolves. `close()` and
   * `tag()` do the same first.
   */
  async flush() {
    if (this.#closed) return;
    await this.#flushEdits();
    await this.#drained();
    await this.#run(() => this.#flushDeferred());
  }

  /**
   * Stops replication and seals the log: the open text handles' edits are
   * logged first, then further writes are refused. Called again — while it
   * runs or after — it is the same close.
   */
  close() {
    if (this.#closing === null) this.#closing = this.#close(false);
    return this.#closing;
  }

  // The close; with `sweep`, the drop: every store removed under the lock before it is let go of.
  async #close(sweep) {
    if (this.#closed) return;
    // What an editor's handle holds goes to the log while writes are taken.
    try {
      await this.#flushEdits();
    } catch (error) {
      this.#logger.warn({ event: 'edits.unlogged', handles: error.handles, edits: error.edits, err: error });
    }
    // Refused from here on: a write that landed while the links were
    // closing would be announced to nobody, after the final catalog save.
    // What was queued before this call still runs, ahead of the seal.
    this.#closed = true;
    if (this.#sync !== null) await this.#sync.stop();
    const seal = async () => {
      // What is in flight lands first.
      await this.#drained();
      await this.#flushDeferred();
      await this.#catalogSave;
      if (!this.#readOnly) await this.#catalog.save(this.#log.lastEventId);
      await this.#log.close();
    };
    const done = this.#queue.then(seal, seal);
    this.#queue = done.catch(() => {});
    await done;
    this.#unhear?.();
    await this.#heard;
    this.#unleash?.();
    if (sweep) {
      // Swept while the lock is held: nothing opens the directory meanwhile. The lock went with the rest: its
      // release finds nothing to let go of.
      await this.#engine.remove(this.#path);
      await this.#lock?.release().catch(NOOP);
    } else await this.#lock?.release();
    await this.#db.close();
    notify(this, this.#logger, 'close');
  }
}

Database.Collection = Collection;
Database.Document = Document;
// The names before the rename (2026-11): `Storage`, `Record`, `open()` stay
// as aliases until 1.0; the docs say `Database`, `Document`, `createDatabase()`.
Database.Record = Document;

const createDatabase = (options) => new Database(options);
const open = createDatabase;

module.exports = { Database, createDatabase, dropDatabase, Storage: Database, open };
