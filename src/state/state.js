'use strict';

// Persistent app state (@alexify/syncom/state): one object a node keeps by
// name — `createState(db, 'ui')` — read and written by path (`get('theme')`,
// `set('panel/width', 320)`, `set('count', (n) => n + 1)`), kept as the
// record `state.<name>` (every path a register of its own: two nodes that
// write different paths of one state both keep theirs, the record
// replicates like any other) or, with `{ local: true }`, as the local
// document `state.<name>` (the whole object, this node's alone; needs the
// `local` plugin). `observe(path, listener)` follows the path; `toStore()`
// takes a state. Requires paths.js and shape.js only: it ships to the browser.

const { valueAt, isPath } = require('../paths.js');
const { isPlainObject } = require('../shape.js');

const PREFIX = 'state.';

const pathArg = (method, path) => {
  if (path === undefined || path === null) return null;
  if (!isPath(path)) throw new TypeError(`${method}() takes a path (segments joined by '/')`);
  return path;
};

// `value` laid into a copy of `object` at `path`, the objects on the way made where absent.
const laid = (object, path, value) => {
  const out = isPlainObject(object) ? { ...object } : {};
  const parts = path.split('/');
  let at = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = isPlainObject(at[parts[i]]) ? { ...at[parts[i]] } : {};
    at[parts[i]] = next;
    at = next;
  }
  if (value === undefined) delete at[parts[parts.length - 1]];
  else at[parts[parts.length - 1]] = value;
  return out;
};

const next = (method, given, current) => {
  const value = typeof given === 'function' ? given(current === undefined ? null : current) : given;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`${method}() takes a JSON value, or a function of the value that answers one`);
  }
  return value;
};

// A state over a record: a path is a field of the record (a register of its own).
const overRecord = (db, id) => ({
  get: async (path) => {
    const data = await db.get(id);
    if (data === null) return path === null ? {} : undefined;
    if (path === null) {
      const out = {};
      for (const key of Object.keys(data)) if (key !== '$type') out[key] = data[key];
      return out;
    }
    return valueAt(data, path);
  },
  set: (path, given) =>
    db.transact(async (tx) => {
      const data = await tx.get(id);
      if (path === null) {
        const value = next('set', given, data === null ? null : data);
        if (!isPlainObject(value)) throw new TypeError('set() of the whole state takes an object');
        await tx.set(id, value);
        return value;
      }
      const value = next('set', given, data === null ? undefined : valueAt(data, path));
      if (data === null) await tx.set(id, { [path]: value });
      else await tx.update(id, { [path]: value });
      return value;
    }),
  delete: (path) =>
    db.transact(async (tx) => {
      if (!(await tx.has(id))) return;
      if (path === null) await tx.delete(id);
      else await tx.unset(id, [path]);
    }),
  observe: (path, listener) => db.observe(id, path, listener),
});

// A state over a local document: the whole object, read and written at once
// — through the store's `set(key, fn)`, one change of the document at a time,
// so two sets made at once both land.
const overLocal = (store, key) => ({
  get: async (path) => {
    const held = await store.get(key);
    if (path === null) return held === null ? {} : held;
    return held === null ? undefined : valueAt(held, path);
  },
  set: async (path, given) => {
    let value;
    await store.set(key, (held) => {
      if (path === null) {
        value = next('set', given, held);
        if (!isPlainObject(value)) throw new TypeError('set() of the whole state takes an object');
        return value;
      }
      value = next('set', given, held === null ? undefined : valueAt(held, path));
      return laid(held, path, value);
    });
    return value;
  },
  delete: async (path) => {
    if (path === null) return store.delete(key);
    // Nothing held: nothing to take a path out of (`undefined` back leaves the document as it is).
    await store.set(key, (held) => (held === null ? undefined : laid(held, path, undefined)));
  },
  observe: (path, listener) => store.observe(key, listener),
});

/**
 * The state `name` of `db`: `get(path?)`, `set(path?, value | fn)`,
 * `delete(path?)`, `observe(path?, listener)` — a path of segments joined
 * by `/`, or nothing for the whole object. Over the record `state.<name>`
 * (replicated, every path its own register), or over the local document
 * `state.<name>` with `{ local: true }`.
 */
const createState = (db, name, { local = false } = {}) => {
  if (!db || typeof db.get !== 'function' || typeof db.transact !== 'function') {
    throw new TypeError('createState() takes a database');
  }
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}$/.test(name)) {
    throw new TypeError('createState() takes a name: letters, digits, _ . -');
  }
  const id = `${PREFIX}${name}`;
  const inner = local ? overLocal(db.local, id) : overRecord(db, id);
  const state = {
    name,
    id,
    local,
    /** A marker for `toStore()`: a state. */
    state: true,
    // A refusal of the arguments is a rejection, as from the database.
    get: async (path) => inner.get(pathArg('get', path)),
    set: async (path, value) => {
      // `set(value)`: the whole state.
      if (value === undefined && (typeof path !== 'string' || !isPath(path))) return inner.set(null, path);
      return inner.set(pathArg('set', path), value);
    },
    delete: async (path) => inner.delete(pathArg('delete', path)),
    observe: (path, listener) => {
      if (typeof path === 'function' && listener === undefined) [path, listener] = [null, path];
      if (typeof listener !== 'function') throw new TypeError('observe() takes a listener');
      const at = pathArg('observe', path);
      // What the listener hears: the value at the path, read after the change; a read that fails or a listener
      // that throws is contained, as every listener is.
      return inner.observe(at, () => {
        inner
          .get(at)
          .then(listener)
          .catch((err) => db.logger.warn({ event: 'listener.error', name: 'observe', err }));
      });
    },
  };
  return Object.freeze(state);
};

module.exports = { createState };
