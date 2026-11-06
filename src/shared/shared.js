'use strict';

// Several instances over one database (@alexify/syncom/shared): the tabs of
// one browser profile over one IndexedDB, the windows of one Electron app
// over one SQLite file, the workers of one process over one memory engine.
// One of them leads — a full `Database`, the one that writes, dials and
// hosts — and the others follow: each a `createDatabase({ readOnly: true })`
// over the same engine, reading what the leader lands and hearing it through
// the engine's change stream (a record whole: a follower's live Document says
// `update`, but a follower raises no `transaction` event and `observe()`
// hears nothing there — the facade has no `observe`), its writes forwarded to
// the leader over a channel (`{ call(method, args) }`: a wrpc client over a worker port, or
// anything carrying JSON). Leadership is an election (src/shared/election.js:
// Web Locks, or a heartbeat); when the leader goes, a follower is granted the
// lock and opens the database as the leader in its place — the same node id,
// the same log — and every live thing made through this facade (`live`,
// `document`, `observe`) is made again over the new instance. A write a
// follower sent while the leader went is tried again once a leader answers,
// within `failover` ms; past it, `LEADER_LOST`. `openShared({ createDatabase,
// ...options, channel, election })` — the database options are what
// `createDatabase` takes (the engine must be `shared`), `createDatabase` the
// one of the flavour in use (the core's or `/all`'s: nothing of the core is
// bundled here, as /branch opens through the parent's constructor) —
// requires emitter.js, errors.js, hooks.js, election.js, channel.js only.

const { Emitter } = require('../emitter.js');
const { SyncomError } = require('../errors.js');
const { notify } = require('../hooks.js');
const { elect } = require('./election.js');
const { isChannel, answerOf, unwrap, describe } = require('./channel.js');

const START = Symbol('start');
const WRITE = Symbol('write');
const READ = Symbol('read');

// The database's writers a follower forwards; `transact` beside them, as a recorded batch.
const MUTATORS = Object.freeze([
  'insert',
  'saveData',
  'set',
  'update',
  'swap',
  'unset',
  'delete',
  'purge',
  'forget',
  'inc',
  'add',
  'remove',
  'splice',
  'push',
  'setAt',
  'move',
  'mark',
  'unmark',
  'unmarkById',
  'updateText',
  'insertEmbed',
  'updateBlock',
  'treeMove',
  'treeRemove',
  'applyPatches',
  'restore',
  'compact',
]);
// What a recorded transaction may call: the writers a transaction's api has, `insert` excepted (its id is minted
// where it runs, which a follower's function never learns in time).
const TX_WRITERS = Object.freeze([
  'set',
  'update',
  'swap',
  'unset',
  'delete',
  'purge',
  'inc',
  'add',
  'remove',
  'splice',
  'push',
  'setAt',
  'move',
  'mark',
  'unmark',
  'unmarkById',
  'updateText',
  'insertEmbed',
  'updateBlock',
  'treeMove',
  'treeRemove',
]);
// The readers the facade answers from the current instance; everything else — a collection's queries among them,
// `shared.collection(name)` — is the current `shared.db`'s.
const READERS = Object.freeze(['get', 'has', 'hasRecord', 'list', 'getCachedData']);

const DEFAULT_GRACE = 50;
const DEFAULT_FAILOVER = 10_000;
const LOCKED_RETRIES = 40;
const LOCKED_STEP = 50;
const NOOP = () => {};
const QUIET = { warn: NOOP, error: NOOP, info: NOOP, debug: NOOP };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const notLeader = (path, what) =>
  new SyncomError('NOT_LEADER', `${what} is the leader's: the instance at ${path} follows`, { path, what });

// A live Document of the current instance, made again over the next: `data()`, the `update` event (data, delta)
// — and once after a failover, with the data as the new instance reads it (delta null).
class SharedDocument extends Emitter {
  #id;
  #doc = null;
  #ready;
  #off;
  constructor(shared, id, logger) {
    super();
    this.#id = id;
    let first = true;
    this.#off = shared.live((db) => {
      const bound = db.document(id).then((doc) => {
        this.#doc = doc;
        const listener = (data, delta) => notify(this, logger(), 'update', data, delta);
        doc.on('update', listener);
        if (!first) {
          doc
            .data()
            .then((data) => notify(this, logger(), 'update', data, null))
            .catch((error) => logger().warn({ event: 'shared.rebind.failed', id, err: error }));
        }
        first = false;
        return () => doc.off('update', listener);
      });
      this.#ready = bound.then(NOOP, NOOP);
      return bound;
    });
  }
  get id() {
    return this.#id;
  }
  /** The record as the current instance reads it. */
  async data() {
    await this.#ready;
    return this.#doc.data();
  }
  /** The instance's Document behind this one now (null until the first is read). */
  get document() {
    return this.#doc;
  }
  close() {
    this.#off();
  }
}

// What `live()`'s `make` answered: the stop function, or a promise of one — stopped when it is there.
const stopOf = (stop, logger) => {
  if (stop === null || stop === undefined) return;
  Promise.resolve(stop)
    .then((fn) => {
      if (typeof fn === 'function') fn();
    })
    .catch((error) => logger().warn({ event: 'shared.rebind.failed', err: error }));
};

class Shared extends Emitter {
  #make;
  #dial;
  #options;
  #electionOptions;
  #path;
  #grace;
  #failover;
  #election = null;
  #db = null;
  #leader = false;
  #closed = false;
  #promoting = false;
  #generation = 0;
  #channel = null;
  #lives = new Set();
  #waiters = [];

  constructor(options) {
    super();
    if (options === null || typeof options !== 'object') throw new TypeError('openShared() takes an options object');
    const {
      createDatabase,
      channel = null,
      election = {},
      grace = DEFAULT_GRACE,
      failover = DEFAULT_FAILOVER,
      ...database
    } = options;
    if (typeof createDatabase !== 'function') {
      throw new TypeError('openShared(): createDatabase is required — the one of the flavour in use');
    }
    if (typeof database.path !== 'string' || database.path.length === 0) {
      throw new TypeError('openShared(): path is required');
    }
    if (channel !== null && typeof channel !== 'function') {
      throw new TypeError('openShared(): channel must be a function answering the channel to the leader');
    }
    if (election === null || typeof election !== 'object') {
      throw new TypeError('openShared(): election must be an object');
    }
    if (!Number.isFinite(grace) || grace < 0) throw new TypeError('openShared(): grace must be a non-negative number');
    if (!Number.isFinite(failover) || failover < 0) {
      throw new TypeError('openShared(): failover must be a non-negative number');
    }
    this.#make = createDatabase;
    this.#dial = channel;
    this.#options = database;
    this.#electionOptions = election;
    this.#path = database.path;
    this.#grace = grace;
    this.#failover = failover;
  }

  // The election, then the first instance: the leader where the grant comes within `grace` ms, a follower else.
  async [START]() {
    this.#election = elect({ name: `syncom:leader:${this.#path}`, ...this.#electionOptions });
    const granted =
      this.#election.mode === 'alone' ||
      (await Promise.race([this.#election.lead.then(() => true), sleep(this.#grace).then(() => false)]));
    if (granted) await this.#promote(true);
    else {
      await this.#follow();
      this.#election.lead.then(() => this.#promote(false)).catch(NOOP);
    }
    this.#election.onLost(() => this.#demote().catch(NOOP));
    return this;
  }

  #logger() {
    return this.#db?.logger ?? QUIET;
  }

  #check() {
    if (this.#closed) {
      throw new SyncomError('CLOSED', `The shared database at ${this.#path} is closed`, { path: this.#path });
    }
  }

  // A follower: read-only over the same engine, nothing of `sync` (a follower neither dials nor hosts), no lock.
  async #follow() {
    const options = { readOnly: true };
    for (const key of Object.keys(this.#options)) {
      if (key !== 'sync' && key !== 'lock') options[key] = this.#options[key];
    }
    const db = await this.#make(options);
    if (this.#closed) return void (await db.close().catch(NOOP));
    this.#db = db;
    this.#leader = false;
    this.#relay(db);
    notify(this, this.#logger(), 'follower', { path: this.#path, generation: this.#generation });
  }

  #relay(db) {
    db.on('error', (error) => notify(this, this.#logger(), 'error', error));
  }

  // Granted the lock: the database opened as the leader beside the follower (which holds no lock), the facade
  // moved to it, the live things made again, the follower closed. The database's own lock may still be the old
  // leader's for a moment: `LOCKED` is tried again, LOCKED_RETRIES times.
  async #promote(first) {
    if (this.#closed || this.#leader || this.#promoting) return;
    this.#promoting = true;
    try {
      let writer = null;
      for (let attempt = 0; writer === null; attempt++) {
        if (this.#closed) return;
        try {
          writer = await this.#make(this.#options);
        } catch (error) {
          if (error?.code !== 'LOCKED' || attempt >= LOCKED_RETRIES) throw error;
          await sleep(LOCKED_STEP);
        }
      }
      if (this.#closed) return void (await writer.close().catch(NOOP));
      const old = this.#db;
      const channel = this.#channel;
      this.#db = writer;
      this.#leader = true;
      this.#channel = null;
      if (!first) this.#generation++;
      this.#relay(writer);
      if (!first) this.#rebind();
      notify(this, this.#logger(), 'leader', { path: this.#path, generation: this.#generation });
      const waiters = this.#waiters;
      this.#waiters = [];
      for (let i = 0; i < waiters.length; i++) waiters[i].resolve();
      if (old !== null) await old.close().catch(NOOP);
      if (channel !== null) await Promise.resolve(channel.close?.()).catch(NOOP);
    } catch (error) {
      const lost = new SyncomError(
        'LEADER_LOST',
        `Elected, but the database at ${this.#path} could not be opened as the leader`,
        {
          path: this.#path,
          cause: error,
        },
      );
      this.#logger().error({ event: 'shared.promote.failed', path: this.#path, err: error });
      notify(this, this.#logger(), 'error', lost);
    } finally {
      this.#promoting = false;
    }
  }

  // A leader that yielded (the heartbeat election's two-leaders rule): a follower again over the same engine.
  async #demote() {
    if (this.#closed || !this.#leader) return;
    const old = this.#db;
    await this.#follow();
    if (this.#closed) return;
    this.#generation++;
    this.#rebind();
    await old.close().catch(NOOP);
  }

  // Every live thing made through the facade, made again over the current instance.
  #rebind() {
    for (const entry of this.#lives) {
      stopOf(entry.stop, () => this.#logger());
      try {
        entry.stop = entry.make(this.#db) ?? null;
      } catch (error) {
        entry.stop = null;
        this.#logger().warn({ event: 'shared.rebind.failed', path: this.#path, err: error });
      }
    }
    notify(this, this.#logger(), 'rebind', { path: this.#path, generation: this.#generation });
  }

  /** The current instance: the leader's `Database`, or a follower's read-only one. */
  get db() {
    this.#check();
    return this.#db;
  }
  /** Whether this instance leads now. */
  get leader() {
    return this.#leader;
  }
  isLeader() {
    return this.#leader;
  }
  get path() {
    return this.#path;
  }
  /** Counted up at every change of instance (a promotion, a yield): what a live thing was made again at. */
  get generation() {
    return this.#generation;
  }
  /** How leadership is decided: `'locks'`, `'heartbeat'` or `'alone'`. */
  get mode() {
    return this.#election.mode;
  }
  get nodeId() {
    return this.db.nodeId;
  }
  /** Replication is the leader's: `NOT_LEADER` on a follower. */
  get sync() {
    this.#check();
    if (!this.#leader) throw notLeader(this.#path, 'sync');
    return this.#db.sync;
  }

  /** Resolves once this instance leads; rejects when it is closed first, or `signal` aborts. */
  waitForLeadership({ signal = null } = {}) {
    this.#check();
    if (this.#leader) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.#waiters.push(waiter);
      signal?.addEventListener?.(
        'abort',
        () => {
          const kept = [];
          for (let i = 0; i < this.#waiters.length; i++) if (this.#waiters[i] !== waiter) kept.push(this.#waiters[i]);
          this.#waiters = kept;
          reject(aborted());
        },
        { once: true },
      );
    });
  }
  onLeader(listener) {
    this.on('leader', listener);
    return () => this.off('leader', listener);
  }

  /** The collection named, of the current instance (`shared.db.collections[name]`): its queries and documents. */
  collection(name) {
    const collection = this.db.collections[name];
    if (collection === undefined) throw new TypeError(`collection(): no collection ${String(name)}`);
    return collection;
  }

  /**
   * A live thing over the current instance, made again over the next: `make(db)` subscribes and answers what
   * stops it (or a promise of it). Answers the function that stops it for good.
   */
  live(make) {
    if (typeof make !== 'function') throw new TypeError('live() takes a function over the current database');
    this.#check();
    const entry = { make, stop: null };
    entry.stop = make(this.#db) ?? null;
    this.#lives.add(entry);
    return () => {
      if (this.#lives.delete(entry)) stopOf(entry.stop, () => this.#logger());
    };
  }
  /** A Document that follows the instance: re-read once after a failover. */
  document(id) {
    this.#check();
    return new SharedDocument(this, id, () => this.#logger());
  }
  [READ](name, args) {
    const db = this.db;
    return Reflect.apply(db[name], db, args);
  }

  async [WRITE](name, args) {
    this.#check();
    if (this.#leader) return Reflect.apply(this.#db[name], this.#db, args);
    return this.#forward(name, args);
  }

  // A follower's write: carried to the leader, tried again while a leader comes within `failover` ms — this
  // instance's own, where the election made it so meanwhile — then `LEADER_LOST`.
  async #forward(name, args) {
    if (this.#dial === null) throw notLeader(this.#path, `${name}() without a channel to the leader`);
    const deadline = Date.now() + this.#failover;
    let cause = null;
    for (let attempt = 0; ; attempt++) {
      this.#check();
      if (this.#leader) return Reflect.apply(this.#db[name], this.#db, args);
      let answer;
      try {
        if (this.#channel === null) {
          this.#channel = await this.#dial({ path: this.#path, generation: this.#generation });
          if (!isChannel(this.#channel)) {
            this.#channel = null;
            throw new TypeError('openShared(): channel() must answer { call(method, args) }');
          }
        }
        answer = await this.#channel.call(name, args);
      } catch (error) {
        if (error instanceof TypeError) throw error;
        cause = error;
        answer = null;
      }
      if (answer !== null) {
        try {
          return unwrap(answer, name);
        } catch (error) {
          // The instance that answered follows now: the leader is another, dialed again.
          if (error?.code !== 'NOT_LEADER' && error?.code !== 'LEADER_LOST') throw error;
          cause = error;
        }
      }
      // The leader went: the channel dropped, a new one dialed once a leader answers.
      await Promise.resolve(this.#channel?.close?.()).catch(NOOP);
      this.#channel = null;
      if (Date.now() >= deadline) {
        throw new SyncomError(
          'LEADER_LOST',
          `${name}() reached no leader of ${this.#path} within ${this.#failover} ms`,
          {
            path: this.#path,
            method: name,
            attempts: attempt + 1,
            cause,
          },
        );
      }
      await sleep(Math.min(LOCKED_STEP * (attempt + 1), 1000));
    }
  }

  /**
   * On the leader, the database's own transaction. On a follower, a RECORDED one: `fn(tx)` runs here against a
   * recorder whose writers note the call and answer at once (`get`/`has` read this instance), and the batch is
   * carried to the leader as one transaction — so `fn` never reads what it wrote, and `insert` is refused (its id
   * would be the leader's); `set(id, data)` with an id of your own instead.
   */
  async transact(fn, options = {}) {
    if (typeof fn !== 'function') throw new TypeError('transact() takes a function');
    this.#check();
    if (this.#leader) return this.#db.transact(fn, options);
    const ops = [];
    const tx = {
      get: (id) => this.#db.get(id),
      has: (id) => this.#db.has(id),
      insert: async () => {
        throw new TypeError(
          "transact() on a follower cannot insert(): the id would be the leader's — set(id, data) instead",
        );
      },
    };
    for (let i = 0; i < TX_WRITERS.length; i++) {
      const name = TX_WRITERS[i];
      tx[name] = async (...args) => void ops.push([name, args]);
    }
    const result = await fn(tx);
    if (ops.length > 0) await this.#forward('transact', [ops, options]);
    return result;
  }

  /**
   * The procedures a leader mounts for its followers (`defineRouter({ 'syncom-db': shared.serve() })`): one per
   * writer and `transact`, each answering a value — the result, or the error described — never throwing; an
   * instance that follows again answers `NOT_LEADER`. `NOT_LEADER` here on a follower.
   */
  serve({ access = 'public' } = {}) {
    this.#check();
    if (!this.#leader) throw notLeader(this.#path, 'serve()');
    const run = (fn) => async (context, args) => {
      if (this.#closed || !this.#leader) {
        return { ok: false, error: describe(notLeader(this.#path, 'a forwarded write')) };
      }
      return answerOf(() => fn(Array.isArray(args) ? args : []));
    };
    const procedures = {};
    for (let i = 0; i < MUTATORS.length; i++) {
      const name = MUTATORS[i];
      procedures[name] = { access, handler: run((args) => Reflect.apply(this.#db[name], this.#db, args)) };
    }
    procedures.transact = {
      access,
      handler: run(([ops, options]) => {
        if (!Array.isArray(ops)) throw new TypeError('transact: a list of [method, args]');
        return this.#db.transact(async (tx) => {
          for (let i = 0; i < ops.length; i++) {
            const [name, args] = ops[i];
            if (!TX_WRITERS.includes(name) || typeof tx[name] !== 'function') {
              throw new TypeError(`transact: ${String(name)} is not a transaction writer`);
            }
            await Reflect.apply(tx[name], tx, Array.isArray(args) ? args : []);
          }
        }, options ?? {});
      }),
    };
    return procedures;
  }

  /** The instance closed, the election left, the channel closed; the leadership waiters rejected (`CLOSED`). */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#election?.release();
    for (const entry of this.#lives) stopOf(entry.stop, () => QUIET);
    this.#lives.clear();
    const waiters = this.#waiters;
    this.#waiters = [];
    for (let i = 0; i < waiters.length; i++) {
      waiters[i].reject(
        new SyncomError('CLOSED', `The shared database at ${this.#path} is closed`, { path: this.#path }),
      );
    }
    await Promise.resolve(this.#channel?.close?.()).catch(NOOP);
    this.#channel = null;
    const db = this.#db;
    this.#db = null;
    this.#leader = false;
    if (db !== null) await db.close();
  }

  static {
    for (let i = 0; i < READERS.length; i++) {
      const name = READERS[i];
      Shared.prototype[name] = function (...args) {
        return this[READ](name, args);
      };
    }
    for (let i = 0; i < MUTATORS.length; i++) {
      const name = MUTATORS[i];
      Shared.prototype[name] = function (...args) {
        return this[WRITE](name, args);
      };
    }
  }
}

const aborted = () => Object.assign(new Error('waitForLeadership() aborted'), { name: 'AbortError' });

/** Opens the database as one of several instances: `await openShared({ createDatabase, path, engine, …, channel, election })`. */
const openShared = (options) => new Shared(options)[START]();

module.exports = { openShared, Shared, SharedDocument, elect, MUTATORS, TX_WRITERS, READERS };
