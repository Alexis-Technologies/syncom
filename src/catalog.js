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
//
// A searchable entity (`search: [...]` fields) keeps the joined text of
// those fields on its row too, and hands it to an injected text index
// (`open({ search })`, the TextIndex contract) on every put — the index is
// rebuilt from the rows at load and never persists anything of its own.
// `$text` in a query then seeds the candidates with the index's ranking.

const FILE = 'catalog.json';
// The key `ids()` caches the whole live list under.
const ALL = Symbol('syncom.catalog.all');
const FORMAT = 3;

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

// A value with its object keys sorted at every depth: `{ a, b }` and
// `{ b, a }` are equal to the query's predicate, so they share a key. A
// prototype-less copy, so a `__proto__` field stays a field.
const canonical = (value) => {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) out.push(canonical(value[i]));
    return out;
  }
  if (!isObject(value)) return value;
  const out = Object.create(null);
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
};

// What `result` and `found` both hold, in `result`'s order (the `$text`
// ranking rides on it); `found` itself when there is no result yet.
const meet = (result, found) => {
  if (result === null) return found;
  const next = new Set();
  for (const id of result) if (found.has(id)) next.add(id);
  return next;
};

// Arrays and objects are keyed as values; an array is posted under each of
// its elements too (see `post`). Unique keys compare the whole value.
const keyOf = (value) => JSON.stringify(canonical(value));

// The text `$text` searches a record by: its string fields among `fields`,
// and the string elements of its array fields, joined by a space — as the
// record reads (the lens applied). Nothing else is a word.
const textOf = (data, fields) => {
  const parts = [];
  // The strings of a value: itself, its array elements, and — four levels
  // down, for a list's elements that carry fields — the strings of its objects.
  const collect = (value, depth) => {
    if (typeof value === 'string') parts.push(value);
    else if (depth > 0 && Array.isArray(value)) for (let j = 0; j < value.length; j++) collect(value[j], depth - 1);
    else if (depth > 0 && isObject(value)) for (const key of Object.keys(value)) collect(value[key], depth - 1);
  };
  for (let i = 0; i < fields.length; i++) collect(valueOf(data, fields[i]), 4);
  return parts.join(' ');
};

// The TextIndex contract — what `open({ search })` must hand back for an
// entity: put(id, text), remove(id), query(text) → [{ id, score }] best first.
const isTextIndex = (value) =>
  isObject(value) &&
  typeof value.put === 'function' &&
  typeof value.remove === 'function' &&
  typeof value.query === 'function';

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
  #text;
  #logger;

  constructor({ fsi, path, entities, text = new Map(), logger = null }) {
    this.#fsi = fsi;
    this.#dir = `${path}/index`;
    this.#text = text;
    this.#logger = logger;
    const shape = [];
    for (const [name, def] of entities) {
      const fields = new Set(def.index);
      for (const key of def.unique) for (const field of key) fields.add(field);
      const search = def.search ?? [];
      this.#defs.set(name, { index: def.index, unique: def.unique, search, fields: [...fields], indexed: fields });
      shape.push([name, def.index, def.unique, search]);
    }
    // What a persisted catalog must have been built with to be reused.
    this.#indexKey = keyOf(shape);
  }

  // The row's text into the entity's text index, or out of it. Derived
  // state never fails a write — the record is durable by now — so an index
  // that throws is logged (where there is a logger) and left as it is.
  #index(id, row, kept) {
    if (row.text === undefined) return;
    const index = this.#text.get(row.type);
    if (index === undefined) return;
    try {
      if (kept) index.put(id, row.text);
      else index.remove(id);
    } catch (error) {
      this.#logger?.warn({ event: 'catalog.search', id, err: error });
    }
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
    this.#index(id, row, false);
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

  /** What unique key `key` (a field list) reads as in `data` — null when a field is missing. */
  uniqueKey(data, key) {
    const fields = {};
    for (const field of key) {
      const value = valueOf(data, field);
      if (value !== undefined) fields[field] = value;
    }
    return this.#uniqueKey(fields, key);
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
    this.#index(id, row, true);
    const def = row.type === null ? undefined : this.#defs.get(row.type);
    if (!def) return;
    let eq = this.#eq.get(row.type);
    if (!eq) {
      eq = new Map();
      for (let i = 0; i < def.fields.length; i++) eq.set(def.fields[i], new Map());
      this.#eq.set(row.type, eq);
    }
    for (const field of Object.keys(row.fields)) post(eq.get(field), row.fields[field], id, add);
    let unique = this.#unique.get(row.type);
    if (!unique) {
      unique = new Map();
      for (let i = 0; i < def.unique.length; i++) unique.set(def.unique[i].join(','), new Map());
      this.#unique.set(row.type, unique);
    }
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
      if (def.search.length > 0) {
        const text = textOf(view.data, def.search);
        if (text.length > 0) row.text = text;
      }
    }
    this.#insert(id, row);
  }

  /** Whether `$text` can be asked of this collection: it has search fields and an index. */
  searches(type) {
    return this.#text.has(type);
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
    if (!def || !isObject(query) || Array.isArray(query)) return null;
    // `$text` seeds the candidates with the index's ranking, best first;
    // every equality then narrows that order rather than replacing it.
    const index = this.#text.get(entity);
    const ranked = index !== undefined && typeof query.$text === 'string' ? this.#ranked(index, query.$text) : null;
    const eq = this.#eq.get(entity);
    if (!eq) return ranked;
    return this.#narrow(eq, query, ranked);
  }

  // A fresh Set in the index's order: never the index's own structures.
  #ranked(index, text) {
    const found = new Set();
    for (const hit of index.query(text)) if (isObject(hit) && typeof hit.id === 'string') found.add(hit.id);
    return found;
  }

  #narrow(eq, query, seed = null) {
    let result = seed;
    for (const key of Object.keys(query)) {
      const condition = query[key];
      if (key === '$and') {
        if (!Array.isArray(condition)) continue;
        for (const sub of condition) {
          const found = isObject(sub) && !Array.isArray(sub) ? this.#narrow(eq, sub) : null;
          if (found !== null) result = meet(result, found);
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
        if (!whole) result = meet(result, union);
      } else if (eq.has(key)) {
        let values;
        if (!isObject(condition) || Array.isArray(condition)) values = [condition];
        else if (Object.hasOwn(condition, '$eq')) values = [condition.$eq];
        else if (Array.isArray(condition.$in)) values = condition.$in;
        else continue;
        const posting = eq.get(key);
        const found = new Set();
        for (const value of values) for (const id of posting.get(keyOf(value)) ?? []) found.add(id);
        result = meet(result, found);
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
  /** The rows as they are, `[id, row]` pairs — shared objects, never edited in place. */
  rows() {
    return [...this.#rows];
  }

  /** Takes rows as `rows()` hands them out — a copy of another catalog, under the same definitions. */
  adopt(rows) {
    for (const [id, row] of rows) {
      this.#remove(id);
      this.#insert(id, row);
      this.#dirty++;
    }
  }

  // `strict: false` reuses a catalog saved under other indexes — a tag's,
  // where the rows say what existed and the indexes are those of its day.
  async load({ strict = true } = {}) {
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
      (!strict || parsed.indexes === this.#indexKey) &&
      typeof parsed.stamp === 'string' &&
      Array.isArray(parsed.rows);
    if (!usable) return null;
    for (const row of parsed.rows) {
      if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
      const [id, type, v, encrypted, fields, gone, text] = row;
      this.#remove(id);
      const loaded = {
        type: typeof type === 'string' ? type : null,
        v: v ?? null,
        encrypted: encrypted === true,
        fields: isObject(fields) ? fields : {},
      };
      if (gone === true) loaded.gone = true;
      else if (typeof text === 'string') loaded.text = text;
      // Replayed through #insert: the text index is rebuilt here, under the
      // file's stamp, from the rows alone.
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
      else if (row.text !== undefined) cells.push(false, row.text);
      rows.push(cells);
    }
    const saved = this.#dirty;
    await this.#fsi.write(this.#dir, FILE, JSON.stringify({ format: FORMAT, indexes: this.#indexKey, stamp, rows }));
    this.#dirty -= saved;
  }
}

module.exports = { Catalog, valueOf, textOf, isTextIndex };
