'use strict';

// A shared log in memory for the hub tests: the contract `createDatabase({ sync:
// { sharedLog } })` takes — wrpc's `BrokerLog` shape (`append`, `read`,
// `parseId`), with the memory broker's rules: ids `<epoch>.<n>`, a read after
// an id of another epoch or one trimmed past is 410, a malformed id or one past
// the tip 400, a read tails live until its signal aborts. `fail(topic)` makes
// the next appends to a topic throw (what a broker outage looks like), `hang(topic)` makes the next
// append wait until `release()` (a broker that never answers), `trim(topic, keep)` drops the oldest,
// `entries(topic)` is what a test asserts on.

const LOG_ID = /^[A-Za-z0-9_-]{1,64}\.\d{1,16}$/;

const coded = (message, code) => Object.assign(new Error(message), { code, expose: true });

const createMemorySharedLog = ({ epoch = Math.random().toString(36).slice(2, 10), maxEntries = Infinity } = {}) => {
  const topics = new Map();
  let closed = false;
  const failing = new Map();
  const hanging = new Set();
  const held = [];
  const state = (topic) => {
    let found = topics.get(topic);
    if (!found) topics.set(topic, (found = { entries: [], first: 1, next: 1, waiters: new Set() }));
    return found;
  };
  const wake = (found) => {
    const waiters = [...found.waiters];
    found.waiters.clear();
    for (const waiter of waiters) waiter();
  };
  const wait = (found, signal) =>
    new Promise((resolve) => {
      const done = () => {
        found.waiters.delete(done);
        signal?.removeEventListener?.('abort', done);
        resolve();
      };
      found.waiters.add(done);
      signal?.addEventListener?.('abort', done, { once: true });
    });
  const trim = (topic, keep) => {
    const found = topics.get(topic);
    if (!found) return;
    const excess = found.entries.length - keep;
    if (excess <= 0) return;
    found.entries.splice(0, excess);
    found.first += excess;
  };
  return {
    name: 'memory',
    epoch,
    async append(topic, value, { headers = {} } = {}) {
      if (closed) throw coded('closed', 503);
      if (hanging.has(topic)) {
        hanging.delete(topic);
        await new Promise((resolve) => held.push(resolve));
      }
      const remaining = failing.get(topic);
      if (remaining !== undefined) {
        if (remaining === 1) failing.delete(topic);
        else failing.set(topic, remaining - 1);
        throw coded(`the broker is down (${topic})`, 503);
      }
      const found = state(topic);
      const n = found.next++;
      const id = `${epoch}.${n}`;
      found.entries.push({
        id,
        value: typeof value === 'string' ? value : new TextDecoder().decode(value),
        headers: { ...headers },
      });
      if (found.entries.length > maxEntries) trim(topic, maxEntries);
      queueMicrotask(() => wake(found));
      return id;
    },
    read(topic, { after = null, from = 'latest', signal = null } = {}) {
      const found = state(topic);
      let position;
      let failure = null;
      if (after !== null && after !== undefined) {
        if (!LOG_ID.test(after)) failure = coded('Malformed event id', 400);
        else {
          const dot = after.lastIndexOf('.');
          const n = Number(after.slice(dot + 1));
          if (after.slice(0, dot) !== epoch) failure = coded('Event id belongs to another log', 410);
          else if (n >= found.next) failure = coded('Event id is beyond the end of the log', 400);
          else if (n + 1 < found.first) failure = coded('Event history was trimmed past this id', 410);
          else position = n + 1;
        }
      } else position = from === 'earliest' ? found.first : found.next;
      const iterate = async function* () {
        if (failure) throw failure;
        for (;;) {
          if (signal?.aborted || closed) return;
          if (position < found.first) throw coded('Event history was trimmed past this reader', 410);
          if (position < found.next) {
            const entry = found.entries[position - found.first];
            position++;
            yield { id: entry.id, value: entry.value, headers: { ...entry.headers } };
            continue;
          }
          await wait(found, signal);
        }
      };
      return { ready: Promise.resolve(), [Symbol.asyncIterator]: iterate };
    },
    parseId: (text) => (typeof text === 'string' && LOG_ID.test(text) ? text : null),
    trim,
    /** The next `count` appends to `topic` fail with 503. */
    fail(topic, count = 1) {
      failing.set(topic, count);
    },
    /** The next append to `topic` waits until `release()`. */
    hang(topic) {
      hanging.add(topic);
    },
    /** Every append held by `hang` goes on. */
    release() {
      const waiting = held.splice(0);
      for (const resolve of waiting) resolve();
    },
    entries: (topic) =>
      (topics.get(topic)?.entries ?? []).map((entry) => ({ ...entry, headers: { ...entry.headers } })),
    close() {
      closed = true;
      for (const found of topics.values()) wake(found);
    },
  };
};

module.exports = { createMemorySharedLog };
