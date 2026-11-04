'use strict';

// A shared log over MongoDB (`mongoSharedLog()`, @alexify/syncom/mongodb): the
// contract `createDatabase({ sync: { sharedLog } })` takes — `append`, `read`,
// `parseId`, the shape of wrpc's `BrokerLog` — over two collections of the
// driver's database, for the hubs of a mesh that share a MongoDB and no
// broker. An entry is a document `{ _id: [topic, n], topic, n, v, h, at }`, its
// id `<epoch>.<n>`: the topic's head document (`{ _id: topic, epoch, next,
// first }`) hands out `n` with one `findOneAndUpdate` — the one round trip two
// appenders agree through — and the entry is inserted after, so a reader that
// finds `n + 1` before `n` waits for `n` (`gapTimeout`, 2 s: an appender's
// insert is one round trip behind its number, a hole older than that is a
// crashed appender's). A read is a range by `n` over an index, then a tail:
// woken by a change stream on the collection where the server has them
// (`changes`, a replica set), polled every `poll` ms otherwise — a stream that
// fails falls back to the poll. `after` names an entry of another epoch or one
// trimmed past as 410, a malformed id or one past the tip as 400, the codes
// wrpc's feeds speak. `trim(topic, keep)` drops all but the newest `keep`;
// `retention.maxEntries` does it on every 64th append. The client is the
// caller's: nothing here connects or closes it. Requires nothing of the core.

const DEFAULT_COLLECTION = 'shared';
const LOG_ID = /^[A-Za-z0-9_-]{1,64}\.\d{1,16}$/;
const PAGE = 256;
// A retention check every so many appends.
const TRIM_EVERY = 64;

const decoder = new TextDecoder();

const coded = (message, code) => {
  const error = new Error(message);
  error.code = code;
  error.expose = true;
  return error;
};

const toText = (value) => {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return decoder.decode(value);
  throw new TypeError('mongoSharedLog.append: value must be a string or a Uint8Array');
};

// Headers as a plain string map; a key no one should set as a field stays a plain entry.
const toHeaders = (value) => {
  const headers = {};
  if (value === undefined || value === null || typeof value !== 'object') return headers;
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (entry === undefined || entry === null) continue;
    headers[key] = typeof entry === 'string' ? entry : String(entry);
  }
  return headers;
};

const epochOf = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms, signal) =>
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

/**
 * A shared log over the MongoDB database `db` (or `client.db(name)`): the
 * entries in `collection`, the topics' heads in `<collection>_heads`.
 */
const mongoSharedLog = ({
  client = null,
  db = null,
  name = 'syncom',
  collection = DEFAULT_COLLECTION,
  changes = true,
  poll = 250,
  gapTimeout = 2000,
  retention = null,
  logger = null,
} = {}) => {
  if (db === null && (client === null || typeof client.db !== 'function')) {
    throw new TypeError('mongoSharedLog: a connected MongoClient (client) or a Db (db) is required');
  }
  if (typeof collection !== 'string' || collection.length === 0) {
    throw new TypeError('mongoSharedLog: collection must be a non-empty string');
  }
  if (!Number.isFinite(poll) || poll <= 0) throw new TypeError('mongoSharedLog: poll must be a positive number');
  if (!Number.isFinite(gapTimeout) || gapTimeout < 0) {
    throw new TypeError('mongoSharedLog: gapTimeout must be a non-negative number');
  }
  const maxEntries = retention?.maxEntries;
  if (maxEntries !== undefined && !(Number.isInteger(maxEntries) && maxEntries > 0)) {
    throw new TypeError('mongoSharedLog: retention.maxEntries must be a positive integer');
  }
  const database = db ?? client.db(name);
  const entries = database.collection(collection);
  const heads = database.collection(`${collection}_heads`);
  let indexed = null;
  const ensure = () => {
    indexed ??= entries.createIndex({ topic: 1, n: 1 }).then(() => undefined);
    return indexed;
  };
  const keyOf = (topic, n) => JSON.stringify([topic, n]);
  const appends = new Map();
  // One tail per topic of this instance, shared by every reader of it: the
  // change stream (or the poll) wakes every waiter once.
  const tails = new Map();
  let closed = false;

  const requireTopic = (topic, where) => {
    if (typeof topic !== 'string' || topic.length === 0) {
      throw new TypeError(`${where}: topic must be a non-empty string`);
    }
  };

  // The head of a topic, its `next` taken one up: the number of this append and the topic's epoch.
  const number = async (topic) => {
    const taken = await heads.findOneAndUpdate(
      { _id: topic },
      [
        {
          $set: {
            next: { $add: [{ $ifNull: ['$next', 1] }, 1] },
            epoch: { $ifNull: ['$epoch', epochOf()] },
            first: { $ifNull: ['$first', 1] },
          },
        },
      ],
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );
    const head = taken?.value ?? taken;
    return { n: head.next - 1, epoch: head.epoch, first: head.first };
  };

  const trimTo = async (topic, floor) => {
    await entries.deleteMany({ topic, n: { $lt: floor } });
    await heads.updateOne({ _id: topic }, { $max: { first: floor } });
  };

  const append = async (topic, value, options = {}) => {
    requireTopic(topic, 'mongoSharedLog.append');
    if (closed) throw coded('The shared log is closed', 503);
    const text = toText(value);
    const h = toHeaders(options.headers);
    await ensure();
    const { n, epoch, first } = await number(topic);
    await entries.insertOne({ _id: keyOf(topic, n), topic, n, v: text, h, at: new Date() });
    if (maxEntries !== undefined) {
      const count = (appends.get(topic) ?? 0) + 1;
      appends.set(topic, count % TRIM_EVERY);
      const floor = n - maxEntries + 1;
      if (count % TRIM_EVERY === 0 && floor > first) await trimTo(topic, floor);
    }
    const tail = tails.get(topic);
    if (tail !== undefined) tail.wake();
    return `${epoch}.${n}`;
  };

  const parseId = (text) => (typeof text === 'string' && LOG_ID.test(text) ? text : null);

  // The tail of a topic: a change stream on the collection, matched to the
  // topic on the server, wakes the waiters; where there is none, or it
  // failed, the waiters wake every `poll` ms.
  const tailOf = (topic) => {
    let tail = tails.get(topic);
    if (tail !== undefined) return tail;
    const waiters = new Set();
    let stream = null;
    let readers = 0;
    const wake = () => {
      if (waiters.size === 0) return;
      const woken = [...waiters];
      waiters.clear();
      for (let i = 0; i < woken.length; i++) woken[i]();
    };
    const listen = () => {
      if (!changes || stream !== null) return;
      try {
        stream = entries.watch([{ $match: { 'fullDocument.topic': topic } }], { fullDocument: 'updateLookup' });
      } catch (error) {
        logger?.warn?.({ event: 'shared.stream.failed', topic, err: error });
        stream = null;
        return;
      }
      const over = (error) => {
        if (stream === null) return;
        const closing = stream;
        stream = null;
        logger?.warn?.({ event: 'shared.stream.failed', topic, err: error });
        try {
          closing.close()?.catch?.(() => {});
        } catch {
          // Closed already.
        }
        wake();
      };
      stream.on('change', wake);
      stream.on('error', over);
      stream.on('close', () => over(new Error(`the change stream on ${topic} closed`)));
      stream.on('end', () => over(new Error(`the change stream on ${topic} ended`)));
    };
    tail = {
      wake,
      enter() {
        readers++;
        listen();
      },
      leave() {
        if (--readers > 0) return;
        tails.delete(topic);
        if (stream !== null) {
          const closing = stream;
          stream = null;
          try {
            closing.close()?.catch?.(() => {});
          } catch {
            // Closed already.
          }
        }
      },
      // Until an entry lands, the poll elapses or the reader is done.
      wait(signal) {
        return new Promise((resolve) => {
          const timer = setTimeout(done, poll);
          timer.unref?.();
          function done() {
            clearTimeout(timer);
            waiters.delete(done);
            signal?.removeEventListener?.('abort', done);
            resolve();
          }
          waiters.add(done);
          signal?.addEventListener?.('abort', done, { once: true });
        });
      },
    };
    tails.set(topic, tail);
    return tail;
  };

  const read = (topic, { after = null, from = 'latest', signal = null } = {}) => {
    requireTopic(topic, 'mongoSharedLog.read');
    if (from !== 'latest' && from !== 'earliest') {
      throw new TypeError("mongoSharedLog.read: from must be 'latest' or 'earliest'");
    }
    const iterate = async function* () {
      if (closed) throw coded('The shared log is closed', 503);
      await ensure();
      const head = await heads.findOne({ _id: topic });
      // A topic never appended to has no epoch yet: the first head seen is its.
      let epoch = head?.epoch ?? null;
      let position;
      if (after !== null && after !== undefined) {
        const id = parseId(after);
        if (id === null) throw coded('Malformed event id', 400);
        const dot = id.lastIndexOf('.');
        const n = Number(id.slice(dot + 1));
        if (epoch === null || id.slice(0, dot) !== epoch) throw coded('Event id belongs to another log', 410);
        if (n >= head.next) throw coded('Event id is beyond the end of the log', 400);
        if (n + 1 < head.first) throw coded('Event history was trimmed past this id', 410);
        position = n + 1;
      } else position = from === 'earliest' ? (head?.first ?? 1) : (head?.next ?? 1);
      const tail = tailOf(topic);
      tail.enter();
      try {
        // How long the entry at `position` has been waited for: a hole older than `gapTimeout` is skipped.
        let waitedSince = 0;
        for (;;) {
          if (signal?.aborted || closed) return;
          const query = { topic, n: { $gte: position } };
          // oxlint-disable-next-line no-restricted-properties -- the driver's find, not an array's
          const found = entries.find(query, { sort: { n: 1 }, limit: PAGE, projection: { _id: 0 } });
          const docs = await found.toArray();
          if (docs.length === 0) {
            if (signal?.aborted || closed) return;
            await tail.wait(signal);
            continue;
          }
          let yielded = false;
          for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            if (doc.n > position) {
              // A number handed out whose entry is not here yet, or never will be.
              if (waitedSince === 0) waitedSince = Date.now();
              if (Date.now() - waitedSince < gapTimeout) break;
              position = doc.n;
            }
            waitedSince = 0;
            yielded = true;
            const current = await heads.findOne({ _id: topic }, { projection: { _id: 0, epoch: 1, first: 1 } });
            if (current === null) throw coded('Event id belongs to another log', 410);
            if (epoch === null) epoch = current.epoch;
            else if (current.epoch !== epoch) throw coded('Event id belongs to another log', 410);
            if (doc.n < current.first) throw coded('Event history was trimmed past this reader', 410);
            position = doc.n + 1;
            yield { id: `${epoch}.${doc.n}`, value: doc.v, headers: { ...doc.h } };
          }
          if (!yielded) await sleep(Math.min(poll, 50), signal);
        }
      } finally {
        tail.leave();
      }
    };
    return { ready: Promise.resolve(), [Symbol.asyncIterator]: () => iterate() };
  };

  const trim = async (topic, keep) => {
    requireTopic(topic, 'mongoSharedLog.trim');
    if (!Number.isInteger(keep) || keep < 0) {
      throw new TypeError('mongoSharedLog.trim: keep must be a non-negative integer');
    }
    const head = await heads.findOne({ _id: topic });
    if (head === null) return;
    const floor = head.next - keep;
    if (floor > head.first) await trimTo(topic, floor);
  };

  return Object.freeze({
    name: 'mongodb',
    append,
    read,
    parseId,
    trim,
    /** The topic's head: its epoch, the next number and the oldest kept, or null for a topic never appended to. */
    async head(topic) {
      requireTopic(topic, 'mongoSharedLog.head');
      const doc = await heads.findOne({ _id: topic });
      return doc === null ? null : { epoch: doc.epoch, next: doc.next, first: doc.first };
    },
    /** Stops every tail; a read after it fails with 503. The client is the caller's. */
    async close() {
      closed = true;
      for (const tail of [...tails.values()]) tail.wake();
    },
  });
};

module.exports = { mongoSharedLog };
