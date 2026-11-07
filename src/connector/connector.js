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
//     says what the record should be; or `{ id, error }` for a row refused by
//     name, parked until a turn of the record or `reSync()`.
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
// A handler that fails is told (`error`, REPLICATION_FAILED with the direction
// and `retryIn`) and tried again after a backoff; nothing is skipped. Requires
// symbols.js, engine.js, shape.js, errors.js, hooks.js, emitter.js, same.js only.

const { SOURCE, DB } = require('../symbols.js');
const { kvNamespace } = require('../engine.js');
const { isPlainObject, isRecordId } = require('../shape.js');
const { SyncomError } = require('../errors.js');
const { notify } = require('../hooks.js');
const { Emitter } = require('../emitter.js');
const { canonical, same } = require('./same.js');

const NAMESPACE = 'connector';
const DEFAULT_BATCH = 100;
const DEFAULT_RETRY = 5000;
// The most a retry waits: the backoff doubles from `retryTime` up to it, with jitter (±25 %).
const DEFAULT_MAX_RETRY = 60_000;
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

const failed = (direction, message, cause, name, retryIn = null) =>
  new SyncomError('REPLICATION_FAILED', message, { direction, name, cause, retryIn });

// The canonical text parsed back — the backend's state as a push hands it over as `assumed`.
const parsed = (text) => (text === null ? null : JSON.parse(text));

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
  #maxRetryTime;
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
  // A retry timer per direction: a push that fails must not cancel the pull's try, nor the other way round; the
  // failures in a row per direction, what the backoff doubles by, reset by a success.
  #retry = { pull: null, push: null };
  #attempts = { pull: 0, push: 0 };
  // The ids whose state is to go to the backend, in the order they came, each with the log position BEFORE the
  // turn that made it pending (where a restart resumes the push from; null: the start); the ids of the push in
  // flight, and among them the ones a newer turn touched meanwhile (pending again after it, from that turn's
  // position); the ids the backend refused by name, set aside until a turn of theirs or `reSync()`.
  #pending = new Map();
  #inflight = new Set();
  #redo = new Map();
  #parked = new Set();
  // The ids of the push in flight whose rows the backend answered as conflicts: they stay pending for the next round.
  #conflicted = new Set();
  // Per id, the backend's state a conflict answered while the row assumed exactly it (the same data under a new
  // revision heals in a round); answered so twice in a row, the backend contradicts itself and the row is parked.
  #contradicted = new Map();
  // The newest turn heard: the position the next pending id is pending since.
  #last = null;
  // The push in flight; the pull in flight.
  #pushing = null;
  #pulling = null;
  // One judgement at a time: a page landing and a push (the rows read, the answer judged, the conflicts landed) take
  // turns, so neither judges a record against a state the other is changing under it.
  #turn = Promise.resolve();
  // The backend's state of each record as this node last knew it, as the canonical text of the backend's shape
  // (null: it holds nothing) — what a push says it assumed, what a pull is judged against.
  #known = new Map();
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
      maxRetryTime = DEFAULT_MAX_RETRY,
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
    if (!Number.isFinite(maxRetryTime) || maxRetryTime < retryTime) {
      throw new TypeError('replicate(): maxRetryTime must be a number of at least retryTime');
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
    this.#maxRetryTime = maxRetryTime;
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

  /** The counts: documents pulled and applied, rows pushed, conflicts met, refused, pulls and pushes made, pending, parked. */
  stats() {
    return {
      ...this.#stats,
      pending: this.#pending.size,
      parked: this.#parked.size,
      active: this.#active,
      canceled: this.#canceled,
    };
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
    // Listened to before the log is read: a turn landing between the two is in `log.since` or is heard.
    this.#listener = (event) => this.#heard(event);
    this.#db.on('transaction', this.#listener);
    this.#last = this.#db.log.lastEventId;
    try {
      // The backend first: what it holds is what a push then assumes (a fresh connector knows nothing of it), and
      // what the pull landed is the backend's already — the push since skips the connector's own writes.
      if (this.#pull !== null) await this.#pullAll();
      if (this.#push !== null) {
        this.#collectPending();
        await this.#flush();
      }
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
    if (this.#push === null) return;
    // The rows the backend refused by name are tried again, with what the log holds since `pushed`.
    for (const id of this.#parked) this.#pending.set(id, this.#last);
    this.#parked.clear();
    this.#collectPending();
    await this.#flush();
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

  // A handler, or the landing of what it answered, failed: kept, told (`retryIn`: the wait before the retry, null
  // for none), tried again after a backoff — `retryTime` doubled per failure in a row up to `maxRetryTime`, with
  // ±25 % of jitter, reset by the direction's next success.
  #failed(direction, error, retry) {
    if (this.#errors.length >= MAX_ERRORS) this.#errors.shift();
    this.#errors.push(error);
    let retryIn = null;
    if (!this.#canceled && retry !== null && direction !== null) {
      const doubled = this.#retryTime * 2 ** this.#attempts[direction]++;
      retryIn = Math.round(Math.min(doubled, this.#maxRetryTime) * (0.75 + Math.random() / 2));
    }
    this.#logger.warn({ event: 'connector.failed', name: this.#name, direction, retryIn, err: error });
    const message = `Connector ${this.#name}: the ${direction} failed (${error?.message ?? error})`;
    notify(this, this.#logger, 'error', failed(direction, message, error, this.#name, retryIn));
    if (retryIn === null) return;
    if (this.#retry[direction] !== null) clearTimeout(this.#retry[direction]);
    this.#retry[direction] = setTimeout(() => {
      this.#retry[direction] = null;
      if (!this.#canceled) retry();
    }, retryIn);
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
        this.#attempts.pull = 0;
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

  // `task` run after the judgement in flight, if any, and before the next.
  #exclusive(task) {
    const run = this.#turn.then(task);
    this.#turn = run.catch(NOOP);
    return run;
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
      // What the backend holds, in its own shape — before the modifier: what a push compares against.
      doc.text = doc.deleted ? null : canonical(doc.data);
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
    const conflicts = [];
    let applied = 0;
    if (docs.length > 0) {
      // Each document against what the backend was known to hold and whether an edit of the record waits to go:
      // (1) the state known already is an echo — nothing to learn, and over a pending edit nothing to write: the
      // edit is compared against it by the push — unless the record reads otherwise with no edit pending (a landing
      // that never happened), which lands; (2) another state over a pending edit is a conflict — the backend moved
      // under the edit: `resolve` or the backend wins, landed here under the resolve actor, told; (3) another state
      // over a record with nothing pending is the backend's newer state: landed unless the record reads so already.
      await this.#exclusive(() =>
        this.#db.transact(
          async (tx) => {
            for (let i = 0; i < docs.length; i++) {
              const { id, deleted, data, text } = docs[i];
              try {
                const local = await tx.get(id);
                const pending = this.#pending.has(id);
                const echo = this.#assumedText(id, text);
                if (
                  echo &&
                  (pending || (deleted ? local === null : local !== null && same(plain(local), plain(data))))
                ) {
                  continue;
                }
                if (!echo && pending) {
                  const decided = await this.#decide(id, plain(local), { data, deleted });
                  this.#learn(id, text);
                  await this.#landResolution(tx, decided);
                  conflicts.push(decided.event);
                  continue;
                }
                this.#learn(id, text);
                if (deleted) {
                  if (local === null) continue;
                  await tx.delete(id);
                } else {
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
        ),
      );
    }
    for (let i = 0; i < refusals.length; i++) this.#refuse('pull', refusals[i][0], refusals[i][1], refusals[i][2]);
    for (let i = 0; i < conflicts.length; i++) notify(this, this.#logger, 'conflict', conflicts[i]);
    if (docs.length === 0) return;
    this.#stats.applied += applied;
    notify(this, this.#logger, 'received', { documents: docs.length, applied });
  }

  // Whether `text` is the backend's state as this node knows it.
  #assumedText(id, text) {
    return this.#known.has(id) && this.#known.get(id) === text;
  }

  // A conflict decided: the document as the backend holds it (`remote`, its shape — through `modifier.pull` for the
  // application) against the record here (`local`, plain). The backend wins — unless `resolve` answers the data to
  // keep or `null` to delete; a `resolve` that throws is said and the backend wins. Answers what to land and the
  // `conflict` event to tell once it has.
  async #decide(id, local, remote) {
    let remoteData = remote.deleted ? null : remote.data;
    if (remoteData !== null && this.#modifier.pull !== null) remoteData = this.#modifier.pull(remoteData, id);
    let resolved = remoteData;
    let deleted = remote.deleted;
    if (this.#resolve !== null) {
      try {
        const answer = await this.#resolve({ id, local, remote: remoteData, deleted: remote.deleted });
        if (answer === null) {
          resolved = null;
          deleted = true;
        } else if (isPlainObject(answer)) {
          resolved = answer;
          deleted = false;
        }
      } catch (error) {
        this.#logger.warn({ event: 'connector.resolve.failed', name: this.#name, id, err: error });
      }
    }
    this.#stats.conflicts++;
    return { id, data: resolved, deleted, event: { id, local, remote: remoteData, deleted: remote.deleted, resolved } };
  }

  // A resolution landed through `tx` under the resolve actor (what a restart's `log.since` keeps, unlike a pull's
  // writes): a deletion, or the data unless the record reads so already.
  async #landResolution(tx, { id, data, deleted }) {
    const actor = `${this.#actor}:resolve`;
    const local = await tx.get(id);
    if (deleted) {
      if (local !== null) await tx.delete(id, { actor });
      return;
    }
    if (local !== null && same(plain(local), plain(data))) return;
    await tx.set(id, { ...data, $type: this.#collection }, { actor });
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

  // The backend's state of a record as this node knows it now: `text` the canonical JSON of the backend's shape,
  // null for nothing held.
  #learn(id, text) {
    this.#known.set(id, text);
  }

  // What a push says it assumed of a record: the backend's state as known, null for a record never seen.
  #assumedOf(id) {
    return this.#known.has(id) ? parsed(this.#known.get(id)) : null;
  }

  // A turn of the database: the records of the collection it changed go to the backend — every turn but this
  // connector's own pulls (the backend has those already). The turn before it (`#last`) is the position the ids are
  // pending since; an id already pending keeps its older one, and one in the push in flight is pending again after
  // it, from this turn's.
  #heard(event) {
    const since = this.#last;
    if (typeof event.eventId === 'string') this.#last = event.eventId;
    if (this.#canceled || this.#push === null || event.source === this.#source) return;
    const { changes } = event;
    let any = false;
    for (let i = 0; i < changes.length; i++) {
      const { id } = changes[i];
      const row = this.#seam.row(id);
      const type = row?.type ?? changes[i].type ?? null;
      // A sealed record is the key holder's: it never goes to a backend.
      if (type !== this.#collection || row?.encrypted === true) continue;
      if (this.#pending.has(id)) {
        if (this.#inflight.has(id) && !this.#redo.has(id)) this.#redo.set(id, since);
        continue;
      }
      this.#pending.set(id, since);
      this.#parked.delete(id);
      any = true;
    }
    if (any) this.#flush().catch(NOOP);
  }

  // What the log holds of the collection since the position pushed through, pending since that position; every
  // record once where the log cannot resume there (`connector.rebuild`), pending since the start.
  #collectPending() {
    const pushed = this.#checkpoint.pushed;
    const entries = pushed === null ? null : this.#db.log.since(pushed);
    if (entries === null) {
      const ids = this.#seam.ids(this.#collection);
      this.#logger.info({ event: 'connector.rebuild', name: this.#name, records: ids.length });
      this.#checkpoint.pushed = null;
      for (let i = 0; i < ids.length; i++) {
        // A sealed record never goes.
        if (this.#seam.row(ids[i])?.encrypted === true || this.#pending.has(ids[i])) continue;
        this.#pending.set(ids[i], null);
      }
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const { op } = entries[i];
      // This connector's own pulls are the backend's already.
      if (op.actor === this.#actor || typeof op.id !== 'string' || this.#pending.has(op.id)) continue;
      const row = this.#seam.row(op.id);
      if (row === null || row.type !== this.#collection || row.encrypted === true) continue;
      this.#pending.set(op.id, pushed);
    }
  }

  // One push at a time; what comes meanwhile goes in the next. Never rejects: a failure is told and tried again.
  #flush() {
    if (this.#pushing !== null || this.#push === null) return this.#pushing ?? Promise.resolve();
    this.#pushing = this.#pushPending().finally(() => {
      this.#pushing = null;
      this.#settle();
      if (this.#pending.size > 0 && !this.#canceled && this.#retry.push === null) this.#flush().catch(NOOP);
    });
    return this.#pushing;
  }

  // The pending ids, `batchSize` a push: the rows read (one with nothing to say — the backend holds it as assumed —
  // leaves pending without a push), the handler asked, its answer judged (a row accepted is the backend's state now;
  // one refused by name is parked; a conflict is landed, the backend's or `resolve`'s way), then the ids leave
  // pending — a conflicted one stays, for the resolution to go back or to say nothing — and the checkpoint moves.
  // A failure anywhere after the rows were read keeps every row pending, is told and tried again.
  async #pushPending() {
    while (this.#pending.size > 0 && !this.#canceled) {
      // Everything appended before the rows were read is covered by this push: what lands after is its own turn.
      const eventId = this.#db.log.lastEventId;
      const ids = [];
      for (const id of this.#pending.keys()) {
        ids.push(id);
        if (ids.length >= this.#batchSize) break;
      }
      let rows;
      try {
        rows = await this.#exclusive(() => this.#pushBatch(ids));
      } catch (error) {
        this.#inflight.clear();
        this.#redo.clear();
        this.#conflicted.clear();
        this.#failed('push', error, () => this.#flush());
        return;
      }
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const redo = this.#redo.get(id);
        if (redo !== undefined) {
          // A newer turn came while the row was in flight: pending again, from before that turn.
          this.#parked.delete(id);
          this.#pending.delete(id);
          this.#pending.set(id, redo);
        } else if (!this.#conflicted.has(id)) this.#pending.delete(id);
      }
      this.#inflight.clear();
      this.#redo.clear();
      this.#conflicted.clear();
      if (rows.length > 0) notify(this, this.#logger, 'sent', { rows: rows.length });
      this.#checkpoint.pushed = eventId;
      await this.#save();
    }
  }

  // One batch, in its turn: the rows read, the handler asked, the answer judged. Answers the rows pushed.
  async #pushBatch(ids) {
    const { rows, texts } = await this.#rowsOf(ids);
    if (rows.length === 0) return rows;
    for (let i = 0; i < rows.length; i++) this.#inflight.add(rows[i].id);
    const answers = await this.#push.handler(rows);
    this.#stats.pushes++;
    this.#attempts.push = 0;
    await this.#answered(rows, texts, answers);
    this.#stats.pushed += rows.length;
    return rows;
  }

  // The rows of `ids` as the backend is to hold them — the data in the backend's shape (`modifier.push`), or
  // deleted — with what the backend was last known to hold of each (`assumed`); beside them the canonical text of
  // each. A row that reads as the backend is known to hold it has nothing to say and leaves pending here; a
  // `modifier.push` that throws is that row's refusal.
  async #rowsOf(ids) {
    const rows = [];
    const texts = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const data = await this.#db.get(id);
      let out = null;
      if (data !== null) {
        out = plain(data);
        if (this.#modifier.push !== null) {
          try {
            out = this.#modifier.push(out, id);
          } catch (error) {
            this.#pending.delete(id);
            this.#refuse('push', id, 'modifier', error);
            continue;
          }
        }
      }
      const text = out === null ? null : canonical(out);
      if (this.#known.has(id) && this.#known.get(id) === text) {
        this.#pending.delete(id);
        continue;
      }
      rows.push({ id, data: out, deleted: data === null, assumed: this.#assumedOf(id) });
      texts.push(text);
    }
    return { rows, texts };
  }

  // The handler's answer, row by row: a row not answered is the backend's now (learned); `{ id, error }` is a row
  // refused by name — parked; `{ id, data, deleted }` is the document as the backend holds it — a conflict, landed.
  // An answer for a row the push did not carry, or that is no document, is said and left alone.
  async #answered(rows, texts, answers) {
    const byId = new Map();
    const list = Array.isArray(answers) ? answers : [];
    for (let i = 0; i < list.length; i++) {
      const answer = list[i];
      if (!isPlainObject(answer) || !isRecordId(answer.id)) {
        this.#logger.warn({ event: 'connector.document.malformed', name: this.#name, index: i, id: answer?.id });
        continue;
      }
      if (!this.#inflight.has(answer.id)) {
        this.#logger.warn({ event: 'connector.conflict.unexpected', name: this.#name, id: answer.id });
        continue;
      }
      byId.set(answer.id, answer);
    }
    const conflicts = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const answer = byId.get(row.id);
      if (answer === undefined) {
        this.#learn(row.id, texts[i]);
        this.#contradicted.delete(row.id);
        continue;
      }
      if (answer.error !== undefined && answer.error !== null) {
        this.#park(row.id, answer.error);
        continue;
      }
      const remote = documentOf(answer);
      if (remote === null) {
        this.#park(row.id, { code: 'answer', message: 'the handler answered neither a document nor an error' });
        continue;
      }
      // A conflict over a row that assumed exactly what the backend says it holds: once, a revision moved under the
      // same data (tried again with it); twice in a row, a backend contradicting itself — parked, never a loop.
      const text = remote.deleted ? null : canonical(remote.data);
      if (row.assumed !== undefined && this.#known.has(row.id) && this.#known.get(row.id) === text) {
        if (this.#contradicted.get(row.id) === text) {
          this.#contradicted.delete(row.id);
          this.#park(row.id, { code: 'conflict', message: 'the backend refused a row that assumed what it holds' });
          continue;
        }
        this.#contradicted.set(row.id, text);
      } else this.#contradicted.delete(row.id);
      conflicts.push([row, remote, text]);
    }
    if (conflicts.length > 0) await this.#resolveConflicts(conflicts);
  }

  // A row the backend refuses by name (an id it cannot carry, a body too large): set aside — said (`refused`,
  // `direction: 'push'`, the error's code), out of pending — until a turn of the record or `reSync()` tries it again.
  #park(id, error) {
    this.#pending.delete(id);
    this.#parked.add(id);
    this.#refuse('push', id, error?.code ?? 'backend', error);
  }

  // Rows the backend refused as conflicts, each with the document as the backend holds it. The backend's state is
  // what the next push assumes; the backend wins — the record is set to its state here — unless `resolve` says
  // otherwise (a `resolve` that throws is said and the backend wins). The landing is one transaction under
  // `source: connector:<name>:resolve` — a turn this connector hears — row by row: a resolution the engine refuses
  // is said (`refused`, `direction: 'push'`) and the record stands. The ids stay pending: a resolution equal to
  // the backend's state has nothing to say, another goes back with the backend's state assumed.
  async #resolveConflicts(conflicts) {
    const decided = [];
    for (let i = 0; i < conflicts.length; i++) {
      const [row, remote] = conflicts[i];
      let local = null;
      try {
        local = plain(await this.#db.get(row.id));
      } catch {
        local = null;
      }
      try {
        decided.push(await this.#decide(row.id, local, remote));
      } catch (error) {
        // `modifier.pull` threw over the backend's state: the row cannot be judged — parked, said.
        this.#park(row.id, { code: 'modifier', message: error?.message ?? String(error) });
        conflicts[i] = null;
      }
    }
    const refusals = [];
    await this.#db.transact(
      async (tx) => {
        for (let i = 0; i < decided.length; i++) {
          try {
            await this.#landResolution(tx, decided[i]);
          } catch (error) {
            refusals.push([decided[i].id, error?.code ?? error?.name ?? 'error', error]);
          }
        }
      },
      { source: `${this.#source}:resolve`, actor: this.#actor },
    );
    // Landed: the backend's state is what the next push assumes, the ids stay pending for it. A landing that failed
    // whole learned nothing — the rows go again with what they assumed, and the backend answers the conflict again.
    for (let i = 0; i < conflicts.length; i++) {
      if (conflicts[i] === null) continue;
      const [row, , text] = conflicts[i];
      this.#conflicted.add(row.id);
      this.#learn(row.id, text);
    }
    for (let i = 0; i < refusals.length; i++) this.#refuse('push', refusals[i][0], refusals[i][1], refusals[i][2]);
    for (let i = 0; i < decided.length; i++) notify(this, this.#logger, 'conflict', decided[i].event);
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
