'use strict';

// The record catalog: every live record's id, collection and indexed field
// values, in memory, so `list()`, `hasRecord()` and a query by an indexed
// field cost no I/O. It is derived state — rebuilt from `data/` when it is
// missing or stale — and persisted as `<path>/index/catalog.json` stamped
// with the log position it reflects, so a reopen catches up from the log
// instead of scanning. No requires: this file ships to the browser.
//
// Rows hold the indexed field values only (the record itself stays in the
// cache or on disk); an encrypted record is a row with no fields, so it is
// listed but never matched.

const FILE = 'catalog.json';
const FORMAT = 1;

const isObject = (value) => typeof value === 'object' && value !== null;

// A value by dotted path — a key spelled with the dot first (a catalog
// row, a projected row), the walk otherwise; `undefined` when a step is
// missing.
const valueOf = (data, path) => {
  if (isObject(data) && Object.hasOwn(data, path)) return data[path];
  let value = data;
  for (const part of path.split('.')) {
    if (!isObject(value)) return undefined;
    value = value[part];
  }
  return value;
};

// Arrays and objects are keyed as values, not as sets of their elements.
const keyOf = (value) => JSON.stringify(value);

const add = (map, key, id) => {
  let ids = map.get(key);
  if (!ids) map.set(key, (ids = new Set()));
  ids.add(id);
};

const drop = (map, key, id) => {
  const ids = map.get(key);
  if (!ids) return;
  ids.delete(id);
  if (ids.size === 0) map.delete(key);
};

class Catalog {
  #fsi;
  #dir;
  #defs = new Map();
  #indexKey;
  #rows = new Map();
  #byType = new Map();
  #eq = new Map();
  #unique = new Map();
  #watchers = new Map();
  #dirty = 0;

  constructor({ fsi, path, entities }) {
    this.#fsi = fsi;
    this.#dir = `${path}/index`;
    const shape = [];
    for (const [name, def] of entities) {
      const fields = new Set(def.index);
      for (const key of def.unique) for (const field of key) fields.add(field);
      this.#defs.set(name, { index: def.index, unique: def.unique, fields: [...fields] });
      shape.push([name, def.index, def.unique]);
    }
    // What a persisted catalog must have been built with to be reused.
    this.#indexKey = keyOf(shape);
  }

  get size() {
    return this.#rows.size;
  }

  /** Puts since the last save. */
  get dirty() {
    return this.#dirty;
  }

  #remove(id) {
    const row = this.#rows.get(id);
    if (!row) return;
    this.#rows.delete(id);
    drop(this.#byType, row.type, id);
    const def = row.type === null ? undefined : this.#defs.get(row.type);
    if (!def) return;
    const eq = this.#eq.get(row.type);
    for (const field of Object.keys(row.fields)) drop(eq.get(field), keyOf(row.fields[field]), id);
    const unique = this.#unique.get(row.type);
    for (const key of def.unique) {
      const value = this.#uniqueKey(row.fields, key);
      if (value !== null) drop(unique.get(key.join(',')), value, id);
    }
  }

  #uniqueKey(fields, key) {
    const parts = [];
    for (const field of key) {
      if (fields[field] === undefined) return null;
      parts.push(fields[field]);
    }
    return keyOf(parts);
  }

  #insert(id, row) {
    this.#rows.set(id, row);
    add(this.#byType, row.type, id);
    const def = row.type === null ? undefined : this.#defs.get(row.type);
    if (!def) return;
    let eq = this.#eq.get(row.type);
    if (!eq) this.#eq.set(row.type, (eq = new Map(def.fields.map((field) => [field, new Map()]))));
    for (const field of Object.keys(row.fields)) add(eq.get(field), keyOf(row.fields[field]), id);
    let unique = this.#unique.get(row.type);
    if (!unique) this.#unique.set(row.type, (unique = new Map(def.unique.map((key) => [key.join(','), new Map()]))));
    for (const key of def.unique) {
      const value = this.#uniqueKey(row.fields, key);
      if (value !== null) add(unique.get(key.join(',')), value, id);
    }
  }

  /**
   * Records what `id` is now: `null` for gone (deleted, purged), `{ type,
   * v, encrypted: true }` for a sealed record, `{ type, v, data }` for a
   * live one — `data` as it reads (the lens applied).
   */
  put(id, view) {
    const before = this.#rows.get(id)?.type ?? null;
    this.#remove(id);
    this.#dirty++;
    const type = view === null ? null : typeof view.type === 'string' ? view.type : null;
    if (before !== null) this.#wake(before);
    if (type !== null && type !== before) this.#wake(type);
    if (view === null) return;
    const row = { type, v: view.v ?? null, encrypted: view.encrypted === true, fields: {} };
    const def = type === null ? undefined : this.#defs.get(type);
    if (def && !row.encrypted) {
      for (const field of def.fields) {
        const value = valueOf(view.data, field);
        if (value !== undefined) row.fields[field] = value;
      }
    }
    this.#insert(id, row);
  }

  has(id) {
    return this.#rows.has(id);
  }

  /** The fields of a collection the catalog holds — what a covered query may read. */
  indexed(type) {
    return new Set(this.#defs.get(type)?.fields ?? []);
  }

  /** Calls `fn` after every change to a record of `type`; returns the unsubscribe. */
  subscribe(type, fn) {
    let fns = this.#watchers.get(type);
    if (!fns) this.#watchers.set(type, (fns = new Set()));
    fns.add(fn);
    return () => {
      fns.delete(fn);
      if (fns.size === 0) this.#watchers.delete(type);
    };
  }

  #wake(type) {
    const fns = this.#watchers.get(type);
    if (fns) for (const fn of [...fns]) fn();
  }

  row(id) {
    return this.#rows.get(id) ?? null;
  }

  /** Every live id, or those of one collection, sorted. */
  ids(type) {
    const ids = type === undefined ? [...this.#rows.keys()] : [...(this.#byType.get(type) ?? [])];
    return ids.sort();
  }

  /**
   * The ids a query over `entity` can only match, from the indexed fields
   * it names by equality (`field: value`, `{ $eq }`, `{ $in }`): the
   * intersection of their posting lists. `null` when no indexed field is
   * named — then every record of the collection is a candidate.
   */
  candidates(entity, query) {
    const def = this.#defs.get(entity);
    const eq = this.#eq.get(entity);
    if (!def || !eq || !isObject(query)) return null;
    let result = null;
    for (const field of Object.keys(query)) {
      if (!eq.has(field)) continue;
      const condition = query[field];
      let values;
      if (!isObject(condition) || Array.isArray(condition)) values = [condition];
      else if (Object.hasOwn(condition, '$eq')) values = [condition.$eq];
      else if (Array.isArray(condition.$in)) values = condition.$in;
      else continue;
      const posting = eq.get(field);
      const found = new Set();
      for (const value of values) for (const id of posting.get(keyOf(value)) ?? []) found.add(id);
      result = result === null ? found : new Set([...result].filter((id) => found.has(id)));
      if (result.size === 0) break;
    }
    return result;
  }

  /**
   * The unique keys `data` would collide on, were it the record `id`:
   * `[{ fields, other }]`, `other` being an id already holding that key.
   */
  uniqueConflicts(entity, id, data) {
    const def = this.#defs.get(entity);
    const unique = this.#unique.get(entity);
    if (!def || !unique) return [];
    const conflicts = [];
    for (const key of def.unique) {
      const fields = {};
      for (const field of key) {
        const value = valueOf(data, field);
        if (value !== undefined) fields[field] = value;
      }
      const value = this.#uniqueKey(fields, key);
      if (value === null) continue;
      for (const other of unique.get(key.join(','))?.get(value) ?? []) {
        if (other !== id) conflicts.push({ fields: [...key], other });
      }
    }
    return conflicts;
  }

  /**
   * Reads the persisted catalog; `{ stamp }` (the log position it reflects)
   * when it was built for these indexes, `null` when absent, unreadable or
   * built for others — a rebuild is the caller's.
   */
  async load() {
    if (!(await this.#fsi.exists(this.#dir, FILE))) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(await this.#fsi.read(this.#dir, FILE));
    } catch {
      return null;
    }
    const usable =
      isObject(parsed) &&
      parsed.format === FORMAT &&
      parsed.indexes === this.#indexKey &&
      typeof parsed.stamp === 'string' &&
      Array.isArray(parsed.rows);
    if (!usable) return null;
    for (const row of parsed.rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
      const [id, type, v, encrypted, fields] = row;
      this.#remove(id);
      this.#insert(id, {
        type: typeof type === 'string' ? type : null,
        v: v ?? null,
        encrypted: encrypted === true,
        fields: isObject(fields) ? fields : {},
      });
    }
    this.#dirty = 0;
    return { stamp: parsed.stamp };
  }

  /**
   * Writes the catalog as of `stamp`, the log position it reflects. The rows
   * are taken before the first await, so a save may run while puts go on:
   * what lands during the write stays dirty for the next one.
   */
  async save(stamp) {
    const rows = [];
    for (const [id, row] of this.#rows) rows.push([id, row.type, row.v, row.encrypted, row.fields]);
    const saved = this.#dirty;
    await this.#fsi.write(this.#dir, FILE, JSON.stringify({ format: FORMAT, indexes: this.#indexKey, stamp, rows }));
    this.#dirty -= saved;
  }
}

module.exports = { Catalog, valueOf };
