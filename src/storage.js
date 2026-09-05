'use strict';

const { Emitter, generateUUID, createLogger } = require('./utils.js');
const { encrypt, decrypt, loadKeys, calculateHash } = require('./crypto.js');
const { Blockchain } = require('./chain.js');
const { SyncManager } = require('./sync.js');
const { OpLog } = require('./log.js');
const { applyOp, isAlive, latestClock } = require('./ops.js');
const { Clock, opKey, keyScope, vectorHas, vectorNext, vectorAdvance } = require('./vector.js');
const { notify } = require('./hooks.js');
const fsi = require('./fsi.js');
const { createTelemetry, traced, now } = require('./telemetry.js');

const NODE_FILE = 'node.json';
const GLOBAL_SCOPE = '*';

// Module-private entry points between Storage and Record: a Record commits
// through the same path every other write takes and is refreshed when the
// record changes underneath it. Symbols keep both off the public surface.
const COMMIT = Symbol('syncom.commit');
const REFRESH = Symbol('syncom.refresh');

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// What a commit came to: an op, `null` for a write that changed nothing, and
// `undefined` for an encrypted record (saved locally, no op).
const commitResult = (op) => (op === undefined ? 'encrypted' : op === null ? 'noop' : 'applied');

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

  async delete(id) {
    return this.#storage.delete(id);
  }

  async update(id, delta) {
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
  #schema = null;
  #getId = null;
  #logger;
  #otel;
  #options;
  #nodeId = null;
  #clock = new Clock();
  #scopeOf;
  #encrypted = false;
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
    if (options.schema) this.#schema = options.schema;
    // A non-function is ignored rather than rejected: the id generator is a
    // convenience seam, not a security boundary, and the default still holds.
    if (typeof options.getId === 'function') this.#getId = options.getId;
    // Encrypt every record at rest by default; a per-call `{ encrypted }`
    // still overrides. Encrypted records are local — see saveData().
    this.#encrypted = options.encrypted === true;
    const scope = options.sync?.scope;
    this.#scopeOf = typeof scope === 'function' ? scope : () => GLOBAL_SCOPE;
    return this.#init();
  }

  async #init() {
    this.#keys = await loadKeys(`${this.#path}/keys`);
    this.#chain = await new Blockchain(`${this.#path}/blockchain`);
    this.#log = await new OpLog(this.#path, {
      ...this.#options.sync?.log,
      retention: this.#options.sync?.retention,
      logger: this.#logger,
      telemetry: this.#otel,
    });
    // The clock picks up where the log left off: every stamp this node ever
    // logged is below what it will stamp next, whatever the wall clock says.
    this.#clock.observe(this.#log.latestTs);
    await this.#loadIdentity();
    await this.#replayTail();
    this.#sync = await new SyncManager(this, this.#options.sync);
    this.#initCollections();
    return this;
  }

  // The node id is minted once and never changes; the own sequence numbers
  // (one per scope) live in the log's vector, which survives compaction — so
  // a seq is durable the moment its op is appended, before anyone hears of it.
  async #loadIdentity() {
    if (await fsi.exists(this.#path, NODE_FILE)) {
      const raw = await fsi.read(this.#path, NODE_FILE);
      this.#nodeId = JSON.parse(raw).id;
    } else {
      this.#nodeId = generateUUID();
      await fsi.write(this.#path, NODE_FILE, JSON.stringify({ id: this.#nodeId }));
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
    for (const { seq, op } of tail) {
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
    const entities = this.#schema?.entities;
    if (!entities) return;
    for (const [name] of entities.entries?.() ?? Object.entries(entities)) {
      this[name] = new Collection(this, name);
    }
  }

  get schema() {
    return this.#schema;
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
    const result = this.#queue.then(task, task);
    this.#queue = result.catch(() => {});
    return result;
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
    if (this.#cache.has(id)) return this.#cache.get(id);
    const dataDir = `${this.#path}/data`;
    const exists = await fsi.exists(dataDir, `${id}.json`);
    if (!exists) {
      this.#cache.set(id, null);
      return null;
    }
    const raw = await fsi.read(dataDir, `${id}.json`);
    const { data, meta, encrypted, block } = JSON.parse(raw);
    const isValid = await this.validate(id, data, block);
    if (!isValid) throw new Error(`Storage record ${id} is invalid`);
    const entry = encrypted
      ? { data: await decrypt(data, this.#keys.privateKey), meta: null, encrypted: true, block }
      : { data, meta, encrypted: false, block };
    this.#cache.set(id, entry);
    return entry;
  }

  async #writeEntry(id, entry, blockHash) {
    const stored = { data: entry.data, meta: entry.meta, encrypted: false, timestamp: Date.now(), block: blockHash };
    await fsi.write(`${this.#path}/data`, `${id}.json`, JSON.stringify(stored));
    this.#cache.set(id, { data: entry.data, meta: entry.meta, encrypted: false, block: blockHash });
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

  async #commit(type, id, payload, { source = null, via = null, from = null } = {}) {
    {
      const current = await this.#load(id);
      if (current?.encrypted) {
        // An encrypted record has no op log: writes to it stay local. Set
        // and write map onto the encrypted save; a counter needs ops.
        if (type === 'write') return void (await this.#writeEncrypted(id, payload.data, source));
        if (type === 'set') return void (await this.#writeEncrypted(id, { ...current.data, ...payload.data }, source));
        if (type === 'delete') return void (await this.#removeEncrypted(id, source));
        throw new Error(`Record ${id} is encrypted; ${type} needs a replicated record`);
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
      // Sequence numbers run per stream (see vector.js opKey): the scope's,
      // or the bootstrap stream for a merge.
      op.seq = (this.#log.vector[opKey(op)] ?? 0) + 1;
      if (payload.data !== undefined) op.data = payload.data;
      if (payload.meta !== undefined) op.meta = payload.meta;
      if (payload.key !== undefined) op.key = payload.key;
      if (payload.value !== undefined) op.value = payload.value;

      const { entry, changed, delta, rejected } = applyOp(current, op);
      if (rejected.length > 0) {
        const [{ field, reason }] = rejected;
        const hint = reason === 'counter' ? 'a counter; use inc()' : 'a register; use update()';
        throw new Error(`Field ${field} of record ${id} is ${hint}`);
      }
      if (!changed) return null;

      const [{ seq: position }] = await this.#log.append([op]);
      const hash = await calculateHash(entry.data);
      const blockHash = await this.#chain.addBlock({ id, hash, from: this.#log.formatId(position) });
      await this.#writeEntry(id, entry, blockHash);

      const alive = isAlive(entry);
      this.#emitUpdate(id, alive ? entry.data : null, delta, source);
      // Announced after everything is durable. `via` is null for a local
      // write; a merge made from a peer's snapshot names that peer, so the
      // relay does not hand its own state straight back to it.
      notify(this, this.#logger, 'change', op, via);
      return op;
    }
  }

  // ---------------------------------------------------------------------
  // Public API

  // Encrypted at rest for THIS node's key: written directly, outside the op
  // log, because no peer could read it. Runs inside the mutation queue.
  async #writeEncrypted(id, data, source = null) {
    const record = await encrypt(data, this.#keys.publicKey);
    const hash = await calculateHash(record);
    const blockHash = await this.#chain.addBlock({ id, hash });
    const entry = { data: record, meta: null, encrypted: true, timestamp: Date.now(), block: blockHash };
    await fsi.write(`${this.#path}/data`, `${id}.json`, JSON.stringify(entry));
    this.#cache.set(id, { data, meta: null, encrypted: true, block: blockHash });
    this.#emitUpdate(id, data, { ...data }, source);
  }

  async #removeEncrypted(id, source = null) {
    await fsi.remove(`${this.#path}/data`, `${id}.json`);
    this.#cache.set(id, null);
    this.#emitUpdate(id, null, {}, source);
  }

  async saveData(id, data, options = {}) {
    const { encrypted = this.#encrypted } = options;
    if (!encrypted) return void (await this[COMMIT]('write', id, { data }));
    const current = await this.#load(id);
    if (current && !current.encrypted) throw new Error(`Record ${id} is replicated and cannot become encrypted`);
    await this.#run(() => this.#writeEncrypted(id, data));
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

  hasRecord(id) {
    return (this.#cache.has(id) && this.#cache.get(id) !== null) || this.#records.has(id);
  }

  async get(id) {
    const entry = await this.#load(id);
    if (entry === null) return null;
    if (entry.encrypted) return entry.data;
    return isAlive(entry) ? entry.data : null;
  }

  /** Every live record id — tombstones excluded, encrypted records included. */
  async list() {
    const names = await fsi.list(`${this.#path}/data`);
    const ids = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const entry = await this.#load(id);
      if (entry && (entry.encrypted || isAlive(entry))) ids.push(id);
    }
    return ids;
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
    const data = await this.get(id);
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
          'syncom.ops.duplicates': r.duplicates,
          'syncom.ops.gaps': r.gaps,
        }),
      );
      return result;
    } finally {
      otel.recordApply(result ?? { applied: 0, duplicates: 0, gaps: 0 }, now() - started);
    }
  }

  async #applyRemote(ops, { via = null, scopes = null } = {}) {
    {
      const accepted = [];
      const touched = new Map();
      const deltas = new Map();
      const vector = this.#log.vector;
      let adopted = null;
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
        const current = touched.get(op.id) ?? (await this.#load(op.id));
        if (current?.encrypted) {
          this.#logger.warn({ event: 'sync.op.encrypted', id: op.id });
          vectorAdvance(vector, op);
          accepted.push(op);
          continue;
        }
        this.#clock.observe(op.ts);
        const { entry, changed, delta, rejected } = applyOp(current, op);
        if (rejected.length > 0) {
          this.#logger.warn({ event: 'sync.op.rejected', id: op.id, rejected });
          this.#otel.recordRejected(rejected[0].reason);
          notify(this, this.#logger, 'error', Object.assign(new Error(`Refused op on ${op.id}`), { op, rejected }));
        }
        vectorAdvance(vector, op);
        accepted.push(op);
        this.#otel.recordLag(op.ts);
        if (!changed) continue;
        touched.set(op.id, entry);
        deltas.set(op.id, { ...(deltas.get(op.id) ?? {}), ...delta });
      }
      if (accepted.length === 0) return { applied: 0, duplicates, gaps };

      const entries = await this.#log.append(accepted);
      if (adopted) await this.#log.advance(adopted);
      if (touched.size > 0) {
        await this.#persistBatch(touched, entries[0].seq, entries[entries.length - 1].seq);
        for (const [id, entry] of touched) {
          this.#emitUpdate(id, isAlive(entry) ? entry.data : null, deltas.get(id));
        }
      }
      for (const op of accepted) notify(this, this.#logger, 'change', op, via);
      return { applied: accepted.length, duplicates, gaps };
    }
  }

  /**
   * One page of this node's state for a peer that cannot be resumed from
   * the log: live records AND tombstones, with their metadata, in id order.
   * `cursor` is the last id of the previous page; `null` back means done.
   */
  async snapshot({ cursor = null, limit = 500, scopes = null } = {}) {
    const names = await fsi.list(`${this.#path}/data`);
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
      await this.#log.close();
    });
    this.#closed = true;
  }
}

Storage.Collection = Collection;
Storage.Record = Record;

const open = (options) => new Storage(options);

module.exports = { Storage, open };
