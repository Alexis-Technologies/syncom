'use strict';

// The query cache (the query plugin's, one per database): a result by its
// key — the entity, the query, the order, the window, the projection and
// the populated fields, as canonical text — with the catalog's generation
// it was read at, so a `fetch()` of a key the catalog has not moved since
// reads nothing; and the ONE live run (./live.js) every `watch()` of a key
// shares, whose rows keep the key's result current for as long as it runs.
// At most `max` results no live run keeps are held, the least recently
// used let go of first. A cursor with a `filter(fn)` has no key: a
// function cannot be named. No requires: it ships to the browser.

const MAX = 100;

// A RegExp has no JSON of its own: keyed by its source and flags.
const replacer = (key, value) => (value instanceof RegExp ? { $regex: value.source, $options: value.flags } : value);

// A value with its object keys sorted at every depth, as text: `{ a, b }` and `{ b, a }` are one query.
const canonical = (value) => {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) out.push(canonical(value[i]));
    return out;
  }
  if (value === null || typeof value !== 'object' || value instanceof RegExp) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
};

/** The key of a cursor's result: what it reads and how, as one text. */
const keyOf = (parts) => JSON.stringify(canonical(parts), replacer);

class QueryCache {
  #entries = new Map();
  #max;
  // How many entries hold a result no live run keeps.
  #idle = 0;

  constructor({ max = MAX } = {}) {
    this.#max = max;
  }

  get size() {
    return this.#entries.size;
  }

  #entry(key) {
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { rows: null, generation: -1, live: null };
      this.#entries.set(key, entry);
    } else {
      // Most recently used: last in the map.
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    return entry;
  }

  /** The rows kept for `key` as of `generation`, or null when there are none or the catalog moved since. */
  rows(key, generation) {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.rows === null || entry.generation !== generation) return null;
    this.#entry(key);
    return entry.rows;
  }

  /** Keeps `rows` as the result of `key` read at `generation`; the least recently used idle result goes past `max`. */
  keep(key, generation, rows) {
    const entry = this.#entry(key);
    if (entry.rows === null && entry.live === null) this.#idle++;
    entry.rows = rows;
    entry.generation = generation;
    this.#trim();
  }

  #trim() {
    if (this.#idle <= this.#max) return;
    for (const [key, entry] of this.#entries) {
      if (entry.live !== null) continue;
      this.#entries.delete(key);
      this.#idle--;
      if (this.#idle <= this.#max) break;
    }
  }

  /** The live run of `key`, made by `make()` at the first ask; `release(key)` once it has no subscriber. */
  live(key, make) {
    const entry = this.#entry(key);
    if (entry.live === null) {
      if (entry.rows !== null) this.#idle--;
      entry.live = make(entry);
    }
    return entry.live;
  }

  /** The live run of `key` is over: its last rows stay as an idle result. */
  release(key) {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.live === null) return;
    entry.live = null;
    if (entry.rows === null) this.#entries.delete(key);
    else {
      this.#idle++;
      this.#trim();
    }
  }
}

module.exports = { QueryCache, keyOf };
