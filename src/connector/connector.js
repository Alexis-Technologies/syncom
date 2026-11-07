'use strict';

// Connectors (@alexify/syncom/connector): one collection kept in step with a
// backend of its own — a CouchDB, a GraphQL endpoint, a Firestore, a
// Postgres behind Supabase, a MongoDB, a file in a drive — through two
// handlers the application (or an adapter beside this module) writes:
//
//   pull.handler(checkpoint, batchSize) → { documents: [{ id, data, deleted }], checkpoint }
//     the backend's documents changed since `checkpoint`, a page at a time, and
//     the position after them; `pull.stream(emit)` → stop, when the backend
//     tells of changes: `emit({ documents, checkpoint })`, or `emit('RESYNC')`
//     to pull again from the checkpoint.
//   push.handler(rows) → conflicts
//     rows `[{ id, data, deleted, assumed }]` — the record as this node reads it
//     (`deleted` for a tombstone) and `assumed`, the backend's state as this
//     node last knew it (what a compare-and-set backend checks against) —
//     answered with the rows it refused, each as the backend holds it
//     (`{ id, data, deleted }`): a conflict the backend wins, unless `resolve`
//     says what the record should be.
//
// What comes in lands as ordinary writes of this node — a transaction of
// `set`/`delete` per page, stamped here, `source: 'connector:<name>'` — so a
// pulled record reaches every peer like a local one; a document equal to
// what the record reads as is left alone (no op), which is how this node's
// own writes, come back from the backend, make no echo; a document that
// cannot land (another collection's record, a sealed one, no JSON, a
// validator's no) is refused by name (`refused`) and the rest of the page
// lands. What goes out follows
// the `transaction` events of the collection — every turn but a pull of this
// connector's — pages of `batchSize` rows, in order, one push in flight. The
// checkpoint (`{ pull, pushed }`: the backend's position, and this node's log
// position pushed through) lives in the `connector` kv namespace under the
// name: a restart pulls from `pull` and pushes what the log holds since
// `pushed` — every record of the collection once where the log cannot resume.
// A handler that fails is told (`error`, REPLICATION_FAILED with the direction)
// and tried again after `retryTime`; nothing is skipped. Requires symbols.js,
// engine.js, shape.js, errors.js, hooks.js, emitter.js only.

const { SOURCE, DB } = require('../symbols.js');
const { kvNamespace } = require('../engine.js');
const { isPlainObject, isRecordId } = require('../shape.js');
const { SyncomError } = require('../errors.js');
const { notify } = require('../hooks.js');
const { Emitter } = require('../emitter.js');
const { same } = require('./same.js');

const NAMESPACE = 'connector';
const DEFAULT_BATCH = 100;
const DEFAULT_RETRY = 5000;
// How many of the handlers' errors are kept (the newest).
const MAX_ERRORS = 20;
// A pull whose checkpoint does not move while it answers full pages is asked this many times, then left.
const MAX_STALLS = 3;
const NOOP = () => {};

const isDatabase = (value) =>
  value !== null && typeof value === 'object' && typeof value.transact === 'function' && typeof value.on === 'function';

// A record's data as a backend sees it: without the collection's mark.
const plain = (data) => {
  if (data === null) return null;
  const out = {};
  for (const key of Object.keys(data)) if (key !== '$type') out[key] = data[key];
  return out;
};

// A pulled document, checked: `{ id, data, deleted }`, or null for one that is no document.
const documentOf = (doc) => {
  if (!isPlainObject(doc) || !isRecordId(doc.id)) return null;
  const deleted = doc.deleted === true;
  if (!deleted && !isPlainObject(doc.data)) return null;
  return { id: doc.id, data: deleted ? null : doc.data, deleted };
};

// JSON alone crosses: null, booleans, finite numbers, strings, arrays and plain objects of them. A Date, a Decimal, a
// Timestamp or a reference of a backend's SDK is refused on pull (`reason: 'value'`) — never flattened into a record
// and written back as a string.
const MAX_DEPTH = 64;
const isJson = (value, depth = 0) => {
  if (value === null || value === undefined) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object' || depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!isJson(value[i], depth + 1)) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Object.keys(value)) if (!isJson(value[key], depth + 1)) return false;
  return true;
};

const failed = (direction, message, cause, name) =>
  new SyncomError('REPLICATION_FAILED', message, { direction, name, cause });

const checkHandlers = (name, side, value, methods) => {
  if (value === undefined) return null;
  if (!isPlainObject(value)) throw new TypeError(`replicate(): ${side} must be an object`);
  for (let i = 0; i < methods.length; i++) {
    const [method, required] = methods[i];
    const fn = value[method];
    if (fn === undefined && !required) continue;
    if (typeof fn !== 'function') throw new TypeError(`replicate(): ${side}.${method} must be a function`);
  }
  return value;
};

class Replication extends Emitter {
  #db;
  #name;
  #collection;
  #pull;
  #push;
  #live;
  #retryTime;
  #batchSize;
  #modifier;
  #resolve;
  #store;
  #seam;
  #logger;
  #source;
  #actor;
  #checkpoint = { pull: null, pushed: null };
  #loaded = false;
  #active = false;
  #canceled = false;
  #initial = null;
  #initialDone = false;
  #listener = null;
  #stream = null;
  #timer = null;
  // A retry timer per direction: a push that fails must not cancel the pull's try, nor the other way round.
  #retry = { pull: null, push: null };
  // The ids whose state is to go to the backend, in the order they came; the push in flight; the pull in flight.
  #pending = new Set();
  #pushing = null;
  #pulling = null;
  // The backend's state of each record as this node last knew it — what a push says it assumed.
  #assumed = new Map();
  #errors = [];
  #waiters = new Set();
  #stats = { pulled: 0, applied: 0, pushed: 0, conflicts: 0, refused: 0, pulls: 0, pushes: 0 };

  constructor(db, options) {
    super();
    const {
      name,
      collection,
      pull,
      push,
      live = true,
      retryTime = DEFAULT_RETRY,
      batchSize = DEFAULT_BATCH,
      modifier,
      resolve = null,
    } = options;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}$/.test(name)) {
      throw new TypeError('replicate() takes a name: letters, digits, _ . -');
    }
    if (typeof collection !== 'string' || collection.length === 0) {
      throw new TypeError('replicate() takes a collection');
    }
    this.#pull = checkHandlers(name, 'pull', pull, [
      ['handler', true],
      ['stream', false],
    ]);
    this.#push = checkHandlers(name, 'push', push, [['handler', true]]);
    if (this.#pull === null && this.#push === null) throw new TypeError('replicate() takes a pull, a push, or both');
    if (typeof live !== 'boolean') throw new TypeError('replicate(): live must be a boolean');
    if (!Number.isFinite(retryTime) || retryTime <= 0) {
      throw new TypeError('replicate(): retryTime must be a positive number');
    }
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new TypeError('replicate(): batchSize must be a positive integer');
    }
    if (modifier !== undefined) {
      if (!isPlainObject(modifier)) throw new TypeError('replicate(): modifier must be an object');
      for (const side of ['pull', 'push']) {
        if (modifier[side] !== undefined && typeof modifier[side] !== 'function') {
          throw new TypeError(`replicate(): modifier.${side} must be a function`);
        }
      }
    }
    if (resolve !== null && typeof resolve !== 'function') {
      throw new TypeError('replicate(): resolve must be a function');
    }
    this.#db = db;
    this.#name = name;
    this.#collection = collection;
    this.#live = live;
    this.#retryTime = retryTime;
    this.#batchSize = batchSize;
    this.#modifier = { pull: modifier?.pull ?? null, push: modifier?.push ?? null };
    this.#resolve = resolve;
    this.#store = kvNamespace(db[DB].kv, NAMESPACE);
    this.#seam = db[SOURCE];
    this.#logger = db.logger;
    this.#source = `connector:${name}`;
    this.#actor = this.#source;
  }

  get name() {
    return this.#name;
  }

  get collection() {
    return this.#collection;
  }

  /** Whether the connector follows the collection and the backend now. */
  get active() {
    return this.#active;
  }

  get canceled() {
    return this.#canceled;
  }

  /** The backend's position pulled through and this node's log position pushed through. */
  get checkpoint() {
    return { ...this.#checkpoint };
  }

  /** The handlers' failures, the newest twenty. */
  get errors() {
    return this.#errors.slice();
  }

  /** The counts: documents pulled and applied, rows pushed, conflicts met, pulls and pushes made. */
  stats() {
    return { ...this.#stats, pending: this.#pending.size, active: this.#active, canceled: this.#canceled };
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /**
   * Begins: the checkpoint read, the collection followed, the backend pulled from the checkpoint and what this node
   * holds since `pushed` pushed — the initial replication, which `awaitInitialReplication()` waits for — then the
   * live half (the backend's stream or a pull every `retryTime`, the turns pushed as they come).
   */
  start() {
    if (this.#canceled) {
      throw new SyncomError('REPLICATION_FAILED', `Connector ${this.#name} was canceled`, {
        direction: null,
        name: this.#name,
      });
    }
    if (this.#active) return this.#initial;
    this.#active = true;
    notify(this, this.#logger, 'active', true);
    this.#initial = this.#begin();
    return this.#initial;
  }

  async #begin() {
    if (!this.#loaded) await this.#load();
    if (this.#canceled) return;
    this.#listener = (event) => this.#heard(event);
    this.#db.on('transaction', this.#listener);
    try {
      // The backend first: what it holds is what a push then assumes (a fresh connector knows nothing of it), and
      // what the pull landed is the backend's already — the push since skips the connector's own writes.
      if (this.#pull !== null) await this.#pullAll();
      if (this.#push !== null) await this.#pushSince();
    } finally {
      this.#initialDone = true;
      this.#settle();
    }
    if (this.#canceled) return;
    if (this.#live && this.#pull !== null) this.#follow();
  }

  /** Stops for good: the collection no longer followed, the backend's stream closed, what is in flight finished. */
  async cancel() {
    if (this.#canceled) return;
    this.#canceled = true;
    this.#active = false;
    if (this.#listener !== null) this.#db.off('transaction', this.#listener);
    this.#listener = null;
    this.#stopFollowing();
    for (const direction of ['pull', 'push']) {
      if (this.#retry[direction] !== null) clearTimeout(this.#retry[direction]);
      this.#retry[direction] = null;
    }
    await Promise.allSettled([this.#pushing, this.#pulling]);
    for (const waiter of this.#waiters) {
      waiter.reject(failed(null, `Connector ${this.#name} was canceled`, null, this.#name));
    }
    this.#waiters.clear();
    notify(this, this.#logger, 'active', false);
  }

  /** Pulls again from the checkpoint, and pushes what the collection holds since `pushed` — a backend that lost a change. */
  async reSync() {
    if (!this.#active) {
      throw new SyncomError('REPLICATION_FAILED', `Connector ${this.#name} is not active`, {
        direction: null,
        name: this.#name,
      });
    }
    // Behind a pull in flight: a pull again, from the checkpoint as it then stands.
    if (this.#pulling !== null) await this.#pulling.catch(NOOP);
    if (this.#pull !== null) await this.#pullAll();
    if (this.#push !== null) await this.#pushSince();
  }

  /** Resolves once the initial pull and push are done — what a reader waits for before it trusts the collection. */
  awaitInitialReplication({ signal = null } = {}) {
    return this.#await(() => this.#initialDone, signal);
  }

  /** Resolves once nothing waits to go to the backend and nothing is in flight either way. */
  awaitInSync({ signal = null } = {}) {
    return this.#await(
      () => this.#initialDone && this.#pending.size === 0 && this.#pushing === null && this.#pulling === null,
      signal,
    );
  }

  #await(check, signal) {
    if (this.#canceled) return Promise.reject(failed(null, `Connector ${this.#name} was canceled`, null, this.#name));
    if (check()) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    return new Promise((resolve, reject) => {
      const waiter = { check, resolve, reject };
      this.#waiters.add(waiter);
      signal?.addEventListener?.(
        'abort',
        () => {
          if (this.#waiters.delete(waiter)) reject(signal.reason ?? new Error('aborted'));
        },
        { once: true },
      );
    });
  }

  #settle() {
    if (this.#waiters.size === 0) return;
    for (const waiter of [...this.#waiters]) {
      if (!waiter.check()) continue;
      this.#waiters.delete(waiter);
      waiter.resolve();
    }
  }

  // The checkpoint from the kv: a text that does not read is said and read as none (a pull from the start, a
  // push of every record).
  async #load() {
    this.#loaded = true;
    let parsed = null;
    try {
      const text = await this.#store.get(this.#name);
      if (text !== null) parsed = JSON.parse(text);
    } catch (error) {
      this.#logger.warn({ event: 'connector.checkpoint.unreadable', name: this.#name, err: error });
    }
    if (!isPlainObject(parsed)) return;
    this.#checkpoint = {
      pull: parsed.pull === undefined ? null : parsed.pull,
      pushed: typeof parsed.pushed === 'string' ? parsed.pushed : null,
    };
  }

  async #save() {
    try {
      await this.#store.put(this.#name, JSON.stringify(this.#checkpoint), { atomic: true });
    } catch (error) {
      this.#logger.warn({ event: 'connector.checkpoint.failed', name: this.#name, err: error });
    }
  }

  // A handler, or the landing of what it answered, failed: kept, told, tried again after `retryTime`.
  #failed(direction, error, retry) {
    if (this.#errors.length >= MAX_ERRORS) this.#errors.shift();
    this.#errors.push(error);
    this.#logger.warn({ event: 'connector.failed', name: this.#name, direction, err: error });
    const message = `Connector ${this.#name}: the ${direction} failed (${error?.message ?? error})`;
    notify(this, this.#logger, 'error', failed(direction, message, error, this.#name));
    if (this.#canceled || retry === null || direction === null) return;
    if (this.#retry[direction] !== null) clearTimeout(this.#retry[direction]);
    this.#retry[direction] = setTimeout(() => {
      this.#retry[direction] = null;
      if (!this.#canceled) retry();
    }, this.#retryTime);
    this.#retry[direction].unref?.();
  }

  // -------------------------------------------------------------------------
  // Pull

  // Every page the backend has since the checkpoint, applied and the checkpoint moved, until a page comes short.
  #pullAll() {
    if (this.#pulling !== null) return this.#pulling;
    this.#pulling = this.#pullPages().finally(() => {
      this.#pulling = null;
      this.#settle();
    });
    return this.#pulling;
  }

  async #pullPages() {
    let stalls = 0;
    for (;;) {
      if (this.#canceled) return;
      let page;
      try {
        page = await this.#pull.handler(this.#checkpoint.pull, this.#batchSize);
        this.#stats.pulls++;
      } catch (error) {
        this.#failed('pull', error, () => this.#pullAll());
        return;
      }
      if (!isPlainObject(page) || !Array.isArray(page.documents)) {
        this.#failed('pull', new TypeError('pull.handler must answer { documents, checkpoint }'), null);
        return;
      }
      // The page landed and the checkpoint moved past it, or neither: a landing that fails whole (the engine, the
      // database closing under it) is the pull's failure — told, tried again from the checkpoint as it stands.
      try {
        const moved = !same(page.checkpoint ?? null, this.#checkpoint.pull);
        await this.#land(page.documents);
        this.#checkpoint.pull = page.checkpoint ?? null;
        await this.#save();
        if (page.documents.length < this.#batchSize) return;
        // A full page at a position that does not move: asked a few times more, then left to the stream.
        if (moved) stalls = 0;
        else if (++stalls >= MAX_STALLS) return;
      } catch (error) {
        this.#failed('pull', error, () => this.#pullAll());
        return;
      }
    }
  }

  // A document, a row, that cannot land here or go to the backend: said once (`refused`, with the direction and
  // why), counted, and left out — the rest of its page is not held up by it.
  #refuse(direction, id, reason, cause) {
    this.#stats.refused++;
    this.#logger.warn({ event: 'connector.document.refused', name: this.#name, direction, id, reason, err: cause });
    notify(this, this.#logger, 'refused', { direction, id, reason, cause });
  }

  // The backend's documents, landed as this node's writes — one transaction a page, under the connector's source so
  // its own listener passes them — a document that reads as the record already does left alone. A document is
  // judged before the transaction (no document at all, a value that is no JSON, another collection's record, a
  // sealed one, a modifier that throws) and inside it (a validator's no, a field the engine refuses): one refused
  // is said and left out, the rest of the page lands and the checkpoint moves.
  async #land(documents) {
    const docs = [];
    const refusals = [];
    const modify = this.#modifier.pull;
    for (let i = 0; i < documents.length; i++) {
      const doc = documentOf(documents[i]);
      if (doc === null) {
        this.#logger.warn({ event: 'connector.document.malformed', name: this.#name, index: i, id: documents[i]?.id });
        continue;
      }
      const { id } = doc;
      const row = this.#seam.row(id);
      if (row !== null && row.type !== this.#collection) {
        refusals.push([id, 'collection']);
        continue;
      }
      if (row?.encrypted === true) {
        refusals.push([id, 'sealed']);
        continue;
      }
      if (!isJson(doc.data)) {
        refusals.push([id, 'value']);
        continue;
      }
      if (!doc.deleted && modify !== null) {
        try {
          doc.data = modify(doc.data, id);
        } catch (error) {
          refusals.push([id, 'modifier', error]);
          continue;
        }
        if (!isPlainObject(doc.data)) {
          refusals.push([id, 'modifier']);
          continue;
        }
      }
      docs.push(doc);
    }
    this.#stats.pulled += documents.length;
    const collection = this.#collection;
    let applied = 0;
    if (docs.length > 0) {
      await this.#db.transact(
        async (tx) => {
          for (let i = 0; i < docs.length; i++) {
            const { id, deleted, data } = docs[i];
            try {
              const local = await tx.get(id);
              if (deleted) {
                this.#assumed.set(id, null);
                if (local === null) continue;
                await tx.delete(id);
              } else {
                this.#assumed.set(id, data);
                if (local !== null && same(plain(local), plain(data))) continue;
                await tx.set(id, { ...data, $type: collection });
              }
              applied++;
            } catch (error) {
              refusals.push([id, error?.code ?? error?.name ?? 'error', error]);
            }
          }
        },
        { source: this.#source, actor: this.#actor },
      );
    }
    for (let i = 0; i < refusals.length; i++) this.#refuse('pull', refusals[i][0], refusals[i][1], refusals[i][2]);
    if (docs.length === 0) return;
    this.#stats.applied += applied;
    notify(this, this.#logger, 'received', { documents: docs.length, applied });
  }

  // The live half of the pull: the backend's stream where it has one, a pull every `retryTime` otherwise.
  #follow() {
    if (this.#canceled || !this.#live) return;
    if (typeof this.#pull.stream === 'function') {
      try {
        const stop = this.#pull.stream((signal) => this.#streamed(signal));
        this.#stream = typeof stop === 'function' ? stop : NOOP;
      } catch (error) {
        this.#failed('pull', error, () => this.#follow());
      }
      return;
    }
    this.#timer = setInterval(() => {
      this.#pullAll().catch(NOOP);
    }, this.#retryTime);
    this.#timer.unref?.();
  }

  #stopFollowing() {
    if (this.#stream !== null) {
      try {
        this.#stream();
      } catch (error) {
        this.#logger.warn({ event: 'connector.stream.stop', name: this.#name, err: error });
      }
      this.#stream = null;
    }
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  // What the backend's stream tells: a page of documents with the position after them, or `RESYNC` — pull again.
  #streamed(signal) {
    if (this.#canceled) return;
    if (signal === 'RESYNC') return void this.#pullAll().catch(NOOP);
    if (!isPlainObject(signal) || !Array.isArray(signal.documents)) {
      this.#logger.warn({ event: 'connector.stream.malformed', name: this.#name });
      return;
    }
    // In order, behind a pull in flight.
    const run = async () => {
      await this.#land(signal.documents);
      if (signal.checkpoint !== undefined) {
        this.#checkpoint.pull = signal.checkpoint;
        await this.#save();
      }
    };
    this.#pulling = (this.#pulling ?? Promise.resolve())
      .then(run)
      .catch((error) => this.#failed('pull', error, null))
      .finally(() => {
        this.#pulling = null;
        this.#settle();
      });
  }

  // -------------------------------------------------------------------------
  // Push

  // A turn of the database: the records of the collection it changed go to the backend — every turn but this
  // connector's own pulls (the backend has those already).
  #heard(event) {
    if (this.#canceled || this.#push === null || event.source === this.#source) return;
    const { changes } = event;
    let any = false;
    for (let i = 0; i < changes.length; i++) {
      const { id } = changes[i];
      const row = this.#seam.row(id);
      const type = row?.type ?? changes[i].type ?? null;
      // A sealed record is the key holder's: it never goes to a backend.
      if (type !== this.#collection || row?.encrypted === true || this.#pending.has(id)) continue;
      this.#pending.add(id);
      any = true;
    }
    if (any) this.#flush();
  }

  // What the log holds of the collection since the position pushed through; every record once where it cannot.
  async #pushSince() {
    const pushed = this.#checkpoint.pushed;
    const entries = pushed === null ? null : this.#db.log.since(pushed);
    if (entries === null) {
      const ids = this.#seam.ids(this.#collection);
      this.#logger.info({ event: 'connector.rebuild', name: this.#name, records: ids.length });
      for (let i = 0; i < ids.length; i++) {
        // A sealed record never goes; a record that reads as the backend was just seen to hold it (pulled,
        // unchanged) has nothing to push.
        if (this.#seam.row(ids[i])?.encrypted === true) continue;
        const assumed = this.#assumed.get(ids[i]);
        if (assumed !== undefined && assumed !== null && same(plain(await this.#db.get(ids[i])), plain(assumed))) {
          continue;
        }
        this.#pending.add(ids[i]);
      }
    } else {
      for (let i = 0; i < entries.length; i++) {
        const { op } = entries[i];
        // This connector's own writes — what it pulled, what a conflict set — are the backend's already.
        if (op.actor === this.#actor) continue;
        if (typeof op.id !== 'string') continue;
        const row = this.#seam.row(op.id);
        if (row === null || row.type !== this.#collection || row.encrypted === true) continue;
        this.#pending.add(op.id);
      }
    }
    if (this.#pending.size === 0) {
      this.#checkpoint.pushed = this.#db.log.lastEventId;
      await this.#save();
      return;
    }
    await this.#flush();
  }

  // One push at a time; what comes meanwhile goes in the next.
  #flush() {
    if (this.#pushing !== null || this.#push === null) return this.#pushing ?? Promise.resolve();
    this.#pushing = this.#pushPending().finally(() => {
      this.#pushing = null;
      this.#settle();
      if (this.#pending.size > 0 && !this.#canceled && this.#retry.push === null) this.#flush();
    });
    return this.#pushing;
  }

  async #pushPending() {
    while (this.#pending.size > 0 && !this.#canceled) {
      // Everything appended before the rows were read is covered by this push: what lands after is its own turn.
      const eventId = this.#db.log.lastEventId;
      const ids = [];
      for (const id of this.#pending) {
        ids.push(id);
        if (ids.length >= this.#batchSize) break;
      }
      const rows = [];
      for (let i = 0; i < ids.length; i++) rows.push(await this.#rowOf(ids[i]));
      let conflicts;
      try {
        conflicts = await this.#push.handler(rows);
        this.#stats.pushes++;
      } catch (error) {
        this.#failed('push', error, () => this.#flush());
        return;
      }
      for (let i = 0; i < ids.length; i++) this.#pending.delete(ids[i]);
      for (let i = 0; i < rows.length; i++) this.#assumed.set(rows[i].id, rows[i].deleted ? null : rows[i].data);
      this.#stats.pushed += rows.length;
      notify(this, this.#logger, 'sent', { rows: rows.length });
      if (Array.isArray(conflicts) && conflicts.length > 0) await this.#conflicted(conflicts, new Set(ids));
      this.#checkpoint.pushed = eventId;
      await this.#save();
    }
  }

  // A record as the backend is to hold it: its data (modified for the backend), or deleted; and what the backend
  // was last known to hold of it.
  async #rowOf(id) {
    const data = await this.#db.get(id);
    const row = { id, data: null, deleted: data === null, assumed: this.#assumed.get(id) ?? null };
    if (data !== null) {
      const stripped = plain(data);
      row.data = this.#modifier.push === null ? stripped : this.#modifier.push(stripped, id);
    }
    return row;
  }

  // Rows the backend refused: each as the backend holds it. The backend wins — the record is set to its state here
  // (a turn of its own, so a resolution that differs goes back to the backend) — unless `resolve` says otherwise.
  // An answer for a row the push did not carry is no conflict of this node's: said, left alone.
  async #conflicted(conflicts, ids) {
    const docs = [];
    for (let i = 0; i < conflicts.length; i++) {
      const remote = documentOf(conflicts[i]);
      if (remote === null) {
        this.#logger.warn({ event: 'connector.document.malformed', name: this.#name, index: i, id: conflicts[i]?.id });
        continue;
      }
      if (!ids.has(remote.id)) {
        this.#logger.warn({ event: 'connector.conflict.unexpected', name: this.#name, id: remote.id });
        continue;
      }
      this.#stats.conflicts++;
      let local = null;
      try {
        local = await this.#db.get(remote.id);
      } catch {
        local = null;
      }
      let resolved = remote.deleted ? null : remote.data;
      let deleted = remote.deleted;
      if (this.#resolve !== null) {
        const answer = await this.#resolve({
          id: remote.id,
          local: plain(local),
          remote: remote.data,
          deleted: remote.deleted,
        });
        if (answer === null) deleted = true;
        else if (isPlainObject(answer)) {
          resolved = answer;
          deleted = false;
        }
      }
      notify(this, this.#logger, 'conflict', {
        id: remote.id,
        local: plain(local),
        remote: remote.data,
        deleted: remote.deleted,
        resolved,
      });
      // The backend's state is what the next push assumes.
      this.#assumed.set(remote.id, remote.deleted ? null : remote.data);
      docs.push({ id: remote.id, data: resolved, deleted });
    }
    if (docs.length === 0) return;
    // Landed under another source than a pull's: a resolution that differs from the backend's state is a turn this
    // connector hears, and goes back to the backend with the backend's state as what it assumed.
    const resolving = `${this.#source}:resolve`;
    const refusals = [];
    await this.#db.transact(
      async (tx) => {
        for (let i = 0; i < docs.length; i++) {
          const { id, data, deleted } = docs[i];
          try {
            const local = await tx.get(id);
            if (deleted) {
              if (local !== null) await tx.delete(id);
              continue;
            }
            if (local !== null && same(plain(local), plain(data))) continue;
            await tx.set(id, { ...data, $type: this.#collection });
          } catch (error) {
            refusals.push([id, error?.code ?? error?.name ?? 'error', error]);
          }
        }
      },
      { source: resolving, actor: this.#actor },
    );
    for (let i = 0; i < refusals.length; i++) this.#refuse('push', refusals[i][0], refusals[i][1], refusals[i][2]);
  }
}

/**
 * A connector over `db`: the collection kept in step with a backend through
 * the `pull` and `push` handlers. Started unless `autoStart: false`.
 */
const replicate = (db, options = {}) => {
  if (!isDatabase(db)) throw new TypeError('replicate() takes a database');
  if (!isPlainObject(options)) throw new TypeError('replicate() takes options');
  const { autoStart = true, ...rest } = options;
  if (typeof autoStart !== 'boolean') throw new TypeError('replicate(): autoStart must be a boolean');
  const replication = new Replication(db, rest);
  if (autoStart) replication.start().catch(NOOP);
  return replication;
};

module.exports = { replicate, Replication };
