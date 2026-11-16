'use strict';

// Connectors (@alexify/syncom/connector): one collection kept in step with a
// backend of its own — a CouchDB, a GraphQL endpoint, a Firestore, a
// Postgres behind Supabase, a MongoDB, a file in a drive — through two
// handlers the application (or an adapter beside this module) writes:
//
//   pull.handler(checkpoint, batchSize) → { documents: [{ id, data, deleted }], checkpoint }
//     the backend's documents changed since `checkpoint`, a page at a time, and
//     the position after them; `pull.stream(emit, { checkpoint })` → stop, when
//     the backend tells of changes: `emit({ documents })` (landed; the
//     checkpoint moves with the pulls alone), `emit('RESYNC')` to pull again
//     from the checkpoint, `emit('END')` when the stream is over (followed
//     again after a backoff).
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
// cannot land (another collection's record, a sealed one, no JSON after
// `modifier.pull`, a validator's no) is refused by name (`refused`) and the
// rest of the page lands. What goes out follows
// the `transaction` events of the collection — every turn but a pull of this
// connector's — pages of `batchSize` rows, in order, one push in flight. The
// checkpoint text (`{ pull, pushed, known, refused, parked }`: the backend's
// position, this node's log position pushed through — a frontier before the
// oldest pending turn — the digest of the backend's state per record, the
// ids whose state the database refused to land, never learned, and the ids
// of the rows parked, each with why) lives in the `connector` kv namespace
// under the name: a restart pulls from `pull` and pushes what the log holds
// since `pushed` — a record known by digest alone as a probe — or every
// record of the collection once where the log cannot resume; a parked row
// stays parked across it.
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
// With a stream, a pull from the checkpoint this often anyway — a stream that went quiet without saying END (0: none).
const DEFAULT_SAFETY = 60_000;
// How many of the handlers' errors are kept (the newest).
const MAX_ERRORS = 20;
// The checkpoint text is written at most this often while pages keep landing (one write in flight, the next after
// the gap); the end of a pull run, a push, a stream page and cancel() write at once.
const SAVE_GAP = 200;
// How much of the SHA-256 (base64url) names the backend's state of a record in the checkpoint text: 132 bits.
const DIGEST_LENGTH = 22;
// How many records' backend state is kept as text in memory (what a push hands over as `assumed`); past it the
// oldest not pending is forgotten — its digest stays, and a push of it asks the backend first (a probe).
const KNOWN_MAX = 10_000;
// A pull whose checkpoint does not move while it answers full pages is asked this many times, then left.
const MAX_STALLS = 3;
// How much of a parked row's reason the checkpoint keeps.
const REASON_MAX = 64;
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
// Timestamp or a reference of a backend's SDK left in what `modifier.pull` answers (or in the document, without one)
// is refused (`reason: 'value'`) — never flattened into a record and written back as a string.
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

// The canonical text of a backend's document — its state as this node knows it, in the backend's shape, before
// `modifier.pull`: null for a deletion. A value JSON has no text for (a BigInt) throws: the document is refused.
const textOf = (doc) => (doc.deleted ? null : canonical(doc.data));

const failed = (direction, message, cause, name, retryIn = null) =>
  new SyncomError('REPLICATION_FAILED', message, { direction, connector: name, cause, retryIn });

// The canonical text parsed back — the backend's state as a push hands it over as `assumed`.
const parsed = (text) => (text === null ? null : JSON.parse(text));

// Why a row is parked, as it is kept and listed: the reason's text (`backend` for one that has none), bounded.
const reasonOf = (reason) => {
  const text = typeof reason === 'string' ? reason : typeof reason === 'number' ? String(reason) : 'backend';
  return text.length > REASON_MAX ? text.slice(0, REASON_MAX) : text;
};

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
  #safetyTime;
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
  // The initial replication: the first pull run through and the first push drained — each on success alone.
  #initialPull = false;
  #initialPush = false;
  #listener = null;
  #closing = null;
  // The live half: the stream's stop, whether it is followed now, the pull timer without a stream, the safety pull
  // timer with one.
  #stream = null;
  #following = false;
  #timer = null;
  #safety = null;
  // A retry timer per direction: a push that fails must not cancel the pull's try, nor the other way round; the
  // failures in a row per direction, what the backoff doubles by, reset by a success.
  #retry = { pull: null, push: null };
  #attempts = { pull: 0, push: 0 };
  // The ids whose state is to go to the backend, in the order they came, each with the log position BEFORE the
  // turn that made it pending (where a restart resumes the push from; null: the start); the ids of the push in
  // flight, and among them the ones a newer turn touched meanwhile (pending again after it, from that turn's
  // position); the ids the backend refused by name (or whose resolution the database refused), each with why, set
  // aside until a turn of theirs or `reSync()` — saved with the checkpoint: its turn is behind `pushed`, so nothing
  // the log holds remembers one. `reSync()` makes a parked id pending again WITHOUT taking it out (the retry's
  // position names no turn of its record): it leaves when the backend takes the row or the row has nothing to say,
  // when the backend's state lands over the record, or when a turn of the record makes it pending by the log.
  #pending = new Map();
  #inflight = new Set();
  #redo = new Map();
  #parked = new Map();
  // The ids of the push in flight whose rows the backend answered as conflicts: they stay pending for the next round.
  #conflicted = new Set();
  // Per id, the backend's state a conflict answered while the row assumed exactly it (the same data under a new
  // revision heals in a round); answered so twice in a row, the backend contradicts itself and the row is parked.
  #contradicted = new Map();
  // The newest turn heard: the position the next pending id is pending since.
  #last = null;
  // The push in flight; the pull run in flight, and whether a RESYNC came while it ran (it runs once more).
  #pushing = null;
  #pulling = null;
  #stale = false;
  // One queue for everything the pull side lands — the pages of a run, the pages of the stream — in order; how many
  // wait or run on it.
  #queue = Promise.resolve();
  #queued = 0;
  // One judgement at a time: a page landing and a push (the rows read, the answer judged, the conflicts landed) take
  // turns, so neither judges a record against a state the other is changing under it.
  #turn = Promise.resolve();
  // The backend's state of each record as this node last knew it, as the canonical text of the backend's shape
  // (null: it holds nothing) — what a push says it assumed, what a pull is judged against; at most KNOWN_MAX, the
  // oldest not pending forgotten first. Durably, the digest of that text per id (`#digests`, saved with the
  // checkpoint): a restart judges a pulled document by it, and a push of a record whose text is not in memory asks
  // the backend what it holds (`assumed: undefined`, a probe — `#probing` the ids a rebuild asks about).
  #known = new Map();
  #digests = new Map();
  #probing = new Set();
  // The ids whose backend state the database refused to land (a validator's no, a field, no JSON): never learned —
  // nobody wins. A local edit of one goes with the state known assumed (a conflict `resolve` decides), `reSync()`
  // asks the backend for it again (`#reask`), and it is saved with the checkpoint (`refused`).
  #unlanded = new Set();
  // The checkpoint text's save in flight, whether it is behind what is held, whether the next write is wanted at
  // once, and what wakes a gap early.
  #saving = null;
  #dirty = false;
  #hurried = false;
  #wake = null;
  #errors = [];
  #waiters = new Set();
  #stats = { pulled: 0, applied: 0, pushed: 0, probed: 0, conflicts: 0, refused: 0, pulls: 0, pushes: 0 };

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
      safetyTime = DEFAULT_SAFETY,
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
    if (!Number.isFinite(safetyTime) || safetyTime < 0) {
      throw new TypeError('replicate(): safetyTime must be a non-negative number');
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
    this.#safetyTime = safetyTime;
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

  /** The rows set aside until a turn of theirs or `reSync()`, each with why: across a restart too. */
  get parked() {
    const rows = [];
    for (const [id, reason] of this.#parked) if (!this.#pending.has(id)) rows.push({ id, reason });
    return rows;
  }

  // What the connector counts through the seam's writer (the disabled one without the telemetry plugin), by direction.
  #count(direction, result, count = 1) {
    this.#seam.otel.recordConnector(direction, result, count);
  }

  /** The counts: documents pulled and applied, rows pushed and probed, conflicts met, refused, pulls and pushes made, pending, parked. */
  stats() {
    // A parked row `reSync()` is trying again counts as pending alone.
    let parked = 0;
    for (const id of this.#parked.keys()) if (!this.#pending.has(id)) parked++;
    return {
      ...this.#stats,
      pending: this.#pending.size,
      parked,
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
    // Listened to before the log is read: a turn landing between the two is in `log.since` or is heard. The
    // database's close cancels the connector: no timer, no stream, no handler called after it.
    this.#listener = (event) => this.#heard(event);
    this.#db.on('transaction', this.#listener);
    this.#closing = () => this.cancel().catch(NOOP);
    this.#db.on('close', this.#closing);
    this.#last = this.#db.log.lastEventId;
    if (this.#pull === null) this.#initialPull = true;
    if (this.#push === null) this.#initialPush = true;
    // What waits to go is known BEFORE the backend is pulled: a backend that moved under an offline edit is then a
    // conflict of the pull, not a silent landing over the edit. The backend first: what it holds is what a push
    // then assumes, and what the pull landed is the backend's already. The initial replication is done when both
    // have succeeded once — a first pull or push that fails is tried again, and `awaitInitialReplication()` waits.
    if (this.#push !== null) this.#collectPending();
    if (this.#pull !== null) await this.#pullAll();
    if (this.#push !== null) await this.#flush();
  }

  /** Stops for good: the collection no longer followed, the backend's stream closed, what is in flight finished. */
  async cancel() {
    if (this.#canceled) return;
    this.#canceled = true;
    this.#active = false;
    if (this.#listener !== null) this.#db.off('transaction', this.#listener);
    this.#listener = null;
    if (this.#closing !== null) this.#db.off('close', this.#closing);
    this.#closing = null;
    this.#stopFollowing();
    for (const direction of ['pull', 'push']) {
      if (this.#retry[direction] !== null) clearTimeout(this.#retry[direction]);
      this.#retry[direction] = null;
    }
    await Promise.allSettled([this.#pushing, this.#queue]);
    await this.#flushSave();
    for (const waiter of this.#waiters) {
      waiter.reject(failed(null, `Connector ${this.#name} was canceled`, null, this.#name));
    }
    this.#waiters.clear();
    notify(this, this.#logger, 'active', false);
  }

  /**
   * Asks the backend again about the documents the database refused, pulls again from the checkpoint, and pushes what
   * the collection holds since `pushed` — a backend that lost a change.
   */
  async reSync() {
    if (!this.#active) {
      throw new SyncomError('REPLICATION_FAILED', `Connector ${this.#name} is not active`, {
        direction: null,
        name: this.#name,
      });
    }
    // Behind a pull in flight: a pull again, from the checkpoint as it then stands.
    if (this.#pulling !== null) await this.#pulling.catch(NOOP);
    // The documents the database refused, asked for again — before the pull, so one refused again is told once.
    if (this.#push !== null && this.#unlanded.size > 0) await this.#reask();
    if (this.#pull !== null) await this.#pullAll();
    if (this.#canceled) return;
    if (this.#push === null) return;
    // The parked rows (refused by name, or a resolution the database refused) are tried again, with what the log holds
    // since `pushed`.
    this.#retryParked();
    this.#collectPending();
    await this.#flush();
  }

  /** Resolves once the initial pull and push are done — what a reader waits for before it trusts the collection. */
  awaitInitialReplication({ signal = null } = {}) {
    return this.#await(() => this.#initialPull && this.#initialPush, signal);
  }

  /** Resolves once nothing waits to go to the backend and nothing is in flight either way. */
  awaitInSync({ signal = null } = {}) {
    return this.#await(
      () =>
        this.#initialPull &&
        this.#initialPush &&
        this.#pending.size === 0 &&
        this.#pushing === null &&
        this.#queued === 0,
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

  // The checkpoint text from the kv — `{ pull, pushed, known: { id: digest | null }, refused: [id], parked: { id:
  // reason } }`: the backend's position pulled through, this node's log position pushed through, per record the
  // digest of the backend's state as last known (null: it holds nothing), the ids whose state the database refused
  // to land, and the rows parked with why — one whose id is a sealed record or another collection's by now forgotten
  // here. A text that does not read is said and read as none (a pull from the start, a push of every record).
  async #load() {
    this.#loaded = true;
    let text = null;
    try {
      const read = await this.#store.get(this.#name);
      if (read !== null) text = JSON.parse(read);
    } catch (error) {
      this.#logger.warn({ event: 'connector.checkpoint.unreadable', name: this.#name, err: error });
    }
    if (!isPlainObject(text)) return;
    this.#checkpoint = {
      pull: text.pull === undefined ? null : text.pull,
      pushed: typeof text.pushed === 'string' ? text.pushed : null,
    };
    const refused = Array.isArray(text.refused) ? text.refused : [];
    for (let i = 0; i < refused.length; i++) if (isRecordId(refused[i])) this.#unlanded.add(refused[i]);
    const parked = isPlainObject(text.parked) ? text.parked : {};
    for (const id of Object.keys(parked)) {
      if (!isRecordId(id) || typeof parked[id] !== 'string' || !this.#parkable(id)) continue;
      this.#parked.set(id, reasonOf(parked[id]));
    }
    if (!isPlainObject(text.known)) return;
    for (const id of Object.keys(text.known)) {
      const digest = text.known[id];
      if (!isRecordId(id)) continue;
      if (digest === null || (typeof digest === 'string' && digest.length === DIGEST_LENGTH)) {
        this.#digests.set(id, digest);
      }
    }
  }

  // The checkpoint and the digests saved, coalesced: one write in flight, the next after SAVE_GAP while more lands —
  // `force` (the end of a pull run, a push, a stream page, cancel) writes at once instead. Answers when the text
  // written holds everything as it stood at this call.
  #save(force = false) {
    this.#dirty = true;
    if (force) this.#hurry();
    if (this.#saving === null) this.#saving = this.#saveLoop();
    return this.#saving;
  }

  // What is dirty written at once, where something is; nothing otherwise.
  #flushSave() {
    this.#hurry();
    return this.#saving ?? Promise.resolve();
  }

  #hurry() {
    this.#hurried = true;
    if (this.#wake !== null) this.#wake();
  }

  async #saveLoop() {
    try {
      while (this.#dirty) {
        this.#dirty = false;
        this.#hurried = false;
        await this.#write();
        if (!this.#dirty) break;
        if (!this.#hurried) await this.#gap();
      }
    } finally {
      this.#saving = null;
    }
  }

  #gap() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, SAVE_GAP);
      timer.unref?.();
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }

  async #write() {
    const known = Object.create(null);
    for (const [id, digest] of this.#digests) known[id] = digest;
    const parked = Object.create(null);
    for (const [id, reason] of this.#parked) parked[id] = reason;
    const { pull, pushed } = this.#checkpoint;
    const text = JSON.stringify({ pull, pushed, known, refused: [...this.#unlanded], parked });
    try {
      await this.#store.put(this.#name, text, { atomic: true });
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
    const retryIn = !this.#canceled && retry !== null && direction !== null ? this.#later(direction, retry) : null;
    if (direction !== null) this.#count(direction, 'failed');
    this.#logger.warn({ event: 'connector.failed', name: this.#name, direction, retryIn, err: error });
    const message = `Connector ${this.#name}: the ${direction} failed (${error?.message ?? error})`;
    notify(this, this.#logger, 'error', failed(direction, message, error, this.#name, retryIn));
  }

  // `retry` after the direction's backoff — one timer per direction, the newer call's — answering the wait in ms.
  #later(direction, retry) {
    const doubled = this.#retryTime * 2 ** this.#attempts[direction]++;
    const retryIn = Math.round(Math.min(doubled, this.#maxRetryTime) * (0.75 + Math.random() / 2));
    if (this.#retry[direction] !== null) clearTimeout(this.#retry[direction]);
    this.#retry[direction] = setTimeout(() => {
      this.#retry[direction] = null;
      if (!this.#canceled) retry();
    }, retryIn);
    this.#retry[direction].unref?.();
    return retryIn;
  }

  // -------------------------------------------------------------------------
  // Pull

  // `task` on the pull side's queue: after everything queued before it, before everything after.
  #enqueue(task) {
    this.#queued++;
    const run = this.#queue.then(task).finally(() => {
      this.#queued--;
      if (this.#queued === 0) this.#settle();
    });
    this.#queue = run.catch(NOOP);
    return run;
  }

  // A pull run: every page the backend has since the checkpoint, landed and the checkpoint moved, until a page comes
  // short — on the queue, so the stream's pages and the runs land one after another. A RESYNC (or a timer) while a
  // run is in flight makes it run once more after its pages: a change after the page read is never left waiting
  // for the next signal. Resolves when the run is over, failed or not (a failure is told and tried again).
  #pullAll() {
    if (this.#pulling !== null) {
      this.#stale = true;
      return this.#pulling;
    }
    this.#pulling = this.#enqueue(() => this.#pullRun()).finally(() => {
      this.#pulling = null;
      // A RESYNC that came as the run was ending: a run of its own.
      if (this.#stale && !this.#canceled) this.#pullAll().catch(NOOP);
    });
    return this.#pulling;
  }

  async #pullRun() {
    for (;;) {
      this.#stale = false;
      const through = await this.#pullPages();
      // The run's end writes what its pages left dirty at once.
      await this.#flushSave();
      if (!through || this.#canceled) return;
      if (!this.#initialPull) {
        // The first run through: the initial pull is done, and the live half begins.
        this.#initialPull = true;
        this.#settle();
        this.#follow();
      }
      if (!this.#stale) return;
    }
  }

  // The pages of one run. Answers whether it came to the end; a failure is told, tried again from the checkpoint.
  async #pullPages() {
    let stalls = 0;
    for (;;) {
      if (this.#canceled) return false;
      let page;
      try {
        page = await this.#pull.handler(this.#checkpoint.pull, this.#batchSize);
        this.#stats.pulls++;
        this.#attempts.pull = 0;
      } catch (error) {
        this.#failed('pull', error, () => this.#pullAll());
        return false;
      }
      if (!isPlainObject(page) || !Array.isArray(page.documents)) {
        this.#failed('pull', new TypeError('pull.handler must answer { documents, checkpoint }'), () =>
          this.#pullAll(),
        );
        return false;
      }
      // The page landed and the checkpoint moved past it, or neither: a landing that fails whole (the engine, the
      // database closing under it) is the pull's failure — told, tried again from the checkpoint as it stands.
      try {
        const moved = !same(page.checkpoint ?? null, this.#checkpoint.pull);
        await this.#land(page.documents);
        this.#checkpoint.pull = page.checkpoint ?? null;
        // Saved coalesced behind the pages (the run's end writes at once): a crash between lands the page again.
        this.#save().catch(NOOP);
        if (page.documents.length < this.#batchSize) return true;
        // A full page at a position that does not move: asked a few times more, then left to the stream.
        if (moved) stalls = 0;
        else if (++stalls >= MAX_STALLS) return true;
      } catch (error) {
        this.#failed('pull', error, () => this.#pullAll());
        return false;
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
    this.#count(direction, 'refused');
    this.#logger.warn({ event: 'connector.document.refused', name: this.#name, direction, id, reason, err: cause });
    notify(this, this.#logger, 'refused', { direction, id, reason, cause });
  }

  // The backend's documents, landed as this node's writes — one transaction a page, under the connector's source so
  // its own listener passes them — a document that reads as the record already does left alone. A document is
  // judged before the transaction (no document at all, another collection's record, a sealed one, a value with no
  // JSON text, a modifier that throws, what it answers no JSON) and inside it (a validator's no, a field the engine
  // refuses): one refused is said and left out, the rest of the page lands and the checkpoint moves.
  async #land(documents) {
    const docs = [];
    const refusals = [];
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
      // What the backend holds, in its own shape — before the modifier: what a push compares against; then the
      // application's shape, through the modifier, which must be JSON.
      try {
        doc.text = textOf(doc);
      } catch (error) {
        refusals.push([id, 'value', error]);
        continue;
      }
      const why = this.#shaped(doc);
      if (why !== null) {
        refusals.push([id, why.reason, why.cause]);
        continue;
      }
      docs.push(doc);
    }
    this.#stats.pulled += documents.length;
    this.#count('pull', 'pulled', documents.length);
    const collection = this.#collection;
    const conflicts = [];
    // The backend's states landed, as id and text: learned once the transaction has (one that fails whole, nothing);
    // among them the ids whose record reads as the backend holds it now — what was parked of one is no more.
    const learned = [];
    const settled = [];
    let applied = 0;
    if (docs.length > 0) {
      // Each document against what the backend was known to hold and whether an edit of the record waits to go:
      // (1) the state known already is an echo — nothing to learn, and over a pending edit nothing to write: the
      // edit is compared against it by the push — unless the record reads otherwise with no edit pending (a landing
      // that never happened), which lands; (2) another state over a pending edit is a conflict — the backend moved
      // under the edit: `resolve` or the backend wins, landed here under the resolve actor, told; (3) another state
      // over a record with nothing pending is the backend's newer state: landed unless the record reads so already. A
      // parked row is an edit waiting to go like a pending one — the backend has not taken it: never landed over in
      // silence, by an echo or by a newer state. A state the database refuses to land is not learned (nobody wins:
      // `#unlanded`), and an edit of such a record counts as pending though nothing else remembers it (a restart).
      await this.#exclusive(() =>
        this.#db.transact(
          async (tx) => {
            for (let i = 0; i < docs.length; i++) {
              const { id, deleted, data, text } = docs[i];
              try {
                const local = await tx.get(id);
                const waiting = this.#pending.has(id) || this.#parked.has(id);
                const pending = waiting || (this.#unlanded.has(id) && this.#quiet(id, local) === null);
                const reads = deleted ? local === null : local !== null && same(plain(local), plain(data));
                const echo = this.#assumedText(id, text);
                if (echo && (pending || reads)) {
                  // The backend holds what this node knows: a state refused before is gone from it.
                  this.#unlanded.delete(id);
                  continue;
                }
                if (!echo && pending && !reads) {
                  const decided = await this.#decide(id, plain(local), { data, deleted });
                  await this.#landResolution(tx, decided);
                  learned.push(id, text);
                  conflicts.push(decided.event);
                  // The backend won: the record reads as it holds it.
                  if (decided.event.resolved === decided.event.remote) settled.push(id);
                  continue;
                }
                // The backend's newer state, landed; a pending edit that reads as it has nothing to resolve.
                if (!reads) {
                  if (deleted) await tx.delete(id);
                  else await tx.set(id, { ...data, $type: collection });
                  applied++;
                }
                learned.push(id, text);
                settled.push(id);
              } catch (error) {
                refusals.push([id, error?.code ?? error?.name ?? 'error', error]);
              }
            }
          },
          { source: this.#source, actor: this.#actor },
        ),
      );
    }
    for (let i = 0; i < learned.length; i += 2) this.#learn(learned[i], learned[i + 1]);
    // A row `reSync()` is trying again leaves with its push.
    for (let i = 0; i < settled.length; i++) if (!this.#pending.has(settled[i])) this.#parked.delete(settled[i]);
    for (let i = 0; i < refusals.length; i++) {
      // Not learned: a later edit assumes the state known, `reSync()` asks again. Another collection's record and a
      // sealed one are this node's own: nothing to ask the backend again.
      const reason = refusals[i][1];
      if (reason !== 'collection' && reason !== 'sealed') this.#unlanded.add(refusals[i][0]);
      this.#refuse('pull', refusals[i][0], reason, refusals[i][2]);
    }
    this.#count('pull', 'conflict', conflicts.length);
    for (let i = 0; i < conflicts.length; i++) notify(this, this.#logger, 'conflict', conflicts[i]);
    if (docs.length === 0) return;
    this.#stats.applied += applied;
    this.#count('pull', 'applied', applied);
    notify(this, this.#logger, 'received', { documents: docs.length, applied });
  }

  // Whether `text` is the backend's state as this node knows it: the text in memory, or its digest from the checkpoint.
  #assumedText(id, text) {
    if (this.#known.has(id)) return this.#known.get(id) === text;
    return this.#digests.has(id) && this.#digests.get(id) === this.#digestOf(text);
  }

  // A record as the backend is to hold it: `data` in the backend's shape (`modifier.push`; null for none) and its
  // canonical `text`. A `modifier.push` that throws, throws.
  #outgoing(id, local) {
    let data = plain(local);
    if (data !== null && this.#modifier.push !== null) data = this.#modifier.push(data, id);
    return { data, text: data === null ? null : canonical(data) };
  }

  // The record as the backend is to hold it where it reads as the backend's state as known (knowing nothing, where
  // there is no record); null where it reads otherwise — an edit the backend has not taken (a `modifier.push` that
  // throws counts as one). Asked of an id whose landing was refused, where nothing else remembers the edit.
  #quiet(id, local) {
    let out;
    try {
      out = this.#outgoing(id, local);
    } catch {
      return null;
    }
    const known = this.#known.has(id) || this.#digests.has(id) ? this.#assumedText(id, out.text) : out.text === null;
    return known ? out : null;
  }

  // `reSync()`'s ask about the documents whose landing the database refused, on the pull side's queue: a record
  // still as the backend was last known to hold it is probed — the handler answers what the backend holds, writing
  // nothing — and the answer judged as a pulled document: landed, or refused again; a record edited since is the
  // push's (pending: it goes with the state known assumed, a conflict). A parked or pending id is the push's already.
  #reask() {
    return this.#enqueue(async () => {
      try {
        const ids = [];
        for (const id of this.#unlanded) if (!this.#pending.has(id) && !this.#parked.has(id)) ids.push(id);
        for (let at = 0; at < ids.length && !this.#canceled; at += this.#batchSize) {
          const rows = [];
          for (let i = at; i < ids.length && i < at + this.#batchSize; i++) {
            const local = await this.#db.get(ids[i]);
            const out = this.#quiet(ids[i], local);
            if (out === null) this.#pending.set(ids[i], this.#last);
            else rows.push({ id: ids[i], data: out.data, deleted: local === null, assumed: undefined });
          }
          if (rows.length === 0) continue;
          this.#stats.probed += rows.length;
          this.#count('push', 'probed', rows.length);
          const answers = await this.#exclusive(() => this.#push.handler(rows));
          const docs = [];
          const list = Array.isArray(answers) ? answers : [];
          for (let i = 0; i < list.length; i++) if (isPlainObject(list[i]) && list[i].error == null) docs.push(list[i]);
          await this.#land(docs);
        }
        await this.#save(true);
      } catch (error) {
        this.#failed('pull', error, null);
      }
    });
  }

  // A backend's data in the application's shape: through `modifier.pull` (once), then held to JSON. Answers null, or
  // why it cannot land — `modifier` (it threw or answered no object), `value` (no JSON) — with the cause.
  #shaped(doc) {
    if (doc.deleted) return null;
    if (this.#modifier.pull !== null) {
      try {
        doc.data = this.#modifier.pull(doc.data, doc.id);
      } catch (error) {
        return { reason: 'modifier', cause: error };
      }
      if (!isPlainObject(doc.data)) return { reason: 'modifier', cause: undefined };
    }
    return isJson(doc.data) ? null : { reason: 'value', cause: undefined };
  }

  // A conflict decided: the document as the backend holds it (`remote`, in the application's shape: `#shaped`
  // already) against the record here (`local`, plain). The backend wins — unless `resolve` answers the data to
  // keep or `null` to delete; a `resolve` that throws is said and the backend wins. Answers what to land and the
  // `conflict` event to tell once it has.
  async #decide(id, local, remote) {
    const remoteData = remote.deleted ? null : remote.data;
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
    if (this.#canceled || !this.#live || this.#following || this.#pull === null) return;
    this.#following = true;
    if (typeof this.#pull.stream === 'function') {
      try {
        const stop = this.#pull.stream((signal) => this.#streamed(signal), { checkpoint: this.#checkpoint.pull });
        this.#stream = typeof stop === 'function' ? stop : NOOP;
      } catch (error) {
        this.#following = false;
        this.#failed('pull', error, () => this.#follow());
        return;
      }
      // A stream may go quiet without a word: a pull from the checkpoint every `safetyTime` anyway.
      if (this.#safetyTime > 0) {
        this.#safety = setInterval(() => this.#pullAll().catch(NOOP), this.#safetyTime);
        this.#safety.unref?.();
      }
      return;
    }
    this.#timer = setInterval(() => this.#pullAll().catch(NOOP), this.#retryTime);
    this.#timer.unref?.();
  }

  #stopFollowing() {
    this.#following = false;
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
    if (this.#safety !== null) {
      clearInterval(this.#safety);
      this.#safety = null;
    }
  }

  // What the backend's stream tells: a page of documents, `RESYNC` — pull again from the checkpoint — or `END` — the
  // stream is over (the backend closed it): followed again after the pull's backoff, from the checkpoint as it then
  // stands, and pulled once for what it missed meanwhile.
  #streamed(signal) {
    // A stream stopped (canceled, or ended) may still speak: stale, ignored — an END after our own stop would follow
    // again without end.
    if (this.#canceled || !this.#following) return;
    if (signal === 'RESYNC') return void this.#pullAll().catch(NOOP);
    if (signal === 'END') {
      this.#stopFollowing();
      this.#logger.info({ event: 'connector.stream.ended', name: this.#name });
      this.#later('pull', () => {
        this.#follow();
        this.#pullAll().catch(NOOP);
      });
      return;
    }
    if (!isPlainObject(signal) || !Array.isArray(signal.documents)) {
      this.#logger.warn({ event: 'connector.stream.malformed', name: this.#name });
      return;
    }
    // On the queue, behind the pages before it. The checkpoint stays where the last pull run left it: a page that
    // fails to land is pulled again from there (told, a run after the backoff), never passed over.
    this.#enqueue(async () => {
      if (this.#canceled) return;
      try {
        await this.#land(signal.documents);
        await this.#save(true);
      } catch (error) {
        this.#failed('pull', error, () => this.#pullAll());
      }
    }).catch(NOOP);
  }

  // -------------------------------------------------------------------------
  // Push

  // The backend's state of a record as this node knows it now: `text` the canonical JSON of the backend's shape,
  // null for nothing held — the text in memory (the newest last; past KNOWN_MAX the oldest not pending forgotten),
  // its digest for the checkpoint text. A record the backend holds nothing of and this node no longer has leaves
  // no digest behind.
  #learn(id, text) {
    this.#unlanded.delete(id);
    this.#known.delete(id);
    this.#known.set(id, text);
    if (this.#known.size > KNOWN_MAX) this.#forget();
    const row = this.#seam.row(id);
    if (text === null && (row === null || row.gone === true)) this.#digests.delete(id);
    else this.#digests.set(id, this.#digestOf(text));
  }

  #forget() {
    for (const id of this.#known.keys()) {
      if (this.#pending.has(id) || this.#inflight.has(id)) continue;
      this.#known.delete(id);
      if (this.#known.size <= KNOWN_MAX) return;
    }
  }

  // The digest of a backend state's text: DIGEST_LENGTH of its SHA-256 (base64url), null for nothing held.
  #digestOf(text) {
    return text === null ? null : this.#seam.digest(text).slice(0, DIGEST_LENGTH);
  }

  // What a push says it assumed of a record: the backend's state as known; `undefined` — "tell me what you hold", a
  // probe the handler answers as a refusal without writing — where its text is not in memory but its digest is, or
  // the record is a rebuild's; null for a record never seen.
  #assumedOf(id) {
    if (this.#known.has(id)) return parsed(this.#known.get(id));
    return this.#digests.has(id) || this.#probing.has(id) ? undefined : null;
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
        // A sealed record never goes; every other is asked about first (a probe) unless the backend's state is known.
        if (this.#seam.row(ids[i])?.encrypted === true || this.#pending.has(ids[i])) continue;
        this.#pending.set(ids[i], null);
        this.#parked.delete(ids[i]);
        if (!this.#known.has(ids[i]) && !this.#digests.has(ids[i])) this.#probing.add(ids[i]);
      }
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const { op, seq } = entries[i];
      // This connector's own pulls are the backend's already.
      if (op.actor === this.#actor || typeof op.id !== 'string' || this.#pending.has(op.id)) continue;
      if (!this.#mine(op.id)) continue;
      // Pending since before its first op here: the frontier moves past the records pushed, not past these. A parked
      // row with a turn here is the log's to remember.
      this.#pending.set(op.id, this.#db.log.formatId(seq - 1));
      this.#parked.delete(op.id);
    }
  }

  // Whether `id` is this connector's to push: a record or a tombstone of the collection, not sealed.
  #mine(id) {
    const row = this.#seam.row(id);
    return row !== null && row.type === this.#collection && row.encrypted !== true;
  }

  // Whether a parked id is still a row to push: the collection's record, or what is left of one — a tombstone, a
  // purge (its row names no collection), nothing — which goes as a deletion; never a record sealed since, nor an id
  // that is another collection's by now.
  #parkable(id) {
    const row = this.#seam.row(id);
    if (row === null) return true;
    if (row.gone === true) return row.type === null || row.type === this.#collection;
    return row.type === this.#collection && row.encrypted !== true;
  }

  // `reSync()`'s retry of the parked rows: each pending since the newest turn heard and still parked — kept with the
  // checkpoint — until the backend takes it or refuses it again, so a retry cut short (a push that fails, a crash) is
  // not forgotten. One whose id is a sealed record or another collection's by now is forgotten.
  #retryParked() {
    let dropped = false;
    for (const id of this.#parked.keys()) {
      if (!this.#parkable(id)) dropped = this.#parked.delete(id);
      else if (!this.#pending.has(id)) this.#pending.set(id, this.#last);
    }
    if (dropped) this.#save().catch(NOOP);
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
      this.#checkpoint.pushed = this.#frontier();
      await this.#save(true);
    }
    if (this.#canceled) return;
    // Drained: the initial push is done; nothing pending (or nothing was), everything heard is covered.
    if (!this.#initialPush) {
      this.#initialPush = true;
      this.#settle();
    }
    if (this.#checkpoint.pushed === this.#frontier()) return;
    this.#checkpoint.pushed = this.#frontier();
    await this.#save(true);
  }

  // Where a restart resumes the push from: before the oldest turn still pending (null: the start, a rebuild's), or
  // the newest turn heard where nothing is pending — never a position reserved but not yet announced.
  #frontier() {
    let frontier = this.#last;
    let lowest = Infinity;
    for (const since of this.#pending.values()) {
      if (since === null) return null;
      const seq = Number(since.slice(since.indexOf('.') + 1));
      if (seq < lowest) {
        lowest = seq;
        frontier = since;
      }
    }
    return frontier;
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
    this.#count('push', 'pushed', rows.length);
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
      const local = await this.#db.get(id);
      let out;
      try {
        out = this.#outgoing(id, local);
      } catch (error) {
        this.#pending.delete(id);
        this.#refuse('push', id, 'modifier', error);
        continue;
      }
      if (this.#known.has(id) && this.#known.get(id) === out.text) {
        this.#pending.delete(id);
        this.#parked.delete(id);
        continue;
      }
      const assumed = this.#assumedOf(id);
      if (assumed === undefined) {
        this.#stats.probed++;
        this.#count('push', 'probed');
      }
      rows.push({ id, data: out.data, deleted: local === null, assumed });
      texts.push(out.text);
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
        this.#parked.delete(row.id);
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
      let text;
      try {
        text = textOf(remote);
      } catch (error) {
        this.#park(row.id, { code: 'value', message: error?.message ?? String(error) });
        continue;
      }
      if (row.assumed === undefined) {
        // A probe answered: what the backend holds. The state this node knew durably (its digest), or — knowing
        // nothing — nothing held or the row itself: learned, and the row goes again in the next round with it
        // assumed (or says nothing). Another state is a conflict: the backend moved under what this node holds.
        this.#probing.delete(row.id);
        const known = this.#digests.has(row.id)
          ? this.#digests.get(row.id) === this.#digestOf(text)
          : text === null || text === texts[i];
        if (known) {
          this.#learn(row.id, text);
          this.#conflicted.add(row.id);
          continue;
        }
        conflicts.push([row, remote, text]);
        continue;
      }
      // A conflict over a row that assumed exactly what the backend says it holds: once, a revision moved under the
      // same data (tried again with it); twice in a row, a backend contradicting itself — parked, never a loop.
      if (this.#assumedText(row.id, text)) {
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
    const reason = error?.code ?? 'backend';
    this.#pending.delete(id);
    this.#probing.delete(id);
    this.#parked.set(id, reasonOf(reason));
    this.#count('push', 'parked');
    this.#refuse('push', id, reason, error);
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
      // The backend's state in the application's shape, as a pulled one: a modifier that throws, or what it answers
      // no JSON, and the row cannot be judged — parked, said, never flattened into the record.
      const why = this.#shaped(remote);
      if (why !== null) {
        const message = why.cause?.message ?? (why.reason === 'value' ? 'no JSON' : 'no object');
        this.#park(row.id, { code: why.reason, message });
        conflicts[i] = null;
        continue;
      }
      let local = null;
      try {
        local = plain(await this.#db.get(row.id));
      } catch {
        local = null;
      }
      decided.push(await this.#decide(row.id, local, remote));
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
    // A resolution the engine refused learns nothing (nobody wins): the row is parked — a turn of the record or
    // `reSync()` pushes it again with the state known assumed, the same conflict — the backend's state unlanded.
    const refused = new Set();
    for (let i = 0; i < refusals.length; i++) {
      const id = refusals[i][0];
      refused.add(id);
      this.#unlanded.add(id);
      this.#parked.set(id, reasonOf(refusals[i][1]));
      this.#count('push', 'parked');
      this.#refuse('push', id, refusals[i][1], refusals[i][2]);
    }
    // Landed: the backend's state is what the next push assumes, the ids stay pending for it. A landing that failed
    // whole learned nothing — the rows go again with what they assumed, and the backend answers the conflict again.
    for (let i = 0; i < conflicts.length; i++) {
      if (conflicts[i] === null || refused.has(conflicts[i][0].id)) continue;
      const [row, , text] = conflicts[i];
      this.#conflicted.add(row.id);
      this.#learn(row.id, text);
    }
    this.#count('push', 'conflict', decided.length);
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
