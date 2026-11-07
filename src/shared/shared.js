'use strict';

// Several instances over one database (@alexify/syncom/shared): the tabs of
// one browser profile over one IndexedDB, the workers of one process over one
// memory engine, the instances of one service over one MongoDB. One of them
// leads — a full `Database`, the one that writes, dials and hosts — and the
// others follow: each a `createDatabase({ readOnly: true })` over the same
// engine (one that is `shared`), reading what the leader lands and hearing it
// through the engine's change stream (a record whole: a follower's live
// Document says `update`, but a follower raises no `transaction` event and
// `observe()` hears nothing there — the facade has no `observe`), its writes
// forwarded to the leader over a channel (`{ call(method, args) }`: a wrpc
// client over a worker port, or anything carrying JSON). Leadership is an
// election (src/shared/election.js: Web Locks, or a heartbeat), re-armable:
// when the leader goes, a follower is granted the lock and opens the
// database as the leader in its place — the same node id, the same log —
// and every live thing made through this facade (`live`, `document`) is made
// again over the new instance; an elected instance that cannot open says
// PROMOTE_FAILED, yields the lock and asks again after a backoff. A write a
// follower sent while the leader went is tried again once a leader answers,
// within `failover` ms; past it, `LEADER_LOST`. `openShared({ createDatabase,
// ...options, channel, election })` — the database options are what
// `createDatabase` takes, `createDatabase` the one of the flavour in use (the
// core's or `/all`'s: nothing of the core is bundled here, as /branch opens
// through the parent's constructor) — requires emitter.js, errors.js,
// hooks.js, election.js, channel.js only.

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
// A promotion that failed asks for the lock again after LOCKED_STEP · 2^attempt ms, MAX_BACKOFF at most.
const MAX_BACKOFF = 5000;
// The answers a leader keeps for the calls tried again: per follower (its token), and how many followers.
const ANSWERS_KEPT = 256;
const TOKENS_KEPT = 64;
const CALL_ID_MAX = 128;
const NOOP = () => {};
const QUIET = { warn: NOOP, error: NOOP, info: NOOP, debug: NOOP };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A forwarded call as the wire carries it: `{ id: '<token>:<n>', args, retry? }`, or null where it is none.
const callOf = (payload) => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { id, args, retry = false } = payload;
  if (typeof id !== 'string' || id.length === 0 || id.length > CALL_ID_MAX || !Array.isArray(args)) return null;
  if (typeof retry !== 'boolean') return null;
  const at = id.lastIndexOf(':');
  if (at <= 0) return null;
  return { id, token: id.slice(0, at), args, retry };
};

const notLeader = (path, what) =>
  new SyncomError('NOT_LEADER', `${what} is the leader's: the instance at ${path} follows`, { path, what });
const closed = (path) => new SyncomError('CLOSED', `The shared database at ${path} is closed`, { path });

// A live Document of the current instance, made again over the next: `data()`, the `update` event (data, delta)
// — and once after a failover, with the data as the new instance reads it (delta null). A bind that failed is
// what `data()` throws, never a read of nothing.
class SharedDocument extends Emitter {
  #id;
  #doc = null;
  #error = null;
  #ready;
  #off;
  constructor(shared, id, logger) {
    super();
    this.#id = id;
    let first = true;
    this.#off = shared.live((db) => {
      const bound = db.document(id).then((doc) => {
        this.#doc = doc;
        this.#error = null;
        const listener = (data, delta) => notify(this, logger(), 'update', data, delta);
        doc.on('update', listener);
        if (!first) {
          doc
            .data()
            .then((data) => notify(this, logger(), 'update', data, null))
            .catch((error) => logger().warn({ event: 'tabs.rebind.failed', id, err: error }));
        }
        first = false;
        return () => doc.off('update', listener);
      });
      this.#ready = bound.then(NOOP, (error) => {
        this.#error = error;
      });
      return bound;
    });
  }
  get id() {
    return this.#id;
  }
  /** The record as the current instance reads it; what the bind threw where it failed. */
  async data() {
    await this.#ready;
    if (this.#doc === null) throw this.#error ?? new TypeError(`document(${this.#id}): not bound`);
    return this.#doc.data();
  }
  /** The instance's Document behind this one (null until the first is read). */
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
    .catch((error) => logger().warn({ event: 'tabs.rebind.failed', err: error }));
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
  #offLead = NOOP;
  #offLost = NOOP;
  #db = null;
  #leader = false;
  #closed = false;
  #promoting = false;
  #promotion = null;
  #attempts = 0;
  #retry = null;
  #generation = 0;
  #channel = null;
  #dialing = null;
  #calls = 0;
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

  // The election, then the first instance: the leader where the grant comes within `grace` ms, a follower else —
  // one that waits for the leader's identity on a fresh path, and is promoted the moment the grant comes. A first
  // open that fails leaves nothing behind: the election released, the error thrown — `shared.db` is never null.
  async [START]() {
    this.#election = elect({ name: `syncom:leader:${this.#path}`, ...this.#electionOptions });
    try {
      let granted = this.#election.leader;
      if (!granted && this.#election.mode !== 'follower') {
        let grant = NOOP;
        const lead = new Promise((resolve) => {
          grant = resolve;
        });
        const off = this.#election.onLead(grant);
        granted = await Promise.race([lead.then(() => true), sleep(this.#grace).then(() => false)]);
        off();
      }
      if (granted) await this.#promote(true);
      else {
        await this.#follow(true);
        // The grant may have come while the follower opened: the facade promotes now, and at every grant after.
        if (this.#election.leader) await this.#promote(true);
      }
      this.#offLead = this.#election.onLead(() => void this.#promote(false).catch(NOOP));
      this.#offLost = this.#election.onLost(() => void this.#demote().catch(NOOP));
      return this;
    } catch (error) {
      this.#closed = true;
      this.#election.release();
      const db = this.#db;
      this.#db = null;
      if (db !== null) await db.close().catch(NOOP);
      throw error;
    }
  }

  #logger() {
    return this.#db?.logger ?? QUIET;
  }

  #check() {
    if (this.#closed) throw closed(this.#path);
  }

  // A follower: read-only over the same engine, nothing of `sync` (a follower neither dials nor hosts), no lock. A
  // fresh path reads as READ_ONLY until the elected instance writes the identity — tried again every step while
  // this instance is not the one elected, within `failover` ms; past it, LEADER_LOST (reason `fresh`).
  async #follow(first) {
    const options = { readOnly: true };
    for (const key of Object.keys(this.#options)) {
      if (key !== 'sync' && key !== 'lock') options[key] = this.#options[key];
    }
    const deadline = Date.now() + this.#failover;
    let db = null;
    for (let attempt = 0; db === null; attempt++) {
      if (this.#closed) return;
      if (first && this.#election.leader) return;
      try {
        db = await this.#make(options);
      } catch (error) {
        if (error?.code !== 'READ_ONLY') throw error;
        if (Date.now() >= deadline) {
          throw new SyncomError(
            'LEADER_LOST',
            `No leader wrote the database at ${this.#path} within ${this.#failover} ms`,
            {
              path: this.#path,
              reason: 'fresh',
              cause: error,
            },
          );
        }
        await sleep(Math.min(this.#grace, LOCKED_STEP) || LOCKED_STEP);
      }
    }
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
  // leader's for a moment: `LOCKED` is tried again, LOCKED_RETRIES times. An open that fails past the first is
  // PROMOTE_FAILED on `error`: the lock yielded (the next in line leads), asked for again after a backoff.
  async #promote(first) {
    if (this.#closed || this.#leader || this.#promoting) return;
    this.#promoting = true;
    let done = NOOP;
    this.#promotion = new Promise((resolve) => {
      done = resolve;
    });
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
      // Closed, or the election lost while the writer opened (two heartbeat leaders settling): the writer goes.
      if (this.#closed || !this.#election.leader) return void (await writer.close().catch(NOOP));
      const old = this.#db;
      const channel = this.#channel;
      this.#db = writer;
      this.#leader = true;
      this.#channel = null;
      this.#attempts = 0;
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
      if (first) throw error;
      const attempt = this.#attempts++;
      const failed = new SyncomError(
        'PROMOTE_FAILED',
        `Elected, but the database at ${this.#path} could not be opened as the leader (attempt ${attempt + 1})`,
        { path: this.#path, attempt, cause: error },
      );
      this.#logger().error({ event: 'tabs.promote.failed', path: this.#path, attempt, err: error });
      this.#election.yield();
      notify(this, this.#logger(), 'error', failed);
      if (!this.#closed) {
        this.#retry = setTimeout(
          () => {
            this.#retry = null;
            if (!this.#closed) this.#election.request();
          },
          Math.min(LOCKED_STEP * 2 ** attempt, MAX_BACKOFF),
        );
      }
    } finally {
      this.#promoting = false;
      this.#promotion = null;
      done();
    }
  }

  // A leader that lost the election (the heartbeat's two-leaders rule, a lock stolen): a follower again over the
  // same engine, the live things made again.
  async #demote() {
    // A loss while a promotion is in flight: the promotion sees it (the writer goes) or the swap is undone here.
    if (this.#promotion !== null) await this.#promotion;
    if (this.#closed || !this.#leader || this.#election.leader) return;
    const old = this.#db;
    try {
      await this.#follow(false);
    } catch (error) {
      notify(this, this.#logger(), 'error', error);
      return;
    }
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
        this.#logger().warn({ event: 'tabs.rebind.failed', path: this.#path, err: error });
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
  /** How leadership is decided: `'locks'`, `'heartbeat'`, `'follower'` or `'alone'`. */
  get mode() {
    return this.#election.mode;
  }
  /** The election's: what names this instance's calls to the leader. */
  get token() {
    return this.#election.token;
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

  // The channel to the leader, dialed once for every write waiting on it: concurrent forwards share one dial.
  #channelOf() {
    if (this.#channel !== null) return Promise.resolve(this.#channel);
    this.#dialing ??= Promise.resolve()
      .then(() => this.#dial({ path: this.#path, generation: this.#generation }))
      .then((channel) => {
        this.#channel = channel;
        return channel;
      })
      .finally(() => {
        this.#dialing = null;
      });
    return this.#dialing;
  }

  async #dropChannel() {
    const channel = this.#channel;
    this.#channel = null;
    if (channel !== null) await Promise.resolve(channel.close?.()).catch(NOOP);
  }

  // A follower's write: carried to the leader as a CALL — `{ id: '<token>:<n>', args, retry }` — tried again while a
  // leader comes within `failover` ms (this instance's own, where the election made it so meanwhile), then
  // `LEADER_LOST`. At-least-once, deduplicated by the id: a call whose answer was lost goes again with `retry`, and
  // the leader that saw it answers from what it kept; one no leader saw (the leader changed) is CALL_UNKNOWN there,
  // LEADER_LOST with `maybeApplied` here — never run twice. A dial that fails sent nothing (`retry` stays off); a call
  // that rejects — a transport's error, a `TypeError` of a fetch among them — may have reached the leader (`sent`,
  // unless the transport says `sent: false`); a NOT_LEADER, LEADER_LOST or CLOSED answer is from an instance that
  // follows, or is going: tried again, and it never marks a call sent.
  async #forward(name, args) {
    if (this.#dial === null) throw notLeader(this.#path, `${name}() without a channel to the leader`);
    const deadline = Date.now() + this.#failover;
    const id = `${this.#election.token}:${++this.#calls}`;
    let sent = false;
    let cause = null;
    for (let attempt = 0; ; attempt++) {
      this.#check();
      if (this.#leader) return Reflect.apply(this.#db[name], this.#db, args);
      let channel = null;
      try {
        channel = await this.#channelOf();
      } catch (error) {
        // The dial failed: nothing reached a leader.
        cause = error;
      }
      if (channel !== null && !isChannel(channel)) {
        this.#channel = null;
        throw new TypeError('openShared(): channel() must answer { call(method, args) }');
      }
      if (channel !== null) {
        let answer = null;
        try {
          answer = await channel.call(name, { id, args, retry: sent });
        } catch (error) {
          cause = error;
          sent = sent || error?.sent !== false;
        }
        if (answer !== null) {
          try {
            return unwrap(answer, name);
          } catch (error) {
            const code = error?.code;
            if (code === 'CALL_UNKNOWN') {
              throw new SyncomError(
                'LEADER_LOST',
                `${name}() was tried again at a leader that never saw it: the leader changed, the first may have landed`,
                { path: this.#path, method: name, id, attempts: attempt + 1, maybeApplied: true, cause: error },
              );
            }
            // The instance that answered follows now, or is closing: the leader is another, dialed again.
            if (code !== 'NOT_LEADER' && code !== 'LEADER_LOST' && code !== 'CLOSED') throw error;
            cause = error;
          }
        }
      }
      // The leader went: the channel dropped, a new one dialed once a leader answers.
      await this.#dropChannel();
      if (Date.now() >= deadline) {
        throw new SyncomError(
          'LEADER_LOST',
          `${name}() reached no leader of ${this.#path} within ${this.#failover} ms`,
          { path: this.#path, method: name, id, attempts: attempt + 1, maybeApplied: sent, cause },
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
   * writer and `transact`, each taking a call `{ id, args, retry }` and answering a value — the result, or the error
   * described — never throwing; an instance that follows again answers `NOT_LEADER`. The answers are kept by call
   * id, ANSWERS_KEPT per follower and TOKENS_KEPT followers (in memory, this `serve()`'s): a call tried again is
   * answered from what was kept, in flight or done, and one tried again that this leader never saw is
   * CALL_UNKNOWN — never run. `NOT_LEADER` here on a follower. `access` is wrpc's: `'session'` by default — the
   * leader's writers are the application's own tabs', never a router's public face.
   */
  serve({ access = 'session' } = {}) {
    this.#check();
    if (!this.#leader) throw notLeader(this.#path, 'serve()');
    const answers = new Map();
    const keep = (token, id, answer) => {
      let kept = answers.get(token);
      if (kept === undefined) {
        if (answers.size >= TOKENS_KEPT) answers.delete(answers.keys().next().value);
        kept = new Map();
      } else answers.delete(token);
      answers.set(token, kept);
      kept.set(id, answer);
      if (kept.size > ANSWERS_KEPT) kept.delete(kept.keys().next().value);
    };
    const run = (method, fn) => async (context, payload) => {
      const call = callOf(payload);
      if (call === null)
        return { ok: false, error: describe(new TypeError(`${method}: a call is { id, args, retry? }`)) };
      const held = answers.get(call.token)?.get(call.id);
      if (held !== undefined) return held;
      if (this.#closed || !this.#leader) {
        return { ok: false, error: describe(notLeader(this.#path, 'a forwarded write')) };
      }
      if (call.retry) {
        const unknown = new SyncomError(
          'CALL_UNKNOWN',
          `${method}: the call ${call.id} was tried again, and this leader never saw it`,
          { id: call.id, method },
        );
        return { ok: false, error: describe(unknown) };
      }
      const answer = answerOf(() => fn(call.args));
      keep(call.token, call.id, answer);
      return answer;
    };
    const procedures = {};
    for (let i = 0; i < MUTATORS.length; i++) {
      const name = MUTATORS[i];
      procedures[name] = { access, handler: run(name, (args) => Reflect.apply(this.#db[name], this.#db, args)) };
    }
    procedures.transact = {
      access,
      handler: run('transact', ([ops, options]) => {
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

  /**
   * The live things stopped, the leadership waiters rejected (`CLOSED`), the channel closed, a promotion in flight
   * waited for, the instance closed — and the election let go of LAST, so the next leader opens after this one's
   * lock is gone.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retry !== null) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    this.#offLead();
    this.#offLost();
    for (const entry of this.#lives) stopOf(entry.stop, () => QUIET);
    this.#lives.clear();
    const waiters = this.#waiters;
    this.#waiters = [];
    for (let i = 0; i < waiters.length; i++) waiters[i].reject(closed(this.#path));
    await this.#dropChannel();
    if (this.#promotion !== null) await this.#promotion;
    const db = this.#db;
    this.#db = null;
    this.#leader = false;
    try {
      if (db !== null) await db.close();
    } finally {
      this.#election?.release();
    }
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
