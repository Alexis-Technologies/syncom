'use strict';

// Local documents (@alexify/syncom/local): values kept beside the records,
// in the `local` namespace of the engine's kv, that never become an op —
// not logged, not in the catalog, not in a snapshot, never at a peer: the
// window's layout, a draft, a cursor position, what one node keeps for
// itself. `createDatabase({ plugins: [local] })` hands the core `db.local`
// (`get`, `set`, `delete`, `list`, `observe`, `scoped`) and a `local` event
// on the database; a collection's `local` is the same store under the
// collection's prefix. Values are JSON; a key is a kv key (no `/`).
// `observe` is this instance's: another instance over one engine hears
// nothing (a local document is one node's). Requires engine.js, errors.js
// and hooks.js only: it ships to the browser.

const { kvNamespace, isKvKey } = require('../engine.js');
const { notify } = require('../hooks.js');

const NAMESPACE = 'local';

const keyed = (method, key) => {
  if (!isKvKey(key)) throw new TypeError(`${method}() takes a key: a text of at most 255 characters, no '/'`);
  return key;
};

class LocalStore {
  #store;
  #prefix;
  #told;
  #watchers;

  // `store` the kv namespace, `prefix` what a collection's store puts before
  // every key (`''` the database's), `told(key, value)` the database's
  // event; the watchers are shared by every scope.
  constructor(store, prefix, told, watchers = new Map()) {
    this.#store = store;
    this.#prefix = prefix;
    this.#told = told;
    this.#watchers = watchers;
  }

  /** A marker for `toStore()`: a local store. */
  get local() {
    return true;
  }

  #full(method, key) {
    return this.#prefix + keyed(method, key);
  }

  #wake(full, value) {
    const fns = this.#watchers.get(full);
    if (fns !== undefined) for (const fn of [...fns]) fn(value);
    this.#told(full, value);
  }

  /** The value under `key`, or null. */
  async get(key) {
    const text = await this.#store.get(this.#full('get', key));
    return text === null ? null : JSON.parse(text);
  }

  /** Writes `value` (JSON) under `key`; resolves to the value as JSON holds it. */
  async set(key, value) {
    if (value === undefined || value === null) throw new TypeError('set() takes a JSON value; delete() removes one');
    const full = this.#full('set', key);
    const text = JSON.stringify(value);
    if (typeof text !== 'string') throw new TypeError('set() takes a JSON value');
    await this.#store.put(full, text, { atomic: true });
    const held = JSON.parse(text);
    this.#wake(full, held);
    return held;
  }

  /** Removes `key`; nothing to remove is nothing. */
  async delete(key) {
    const full = this.#full('delete', key);
    if (!(await this.#store.has(full))) return;
    await this.#store.remove(full);
    this.#wake(full, null);
  }

  /** The keys of this scope, sorted. */
  async list() {
    const names = await this.#store.list();
    const out = [];
    for (let i = 0; i < names.length; i++) {
      if (names[i].startsWith(this.#prefix)) out.push(names[i].slice(this.#prefix.length));
    }
    return out.sort();
  }

  /** Calls `listener(value)` after every `set`/`delete` of `key` here (null once deleted); returns the stop. */
  observe(key, listener) {
    if (typeof listener !== 'function') throw new TypeError('observe() takes a listener');
    const full = this.#full('observe', key);
    let fns = this.#watchers.get(full);
    if (fns === undefined) this.#watchers.set(full, (fns = new Set()));
    fns.add(listener);
    return () => {
      fns.delete(listener);
      if (fns.size === 0) this.#watchers.delete(full);
    };
  }

  /** The same store under `prefix` — a collection's: keys `<prefix>.<key>`. */
  scoped(prefix) {
    if (!isKvKey(prefix)) throw new TypeError('scoped() takes a prefix: a kv key');
    return new LocalStore(this.#store, `${this.#prefix}${prefix}.`, this.#told, this.#watchers);
  }
}

/** The plugin: `db.local`, the local documents of a database. */
const local = Object.freeze({
  name: 'local',
  setup({ db, storage, logger }) {
    const store = kvNamespace(db.kv, NAMESPACE);
    const told = (key, value) => notify(storage, logger, 'local', { key, value });
    return { local: new LocalStore(store, '', told) };
  },
});

module.exports = { local };
