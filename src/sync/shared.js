'use strict';

// One log shared by the hubs of a mesh, so a client resumes on any hub: a
// broker's stream (wrpc's `BrokerLog` — Redis Streams, NATS, Kafka, AMQP, the
// memory broker — the shape `isSharedLog` checks) or `mongoSharedLog`
// (@alexify/syncom/mongodb). Three halves live here, over the manager's storage:
//
//   the RELAY — every op this hub accepts (its own writes, a client's push, a
//     joined snapshot, an inbox entry) goes to the topic, a batch per tick (what
//     one announce leaves), `pageSize` ops an entry at most; what came from the
//     topic itself (`via.shared`) does not go back. Every op is offered with its
//     log position (the `change` event's `seq`), and the WATERMARK is the last
//     position every op at or below which is in the topic — moved only by a
//     contiguous run of positions appended or read from the topic, never by
//     `lastEventId`, which runs ahead of ops still landing. An append that fails
//     leaves the relay `behind`, and the recovery appends everything the log
//     holds above the watermark (`log.since`), backed off; every start does the
//     same (a stop may leave ops above it), and a watermark the log compacted
//     past is told once and moved to the log's floor — what the log retains
//     joins the topic, what fell below reaches the others through a snapshot.
//   the CONSUMER — a hub that writes reads the topic from its saved cursor and
//     applies what it lacks (one `applyRemote` per entry, the appender as `via`),
//     and the inbox — what a read-only hub forwarded of its clients' pushes —
//     the same way, whose ops then reach the topic through the relay. A hub that
//     cannot write (a follower over MongoDB, a writer whose lease was lost)
//     applies nothing: it shadows the vector as the log moves it — what its
//     hello answers and what a push it forwards is held to.
//   the FEED — `changes` on a hub with a shared log reads the topic from the
//     client's cursor (src/sync/hosting.js) through `read()`: ONE read of the
//     log per hub — the consumer's — serves every feed from a ring of the
//     entries it passed last (`RING`), woken as it passes; a cursor behind the
//     ring (or ahead of the consumer, or a stopped one) reads the log its own
//     way until an entry the ring holds comes by. A snapshot's first page is
//     positioned at a marker this hub appended — behind every op offered before
//     it, refused while the relay is behind — and its consumer reached; the
//     vector it carries is what this hub's reads reflect (`#relayed`: moved by
//     every op offered, never by a position reserved but not landed), so the
//     client takes as seen nothing a page could lack. A hub that cannot write
//     serves no snapshot: its shadow runs ahead of its engine.
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
const { vectorAdvance, opKey, parseEventId } = require('../vector.js');
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
// An entry whose apply a rule refuses this many times in a row leaves its topic stuck (a hook that throws, a bug);
// the engine's refusals — the medium down, a lease late, a group the log refused — are tried again until they land.
const MAX_APPLY_RETRIES = 3;
// How long a snapshot waits for the consumer to reach its marker.
const REACH_TIMEOUT = 30_000;
// A writer trims the inbox past its cursor every so many inbox entries passed (`log.trimBefore`, where the log has it).
const INBOX_TRIM_EVERY = 64;
// The entries of the topic the consumer passed last, kept for the feeds: a feed whose cursor is among them reads
// from here, never from the log.
const RING = 1024;
// How long `stop()` waits for an append in flight before it lets go of it (`sharedLog.stopWait`): what it carried
// is above the watermark, so the next start appends it again.
const DEFAULT_STOP_WAIT = 5000;
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

/** `createDatabase({ sync: { sharedLog } })` checked: `{ log, topic, inbox, stopWait }`, or null when none was given. */
const normalizeShared = (value) => {
  if (value === undefined || value === null) return null;
  const given = isSharedLog(value) ? { log: value } : value;
  if (!isPlainObject(given) || !isSharedLog(given.log)) {
    throw new TypeError('sync.sharedLog: a shared log (append, read, parseId), or { log, topic, inbox, stopWait }');
  }
  const { topic = DEFAULT_TOPIC, stopWait = DEFAULT_STOP_WAIT } = given;
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new TypeError('sync.sharedLog.topic must be a non-empty string');
  }
  const inbox = given.inbox === undefined ? `${topic}.inbox` : given.inbox;
  if (inbox !== false && (typeof inbox !== 'string' || inbox.length === 0 || inbox === topic)) {
    throw new TypeError('sync.sharedLog.inbox must be a non-empty string other than the topic, or false');
  }
  if (!Number.isInteger(stopWait) || stopWait < 0) {
    throw new TypeError('sync.sharedLog.stopWait must be a non-negative integer of milliseconds');
  }
  return { log: given.log, topic, inbox, stopWait };
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
  if (typeof text !== 'string') return undefined;
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
  #stopWait;
  #token = token();
  // The relay: the ops of this tick with their log positions, the chain every append runs on, the watermark (the
  // last position every op at or below which is in the topic; 0 for none), the positions above it that are (sorted),
  // and the recovery after a failed append.
  #buffer = [];
  #flushQueued = false;
  #appending = Promise.resolve();
  #appendedSeq = 0;
  #covered = [];
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
  // The ring the feeds read: the topic's entries passed last, each's ordinal (`#ringNext` counting up, `#ringBase`
  // the first kept), and the feeds waiting for the next one.
  #ring = [];
  #ringOrdinal = new Map();
  #ringNext = 0;
  #ringBase = 0;
  #feedWaiters = new Set();
  #stuck = { topic: false, inbox: false };
  // A topic whose entry fails on the engine and is tried again, backed off (told once per run).
  #retrying = { topic: false, inbox: false };
  #inboxPassed = 0;
  // A read-only hub's vector, as the topic moves it; null while this hub writes.
  #shadow = null;
  // A writing hub's vector as its reads reflect it: every op offered (announced, so landed), none merely reserved —
  // what a hello and a snapshot's first page answer, so a client takes as seen nothing a page could lack.
  #relayed;
  #stats = { relayed: 0, appendFailures: 0, entries: 0, applied: 0, forwarded: 0, malformed: 0, holes: 0 };

  constructor(
    manager,
    storage,
    { log, topic, inbox, stopWait = DEFAULT_STOP_WAIT },
    { kv, pageSize = DEFAULT_PAGE_SIZE },
  ) {
    this.#manager = manager;
    this.#storage = storage;
    this.#logger = storage.logger;
    this.#log = log;
    this.#topic = topic;
    this.#inbox = inbox;
    this.#stopWait = stopWait;
    this.#kv = kv;
    this.#pageSize = pageSize;
    // Nothing is in flight at the open: what the log holds is what the records show.
    this.#relayed = { ...storage.vector };
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
    this.#retrying = { topic: false, inbox: false };
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
    // Every start recovers: what the log holds above the watermark goes to the topic — a hub joins the log with
    // its state, a hub stopped with ops waiting appends them, a hub whose last run ended behind catches up.
    if (!readOnly) {
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
    // The feeds read the log their own way while the consumer is stopped.
    this.#wakeFeeds();
    await Promise.allSettled(this.#loops);
    this.#loops = [];
    // An append the broker never answers does not hold the stop: what it carried is above the watermark, and the
    // next start appends it again — on a chain of its own, never behind the one that hung.
    await Promise.race([this.#appending, sleep(this.#stopWait)]);
    this.#appending = Promise.resolve();
    await this.#saving;
  }

  /** The cursors, the relay's watermark and the counts — `sync.shared()`. */
  stats() {
    return {
      topic: this.#topic,
      inbox: this.#inbox,
      running: this.#running,
      cursor: { ...this.#cursor },
      appended: this.#watermark(),
      covered: this.#covered.length,
      behind: this.#behind,
      stuck: { ...this.#stuck },
      retrying: { ...this.#retrying },
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
    // The watermark is a position of this log: another epoch's (the log began anew) is none.
    const appended = parseEventId(parsed.appended);
    this.#appendedSeq = appended !== null && appended.epoch === this.#storage.log.epoch ? appended.seq : 0;
  }

  // The watermark as an event id of this log, null while nothing is known to be in the topic.
  #watermark() {
    return this.#appendedSeq > 0 ? this.#storage.log.formatId(this.#appendedSeq) : null;
  }

  #saveCursor() {
    if (this.#storage.readOnly || this.#saveQueued) return;
    this.#saveQueued = true;
    this.#saving = this.#saving.then(async () => {
      this.#saveQueued = false;
      const text = JSON.stringify({
        topic: this.#cursor.topic,
        inbox: this.#cursor.inbox,
        appended: this.#watermark(),
      });
      try {
        await this.#kv.put(SHARED, CURSOR, text, { atomic: true });
      } catch (error) {
        this.#logger.warn({ event: 'shared.cursor.failed', topic: this.#topic, err: error });
      }
    });
  }

  // -------------------------------------------------------------------------
  // The relay

  /**
   * An op this hub accepted (`#fanOut`), with its log position: appended with the others of its tick — unless it
   * came from the topic, which holds it already: covered, never appended back.
   */
  offer(op, via, seq = null) {
    // Nothing of a hub that cannot write is its own to relay (a lost lease: what is announced after it is held).
    if (this.#storage.readOnly) return;
    vectorAdvance(this.#relayed, op);
    if (via !== null && via !== undefined && via.shared === true) {
      if (seq !== null) this.#cover(seq);
      return;
    }
    this.#buffer.push({ op, seq });
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => this.#flush());
  }

  #flush() {
    this.#flushQueued = false;
    const items = this.#buffer;
    this.#buffer = [];
    if (items.length === 0) return;
    this.#appending = this.#appending.then(() => this.#append(items)).catch(NOOP);
  }

  async #append(items) {
    // Stopped, or behind: the ops are in the log above the watermark; the next start or the recovery carries them.
    if (!this.#running || this.#behind) return;
    const ops = [];
    for (let i = 0; i < items.length; i++) {
      // At or below the watermark: a recovery carried it already.
      if (items[i].seq !== null && items[i].seq <= this.#appendedSeq) continue;
      ops.push(items[i].op);
    }
    if (ops.length === 0) return;
    try {
      await this.#appendPages(ops);
      this.#landed(items);
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

  // A batch landed in the topic: its positions are covered; the watermark moves as far as the run from it is whole.
  #landed(items) {
    if (!this.#running) return;
    this.#behind = false;
    this.#backoff = 0;
    this.#told = false;
    this.#stats.relayed += items.length;
    for (let i = 0; i < items.length; i++) if (items[i].seq !== null) this.#cover(items[i].seq);
  }

  // A position known to be in the topic: kept above the watermark, sorted, until the run from the watermark
  // reaches it — then the watermark moves over it (`#advance`). An op whose position the log holds but that was
  // never offered would hold the watermark; the recovery sets it straight from what the log holds.
  #cover(seq) {
    if (seq <= this.#appendedSeq) return;
    const list = this.#covered;
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (list[mid] < seq) low = mid + 1;
      else high = mid;
    }
    if (low < list.length && list[low] === seq) return;
    list.splice(low, 0, seq);
    this.#advance();
  }

  #advance() {
    const list = this.#covered;
    let moved = false;
    while (list.length > 0 && list[0] === this.#appendedSeq + 1) {
      list.shift();
      this.#appendedSeq++;
      moved = true;
    }
    if (moved) this.#saveCursor();
  }

  // Everything the log holds above `seq` was appended: the watermark is there, what was covered above it is let go.
  #reached(seq) {
    if (seq <= this.#appendedSeq) return;
    this.#appendedSeq = seq;
    const list = this.#covered;
    let kept = 0;
    while (kept < list.length && list[kept] <= seq) kept++;
    if (kept > 0) list.splice(0, kept);
    this.#saveCursor();
  }

  // An append that failed: nothing more is appended until the recovery lands
  // what the log holds above the watermark — told once per run of failures.
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

  // Everything the log holds above the watermark, appended again — ops that
  // came from the topic among them, duplicates there that every consumer
  // drops — and the watermark moved to the last of them. A watermark the log
  // no longer reaches (compacted: a first start on a log that rolled, a long
  // outage) is told once and moved to the log's floor: what the log retains
  // joins the topic, what fell below reaches the other hubs through a snapshot
  // of this one.
  #recover() {
    this.#recoverTimer = null;
    if (!this.#running) return;
    this.#appending = this.#appending
      .then(async () => {
        if (!this.#running || !this.#behind) return;
        const { log } = this.#storage;
        let entries = log.since(this.#watermark());
        if (entries === null) {
          const appended = this.#watermark();
          this.#logger.warn({ event: 'shared.recover.lost', topic: this.#topic, appended });
          const message = `The log no longer reaches ${appended ?? 'its first op'}: what fell below is not in the shared log ${this.#topic}`;
          notify(this.#manager, this.#logger, 'error', failed('lost', message, { topic: this.#topic, appended }));
          this.#reached(log.floor - 1);
          entries = log.since(this.#watermark()) ?? [];
        }
        const ops = [];
        let last = this.#appendedSeq;
        for (let i = 0; i < entries.length; i++) {
          ops.push(entries[i].op);
          if (entries[i].seq > last) last = entries[i].seq;
        }
        try {
          await this.#appendPages(ops);
          if (!this.#running) return;
          this.#behind = false;
          this.#backoff = 0;
          this.#told = false;
          this.#stats.relayed += ops.length;
          this.#reached(last);
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
  // the loop: the inbox is not this hub's to land any more, or an entry a
  // rule refused three times (`stuck`, reported; `sync.stop()` and `start()`
  // read it again) — an entry the engine refused is tried again until it lands.
  async #take(name, topic, entry) {
    this.#stats.entries++;
    // A hole: a number the log handed out whose entry never came (a crashed appender's). Told — what it carried is
    // in no one's hands but the appender's, whose recovery appends it again when it comes back — and passed.
    if (entry.value === null) {
      this.#stats.holes++;
      this.#logger.warn({ event: 'shared.hole', topic, id: entry.id });
      const message = `The shared log ${topic} has a hole at ${entry.id}: an appender's entry never came`;
      notify(this.#manager, this.#logger, 'error', failed('hole', message, { topic, cursor: entry.id }));
      this.#cursor[name] = entry.id;
      this.#passed(entry.id);
      if (name === 'topic') this.#ringPush(entry);
      this.#saveCursor();
      return true;
    }
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
    if (name === 'topic') this.#ringPush(entry);
    this.#saveCursor();
    // What the writer landed of the inbox is no one else's to read: trimmed past the cursor now and then.
    if (name === 'inbox' && ++this.#inboxPassed >= INBOX_TRIM_EVERY) {
      this.#inboxPassed = 0;
      this.#trimInbox(topic, entry.id);
    }
    return true;
  }

  #trimInbox(topic, id) {
    if (typeof this.#log.trimBefore !== 'function') return;
    this.#log
      .trimBefore(topic, id)
      .catch((error) => this.#logger.warn({ event: 'shared.inbox.trim.failed', topic, cursor: id, err: error }));
  }

  async #apply(name, topic, entry, parsed) {
    const via = { url: null, node: parsed.node };
    if (name === 'inbox') via.inbox = true;
    else via.shared = true;
    const bound = name === 'inbox' ? parsed.scopes : null;
    let backoff = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.#storage.applyRemote(parsed.ops, { via, peer: via, bound });
        this.#stats.applied += result.applied;
        this.#retrying[name] = false;
        return true;
      } catch (error) {
        if (!this.#running) return false;
        if (this.#storage.readOnly) {
          // The lease went while the entry was applied: from here on the topic is shadowed, the inbox left.
          if (name === 'inbox') return false;
          this.#shadowAdvance(parsed.ops);
          return true;
        }
        // Closed under the apply: the loop ends with the hub.
        if (error?.code === 'CLOSED') return false;
        this.#logger.warn({ event: 'shared.entry.failed', topic, id: entry.id, attempt, err: error });
        // A rule's refusal is the same at every try — a hook that throws, a bug (a TypeError): three times and the
        // topic is stuck, for someone to look at. The engine's is not — the medium down, a lease late, a group the
        // log refused: tried again, backed off, until it lands; told once per run.
        const deterministic = error?.code === 'HOOK_FAILED' || error instanceof TypeError;
        if (deterministic) {
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
          continue;
        }
        if (!this.#retrying[name]) {
          this.#retrying[name] = true;
          const message = `An entry of the shared log ${topic} (${entry.id}) failed to apply (${error?.code ?? error?.name ?? 'error'}): tried again until it lands`;
          notify(
            this.#manager,
            this.#logger,
            'error',
            failed('apply', message, { topic, cursor: entry.id, attempt, cause: error }),
          );
        }
        backoff = backoff === 0 ? BACKOFF : Math.min(backoff * 2, MAX_BACKOFF);
        await sleep(backoff, this.#controller.signal);
      }
    }
  }

  #shadowAdvance(ops) {
    const shadow = (this.#shadow ??= { ...this.#storage.vector });
    for (let i = 0; i < ops.length; i++) vectorAdvance(shadow, ops[i]);
  }

  // An entry of the topic passed, kept for the feeds; the oldest let go of past RING; every feed waiting woken.
  #ringPush(entry) {
    this.#ring.push({ id: entry.id, value: entry.value, headers: entry.headers });
    this.#ringOrdinal.set(entry.id, this.#ringNext++);
    if (this.#ring.length > RING) {
      const gone = this.#ring.shift();
      this.#ringOrdinal.delete(gone.id);
      this.#ringBase++;
    }
    this.#wakeFeeds();
  }

  // Where the entry `id` sits in the ring, -1 for none: behind it, ahead of what the consumer passed, or not of the topic.
  #ringIndex(id) {
    const ordinal = this.#ringOrdinal.get(id);
    return ordinal === undefined ? -1 : ordinal - this.#ringBase;
  }

  #wakeFeeds() {
    if (this.#feedWaiters.size === 0) return;
    const woken = [...this.#feedWaiters];
    this.#feedWaiters.clear();
    for (let i = 0; i < woken.length; i++) woken[i]();
  }

  // Until the consumer passes an entry, the hub stops, or the feed's signal aborts.
  #waitFeed(signal) {
    return new Promise((resolve) => {
      const done = () => {
        this.#feedWaiters.delete(done);
        signal?.removeEventListener?.('abort', done);
        resolve();
      };
      this.#feedWaiters.add(done);
      signal?.addEventListener?.('abort', done, { once: true });
    });
  }

  // A feed over the topic from `after`: from the ring where the cursor is in it, woken as the consumer passes the
  // next; from a read of the log's own where it is not — behind the ring, ahead of the consumer, or the consumer
  // stopped — until an entry the ring holds comes by, and over to the ring then. A read of the log that ends ends
  // the feed, which its caller reads again from its cursor.
  async *#feed(after, signal) {
    let cursor = after;
    for (;;) {
      if (signal?.aborted) return;
      if (this.#running && this.#ringIndex(cursor) !== -1) {
        for (;;) {
          if (signal?.aborted) return;
          if (!this.#running) break;
          const index = this.#ringIndex(cursor);
          if (index === -1) break;
          if (index + 1 < this.#ring.length) {
            const entry = this.#ring[index + 1];
            cursor = entry.id;
            yield entry;
            continue;
          }
          await this.#waitFeed(signal);
        }
        continue;
      }
      let caught = false;
      for await (const entry of this.#log.read(this.#topic, { after: cursor, signal })) {
        if (signal?.aborted) return;
        cursor = entry.id;
        yield entry;
        if (this.#running && this.#ringIndex(entry.id) !== -1) {
          caught = true;
          break;
        }
      }
      if (!caught) return;
    }
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

  /**
   * The vector this hub answers at hello and on a snapshot's first page: a read-only hub's as the topic moved it;
   * a writing hub's as its reads reflect it — every op announced, none merely reserved in the log.
   */
  vector() {
    if (!this.#storage.readOnly) return this.#relayed;
    return this.#shadow ?? (this.#shadow = { ...this.#storage.vector });
  }

  /**
   * The topic from `after` on, live — what a `changes` feed reads: the shape of a log's read, served from the
   * consumer's ring where the cursor is in it (one read of the log per hub, however many feeds), the log's own read
   * where it is not.
   */
  read(after, signal) {
    return { ready: Promise.resolve(), [Symbol.asyncIterator]: () => this.#feed(after, signal) };
  }

  /**
   * A marker appended to the topic: the position a snapshot's first page is taken at. Behind every op offered so
   * far (the tick's batch flushed first, the append chained after it), so what the vector claims is in the topic
   * before the marker or on the page; refused while the relay is behind — the topic lacks ops of this hub then,
   * and no position in it is the page's.
   */
  mark() {
    this.#flush();
    const marked = this.#appending.then(() => {
      if (this.#behind) {
        const message = `The relay of the shared log ${this.#topic} is behind: no snapshot can be positioned until it recovers`;
        throw failed('behind', message, { topic: this.#topic });
      }
      return this.#log.append(this.#topic, markText(this.#storage.nodeId), { headers: { by: this.#token } });
    });
    this.#appending = marked.catch(NOOP);
    return marked;
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
