'use strict';

// An engine over a message port (@alexify/syncom/engines): `serveEngine(engine,
// port, { allow })` answers the engine contract on one side — a worker, a
// SharedWorker, Electron's main process — and `remoteEngine(port, { name,
// capabilities, timeout })` is the same engine on the other, every call a
// message and its answer, so the I/O runs off the thread the database lives
// on; `connectEngine(port)` asks the served side what it is first. The
// database stays where it is opened — the seqs are minted there — and only
// its bytes cross the port.
//
// On the wire (structured clones): `{ id, hello: true }` → `{ id, ok: { name,
// capabilities } }`; `{ id, open: path, options }` → `{ id, ok: handle }`;
// `{ id, h, store, method, args }` → `{ id, ok: value, log? }` or `{ id,
// error }`, `log` the log store's getters after a log call (the OpLog reads
// them at once, so the proxy keeps the last answer); `{ id, h, subscribe:
// true }` → events `{ event: id, message }` until `{ id, h, unsubscribe }`;
// `{ id, h, lock: options }` → `{ id, ok: { id: lockId, gen, expiresAt } }`, `{ lost: lockId, error }`
// once when the lease goes, `{ leaseEvent: lockId, lease: event }` as the lease lives. A callback never crosses: `onFail` is `ok: false`
// with the error beside it, `entriesBetween` the entries it would answer —
// the scrubbed ones alone — sent along.
//
// The served side trusts the port as it trusts the process, no further: a
// call names a store and a method of the contract (src/engine.js) and
// nothing else — not a `lock`, a files engine's `fsi`, an inherited
// `valueOf` — every key, id, tag and path is checked before a store sees it
// (a key becomes a file name there, a value a filter), `remove(path)` takes
// what this port opened or what `allow` lists, and an answer that does not
// clone crosses as an error. A port that closes, a worker that exits, fails
// every call waiting and every call after as `ENGINE_UNREACHABLE`; so does a
// call past `timeout`. Requires engine.js, shape.js and errors.js only — the
// port is the platform's (worker_threads, a browser's MessageChannel).

const { checkEngine, checkEngineDb, capabilitiesOf, isKvKey, isKvNamespace } = require('../engine.js');
const { isDigest, checkBlobBytes } = require('../blobs.js');
const { checkWriteSet } = require('../write-set.js');
const { isRecordId } = require('../shape.js');
const { SyncomError, typed } = require('../errors.js');
const { packError, unpackError } = require('../wire-error.js');

const LOG_GETTERS = ['journaled', 'sealedTo', 'open', 'segments', 'corrupt', 'health'];
// A call's arguments are its own, a short fixed list: more is no call of the contract's.
const ARGS_MAX = 4;

const refused = (what) => new TypeError(`serveEngine(): ${what}`);
// A blob's digest: hex, 64 characters (SHA-256) — the contract's `isDigest`.
const digest = (value) => {
  if (!isDigest(value)) throw refused(`${JSON.stringify(value)} is not a digest`);
};
const text = (value, what) => {
  if (typeof value !== 'string') throw refused(`${what} is a text`);
  return value;
};
const key = (value, what) => {
  if (!isKvKey(value)) throw refused(`${JSON.stringify(value)} is not a ${what}`);
  return value;
};
const namespace = (value) => {
  if (!isKvNamespace(value)) throw refused(`${JSON.stringify(value)} is not a namespace`);
  return value;
};
const recordId = (value) => {
  if (!isRecordId(value)) throw refused(`${JSON.stringify(value)} is not a record id`);
  return value;
};
const integer = (value, what) => {
  if (!Number.isSafeInteger(value)) throw refused(`${what} is an integer`);
  return value;
};
const list = (value, what) => {
  if (!Array.isArray(value)) throw refused(`${what} is a list`);
  return value;
};
const plain = (value, what) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw refused(`${what} is an object`);
  return value;
};
const pathOf = (value) => {
  if (typeof value !== 'string' || value.length === 0) throw refused('a path is a text');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw refused('a path holds no control character');
  }
  return value;
};

// What a port may call of a database, store by store, and what each call
// takes: checked before the store sees it. A store's method not here does
// not exist over the port.
const kvKey = (ns, k) => {
  namespace(ns);
  key(k, 'key');
};
const kvValue = (ns, k, value) => {
  kvKey(ns, k);
  text(value, 'a value');
};
const oneId = (id) => {
  recordId(id);
};
const pieceName = (id, name) => {
  recordId(id);
  key(name, 'piece');
};
const copyKey = (tag, id) => {
  key(tag, 'tag');
  recordId(id);
};
const tagName = (tag) => {
  key(tag, 'tag');
};
const CHECKS = Object.freeze({
  kv: Object.freeze({
    get: kvKey,
    has: kvKey,
    list: (ns) => {
      namespace(ns);
    },
    put: (ns, k, value, options) => {
      kvValue(ns, k, value);
      if (options !== undefined) plain(options, 'options');
    },
    remove: kvKey,
    create: kvValue,
  }),
  records: Object.freeze({
    get: oneId,
    raw: oneId,
    has: oneId,
    getMany: (ids) => {
      list(ids, 'ids');
      for (let i = 0; i < ids.length; i++) recordId(ids[i]);
    },
    ids: (options) => {
      if (options === undefined) return;
      plain(options, 'options');
      if (options.after !== undefined && options.after !== null) recordId(options.after);
      if (options.limit !== undefined && !(typeof options.limit === 'number' && options.limit > 0)) {
        throw refused('limit is a positive number');
      }
    },
  }),
  pieces: Object.freeze({
    get: pieceName,
    getMany: (id, names) => {
      recordId(id);
      list(names, 'names');
      for (let i = 0; i < names.length; i++) key(names[i], 'piece');
    },
    remove: pieceName,
  }),
  blobs: Object.freeze({
    get: digest,
    has: digest,
    list: () => {},
    put: (name, bytes) => {
      digest(name);
      if (!(bytes instanceof Uint8Array)) throw refused('a blob is a Uint8Array');
      checkBlobBytes(typed, bytes, 'serveEngine() blobs.put');
    },
    remove: digest,
  }),
  copies: Object.freeze({
    get: copyKey,
    has: copyKey,
    ids: tagName,
    put: (tag, id, copy) => {
      copyKey(tag, id);
      text(copy, 'a copy');
    },
    remove: copyKey,
    drop: tagName,
  }),
  log: Object.freeze({
    load: () => {},
    append: (entries, headers, options) => {
      list(entries, 'entries');
      if (headers !== null && headers !== undefined) list(headers, 'headers');
      plain(options, 'options');
    },
    seal: (entries, from, to) => {
      list(entries, 'entries');
      integer(from, 'from');
      integer(to, 'to');
    },
    sealed: (to) => {
      integer(to, 'to');
    },
    drop: (range) => {
      plain(range, 'a segment');
      integer(range.from, 'from');
      integer(range.to, 'to');
    },
    saveIndex: (index) => {
      plain(index, 'an index');
    },
    scrub: (seqs, options, entries) => {
      list(seqs, 'seqs');
      plain(options, 'options');
      list(entries, 'entries');
    },
  }),
});
const STORES = Object.freeze(Object.keys(CHECKS));

const unreachable = (reason, fields = {}) =>
  new SyncomError('ENGINE_UNREACHABLE', `remoteEngine(): the served engine is unreachable (${reason})`, {
    reason,
    ...fields,
    cause: null,
  });

// A port as `{ send, listen, onClose }`: Node's MessagePort speaks
// `on('message')` with the data, a browser's `addEventListener` with an
// event; the other side gone is a MessagePort's `close`, a Worker's `exit`.
const portOf = (port) => {
  if (typeof port?.postMessage !== 'function') throw new TypeError('the port has no postMessage()');
  const send = (message) => port.postMessage(message);
  const node = typeof port.on === 'function';
  const listen = (fn) => {
    if (node) {
      port.on('message', fn);
      return () => port.off?.('message', fn) ?? port.removeListener?.('message', fn);
    }
    const onEvent = (event) => fn(event.data);
    port.addEventListener('message', onEvent);
    port.start?.();
    return () => port.removeEventListener('message', onEvent);
  };
  const onClose = (fn) => {
    const once = () => fn();
    if (node) {
      port.on('close', once);
      port.on('exit', once);
      return () => {
        port.off?.('close', once);
        port.off?.('exit', once);
      };
    }
    port.addEventListener?.('close', once);
    return () => port.removeEventListener?.('close', once);
  };
  return { send, listen, onClose };
};

const logState = (log) => {
  const state = {};
  for (let i = 0; i < LOG_GETTERS.length; i++) state[LOG_GETTERS[i]] = log[LOG_GETTERS[i]];
  return state;
};

/**
 * Answers the engine contract over `port` for `engine`: `{ close() }` stops
 * answering and closes every database opened through it. `allow` lists the
 * paths the port may open and remove; without it a port opens any path and
 * removes only what it opened.
 */
const serveEngine = (engine, port, { allow = null } = {}) => {
  const inner = checkEngine(engine, 'serveEngine()');
  if (allow !== null && !Array.isArray(allow)) throw new TypeError('serveEngine(): allow is a list of paths');
  const allowed = allow === null ? null : new Set(allow);
  const { send, listen, onClose } = portOf(port);
  const handles = new Map();
  const subscriptions = new Map();
  const locks = new Map();
  const leases = new Map();
  const opened = new Set();
  let next = 1;
  let stopped = false;

  const permitted = (path, removing) => {
    pathOf(path);
    if (allowed !== null) {
      if (!allowed.has(path)) throw refused(`${path} is not served over this port`);
      return path;
    }
    if (removing && !opened.has(path)) {
      throw refused(`${path} was not opened over this port: remove() takes what a port opened`);
    }
    return path;
  };

  // What a message asks of the engine itself, by its shape.
  const engineCalls = {
    hello: async () => ({ name: inner.name, capabilities: inner.capabilities }),
    async open(message) {
      const path = permitted(message.open, false);
      const db = checkEngineDb(await inner.open(path, { durable: message.options?.durable === true }), 'serveEngine()');
      const handle = next++;
      handles.set(handle, db);
      opened.add(path);
      return handle;
    },
    remove: async (message) => void (await inner.remove(permitted(message.remove, true))),
  };
  // What a message asks of a database opened over this port, by its shape — a store's method otherwise.
  const DATABASE_KINDS = ['subscribe', 'unsubscribe', 'lock', 'release', 'close'];
  const databaseCalls = {
    subscribe(message, db) {
      if (message.subscribe !== true) throw refused('subscribe is true');
      if (db.changes === undefined) throw refused('the engine has no change stream');
      const stop = db.changes.subscribe((data) => send({ event: message.id, message: data }));
      subscriptions.set(message.id, stop);
      return true;
    },
    unsubscribe(message) {
      subscriptions.get(message.unsubscribe)?.();
      subscriptions.delete(message.unsubscribe);
      return true;
    },
    async lock(message, db) {
      if (typeof db.lock !== 'function') throw refused('the engine has no lease');
      const lockId = next++;
      const held = await db.lock({
        ...plain(message.lock, 'lock options'),
        onLost: (error) => send({ lost: lockId, error: packError(error) }),
      });
      locks.set(lockId, held);
      // The lease's life, where the engine tells it: every event over the port, its error packed.
      if (typeof held.subscribe === 'function') {
        const stop = held.subscribe((event) => {
          const packed = event.error === undefined ? event : { ...event, error: packError(event.error) };
          send({ leaseEvent: lockId, lease: packed });
        });
        leases.set(lockId, stop);
      }
      return { id: lockId, gen: held.gen, expiresAt: held.expiresAt ?? null };
    },
    async release(message) {
      const held = locks.get(message.release);
      locks.delete(message.release);
      leases.get(message.release)?.();
      leases.delete(message.release);
      await held?.release();
      return true;
    },
    async close(message, db) {
      if (message.close !== true) throw refused('close is true');
      handles.delete(message.h);
      await db.close();
    },
  };
  // The log store's calls that carry a callback's answer along instead of the callback.
  const logCalls = {
    async append(log, args) {
      const [entries, headers, options] = args;
      let failure = null;
      const landed = await log.append(entries, headers, {
        ...options,
        onFail: (error) => {
          failure = packError(error);
        },
        // The journal reuses the lines it holds; nothing of a group is ever rebuilt from less than it held.
        entriesBetween: () => [],
      });
      return landed ? { landed: true } : { landed: false, error: failure };
    },
    async drop(log, args) {
      // The proxy's segment is a copy: the store's own is found by its range.
      const segments = log.segments;
      let own = null;
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].from === args[0].from && segments[i].to === args[0].to) own = segments[i];
      }
      if (own === null) throw new TypeError('drop(segment): no such segment');
      await log.drop(own);
    },
    async scrub(log, args) {
      const [seqs, options, entries] = args;
      const held = new Map();
      for (let i = 0; i < entries.length; i++) held.set(entries[i].seq, entries[i]);
      const entriesBetween = (from, to) => {
        const out = [];
        for (let seq = from; seq <= to; seq++) if (held.has(seq)) out.push(held.get(seq));
        return out;
      };
      await log.scrub(seqs, { ...options, entriesBetween });
    },
  };
  // A store's method: named by the contract, its arguments checked, called.
  const callStore = async (message, db) => {
    const { store, method } = message;
    const args = list(message.args, 'args');
    if (args.length > ARGS_MAX) throw refused('too many arguments');
    if (store === 'write') return void (await db.write(checkWriteSet(args[0], isRecordId, 'serveEngine()')));
    const checks = typeof store === 'string' && Object.hasOwn(CHECKS, store) ? CHECKS[store] : null;
    if (checks === null || typeof method !== 'string' || !Object.hasOwn(checks, method)) {
      throw refused(`no ${store}.${method}`);
    }
    checks[method](...args);
    if (store === 'log' && Object.hasOwn(logCalls, method)) return logCalls[method](db.log, args);
    const target = db[store];
    if (typeof target?.[method] !== 'function') throw refused(`the engine has no ${store}.${method}`);
    return target[method](...args);
  };
  const call = async (message) => {
    if (message.hello === true) return engineCalls.hello();
    if (message.open !== undefined) return engineCalls.open(message);
    if (message.remove !== undefined) return engineCalls.remove(message);
    const db = handles.get(message.h);
    if (db === undefined) throw refused(`no database ${message.h} (closed?)`);
    for (let i = 0; i < DATABASE_KINDS.length; i++) {
      const kind = DATABASE_KINDS[i];
      if (message[kind] !== undefined) return databaseCalls[kind](message, db);
    }
    return callStore(message, db);
  };

  const onMessage = async (message) => {
    if (stopped || message === null || typeof message !== 'object' || message.id === undefined) return;
    let answer;
    try {
      const ok = await call(message);
      answer = { id: message.id, ok };
      if (message.store === 'log' && message.h !== undefined) {
        const db = handles.get(message.h);
        if (db !== undefined) answer.log = logState(db.log);
      }
    } catch (error) {
      answer = { id: message.id, error: packError(error) };
    }
    try {
      send(answer);
    } catch (error) {
      // An answer that does not clone: the error crosses instead of it. A
      // port that is gone throws here too; its close is heard below.
      try {
        send({ id: message.id, error: packError(error) });
      } catch {
        // Nothing to answer on.
      }
    }
  };
  const stop = listen(onMessage);
  let unclose = () => {};
  const shutdown = async (closePort) => {
    if (stopped) return;
    stopped = true;
    stop();
    unclose();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
    for (const stop of leases.values()) stop();
    leases.clear();
    for (const held of locks.values()) await held.release();
    locks.clear();
    for (const db of handles.values()) await db.close();
    handles.clear();
    if (closePort) port.close?.();
  };
  // The other side gone: what it held — leases, subscriptions, databases — goes with it.
  unclose = onClose(() => {
    shutdown(false).catch(() => {});
  });
  return {
    close: () => shutdown(true),
  };
};

/**
 * The engine served over `port`, as `{ name, capabilities }` say it is —
 * what the other side was given; `connectEngine(port)` asks instead. A call
 * past `timeout` ms (0, none, by default) fails as `ENGINE_UNREACHABLE`.
 */
const remoteEngine = (port, { name, capabilities, timeout = 0 } = {}) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('remoteEngine(): name — or connectEngine(port)');
  }
  if (typeof capabilities !== 'object' || capabilities === null) throw new TypeError('remoteEngine(): capabilities');
  if (typeof timeout !== 'number' || !(timeout >= 0)) throw new TypeError('remoteEngine(): timeout is ms, 0 for none');
  const { send, listen, onClose } = portOf(port);
  const pending = new Map();
  const listeners = new Map();
  const losses = new Map();
  const leaseListeners = new Map();
  let next = 1;
  let dead = null;
  let calls = 0;
  let failures = 0;
  // A call answered, timed out or failed: taken off the table, its timer with it.
  const settle = (id) => {
    const waiting = pending.get(id);
    if (waiting === undefined) return undefined;
    pending.delete(id);
    if (waiting.timer !== null) clearTimeout(waiting.timer);
    return waiting;
  };
  // The served side gone: every call waiting fails, and every call after.
  const fail = (error) => {
    if (dead === null) dead = error;
    for (const waiting of pending.values()) {
      if (waiting.timer !== null) clearTimeout(waiting.timer);
      failures++;
      waiting.reject(error);
    }
    pending.clear();
  };
  const onMessage = (message) => {
    if (message === null || typeof message !== 'object') return;
    if (message.event !== undefined) return void listeners.get(message.event)?.(message.message);
    if (message.lost !== undefined) return void losses.get(message.lost)?.(unpackError(message.error));
    if (message.leaseEvent !== undefined) {
      const listener = leaseListeners.get(message.leaseEvent);
      if (listener === undefined) return;
      const event = message.lease;
      return void listener(event.error === undefined ? event : { ...event, error: unpackError(event.error) });
    }
    const waiting = settle(message.id);
    if (waiting === undefined) return;
    if (message.error !== undefined) {
      failures++;
      waiting.reject(unpackError(message.error));
    } else waiting.resolve(message);
  };
  const stop = listen(onMessage);
  const unclose = onClose(() => fail(unreachable('closed')));
  const ask = (body) =>
    new Promise((resolve, reject) => {
      calls++;
      if (dead !== null) {
        failures++;
        return void reject(dead);
      }
      const id = next++;
      const waiting = { resolve, reject, since: Date.now(), timer: null };
      if (timeout > 0) {
        waiting.timer = setTimeout(() => {
          pending.delete(id);
          failures++;
          reject(unreachable('timeout', { ms: timeout }));
        }, timeout);
        waiting.timer.unref?.();
      }
      pending.set(id, waiting);
      try {
        send({ id, ...body });
      } catch (error) {
        settle(id);
        failures++;
        reject(error);
      }
    });
  const value = async (body) => (await ask(body)).ok;

  const openDb = (p, h) => {
    const method = (store, name) => {
      return (...args) => value({ h, store, method: name, args });
    };
    const kv = {
      get: method('kv', 'get'),
      has: method('kv', 'has'),
      list: method('kv', 'list'),
      put: method('kv', 'put'),
      remove: method('kv', 'remove'),
    };
    if (capabilities.exclusiveCreate) kv.create = method('kv', 'create');
    const records = {
      get: method('records', 'get'),
      raw: method('records', 'raw'),
      has: method('records', 'has'),
      getMany: async (ids) => new Map(await value({ h, store: 'records', method: 'getMany', args: [ids] })),
      ids: method('records', 'ids'),
    };
    const pieces = {
      get: method('pieces', 'get'),
      getMany: async (id, names) => new Map(await value({ h, store: 'pieces', method: 'getMany', args: [id, names] })),
      remove: method('pieces', 'remove'),
    };
    const copies = {
      get: method('copies', 'get'),
      has: method('copies', 'has'),
      ids: method('copies', 'ids'),
      put: method('copies', 'put'),
      remove: method('copies', 'remove'),
      drop: method('copies', 'drop'),
    };
    const blobs = capabilities.blobs
      ? {
          get: method('blobs', 'get'),
          has: method('blobs', 'has'),
          list: method('blobs', 'list'),
          put: method('blobs', 'put'),
          remove: method('blobs', 'remove'),
        }
      : undefined;
    // The log store's getters are read at once by the OpLog: the last state the served side answered with.
    let state = { journaled: false, sealedTo: null, open: 0, segments: [], corrupt: 0, health: null };
    const logCall = async (name, args) => {
      const answer = await ask({ h, store: 'log', method: name, args });
      if (answer.log !== undefined) state = answer.log;
      return answer.ok;
    };
    const log = {
      get journaled() {
        return state.journaled;
      },
      get sealedTo() {
        return state.sealedTo;
      },
      get open() {
        return state.open;
      },
      get segments() {
        return state.segments;
      },
      get corrupt() {
        return state.corrupt;
      },
      get health() {
        return state.health ?? { journaled: false, open: 0, torn: 0, lost: false };
      },
      load: () => logCall('load', []),
      async append(entries, headers, { first, last, sealedTo, onFail }) {
        const result = await logCall('append', [entries, headers, { first, last, sealedTo }]);
        if (result.landed) return true;
        onFail(unpackError(result.error ?? { message: 'the group was not written' }));
        return false;
      },
      // A native store seals a range by its count — the rows are there — so the entries go as their seqs; the files
      // journal reads the lines it holds and needs an entry only for a line it lacks, so a served files engine gets them whole.
      seal(entries, from, to) {
        if (name === 'files') return logCall('seal', [entries, from, to]);
        const seqs = [];
        for (let i = 0; i < entries.length; i++) seqs.push({ seq: entries[i].seq });
        return logCall('seal', [seqs, from, to]);
      },
      sealed: (to) => logCall('sealed', [to]),
      drop: (segment) => logCall('drop', [{ from: segment.from, to: segment.to }]),
      saveIndex: (index) => logCall('saveIndex', [index]),
      // The scrubbed entries as they are now, sent along: the served store swaps them into what it holds.
      scrub(seqs, { id, ids, sealedTo, entriesBetween }) {
        const entries = [];
        for (let i = 0; i < seqs.length; i++) {
          const held = entriesBetween(seqs[i], seqs[i]);
          if (held.length === 1) entries.push(held[0]);
        }
        return logCall('scrub', [seqs, { id, ids, sealedTo }, entries]);
      },
    };
    const db = {
      path: p,
      capabilities,
      kv,
      records,
      pieces,
      copies,
      log,
      write: (batch) => value({ h, store: 'write', args: [batch] }),
      close: () => value({ h, close: true }),
    };
    if (blobs !== undefined) db.blobs = blobs;
    if (capabilities.changeStream) {
      db.changes = {
        subscribe(listener) {
          const id = next++;
          listeners.set(id, listener);
          // The served side's refusal (no change stream) reaches the listener as `{ error }`.
          pending.set(id, {
            resolve() {},
            reject(error) {
              listeners.get(id)?.({ error });
            },
            since: Date.now(),
            timer: null,
          });
          send({ id, h, subscribe: true });
          return () => {
            listeners.delete(id);
            value({ h, unsubscribe: id }).catch(() => {});
          };
        },
      };
    }
    if (capabilities.lock === 'native') {
      db.lock = async ({ onLost = null, ...options }) => {
        const { id: lockId, gen, expiresAt } = await value({ h, lock: options });
        if (onLost !== null) losses.set(lockId, onLost);
        return {
          gen,
          // The served side's estimate, on its clock.
          expiresAt,
          subscribe(listener) {
            leaseListeners.set(lockId, listener);
            return () => void leaseListeners.delete(lockId);
          },
          async release() {
            losses.delete(lockId);
            leaseListeners.delete(lockId);
            await value({ h, release: lockId });
          },
        };
      };
    }
    return Object.freeze(db);
  };

  return Object.freeze({
    name,
    capabilities: capabilitiesOf(capabilities),
    open: async (path, options = {}) =>
      openDb(path, await value({ open: path, options: { durable: options.durable === true } })),
    remove: (path) => value({ remove: path }),
    /** The calls over the port: in flight now, the oldest of them in ms, made and failed since the start, and whether the port is gone. */
    stats() {
      let oldest = 0;
      const now = Date.now();
      for (const waiting of pending.values()) {
        const age = now - waiting.since;
        if (age > oldest) oldest = age;
      }
      return { inflight: pending.size, oldestMs: oldest, calls, failures, closed: dead !== null };
    },
    /** Stops listening and closes the port; the served side keeps its databases. */
    async close() {
      stop();
      unclose();
      fail(unreachable('closed'));
      port.close?.();
    },
  });
};

/** The engine served over `port`, asked what it is: `await connectEngine(port, { timeout })`. */
const connectEngine = async (port, { timeout = 0 } = {}) => {
  const { send, listen, onClose } = portOf(port);
  const info = await new Promise((resolve, reject) => {
    const id = `hello-${Date.now().toString(36)}`;
    let stop = null;
    let unclose = null;
    let timer = null;
    const done = (settle, outcome) => {
      stop?.();
      unclose?.();
      if (timer !== null) clearTimeout(timer);
      settle(outcome);
    };
    stop = listen((message) => {
      if (message?.id !== id) return;
      if (message.error !== undefined) done(reject, unpackError(message.error));
      else done(resolve, message.ok);
    });
    unclose = onClose(() => done(reject, unreachable('closed')));
    if (timeout > 0) {
      timer = setTimeout(() => done(reject, unreachable('timeout', { ms: timeout })), timeout);
      timer.unref?.();
    }
    send({ id, hello: true });
  });
  return remoteEngine(port, { ...info, timeout });
};

module.exports = { serveEngine, remoteEngine, connectEngine, STORES };
