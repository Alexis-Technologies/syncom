'use strict';

// Framework stores (@alexify/syncom/store): a source of syncom's — a query
// cursor, a live Record, a record read through `get()`, a presence room, or
// any emitter and a reader — as one object two contracts read: Svelte's
// store (`subscribe(run)` calls `run(value)` at once and on every change,
// and returns the stop function) and React's `useSyncExternalStore(store.
// subscribe, store.getSnapshot)` (the snapshot keeps its identity until a
// change). Vue and Solid wrap the same object (docs/guide/frameworks.md).
// The source is watched from the first subscriber to the last, and a store
// with none answers the last value it saw. No requires: no framework is
// imported, and the sources are duck-typed.

const createStore = (start, { initial, onError = null } = {}) => {
  let value = initial;
  let error = null;
  let stop = null;
  // Bumped on every start and stop: a read that resolves for an older
  // watch is dropped.
  let generation = 0;
  const runs = new Set();
  let resolveReady;
  const ready = new Promise((resolve) => (resolveReady = resolve));
  const set = (mine) => (next) => {
    if (mine !== generation) return;
    value = next;
    error = null;
    resolveReady(next);
    for (const run of [...runs]) run(value);
  };
  const fail = (mine) => (err) => {
    if (mine !== generation) return;
    error = err;
    if (onError !== null) onError(err);
  };
  const store = {
    subscribe(run) {
      if (typeof run !== 'function') throw new TypeError('subscribe() takes a function');
      if (stop === null) {
        const mine = ++generation;
        stop = start(set(mine), fail(mine));
      }
      runs.add(run);
      run(value);
      return () => {
        if (!runs.delete(run) || runs.size > 0 || stop === null) return;
        const halt = stop;
        stop = null;
        generation++;
        halt();
      };
    },
    getSnapshot: () => value,
    get value() {
      return value;
    },
    get error() {
      return error;
    },
    ready,
  };
  return Object.freeze(store);
};

// A value or a promise of one, handed to `set` once it is there.
const deliver = (read, set, fail) => {
  try {
    const out = read();
    if (out !== null && typeof out === 'object' && typeof out.then === 'function') out.then(set, fail);
    else set(out);
  } catch (err) {
    fail(err);
  }
};

// The field at a path of a reading: `profile/city` is `data.profile.city`,
// as the record reads.
const at = (data, path) => {
  if (path === null || data === null || data === undefined) return data;
  let out = data;
  for (const segment of path.split('/')) {
    if (out === null || typeof out !== 'object') return undefined;
    out = out[segment];
  }
  return out;
};

const isCursor = (source) => typeof source?.watch === 'function' && typeof source.fetch === 'function';
const isPresence = (source) => typeof source?.states === 'function' && typeof source.encode === 'function';
const isRecord = (source) =>
  typeof source?.id === 'string' && typeof source.data === 'function' && typeof source.on === 'function';
const isStorage = (source) => typeof source?.observe === 'function' && typeof source.get === 'function';

const fromCursor = (cursor, options) =>
  createStore((set, fail) => cursor.watch((rows) => set(rows), { onError: fail }), options);

const fromPresence = (presence, options) =>
  createStore((set) => {
    const changed = () => set(presence.states());
    presence.on('change', changed);
    set(presence.states());
    return () => presence.off('change', changed);
  }, options);

// A live Record: its data, a copy per change — the Record mutates its own.
const fromRecord = (record, options) =>
  createStore((set, fail) => {
    let updated = false;
    const update = (data) => {
      updated = true;
      set(data === null ? null : { ...data });
    };
    record.on('update', update);
    record.data().then((data) => {
      if (!updated) set(data === null ? null : { ...data });
    }, fail);
    return () => record.off('update', update);
  }, options);

// A record as `get()` reads it — the lens and the read hooks applied — read
// again after every turn that changed it; the newest read wins.
const fromGet = (storage, id, { path = null, ...options } = {}) => {
  if (path !== null && typeof path !== 'string') throw new TypeError('toStore() takes a path as a string');
  return createStore((set, fail) => {
    let reads = 0;
    const read = () => {
      const mine = ++reads;
      storage.get(id).then((data) => {
        if (mine === reads) set(at(data, path));
      }, fail);
    };
    const stop = storage.observe(id, path, read);
    read();
    return stop;
  }, options);
};

/**
 * A store over `source`: a cursor (its rows), a live Record (its data), a
 * presence (its states), or a storage and a record id (the record as
 * `get()` reads it, or the field at `options.path`).
 */
const toStore = (source, ...args) => {
  if (isCursor(source)) return fromCursor(source, args[0]);
  if (isPresence(source)) return fromPresence(source, args[0]);
  if (isRecord(source)) return fromRecord(source, args[0]);
  if (isStorage(source) && typeof args[0] === 'string') return fromGet(source, args[0], args[1]);
  throw new TypeError('toStore() takes a cursor, a Record, a presence, or a storage and a record id');
};

/** A store over any emitter: `read()` (a value or a promise of one) at the start and after each of `events`. */
const fromEvents = (emitter, events, read, options) => {
  if (!emitter || typeof emitter.on !== 'function' || typeof emitter.off !== 'function') {
    throw new TypeError('fromEvents() takes an emitter');
  }
  if (!Array.isArray(events) || typeof read !== 'function') {
    throw new TypeError('fromEvents() takes events and a reader');
  }
  return createStore((set, fail) => {
    const changed = () => deliver(read, set, fail);
    for (const event of events) emitter.on(event, changed);
    changed();
    return () => {
      for (const event of events) emitter.off(event, changed);
    };
  }, options);
};

module.exports = { toStore, fromEvents };
