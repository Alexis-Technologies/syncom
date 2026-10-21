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
// listed but never matched. A tombstone — a deleted or purged record, whose
// file stays — is a row flagged `gone`: not listed, not matched, but there,
// so a snapshot can page over every entry without listing the directory.

const FILE = 'catalog.json';
// The key `ids()` caches the whole live list under.
const ALL = Symbol('syncom.catalog.all');
const FORMAT = 2;

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

// Arrays and objects are keyed as values; an array is posted under each of
// its elements too (see `post`). Unique keys compare the whole value.
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

// A value is posted under its own key and, for an array, under each
// element's as well: `{ tags: 'bug' }` then narrows to the arrays that hold
// it, the way the predicate matches it. Candidates are a superset the
// predicate filters — a `[1]` element and a `[1]` value share a key, and
// the extra candidate costs a read, never a wrong row.
const post = (map, value, id, fn) => {
  fn(map, keyOf(value), id);
  if (!Array.isArray(value)) return;
  for (let i = 0; i < value.length; i++) fn(map, keyOf(value[i]), id);
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
  #sorted = null;
  #sortedIds = new Map();

  constructor({ fsi, path, entities }) {
    this.#fsi = fsi;
    this.#dir = `${path}/index`;
    const shape = [];
    for (const [name, def] of entities) {
      const fields = new Set(def.index);
      for (const key of def.unique) for (const field of key) fields.add(field);
      this.#defs.set(name, { index: def.index, unique: def.unique, fields: [...fields], indexed: fields });
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
    this.#sorted = null;
    if (row.gone) return;
    this.#sortedIds.delete(row.type);
    this.#sortedIds.delete(ALL);
    drop(this.#byType, row.type, id);
    const def = row.type === null ? undefined : this.#defs.get(row.type);
    if (!def) return;
    const eq = this.#eq.get(row.type);
    for (const field of Object.keys(row.fields)) post(eq.get(field), row.fields[field], id, drop);
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
    this.#sorted = null;
    if (row.gone) return;
    this.#sortedIds.delete(row.type);
    this.#sortedIds.delete(ALL);
    add(this.#byType, row.type, id);
    const def = row.type === null ? undefined : this.#defs.get(row.type);
    if (!def) return;
    let eq = this.#eq.get(row.type);
    if (!eq) this.#eq.set(row.type, (eq = new Map(def.fields.map((field) => [field, new Map()]))));
    for (const field of Object.keys(row.fields)) post(eq.get(field), row.fields[field], id, add);
    let unique = this.#unique.get(row.type);
    if (!unique) this.#unique.set(row.type, (unique = new Map(def.unique.map((key) => [key.join(','), new Map()]))));
    for (const key of def.unique) {
      const value = this.#uniqueKey(row.fields, key);
      if (value !== null) add(unique.get(key.join(',')), value, id);
    }
  }

  /**
   * Records what `id` is now: `null` for a record with no file any more,
   * `{ type, v, gone: true }` for a tombstone (deleted or purged, the file
   * stays), `{ type, v, encrypted: true }` for a sealed record, `{ type, v,
   * data }` for a live one — `data` as it reads (the lens applied).
   */
  put(id, view) {
    const was = this.#rows.get(id);
    const before = was && !was.gone ? was.type : null;
    this.#remove(id);
    this.#dirty++;
    const gone = view !== null && view.gone === true;
    const type = view === null ? null : typeof view.type === 'string' ? view.type : null;
    if (before !== null) this.#wake(before);
    if (!gone && type !== null && type !== before) this.#wake(type);
    if (view === null) return;
    const row = { type, v: view.v ?? null, encrypted: view.encrypted === true, fields: {} };
    if (gone) row.gone = true;
    const def = type === null || gone ? undefined : this.#defs.get(type);
    if (def && !row.encrypted) {
      for (const field of def.fields) {
        const value = valueOf(view.data, field);
        if (value !== undefined) row.fields[field] = value;
      }
    }
    this.#insert(id, row);
  }

  /** Whether `id` is a live record (an encrypted one counts; a tombstone does not). */
  has(id) {
    const row = this.#rows.get(id);
    return row !== undefined && !row.gone;
  }

  /** Every id with a file — live, encrypted or a tombstone — sorted, cached until the next put. */
  all() {
    this.#sorted ??= [...this.#rows.keys()].sort();
    return this.#sorted;
  }

  /** The fields of a collection the catalog holds — what a covered query may read. Shared: read it, do not edit it. */
  indexed(type) {
    return this.#defs.get(type)?.indexed ?? new Set();
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

  /**
   * Every live id (tombstones left out), or those of one collection, sorted
   * — cached until a record of the collection changes. Shared: read it, do
   * not edit it.
   */
  ids(type) {
    const key = type === undefined ? ALL : type;
    let sorted = this.#sortedIds.get(key);
    if (sorted !== undefined) return sorted;
    if (type !== undefined) sorted = [...(this.#byType.get(type) ?? [])].sort();
    else {
      sorted = [];
      for (const [id, row] of this.#rows) if (!row.gone) sorted.push(id);
      sorted.sort();
    }
    this.#sortedIds.set(key, sorted);
    return sorted;
  }

  /**
   * The ids a query over `entity` can only match, from the indexed fields
   * it names by equality (`field: value`, `{ $eq }`, `{ $in }`) — at the top
   * level and down every `$and` branch; an `$or` narrows when each of its
   * branches does: the intersection of their posting lists. `null` when no
   * indexed field is named — then every record of the collection is a
   * candidate.
   */
  candidates(entity, query) {
    const def = this.#defs.get(entity);
    const eq = this.#eq.get(entity);
    if (!def || !eq || !isObject(query) || Array.isArray(query)) return null;
    return this.#narrow(eq, query);
  }

  #narrow(eq, query) {
    let result = null;
    const meet = (found) => {
      result = result === null ? found : new Set([...result].filter((id) => found.has(id)));
    };
    for (const key of Object.keys(query)) {
      const condition = query[key];
      if (key === '$and') {
        if (!Array.isArray(condition)) continue;
        for (const sub of condition) {
          const found = isObject(sub) && !Array.isArray(sub) ? this.#narrow(eq, sub) : null;
          if (found !== null) meet(found);
        }
      } else if (key === '$or') {
        // One branch that cannot narrow is the whole collection.
        if (!Array.isArray(condition) || condition.length === 0) continue;
        const union = new Set();
        let whole = false;
        for (const sub of condition) {
          const found = isObject(sub) && !Array.isArray(sub) ? this.#narrow(eq, sub) : null;
          if (found === null) {
            whole = true;
            break;
          }
          for (const id of found) union.add(id);
        }
        if (!whole) meet(union);
      } else if (eq.has(key)) {
        let values;
        if (!isObject(condition) || Array.isArray(condition)) values = [condition];
        else if (Object.hasOwn(condition, '$eq')) values = [condition.$eq];
        else if (Array.isArray(condition.$in)) values = condition.$in;
        else continue;
        const posting = eq.get(key);
        const found = new Set();
        for (const value of values) for (const id of posting.get(keyOf(value)) ?? []) found.add(id);
        meet(found);
      }
      if (result !== null && result.size === 0) break;
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
      const [id, type, v, encrypted, fields, gone] = row;
      this.#remove(id);
      const loaded = {
        type: typeof type === 'string' ? type : null,
        v: v ?? null,
        encrypted: encrypted === true,
        fields: isObject(fields) ? fields : {},
      };
      if (gone === true) loaded.gone = true;
      this.#insert(id, loaded);
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
    for (const [id, row] of this.#rows) {
      const cells = [id, row.type, row.v, row.encrypted, row.fields];
      if (row.gone) cells.push(true);
      rows.push(cells);
    }
    const saved = this.#dirty;
    await this.#fsi.write(this.#dir, FILE, JSON.stringify({ format: FORMAT, indexes: this.#indexKey, stamp, rows }));
    this.#dirty -= saved;
  }
}

module.exports = { Catalog, valueOf };
