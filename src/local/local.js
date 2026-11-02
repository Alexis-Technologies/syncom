'use strict';

// Local documents (@alexify/syncom/local): values kept beside the records,
// in the `local` namespace of the engine's kv, that never become an op —
// not logged, not in the catalog, not in a snapshot, never at a peer: the
// window's layout, a draft, a cursor position, what one node keeps for
// itself. `createDatabase({ plugins: [local] })` hands the core `db.local`
// (`get`, `set`, `delete`, `list`, `observe`, `scoped`) and a `local` event
// on the database; a collection's `local` is the same store under the
// collection's prefix. Values are JSON; a key is a kv key (no `/`). The
// changes of one key go one at a time (`set(key, fn)` reads the value the
// write before it left), an observer that throws is contained, a document
// that does not parse is CORRUPT. `observe` is this instance's: another
// instance over one engine hears nothing (a local document is one node's).
// Requires engine.js, errors.js and hooks.js only: it ships to the browser.

const { kvNamespace, isKvKey } = require('../engine.js');
const { SyncomError } = require('../errors.js');
const { notify } = require('../hooks.js');

const NAMESPACE = 'local';

const keyed = (method, key) => {
  if (!isKvKey(key)) throw new TypeError(`${method}() takes a key: a text of at most 255 characters, no '/'`);
  return key;
};

// A document's text as its value; one that does not parse is evidence, not a value.
const parse = (key, text) => {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new SyncomError('CORRUPT', `Local document ${key} is unreadable`, { key, cause });
  }
};

class LocalStore {
  #store;
  #prefix;
  #told;
  #logger;
  #watchers;
  // The change in flight per key: the next one waits for it.
  #lanes;

  // `store` the kv namespace, `prefix` what a collection's store puts before
  // every key (`''` the database's), `told(key, value)` the database's
  // event; the watchers and the lanes are shared by every scope.
  constructor(store, prefix, told, logger, watchers = new Map(), lanes = new Map()) {
    this.#store = store;
    this.#prefix = prefix;
    this.#told = told;
    this.#logger = logger;
    this.#watchers = watchers;
    this.#lanes = lanes;
  }

  /** A marker for `toStore()`: a local store. */
  get local() {
    return true;
  }

  #full(method, key) {
    return this.#prefix + keyed(method, key);
  }

  // One change of a key at a time, in order: a read-modify-write sees what the write before it left.
  #serial(full, change) {
    const before = this.#lanes.get(full) ?? Promise.resolve();
    const next = before.then(
      () => change(),
      () => change(),
    );
    const release = () => void (this.#lanes.get(full) === lane && this.#lanes.delete(full));
    const lane = next.then(release, release);
    this.#lanes.set(full, lane);
    return next;
  }

  // Every observer told, each contained; then the database's event.
  #wake(full, value) {
    const fns = this.#watchers.get(full);
    if (fns !== undefined) {
      for (const fn of [...fns]) {
        try {
          fn(value);
        } catch (err) {
          this.#logger?.warn?.({ event: 'listener.error', name: 'local', key: full, err });
        }
      }
    }
    this.#told(full, value);
  }

  async #read(full) {
    const text = await this.#store.get(full);
    return text === null ? null : parse(full, text);
  }

  /** The value under `key`, or null. */
  async get(key) {
    return this.#read(this.#full('get', key));
  }

  /**
   * Writes `value` (JSON) under `key` — or, given a function, what it answers
   * over the value as it is (null for none; `undefined` back leaves the
   * document as it is), one change of the key at a time. Resolves to the
   * value as JSON holds it.
   */
  async set(key, value) {
    const full = this.#full('set', key);
    return this.#serial(full, async () => {
      const current = typeof value === 'function' ? await this.#read(full) : undefined;
      const given = typeof value === 'function' ? value(current) : value;
      if (given === undefined && typeof value === 'function') return current;
      if (given === undefined || given === null) {
        throw new TypeError(
          'set() takes a JSON value, or a function of the value that answers one; delete() removes one',
        );
      }
      const text = JSON.stringify(given);
      if (typeof text !== 'string') throw new TypeError('set() takes a JSON value');
      await this.#store.put(full, text, { atomic: true });
      const held = JSON.parse(text);
      this.#wake(full, held);
      return held;
    });
  }

  /** Removes `key`; nothing to remove is nothing. */
  async delete(key) {
    const full = this.#full('delete', key);
    return this.#serial(full, async () => {
      if (!(await this.#store.has(full))) return;
      await this.#store.remove(full);
      this.#wake(full, null);
    });
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
    const full = `${this.#prefix}${prefix}.`;
    return new LocalStore(this.#store, full, this.#told, this.#logger, this.#watchers, this.#lanes);
  }
}

/** The plugin: `db.local`, the local documents of a database. */
const local = Object.freeze({
  name: 'local',
  setup({ db, storage, logger }) {
    const store = kvNamespace(db.kv, NAMESPACE);
    const told = (key, value) => notify(storage, logger, 'local', { key, value });
    return { local: new LocalStore(store, '', told, logger) };
  },
});

module.exports = { local };
