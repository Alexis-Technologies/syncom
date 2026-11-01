'use strict';

// An engine over a message port (@alexify/syncom/engines): `serveEngine(engine,
// port)` answers the engine contract on one side — a worker, a SharedWorker,
// Electron's main process — and `remoteEngine(port, { name, capabilities })`
// is the same engine on the other, every call a message and its answer, so the
// I/O runs off the thread the database lives on; `connectEngine(port)` asks
// the served side what it is first. The database stays where it is opened —
// the seqs are minted there — and only its bytes cross the port.
//
// On the wire (structured clones): `{ id, hello: true }` → `{ id, ok: { name,
// capabilities } }`; `{ id, open: path, options }` → `{ id, ok: handle }`;
// `{ id, h, store, method, args }` → `{ id, ok: value, log? }` or `{ id,
// error }`, `log` the log store's getters after a log call (the OpLog reads
// them at once, so the proxy keeps the last answer); `{ id, h, subscribe:
// true }` → events `{ event: id, message }` until `{ id, h, unsubscribe }`;
// `{ id, h, lock: options }` → `{ id, ok: lockId }`, `{ lost: lockId, error }`
// once when the lease goes. A callback never crosses: `onFail` is `ok: false`
// with the error beside it, `entriesBetween` the entries it would answer,
// sent along. Requires engine.js and errors.js only — the port is the
// platform's (worker_threads, a browser's MessageChannel).

const { checkEngine, checkEngineDb, capabilitiesOf } = require('../engine.js');
const { SyncomError } = require('../errors.js');

const LOG_GETTERS = ['journaled', 'sealedTo', 'open', 'segments', 'corrupt', 'health'];
const STORES = ['kv', 'records', 'pieces', 'copies', 'log'];

// A port as `{ send, listen }`: Node's MessagePort speaks `on('message')`
// with the data, a browser's `addEventListener` with an event.
const portOf = (port) => {
  if (typeof port?.postMessage !== 'function') throw new TypeError('the port has no postMessage()');
  const send = (message) => port.postMessage(message);
  const listen = (fn) => {
    if (typeof port.on === 'function') {
      port.on('message', fn);
      return () => port.off?.('message', fn) ?? port.removeListener?.('message', fn);
    }
    const onEvent = (event) => fn(event.data);
    port.addEventListener('message', onEvent);
    port.start?.();
    return () => port.removeEventListener('message', onEvent);
  };
  return { send, listen };
};

// An error as a message, and back: a SyncomError with its code and fields,
// a TypeError, any other with its code (EEXIST).
const packError = (error) => {
  if (error === null || typeof error !== 'object') return { message: String(error) };
  const out = { name: error.name, message: error.message };
  for (const key of Object.keys(error)) if (key !== 'cause' && key !== 'stack') out[key] = error[key];
  if (error.code !== undefined) out.code = error.code;
  return out;
};
const unpackError = (packed) => {
  const { name, message, code, ...fields } = packed;
  if (name === 'SyncomError' && typeof code === 'string') {
    return new SyncomError(code, message, { ...fields, cause: null });
  }
  const error = name === 'TypeError' ? new TypeError(message) : new Error(message);
  if (code !== undefined) error.code = code;
  return Object.assign(error, fields);
};

const logState = (log) => {
  const state = {};
  for (let i = 0; i < LOG_GETTERS.length; i++) state[LOG_GETTERS[i]] = log[LOG_GETTERS[i]];
  return state;
};

/**
 * Answers the engine contract over `port` for `engine`: `{ close() }` stops
 * answering and closes every database opened through it.
 */
const serveEngine = (engine, port) => {
  const inner = checkEngine(engine, 'serveEngine()');
  const { send, listen } = portOf(port);
  const handles = new Map();
  const subscriptions = new Map();
  const locks = new Map();
  let next = 1;

  const call = async (message) => {
    if (message.hello === true) return { name: inner.name, capabilities: inner.capabilities };
    if (message.open !== undefined) {
      const db = checkEngineDb(await inner.open(message.open, message.options ?? {}), 'serveEngine()');
      const handle = next++;
      handles.set(handle, db);
      return handle;
    }
    if (message.remove !== undefined) return void (await inner.remove(message.remove));
    const db = handles.get(message.h);
    if (db === undefined) throw new TypeError(`serveEngine(): no database ${message.h} (closed?)`);
    if (message.subscribe === true) {
      if (db.changes === undefined) throw new TypeError('serveEngine(): the engine has no change stream');
      const stop = db.changes.subscribe((data) => send({ event: message.id, message: data }));
      subscriptions.set(message.id, stop);
      return true;
    }
    if (message.unsubscribe !== undefined) {
      subscriptions.get(message.unsubscribe)?.();
      subscriptions.delete(message.unsubscribe);
      return true;
    }
    if (message.lock !== undefined) {
      if (typeof db.lock !== 'function') throw new TypeError('serveEngine(): the engine has no lease');
      const lockId = next++;
      const held = await db.lock({
        ...message.lock,
        onLost: (error) => send({ lost: lockId, error: packError(error) }),
      });
      locks.set(lockId, held);
      return lockId;
    }
    if (message.release !== undefined) {
      const held = locks.get(message.release);
      locks.delete(message.release);
      await held?.release();
      return true;
    }
    if (message.close === true) {
      handles.delete(message.h);
      return void (await db.close());
    }
    const { store, method, args } = message;
    if (store === 'write') return void (await db.write(args[0]));
    if (store === 'log') {
      const log = db.log;
      if (method === 'append') {
        const [entries, headers, options] = args;
        let failure = null;
        const landed = await log.append(entries, headers, {
          ...options,
          onFail: (error) => {
            failure = packError(error);
          },
          entriesBetween: () => [],
        });
        return landed ? { landed: true } : { landed: false, error: failure };
      }
      if (method === 'drop') {
        // The proxy's segment is a copy: the store's own is found by its range.
        const segments = log.segments;
        let own = null;
        for (let i = 0; i < segments.length; i++) {
          if (segments[i].from === args[0].from && segments[i].to === args[0].to) own = segments[i];
        }
        if (own === null) throw new TypeError('drop(segment): no such segment');
        return void (await log.drop(own));
      }
      if (method === 'scrub') {
        const [seqs, options, entries] = args;
        const held = new Map();
        for (let i = 0; i < entries.length; i++) held.set(entries[i].seq, entries[i]);
        const entriesBetween = (from, to) => {
          const out = [];
          for (let seq = from; seq <= to; seq++) if (held.has(seq)) out.push(held.get(seq));
          return out;
        };
        return void (await log.scrub(seqs, { ...options, entriesBetween }));
      }
      return log[method](...args);
    }
    const target = db[store];
    if (target === undefined || typeof target[method] !== 'function') {
      throw new TypeError(`serveEngine(): no ${store}.${method}`);
    }
    return target[method](...args);
  };

  const onMessage = async (message) => {
    if (message === null || typeof message !== 'object' || message.id === undefined) return;
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
    send(answer);
  };
  const stop = listen(onMessage);
  return {
    async close() {
      stop();
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const held of locks.values()) await held.release();
      locks.clear();
      for (const db of handles.values()) await db.close();
      handles.clear();
      port.close?.();
    },
  };
};

/**
 * The engine served over `port`, as `{ name, capabilities }` say it is —
 * what the other side was given; `connectEngine(port)` asks instead.
 */
const remoteEngine = (port, { name, capabilities } = {}) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('remoteEngine(): name — or connectEngine(port)');
  }
  if (typeof capabilities !== 'object' || capabilities === null) throw new TypeError('remoteEngine(): capabilities');
  const { send, listen } = portOf(port);
  const pending = new Map();
  const listeners = new Map();
  const losses = new Map();
  let next = 1;
  const onMessage = (message) => {
    if (message === null || typeof message !== 'object') return;
    if (message.event !== undefined) return void listeners.get(message.event)?.(message.message);
    if (message.lost !== undefined) return void losses.get(message.lost)?.(unpackError(message.error));
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiting.reject(unpackError(message.error));
    else waiting.resolve(message);
  };
  const stop = listen(onMessage);
  const ask = (body) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      send({ id, ...body });
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
    const pieces = { get: method('pieces', 'get'), remove: method('pieces', 'remove') };
    const copies = {
      get: method('copies', 'get'),
      has: method('copies', 'has'),
      ids: method('copies', 'ids'),
      put: method('copies', 'put'),
      remove: method('copies', 'remove'),
      drop: method('copies', 'drop'),
    };
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
      seal: (entries, from, to) => logCall('seal', [entries, from, to]),
      sealed: (to) => logCall('sealed', [to]),
      drop: (segment) => logCall('drop', [{ from: segment.from, to: segment.to }]),
      saveIndex: (index) => logCall('saveIndex', [index]),
      scrub(seqs, { id, sealedTo, entriesBetween }) {
        const entries = [];
        for (let i = 0; i < seqs.length; i++) {
          const held = entriesBetween(seqs[i], seqs[i]);
          if (held.length === 1) entries.push(held[0]);
        }
        return logCall('scrub', [seqs, { id, sealedTo }, entries]);
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
    if (capabilities.changeStream) {
      db.changes = {
        subscribe(listener) {
          const id = next++;
          listeners.set(id, listener);
          pending.set(id, { resolve() {}, reject() {} });
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
        const lockId = await value({ h, lock: options });
        if (onLost !== null) losses.set(lockId, onLost);
        return {
          async release() {
            losses.delete(lockId);
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
    /** Stops listening and closes the port; the served side keeps its databases. */
    async close() {
      stop();
      for (const waiting of pending.values()) waiting.reject(new Error('remoteEngine(): closed'));
      pending.clear();
      port.close?.();
    },
  });
};

/** The engine served over `port`, asked what it is: `await connectEngine(port)`. */
const connectEngine = async (port) => {
  const { send, listen } = portOf(port);
  const info = await new Promise((resolve, reject) => {
    const id = `hello-${Date.now().toString(36)}`;
    const stop = listen((message) => {
      if (message?.id !== id) return;
      stop();
      if (message.error !== undefined) reject(unpackError(message.error));
      else resolve(message.ok);
    });
    send({ id, hello: true });
  });
  return remoteEngine(port, info);
};

module.exports = { serveEngine, remoteEngine, connectEngine, STORES };
