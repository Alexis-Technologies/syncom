'use strict';

// One log shared by the hubs of a mesh, so a client resumes on any hub: a
// broker's stream (wrpc's `BrokerLog` — Redis Streams, NATS, Kafka, AMQP, the
// memory broker — the shape `isSharedLog` checks) or `mongoSharedLog`
// (@alexify/syncom/mongodb). Three halves live here, over the manager's storage:
//
//   the RELAY — every op this hub accepts (its own writes, a client's push, a
//     joined snapshot, an inbox entry) goes to the topic, a batch per tick (what
//     one announce leaves), `pageSize` ops an entry at most; what came from the
//     topic itself (`via.shared`) does not go back. An append that fails leaves
//     the relay `behind`, and the recovery appends everything the log holds
//     since the last entry that landed (`log.since`), backed off — the first
//     start the same way, from the oldest op retained (`appended` null).
//   the CONSUMER — a hub that writes reads the topic from its saved cursor and
//     applies what it lacks (one `applyRemote` per entry, the appender as `via`),
//     and the inbox — what a read-only hub forwarded of its clients' pushes —
//     the same way, whose ops then reach the topic through the relay. A hub that
//     cannot write (a follower over MongoDB, a writer whose lease was lost)
//     applies nothing: it shadows the vector as the log moves it — what its
//     hello answers and what a push it forwards is held to.
//   the FEED — `changes` on a hub with a shared log reads the topic from the
//     client's cursor (src/sync/hosting.js), and a snapshot's first page is
//     positioned at a marker this hub appended and its consumer reached.
//
// An entry is one JSON text — `{ v: 1, node, ops: [packed…], scopes? }`, or
// `{ v: 1, node, mark: true }` — with the appender's token in its headers
// (`by`), so a hub passes its own without parsing them. The cursor, the inbox
// cursor and the relay's watermark are one kv text (`shared/cursor.json`),
// written coalesced; a read-only hub writes none and reads the topic whole.
// Requires wire.js, protocol.js, shared-log.js, vector.js, shape.js, errors.js,
// hooks.js only.

const { packOps, unpackOps } = require('./wire.js');
const { DEFAULT_PAGE_SIZE } = require('./protocol.js');
const { isSharedLog } = require('./shared-log.js');
const { vectorAdvance, opKey } = require('../vector.js');
const { isPlainObject, wellFormed } = require('../shape.js');
const { SyncomError } = require('../errors.js');
const { notify } = require('../hooks.js');

const DEFAULT_TOPIC = 'syncom';
// The kv namespace and key of the cursor.
const SHARED = 'shared';
const CURSOR = 'cursor.json';
const ENTRY_VERSION = 1;
// The ids the consumer passed lately: a marker appended just before `reached` asks for it.
const RECENT = 256;
// A failed append, read or apply waits this long before the next try, doubling.
const BACKOFF = 1000;
const MAX_BACKOFF = 60_000;
// An entry whose apply fails this many times in a row leaves its topic stuck.
const MAX_APPLY_RETRIES = 3;
// How long a snapshot waits for the consumer to reach its marker.
const REACH_TIMEOUT = 30_000;
const NOOP = () => {};

const token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** A pause of `ms`, cut short by `signal`. */
const sleep = (ms, signal = null) =>
  new Promise((resolve) => {
    if (signal?.aborted) return void resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });

/** `createDatabase({ sync: { sharedLog } })` checked: `{ log, topic, inbox }`, or null when none was given. */
const normalizeShared = (value) => {
  if (value === undefined || value === null) return null;
  const given = isSharedLog(value) ? { log: value } : value;
  if (!isPlainObject(given) || !isSharedLog(given.log)) {
    throw new TypeError('sync.sharedLog: a shared log (append, read, parseId), or { log, topic, inbox }');
  }
  const { topic = DEFAULT_TOPIC } = given;
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new TypeError('sync.sharedLog.topic must be a non-empty string');
  }
  const inbox = given.inbox === undefined ? `${topic}.inbox` : given.inbox;
  if (inbox !== false && (typeof inbox !== 'string' || inbox.length === 0 || inbox === topic)) {
    throw new TypeError('sync.sharedLog.inbox must be a non-empty string other than the topic, or false');
  }
  return { log: given.log, topic, inbox };
};

const entryText = (node, ops, scopes = null) => {
  const entry = { v: ENTRY_VERSION, node, ops: packOps(ops) };
  if (scopes !== null) entry.scopes = scopes;
  return JSON.stringify(entry);
};
const markText = (node) => JSON.stringify({ v: ENTRY_VERSION, node, mark: true });

// The scopes an inbox entry carries, as the forwarding hub granted them: strings, or null (a page for every scope).
const scopesOf = (value) => {
  if (!Array.isArray(value)) return null;
  const scopes = [];
  for (let i = 0; i < value.length; i++) if (typeof value[i] === 'string') scopes.push(value[i]);
  return scopes;
};

/**
 * What an entry of the shared log carries: `{ node, ops, scopes }` (the
 * appender's node id, the ops unpacked, the scopes an inbox entry was
 * forwarded under or null), null for a marker, undefined for a text that is
 * no entry of ours.
 */
const parseEntry = (text) => {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(value) || value.v !== ENTRY_VERSION || typeof value.node !== 'string') return undefined;
  if (value.mark === true) return null;
  if (!Array.isArray(value.ops)) return undefined;
  return { node: value.node, ops: unpackOps(value.ops), scopes: scopesOf(value.scopes) };
};

// A failure of the shared log as the manager reports it: `reason` names the half.
const failed = (reason, message, fields) => new SyncomError('SHARED_LOG_FAILED', message, { reason, ...fields });

class SharedHub {
  #manager;
  #storage;
  #logger;
  #log;
  #topic;
  #inbox;
  #kv;
  #pageSize;
  #token = token();
  // The relay: the ops of this tick, the chain every append runs on, the local
  // event id appended through, and the recovery after a failed append.
  #buffer = [];
  #flushQueued = false;
  #appending = Promise.resolve();
  #appended = null;
  #behind = false;
  #backoff = 0;
  #recoverTimer = null;
  #told = false;
  // The consumer: a loop per topic read, the cursors, their save, the ids passed lately and who waits for one.
  #running = false;
  #controller = null;
  #launching = null;
  #loops = [];
  #cursor = { topic: null, inbox: null };
  #loaded = false;
  #saving = Promise.resolve();
  #saveQueued = false;
  #recent = [];
  #recentSet = new Set();
  #waiters = new Set();
  #stuck = { topic: false, inbox: false };
  // A read-only hub's vector, as the topic moves it; null while this hub writes.
  #shadow = null;
  #stats = { relayed: 0, appendFailures: 0, entries: 0, applied: 0, forwarded: 0, malformed: 0 };

  constructor(manager, storage, { log, topic, inbox }, { kv, pageSize = DEFAULT_PAGE_SIZE }) {
    this.#manager = manager;
    this.#storage = storage;
    this.#logger = storage.logger;
    this.#log = log;
    this.#topic = topic;
    this.#inbox = inbox;
    this.#kv = kv;
    this.#pageSize = pageSize;
  }

  get topic() {
    return this.#topic;
  }

  /** The inbox topic a read-only hub forwards pushes to, or false. */
  get inbox() {
    return this.#inbox;
  }

  /** What a hub over this log answers at hello as its epoch: the same on every hub, so a client keeps its cursor. */
  get epoch() {
    return `shared:${this.#topic}`;
  }

  get running() {
    return this.#running;
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  async start() {
    if (this.#running) return;
    this.#running = true;
    this.#controller = new AbortController();
    this.#stuck = { topic: false, inbox: false };
    if (!this.#loaded) await this.#load();
    // The loops begin on the next turn of the event loop: what the first read
    // says — a cursor gone, a broker down — reaches a listener attached right
    // after the open, not nobody.
    this.#launching = setImmediate(() => this.#launch());
  }

  #launch() {
    this.#launching = null;
    if (!this.#running) return;
    const readOnly = this.#storage.readOnly;
    // Nothing appended yet: everything the log retains goes to the topic — a hub joins the log with its state.
    if (!readOnly && this.#appended === null) {
      this.#behind = true;
      this.#recover();
    }
    this.#loops = [this.#consume('topic', this.#topic)];
    if (!readOnly && this.#inbox !== false) this.#loops.push(this.#consume('inbox', this.#inbox));
  }

  async stop() {
    if (!this.#running) return;
    this.#running = false;
    if (this.#launching !== null) {
      clearImmediate(this.#launching);
      this.#launching = null;
    }
    this.#controller.abort();
    if (this.#recoverTimer !== null) {
      clearTimeout(this.#recoverTimer);
      this.#recoverTimer = null;
    }
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(
        failed('stopped', 'The shared log was stopped before the marker was reached', { topic: this.#topic }),
      );
    }
    this.#waiters.clear();
    await Promise.allSettled(this.#loops);
    this.#loops = [];
    await this.#appending;
    await this.#saving;
  }

  /** The cursors, the relay's watermark and the counts — `sync.shared()`. */
  stats() {
    return {
      topic: this.#topic,
      inbox: this.#inbox,
      running: this.#running,
      cursor: { ...this.#cursor },
      appended: this.#appended,
      behind: this.#behind,
      stuck: { ...this.#stuck },
      shadow: this.#shadow !== null,
      ...this.#stats,
    };
  }

  // The cursor, the inbox cursor and the watermark, from the kv: a text that
  // does not read is said and read as none. A read-only hub starts from the
  // oldest entry whatever is saved — the saved cursor is the writer's.
  async #load() {
    this.#loaded = true;
    let parsed = null;
    try {
      const text = await this.#kv.get(SHARED, CURSOR);
      if (text !== null) parsed = JSON.parse(text);
    } catch (error) {
      this.#logger.warn({ event: 'shared.cursor.unreadable', topic: this.#topic, err: error });
    }
    if (!isPlainObject(parsed) || this.#storage.readOnly) return;
    this.#cursor.topic = this.#log.parseId(parsed.topic);
    this.#cursor.inbox = this.#log.parseId(parsed.inbox);
    this.#appended = typeof parsed.appended === 'string' ? parsed.appended : null;
  }

  #saveCursor() {
    if (this.#storage.readOnly || this.#saveQueued) return;
    this.#saveQueued = true;
    this.#saving = this.#saving.then(async () => {
      this.#saveQueued = false;
      const text = JSON.stringify({ topic: this.#cursor.topic, inbox: this.#cursor.inbox, appended: this.#appended });
      try {
        await this.#kv.put(SHARED, CURSOR, text, { atomic: true });
      } catch (error) {
        this.#logger.warn({ event: 'shared.cursor.failed', topic: this.#topic, err: error });
      }
    });
  }

  // -------------------------------------------------------------------------
  // The relay

  /** An op this hub accepted (`#fanOut`): appended with the others of its tick, unless it came from the topic. */
  offer(op, via) {
    // Nothing of a hub that cannot write is its own to relay (a lost lease: what is announced after it is held).
    if (this.#storage.readOnly || (via !== null && via !== undefined && via.shared === true)) return;
    this.#buffer.push(op);
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => this.#flush());
  }

  #flush() {
    this.#flushQueued = false;
    const ops = this.#buffer;
    this.#buffer = [];
    // Everything in `ops` is at or below this position: what the recovery appends again from.
    const eventId = this.#storage.log.lastEventId;
    this.#appending = this.#appending.then(() => this.#append(ops, eventId)).catch(NOOP);
  }

  async #append(ops, eventId) {
    // Stopped, or behind: the ops are in the log since `appended`; the next start or the recovery carries them.
    if (!this.#running || this.#behind) return;
    try {
      await this.#appendPages(ops);
      this.#landed(ops.length, eventId);
    } catch (error) {
      this.#fallBehind(error);
    }
  }

  async #appendPages(ops) {
    const node = this.#storage.nodeId;
    const headers = { by: this.#token };
    for (let i = 0; i < ops.length; i += this.#pageSize) {
      await this.#log.append(this.#topic, entryText(node, ops.slice(i, i + this.#pageSize)), { headers });
    }
  }

  #landed(count, eventId) {
    this.#appended = eventId;
    this.#behind = false;
    this.#backoff = 0;
    this.#told = false;
    this.#stats.relayed += count;
    this.#saveCursor();
  }

  // An append that failed: nothing more is appended until the recovery lands
  // what the log holds since the watermark — told once per run of failures.
  #fallBehind(error) {
    this.#behind = true;
    this.#stats.appendFailures++;
    if (!this.#told) {
      this.#told = true;
      this.#logger.warn({ event: 'shared.append.failed', topic: this.#topic, err: error });
      const message = `An append to the shared log ${this.#topic} failed; what landed since is appended again once it answers`;
      notify(this.#manager, this.#logger, 'error', failed('append', message, { topic: this.#topic, cause: error }));
    }
    this.#backoff = this.#backoff === 0 ? BACKOFF : Math.min(this.#backoff * 2, MAX_BACKOFF);
    if (!this.#running) return;
    this.#recoverTimer = setTimeout(() => this.#recover(), this.#backoff);
    this.#recoverTimer.unref?.();
  }

  // Everything the log holds since the watermark, appended again — ops that
  // came from the topic among them, duplicates there that every consumer
  // drops. A watermark the log no longer reaches (compacted: a first start on
  // a log that rolled, a long outage) is told: what fell below it reaches the
  // other hubs through a snapshot of this one.
  #recover() {
    this.#recoverTimer = null;
    if (!this.#running) return;
    this.#appending = this.#appending
      .then(async () => {
        if (!this.#running || !this.#behind) return;
        const eventId = this.#storage.log.lastEventId;
        const entries = this.#storage.log.since(this.#appended);
        if (entries === null) {
          this.#logger.warn({ event: 'shared.recover.lost', topic: this.#topic, appended: this.#appended });
          const message = `The log no longer reaches ${this.#appended ?? 'its first op'}: what fell below is not in the shared log ${this.#topic}`;
          notify(
            this.#manager,
            this.#logger,
            'error',
            failed('lost', message, { topic: this.#topic, appended: this.#appended }),
          );
          this.#landed(0, eventId);
          return;
        }
        const ops = [];
        for (let i = 0; i < entries.length; i++) ops.push(entries[i].op);
        try {
          await this.#appendPages(ops);
          this.#landed(ops.length, eventId);
        } catch (error) {
          this.#fallBehind(error);
        }
      })
      .catch(NOOP);
  }

  // -------------------------------------------------------------------------
  // The consumer

  async #consume(name, topic) {
    let backoff = 0;
    let told = false;
    while (this.#running) {
      const { signal } = this.#controller;
      const after = this.#cursor[name];
      try {
        const read = this.#log.read(topic, after === null ? { from: 'earliest', signal } : { after, signal });
        for await (const entry of read) {
          if (!this.#running) return;
          backoff = 0;
          told = false;
          if (!(await this.#take(name, topic, entry))) return;
        }
        // The read ended without an abort — the log closed, a tail that ends: read again from the cursor.
      } catch (error) {
        if (!this.#running) return;
        if (error?.code === 410 || error?.code === 400) {
          this.#lostCursor(name, topic, error);
          continue;
        }
        if (!told) {
          told = true;
          this.#logger.warn({ event: 'shared.read.failed', topic, err: error });
        }
      }
      if (!this.#running) return;
      backoff = backoff === 0 ? BACKOFF : Math.min(backoff * 2, MAX_BACKOFF);
      await sleep(backoff, this.#controller.signal);
    }
  }

  // The cursor names a position the log no longer has — trimmed past, or
  // another log's: everything it retains is read from the oldest, what fell
  // between is told once.
  #lostCursor(name, topic, error) {
    const cursor = this.#cursor[name];
    this.#cursor[name] = null;
    this.#saveCursor();
    this.#logger.warn({ event: 'shared.cursor.lost', topic, cursor, err: error });
    const message = `The shared log ${topic} no longer has ${cursor}: read from its oldest entry; what fell between is not here`;
    notify(this.#manager, this.#logger, 'error', failed('gone', message, { topic, cursor, cause: error }));
  }

  // One entry: this hub's own passed, a marker passed, the rest applied — or,
  // on a hub that cannot write, folded into the shadow vector. False stops
  // the loop: the inbox is not this hub's to land any more, or an entry that
  // would not apply three times (`stuck`, reported; `sync.stop()` and
  // `start()` read it again).
  async #take(name, topic, entry) {
    this.#stats.entries++;
    const headers = entry.headers;
    const own = headers !== undefined && headers !== null && headers.by === this.#token;
    if (!own) {
      const parsed = parseEntry(entry.value);
      if (parsed === undefined) {
        this.#stats.malformed++;
        this.#logger.warn({ event: 'shared.entry.malformed', topic, id: entry.id });
      } else if (parsed !== null) {
        if (this.#storage.readOnly) {
          if (name === 'inbox') return false;
          this.#shadowAdvance(parsed.ops);
        } else if (!(await this.#apply(name, topic, entry, parsed))) return false;
      }
    }
    this.#cursor[name] = entry.id;
    this.#passed(entry.id);
    this.#saveCursor();
    return true;
  }

  async #apply(name, topic, entry, parsed) {
    const via = { url: null, node: parsed.node };
    if (name === 'inbox') via.inbox = true;
    else via.shared = true;
    const bound = name === 'inbox' ? parsed.scopes : null;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.#storage.applyRemote(parsed.ops, { via, peer: via, bound });
        this.#stats.applied += result.applied;
        return true;
      } catch (error) {
        if (!this.#running) return false;
        if (this.#storage.readOnly) {
          // The lease went while the entry was applied: from here on the topic is shadowed, the inbox left.
          if (name === 'inbox') return false;
          this.#shadowAdvance(parsed.ops);
          return true;
        }
        this.#logger.warn({ event: 'shared.entry.failed', topic, id: entry.id, attempt, err: error });
        if (attempt >= MAX_APPLY_RETRIES) {
          this.#stuck[name] = true;
          const message = `An entry of the shared log ${topic} (${entry.id}) failed to apply ${attempt} times: nothing past it is taken until sync.stop() and start()`;
          notify(
            this.#manager,
            this.#logger,
            'error',
            failed('stuck', message, { topic, cursor: entry.id, cause: error }),
          );
          return false;
        }
        await sleep(BACKOFF * attempt, this.#controller.signal);
      }
    }
  }

  #shadowAdvance(ops) {
    const shadow = (this.#shadow ??= { ...this.#storage.vector });
    for (let i = 0; i < ops.length; i++) vectorAdvance(shadow, ops[i]);
  }

  #passed(id) {
    this.#recent.push(id);
    this.#recentSet.add(id);
    if (this.#recent.length > RECENT) this.#recentSet.delete(this.#recent.shift());
    for (const waiter of this.#waiters) {
      if (waiter.id !== id) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve();
    }
  }

  // -------------------------------------------------------------------------
  // What the hosting side asks

  /** A read-only hub's vector as the topic moved it; null while this hub writes (its own vector is current). */
  vector() {
    if (!this.#storage.readOnly) return null;
    return this.#shadow ?? (this.#shadow = { ...this.#storage.vector });
  }

  /** The topic from `after` on, live — what a `changes` feed reads. */
  read(after, signal) {
    return this.#log.read(this.#topic, { after, signal });
  }

  /** A marker appended to the topic: the position a snapshot's first page is taken at. */
  mark() {
    return this.#log.append(this.#topic, markText(this.#storage.nodeId), { headers: { by: this.#token } });
  }

  /** Resolves once the consumer passed the entry `id`; rejects after `timeout` ms. */
  reached(id, timeout = REACH_TIMEOUT) {
    if (this.#recentSet.has(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { id, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        const message = `The shared log's consumer did not reach ${id} within ${timeout} ms`;
        reject(failed('marker', message, { topic: this.#topic, cursor: id }));
      }, timeout);
      waiter.timer.unref?.();
      this.#waiters.add(waiter);
    });
  }

  /**
   * A client's push on a hub that cannot write, forwarded to the inbox for a
   * writer to land: held to the shadow vector as a push is held to the log's
   * — a duplicate dropped, a gap not taken — and the shadow moved past what
   * was forwarded once it is in the inbox (a burst's next page follows at
   * once). Answers what a push answers.
   */
  async forward(ops, node, scopes) {
    const shadow = this.vector();
    const result = {
      vector: {},
      applied: 0,
      skipped: 0,
      duplicates: 0,
      gaps: 0,
      malformed: 0,
      unsigned: 0,
      forged: 0,
      outOfScope: 0,
      equivocations: 0,
      forwarded: true,
    };
    const taking = [];
    const seqs = {};
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!wellFormed(op)) {
        result.malformed++;
        continue;
      }
      const key = opKey(op);
      const held = Object.hasOwn(seqs, key) ? seqs[key] : Object.hasOwn(shadow, key) ? shadow[key] : 0;
      if (op.seq <= held) {
        result.duplicates++;
        continue;
      }
      if (op.seq !== held + 1) {
        result.gaps++;
        continue;
      }
      seqs[key] = op.seq;
      taking.push(op);
    }
    if (taking.length === 0) return result;
    const headers = { by: this.#token };
    for (let i = 0; i < taking.length; i += this.#pageSize) {
      await this.#log.append(this.#inbox, entryText(node, taking.slice(i, i + this.#pageSize), scopes), { headers });
    }
    for (let i = 0; i < taking.length; i++) vectorAdvance(shadow, taking[i]);
    result.vector = seqs;
    result.applied = taking.length;
    this.#stats.forwarded += taking.length;
    return result;
  }
}

module.exports = { SharedHub, normalizeShared, parseEntry, sleep, DEFAULT_TOPIC };
