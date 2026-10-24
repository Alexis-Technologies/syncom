'use strict';

// The engine's front: a Storage opens a directory (through an injected
// backend), owns the mutation queue every write runs in, and lends its
// collaborators to the three write paths — the local one in src/commit.js,
// a peer's batch in src/apply.js, a bootstrap page in src/bootstrap.js.
// Records live in src/entries.js, what the application holds in
// src/record.js, the options in src/options.js.

const { Emitter, generateUUID, createLogger } = require('./utils.js');
const { decrypt, loadKeys, loadSigningKeys, calculateHash } = require('./crypto.js');
const { signOp } = require('./signing.js');
const { Blockchain } = require('./chain.js');
const { SyncManager } = require('./sync.js');
const { OpLog } = require('./log.js');
const { EntryStore } = require('./entries.js');
const { Record, Collection } = require('./record.js');
const { commit, MISMATCH } = require('./commit.js');
const { applyBatch } = require('./apply.js');
const { snapshotPage, mergeBatch, adopt } = require('./bootstrap.js');
const { applyOp, isAlive, isCounter, isSet, isSeq, isTree, deepEqual } = require('./ops.js');
const { diff } = require('./myers.js');
const { buildIndex, spans, isRunKey, isAnchor, cursorAt, indexOfCursor, REVERSED } = require('./sequence.js');
const { TRASH, isNodeId } = require('./tree.js');
const { appliedHere, parseVersion, within, exactStart, fold, gone } = require('./history.js');
const { Clock } = require('./vector.js');
const { notify, runHook, normalizeHooks } = require('./hooks.js');
const { normalizeSchema, createLens, project } = require('./schema.js');
const defaultFsi = require('./fsi.js');
const { checkFsi, withSync } = require('./backend.js');
const { acquireLock } = require('./lock.js');
const { Catalog, isTextIndex } = require('./catalog.js');
const { createTelemetry, traced, now } = require('./telemetry.js');
const { GLOBAL_SCOPE } = require('./scope.js');
const { normalizeStorageOptions } = require('./options.js');
const { isPlainObject, asJson, isRecordId, invalidId, isStreamName, isKeyId, VALIDATED } = require('./shape.js');
const { COMMIT, REFRESH, SOURCE } = require('./symbols.js');
const { SyncomError, typed } = require('./errors.js');

const NODE_FILE = 'node.json';
const SCHEMA_FILE = 'schema.json';

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

// What splice()/push() take: a field name, an index (null: the end) and a
// count, and content — a string for a text, an array of JSON values for a
// list, absent when the call only cuts.
const spliceArgs = (method, key, index, count, content) => {
  if (typeof key !== 'string') throw new TypeError(`${method}() takes a field name`);
  if (index !== null && !(Number.isInteger(index) && index >= 0)) {
    throw new TypeError(`${method}() takes a non-negative integer index`);
  }
  if (!Number.isInteger(count) || count < 0) throw new TypeError(`${method}() takes a non-negative integer count`);
  if (content !== undefined && typeof content !== 'string' && !Array.isArray(content)) {
    throw new TypeError(`${method}() takes a string for a text or an array for a list`);
  }
  if (Array.isArray(content)) {
    for (const element of content) {
      if (element === undefined || typeof element === 'function' || typeof element === 'symbol') {
        throw new TypeError(`${method}() takes JSON values; got ${typeof element}`);
      }
    }
  }
  if (count === 0 && (content === undefined || content.length === 0)) {
    throw new TypeError(`${method}() takes a count to remove or content to insert`);
  }
  const payload = { key, index, count };
  if (content !== undefined) payload.content = content;
  return payload;
};

// What mark()/unmark() take over a range: a field name, a visible range
// start ≤ end, a style name and an expand rule.
const treeArgs = (method, key, node, parent) => {
  if (typeof key !== 'string') throw new TypeError(`${method}() takes a field name`);
  if (!isNodeId(node)) throw new TypeError(`${method}() takes a node id: a non-empty string of at most 128 characters`);
  if (parent !== null && !isNodeId(parent)) throw new TypeError(`${method}() takes a parent: a node id or null`);
  if (parent === node) throw new TypeError(`${method}() cannot put a node under itself`);
};

const markArgs = (method, key, start, end, name, expand) => {
  if (typeof key !== 'string') throw new TypeError(`${method}() takes a field name`);
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || end < start) {
    throw new TypeError(`${method}() takes a range: 0 <= start <= end`);
  }
  if (typeof name !== 'string' || name.length === 0) throw new TypeError(`${method}() takes a style name`);
  if (!Object.hasOwn(REVERSED, expand)) throw new TypeError(`${method}() takes expand: before, after, both or none`);
};

// What add()/remove() take: a field name and a non-empty array of JSON
// values — an element JSON cannot carry (undefined, a function, a symbol) has
// no text to be told apart by.
const setElements = (method, key, elements) => {
  if (typeof key !== 'string') throw new TypeError(`${method}() takes a field name`);
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new TypeError(`${method}() takes a non-empty array of elements`);
  }
  for (const element of elements) {
    if (element === undefined || typeof element === 'function' || typeof element === 'symbol') {
      throw new TypeError(`${method}() takes JSON values; got ${typeof element}`);
    }
  }
  return elements;
};

class Storage extends Emitter {
  #path;
  #keys = null;
  #signing = null;
  #chain = null;
  #log = null;
  #entries = null;
  #core = null;
  #records = null;
  #reaper = null;
  #sync = null;
  #cacheMax;
  #verify;
  #chained;
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
  #options;
  #nodeId = null;
  #clock = new Clock();
  #scopeOf;
  #maxSkew;
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
    this.#path = settings.path;
    this.#lockOptions = settings.lock;
    this.#cacheMax = settings.cacheMax;
    this.#chained = settings.chained;
    this.#verify = settings.verify;
    this.#flushEvery = settings.flushEvery;
    this.#getId = settings.getId ?? Storage.generateId;
    this.#actor = settings.actor;
    this.#encrypted = settings.encrypted;
    this.#scopeOf = settings.scope ?? (() => GLOBAL_SCOPE);
    this.#maxSkew = settings.maxSkew;
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
    this.#otel = createTelemetry(options.telemetry);
    this.#fsi = this.#backend(options, settings.durable);
    this.#defineSchema(options, settings.search);
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

  // The schema is kept as given (`storage.schema`) and read once into the
  // entity definitions the write path consults: validators, id fields,
  // indexes. A malformed one is refused here, not at the first write.
  #defineSchema(options, search) {
    const schema = options.schema ?? null;
    const normalized = normalizeSchema(schema, { validator: options.validator });
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
    this.#lens = createLens(normalized, this.#logger);
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
      const started = this.#otel.enabled ? now() : 0;
      this.#lock = await acquireLock({ fsi: this.#fsi, path: this.#path, ...lock });
      if (started) this.#otel.recordLockWait(now() - started);
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
    this.#keys = await loadKeys(`${this.#path}/keys`, { fsi });
    this.#signing = await loadSigningKeys(`${this.#path}/keys`, { fsi });
    this.#chain = this.#chained ? await new Blockchain(`${this.#path}/blockchain`, { fsi }) : null;
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
      verify: this.#verify ? (id, data, block) => this.validate(id, data, block) : null,
      decrypt: (data) => decrypt(data, this.#keys.privateKey),
      view: (id, entry) => this.#view(id, entry),
    });
    await this.#loadIdentity();
    await this.#loadSchema();
    await this.#loadCatalog();
    this.#core = this.#lend();
    await this.#replayTail();
    await this.#replayHeld();
    const syncOptions = this.#options.sync ?? {};
    this.#sync = await new SyncManager(this, { ...syncOptions, maxListeners: this.#options.maxListeners });
    this.#initCollections();
    // What the observable gauges sample, when a meter was given.
    this.#otel.gauges(() => ({
      outbox: this.#sync.pendingOps(),
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
      keys: this.#keys,
      clock: this.#clock,
      entries: this.#entries,
      catalog: this.#catalog,
      nodeId: this.#nodeId,
      version: this.#version,
      ahead: this.#ahead,
      maxSkew: this.#maxSkew,
      signatures: this.#signatures,
      // Signs an op of this node's own, in place, once it is final.
      sign: this.#signatures === false ? null : (op) => signOp(op, this.#signing.privateKey),
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
      refresh: (id, data, delta, source) => this.#emitUpdate(id, data, delta, source),
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
    if (this.#snapshot !== undefined) this.#schemaHash = await calculateHash(this.#snapshot);
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
      const counters = {};
      const sets = {};
      const seqs = {};
      const trees = {};
      for (const key of Object.keys(view)) {
        if (isCounter(entry.meta, key)) counters[key] = entry.data[key];
        else if (isSet(entry.meta, key)) sets[key] = entry.data[key];
        else if (isSeq(entry.meta, key)) seqs[key] = entry.data[key];
        else if (isTree(entry.meta, key)) trees[key] = entry.data[key];
        else data[key] = view[key];
      }
      await this[COMMIT]('write', id, { data }, { actor });
      for (const key of Object.keys(counters)) {
        await this[COMMIT]('inc', id, { key, value: counters[key] }, { actor });
        result.counters++;
      }
      // A set with nothing live has nothing to add back: it is dropped.
      for (const key of Object.keys(sets)) {
        if (sets[key].length === 0) continue;
        await this[COMMIT]('add', id, { key, value: sets[key] }, { actor });
        result.sets++;
      }
      // A list or a text comes back as one run; an empty one is dropped.
      for (const key of Object.keys(seqs)) {
        if (seqs[key].length === 0) continue;
        await this[COMMIT]('splice', id, { key, index: 0, count: 0, content: seqs[key] }, { actor });
        if (typeof seqs[key] === 'string') result.texts++;
        else result.lists++;
      }
      // A tree comes back as one move per node it reads with, parents
      // first, in order; what hangs in the trash is dropped, and so is a
      // tree with nothing to read.
      for (const key of Object.keys(trees)) {
        const stack = trees[key].map((root) => [root, null]).reverse();
        if (stack.length > 0) result.trees++;
        while (stack.length > 0) {
          const [{ id: node, children }, parent] = stack.pop();
          await this[COMMIT]('tree', id, { key, node, parent }, { actor });
          for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], node]);
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
  async #loadIdentity() {
    const keyId = this.#signing.id;
    if (await this.#fsi.exists(this.#path, NODE_FILE)) {
      let id;
      try {
        ({ id } = JSON.parse(await this.#fsi.read(this.#path, NODE_FILE)));
      } catch (error) {
        throw corrupt(NODE_FILE, error);
      }
      if (!isStreamName(id)) throw corrupt(NODE_FILE, 'no node id in it');
      if (id === keyId) {
        this.#nodeId = keyId;
        return;
      }
      if (isKeyId(id)) {
        const message = `${NODE_FILE} names node ${id}, but keys/sign-public.pem is ${keyId}`;
        throw new SyncomError('IDENTITY_MISMATCH', message, { id, key: keyId });
      }
      this.#logger.warn({ event: 'identity.rekeyed', from: id, to: keyId });
    }
    this.#nodeId = keyId;
    await this.#fsi.write(this.#path, NODE_FILE, JSON.stringify({ id: keyId }));
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
      const { entry, changed } = applyOp(current, op);
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
      log: {
        length: log.length,
        floor: log.floor,
        next: log.next,
        epoch: log.epoch,
        segments: log.segments,
        latestTs: log.latestTs,
        droppedTs: log.droppedTs,
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
      return true;
    } catch (error) {
      await this.#unpersisted(touched, error);
      return false;
    }
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
      for (const [id, entry] of touched) records[id] = await calculateHash(entry.data);
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
      throw typed('NO_CHAIN', 'open({ chain: false }): this storage keeps no chain to validate against');
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
    const entry = await this.#entries.load(id);
    if (entry === null) return null;
    if (entry.encrypted) return asJson(entry.data);
    return isAlive(entry) ? asJson(await this.#view(id, entry)) : null;
  }

  async get(id, { at } = {}) {
    if (at !== undefined) return this.#getAt(id, at);
    await runHook(this.#hooks, 'beforeRead', { id });
    const data = await this.#read(id);
    const replaced = await runHook(this.#hooks, 'afterRead', { id }, data);
    return replaced === undefined ? data : replaced;
  }

  // `get(id, { at })`: the record at a version — an event id (as this node
  // held it after that entry), a stamp (every op stamped at or below it) or
  // `{ vector }` (every op it covers) — folded from the log (src/history.js),
  // through the lens and the read hooks, which see `at`.
  async #getAt(id, at) {
    const version = parseVersion(at);
    await runHook(this.#hooks, 'beforeRead', { id, at });
    const past = await this.#past(id, version);
    let data = null;
    if (past !== null) {
      const { entries, start } = past;
      const steps = fold(entries, start);
      const last = steps.length > 0 ? steps[steps.length - 1].entry : null;
      data = last !== null && isAlive(last) ? asJson(await this.#view(id, last)) : null;
    }
    const replaced = await runHook(this.#hooks, 'afterRead', { id, at }, data);
    return replaced === undefined ? data : replaced;
  }

  /**
   * The record's past as this node's log holds it: one version per op of
   * the record this node applied, newest first — `{ eventId, seq, ts,
   * origin, actor, type, fields, data, scrubbed? }`, `data` the record as it
   * read after the op (`null` once deleted) through the lens and `afterRead`,
   * `fields` what the op changed. `exact` says the versions are what this
   * node held (false once compaction took something a retained op still
   * depends on), `complete` that the list reaches the first op the node
   * ever applied to the record (nothing dropped, nothing cut by `limit`).
   * Rejects with ENCRYPTED for an encrypted record.
   */
  async history(id, { limit = 50 } = {}) {
    if (!(Number.isInteger(limit) && limit > 0) && limit !== Infinity) {
      throw new TypeError('history({ limit }) takes a positive integer');
    }
    await runHook(this.#hooks, 'beforeRead', { id, history: true });
    const { entries, purged } = await this.#applied(id);
    const droppedTs = this.#log.droppedTs;
    const { start, exact: fromReset } = exactStart(entries, droppedTs);
    const steps = fold(entries, start);
    const versions = [];
    for (const { logged, entry, delta } of steps) {
      const { seq, op, scrubbed } = logged;
      const version = {
        eventId: this.#log.formatId(seq),
        seq,
        ts: op.ts,
        origin: op.origin,
        actor: op.actor ?? null,
        type: op.type,
        fields: Object.keys(delta),
        data: null,
      };
      // Before a purge the payloads are gone: the ops are listed, their
      // content is not.
      if (scrubbed) version.scrubbed = true;
      if (purged === null || seq >= purged) {
        version.data = isAlive(entry) ? asJson(await this.#view(id, entry)) : null;
      } else {
        version.fields = [];
        version.scrubbed = true;
      }
      const replaced = await runHook(this.#hooks, 'afterRead', { id, at: version.eventId }, version.data);
      if (replaced !== undefined) version.data = replaced;
      versions.push(version);
    }
    versions.reverse();
    const last = steps.length > 0 ? steps[steps.length - 1].entry : null;
    const exact = fromReset && (await this.#present(id, last));
    return { versions: versions.slice(0, limit), complete: droppedTs === 0 && versions.length <= limit, exact };
  }

  // The retained entries of `id` this node applied, oldest first, and the
  // seq of its purge when the record is purged (0 when the purge itself is
  // no longer retained; `null` when not purged). An encrypted record has no
  // past in the log.
  async #applied(id) {
    if (!isRecordId(id)) return { entries: [], purged: null, current: null };
    const current = await this.#entries.load(id);
    if (current?.encrypted) throw new SyncomError('ENCRYPTED', `Record ${id} is encrypted here; it has no history`);
    const entries = this.#log.entriesOf(id).filter((entry) => appliedHere(entry, this.#version));
    const purge = entries.find((entry) => entry.op.type === 'purge');
    const purged = purge ? purge.seq : current?.meta?.purged ? 0 : null;
    return { entries, purged, current };
  }

  // Whether the fold of everything retained of `id` reads as the record
  // does: when it does not, compaction took something a retained op still
  // depends on (a counter incremented across the reset the fold starts at).
  async #present(id, folded) {
    const current = await this.#entries.load(id);
    const now = current !== null && isAlive(current) ? current.data : null;
    const then = folded !== null && isAlive(folded) ? folded.data : null;
    return deepEqual(now, then);
  }

  // The entries of `id` inside `version`, and where to fold them from; null
  // when the record was not there (or was purged). Throws HISTORY_GONE when
  // the log cannot give the version exactly, INVALID_VERSION for a seq this
  // log has not reached.
  async #past(id, version) {
    const log = this.#log;
    if (version.kind === 'event') {
      if (version.epoch !== log.epoch) throw gone(id, 'epoch');
      if (version.seq >= log.next) {
        throw typed('INVALID_VERSION', `at: ${log.formatId(version.seq)} is not in this log yet`);
      }
    }
    const { entries, purged, current } = await this.#applied(id);
    const inside = entries.filter((entry) => within(version, entry));
    if (purged !== null) {
      // After the purge, nothing; before it, nothing readable.
      if (purged === 0 || inside.some((entry) => entry.seq === purged)) return null;
      throw gone(id, 'scrubbed');
    }
    if (version.kind === 'stamp' && entries.some((entry) => entry.op.type === 'merge' && entry.op.ts > version.ts)) {
      throw gone(id, 'merge');
    }
    const droppedTs = log.droppedTs;
    if (inside.length === 0) {
      if (droppedTs === 0 || this.#catalog.row(id) === null) return null;
      throw gone(id, 'compacted');
    }
    const { start, exact } = exactStart(inside, droppedTs);
    if (!exact) throw gone(id, 'compacted');
    if (droppedTs > 0) {
      // The whole retained past must read as the present does, or the cut
      // cannot be trusted either.
      const all = fold(entries, exactStart(entries, droppedTs).start);
      const last = all.length > 0 ? all[all.length - 1].entry : null;
      if (current === null || !(await this.#present(id, last))) throw gone(id, 'compacted');
    }
    return { entries: inside, start };
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
    if (!(await this.has(id))) throw new SyncomError('NOT_FOUND', `Record ${id} not found`);
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
   * Adds `elements` to set field `key` — an observed-remove set: two nodes
   * that add concurrently both keep theirs, and an add a remove did not
   * observe survives it. Creates the field, and the record, when absent.
   */
  async add(id, key, elements, { actor } = {}) {
    await this[COMMIT]('add', id, { key, value: setElements('add', key, elements) }, { actor });
  }

  /** Removes from set field `key` the `elements` this node has seen added; one it never saw is left alone. */
  async remove(id, key, elements, { actor } = {}) {
    await this[COMMIT]('remove', id, { key, value: setElements('remove', key, elements) }, { actor });
  }

  /**
   * Splices list or text field `key` at `index`: removes `count` elements
   * and inserts `content` — an array for a list, a string for a text — in
   * their place (a `splice` op). The first write decides the kind. Elements
   * merge by position (Fugue): two nodes inserting at one spot both keep
   * theirs, each run whole, and a deleted element keeps its place for the
   * anchors into it. Creates the field, and the record, when absent;
   * rejects with `OUT_OF_RANGE` past the field's length.
   */
  async splice(id, key, index, count = 0, content, { actor } = {}) {
    await this[COMMIT]('splice', id, spliceArgs('splice', key, index, count, content), { actor });
  }

  /** Appends `content` to list or text field `key` — a `splice` at the end. */
  async push(id, key, content, { actor } = {}) {
    await this[COMMIT]('splice', id, spliceArgs('push', key, null, 0, content), { actor });
  }

  /**
   * Makes text field `key` read as `text`: the field is diffed against it
   * inside the mutation queue (Myers, over UTF-16 units) and each hunk is a
   * `splice`, last first, in one turn of the queue — what an editor hands
   * over as a whole string becomes the edits that merge. Returns how many
   * ops it took; a difference deeper than a thousand edit steps is one op
   * replacing the middle.
   */
  async updateText(id, key, text, { actor } = {}) {
    if (typeof key !== 'string') throw new TypeError('updateText() takes a field name');
    if (typeof text !== 'string') throw new TypeError('updateText() takes a string');
    if (!isRecordId(id)) throw invalidId(id);
    return this.#run(async () => {
      const current = await this.#core.entries.load(id);
      const before = current && !current.encrypted && isAlive(current) ? current.data[key] : undefined;
      // Another kind under the field: the first splice is refused for it.
      const hunks = diff(typeof before === 'string' ? before : '', text);
      let ops = 0;
      for (const [index, count, content] of hunks) {
        const payload = { key, index, count };
        if (content.length > 0) payload.content = content;
        if ((await commit(this.#core, 'splice', id, payload, { actor })) !== null) ops++;
      }
      return ops;
    });
  }

  /**
   * Marks visible range `[start, end)` of text field `key` with `name: value`
   * (a `mark` op). `expand` says whether text typed at the range's edges
   * takes the style — `'after'` (the default: bold grows), `'before'`,
   * `'both'`, `'none'` (a link does not). Per name the newest mark wins;
   * `{ many: true }` makes a mark stack with every other of its name
   * (comments), removable only by id. Resolves to the mark's id.
   */
  async mark(id, key, start, end, name, value, { expand = 'after', many = false, actor } = {}) {
    markArgs('mark', key, start, end, name, expand);
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(`mark() takes a JSON value; got ${typeof value}`);
    }
    const payload = { key, start, end, name, value, expand };
    if (many === true) payload.many = true;
    const op = await this[COMMIT]('mark', id, payload, { actor });
    return op ? `${op.ts}:${op.origin}` : null;
  }

  /**
   * Removes a style: over `[start, end)` by `name` — a mark with a null value
   * under the reversed expand rule, so the removal grows where the style would
   * not — or one mark by its id (`unmark(id, key, markId)`), the only way for
   * a `many` mark.
   */
  async unmark(id, key, start, end, name, { expand = 'after', actor } = {}) {
    if (typeof start === 'string') {
      if (typeof key !== 'string') throw new TypeError('unmark() takes a field name');
      if (!isRunKey(start)) throw new TypeError('unmark() takes a mark id, or a range and a name');
      await this[COMMIT]('mark', id, { key, off: start }, end && typeof end === 'object' ? end : { actor });
      return;
    }
    markArgs('unmark', key, start, end, name, expand);
    await this[COMMIT]('mark', id, { key, start, end, name, value: null, expand: REVERSED[expand] }, { actor });
  }

  /**
   * Text field `key` of record `id` as runs of equal style: `[{ text, marks }]`,
   * `marks` per name the winning value (a `many` name lists `{ id, value }`).
   * Raw: no lens, no read hooks. `null` when the record or the field is not
   * a text.
   */
  async spans(id, key) {
    const held = await this.#sequence('spans', id, key);
    if (held === null || held.seq.k !== 't') return null;
    return spans(buildIndex(held.seq, held.base), held.seq, held.base);
  }

  /**
   * A cursor into list or text field `key`: a place that survives edits
   * around it — before the element at `index` (`side: 'before'`, the
   * default) or after the one before it (`'after'`), a string to keep or to
   * send. `index()` says where it is now. `null` out of range or when the
   * field is not a list or a text.
   */
  async cursor(id, key, index, { side = 'before' } = {}) {
    if (side !== 'before' && side !== 'after') throw new TypeError("cursor() takes side: 'before' or 'after'");
    const held = await this.#sequence('cursor', id, key);
    return held === null ? null : cursorAt(buildIndex(held.seq, held.base), index, side);
  }

  /** Where `cursor` is now in list or text field `key`; `null` once its place is gone (a reset, a field no longer a sequence). */
  async index(id, key, cursor) {
    if (typeof cursor !== 'string' || !isAnchor(cursor)) throw new TypeError('index() takes a cursor');
    const held = await this.#sequence('index', id, key);
    return held === null ? null : indexOfCursor(buildIndex(held.seq, held.base), cursor);
  }

  // A sequence field as the record holds it — raw, no lens, no hooks — or null.
  async #sequence(method, id, key) {
    if (!isRecordId(id)) throw invalidId(id);
    if (typeof key !== 'string') throw new TypeError(`${method}() takes a field name`);
    const entry = await this.#entries.load(id);
    if (!entry || entry.encrypted || !isAlive(entry)) return null;
    const seq = Object.hasOwn(entry.meta.seqs ?? {}, key) ? entry.meta.seqs[key] : undefined;
    return seq === undefined ? null : { seq, base: entry.meta.base };
  }

  /**
   * Replaces the element at `index` of list field `key` with `value` (an
   * `assign` op): a register per element, last writer wins, and the value
   * follows the element through a concurrent move.
   */
  async setAt(id, key, index, value, { actor } = {}) {
    if (typeof key !== 'string') throw new TypeError('setAt() takes a field name');
    if (!Number.isInteger(index) || index < 0) throw new TypeError('setAt() takes a non-negative integer index');
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(`setAt() takes a JSON value; got ${typeof value}`);
    }
    await this[COMMIT]('assign', id, { key, index, value }, { actor });
  }

  /**
   * Moves the element at `from` of list field `key` to `to` — its index once
   * it is out (a `move` op). Two nodes moving one element concurrently leave
   * it once, at the newer move's place; a move concurrent with a removal of
   * the element brings it back.
   */
  async move(id, key, from, to, { actor } = {}) {
    if (typeof key !== 'string') throw new TypeError('move() takes a field name');
    if (!Number.isInteger(from) || from < 0 || !Number.isInteger(to) || to < 0) {
      throw new TypeError('move() takes non-negative integer indices');
    }
    if (from === to) return;
    await this[COMMIT]('move', id, { key, index: from, to }, { actor });
  }

  /**
   * Puts node `node` of tree field `key` under `parent` (`null`: a root) —
   * after sibling `after`, before sibling `before`, or last (a `tree` op).
   * A node the tree has not is created there; the field, and the record,
   * when absent. Two nodes moving concurrently so that each would hang
   * under the other: the newer move loses, on every node, and a later move
   * can revive it. Rejects with `CYCLE` for a parent under the node itself
   * and with `NOT_FOUND` for a sibling not under `parent`; a move to where
   * the node already is makes no op.
   */
  async treeMove(id, key, node, parent = null, { after, before, actor } = {}) {
    treeArgs('treeMove', key, node, parent);
    if (after !== undefined && before !== undefined) throw new TypeError('treeMove() takes after or before, not both');
    for (const [name, value] of [
      ['after', after],
      ['before', before],
    ]) {
      if (value === undefined) continue;
      if (!isNodeId(value)) throw new TypeError(`treeMove() takes ${name}: a node id`);
      if (value === node) throw new TypeError(`treeMove() cannot place a node ${name} itself`);
    }
    const payload = { key, node, parent };
    if (after !== undefined) payload.after = after;
    if (before !== undefined) payload.before = before;
    await this[COMMIT]('tree', id, payload, { actor });
  }

  /**
   * Removes node `node` of tree field `key` with everything under it — a
   * move under the trash, which no reading shows. A node not yet known here
   * is created there, so a creation of it elsewhere lands removed.
   */
  async treeRemove(id, key, node, { actor } = {}) {
    treeArgs('treeRemove', key, node, null);
    await this[COMMIT]('tree', id, { key, node, parent: TRASH }, { actor });
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
      ({ entry } = applyOp(entry, entries[i].op));
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
