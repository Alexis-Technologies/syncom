'use strict';

const { fsiNamespace } = require('./engine.js');

// The record catalog: every live record's id, collection and indexed field
// values, in memory, so `list()`, `hasRecord()` and a query by an indexed
// field cost no I/O. It is derived state — rebuilt from `data/` when it is
// missing or stale — and persisted as `<path>/index/catalog.json` stamped
// with the log position it reflects, so a reopen catches up from the log
// instead of scanning. Persisted through a store — one kv namespace
// (src/engine.js): `index` for the live catalog, `tags/<name>/index` for a
// tag's. Requires engine.js only: this file ships to the browser.
//
// Rows hold the indexed field values only (the record itself stays in the
// cache or on disk); an encrypted record is a row with no fields, so it is
// listed but never matched. A tombstone — a deleted or purged record, whose
// file stays — is a row flagged `gone`: not listed, not matched, but there,
// so a snapshot can page over every entry without listing the directory.
//
// A searchable entity (`search: [...]` fields) keeps the joined text of
// those fields on its row too, and hands it to an injected text index
// (`createDatabase({ search })`, the TextIndex contract) on every put — the index is
// rebuilt from the rows at load and never persists anything of its own.
// `$text` in a query then seeds the candidates with the index's ranking.

const FILE = 'catalog.json';
// The key `ids()` caches the whole live list under.
const ALL = Symbol('syncom.catalog.all');
// 4: a folded tombstone's stamps ride on its row (`folded`, the eighth cell; @alexify/syncom/cleanup).
const FORMAT = 4;

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

// A total order for sorting: nothing, then booleans, numbers, strings, then
// everything else (left where it was) — the order of `order()`, of a sorted
// index, of `$gt` and the rest, which hold only between values of one of
// the three ordered kinds.
const rankOf = (value) => {
  if (value === undefined || value === null) return 0;
  const type = typeof value;
  if (type === 'boolean') return 1;
  if (type === 'number') return 2;
  if (type === 'string') return 3;
  return 4;
};

const compare = (a, b) => {
  const rank = rankOf(a);
  const other = rankOf(b);
  if (rank !== other) return rank - other;
  if (rank === 0 || rank === 4) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
};

// Two entries of a sorted index: by each key, then by id.
const compareEntries = (a, b) => {
  for (let i = 0; i < a.keys.length; i++) {
    const order = compare(a.keys[i], b.keys[i]);
    if (order !== 0) return order;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// The first position of `entries` at which `test` is no longer below: a binary search.
const lowerBound = (entries, below) => {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (below(entries[mid])) low = mid + 1;
    else high = mid;
  }
  return low;
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

// Whether two catalog rows say the same: type, version, flags, text and every
// indexed value.
const sameRow = (a, b) => {
  if (a.type !== b.type || a.v !== b.v || a.encrypted !== b.encrypted || a.gone !== b.gone || a.text !== b.text) {
    return false;
  }
  if ((a.folded === undefined) !== (b.folded === undefined)) return false;
  if (a.folded !== undefined && keyOf(a.folded) !== keyOf(b.folded)) return false;
  const keys = Object.keys(a.fields);
  if (keys.length !== Object.keys(b.fields).length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Object.hasOwn(b.fields, key)) return false;
    const x = a.fields[key];
    const y = b.fields[key];
    if (x !== y && (typeof x !== 'object' || typeof y !== 'object' || keyOf(x) !== keyOf(y))) return false;
  }
  return true;
};

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

// The TextIndex contract — what `createDatabase({ search })` must hand back for an
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

// What the catalog keeps of an entity definition: the indexed fields (the
// `index` ones and every field of a unique key), the unique keys, the search fields.
const defOf = (def) => {
  const fields = new Set(def.index);
  for (const key of def.unique) for (const field of key) fields.add(field);
  const search = def.search ?? [];
  // The sorted keys kept: the declared indexes (singles as one-field keys), each with its name.
  let indexes = def.indexes ?? null;
  if (indexes === null) {
    indexes = [];
    for (let i = 0; i < def.index.length; i++) indexes.push([def.index[i]]);
  }
  return { index: def.index, indexes, unique: def.unique, search, fields: [...fields], indexed: fields };
};

// What a sorted index holds of a row: its keys, one per field of the index
// — and, where a field holds an array, one entry per element of it (as the
// posting lists post an array, and as the predicate matches one: by any of
// its elements), every combination of them; `multi` says an array was met.
// Bounded: past 64 entries the array is keyed whole alone.
const MAX_ENTRIES = 64;
const keysOf = (fields, index) => {
  let tuples = [[]];
  let multi = false;
  for (let i = 0; i < index.length; i++) {
    const value = valueOf(fields, index[i]);
    const elements =
      Array.isArray(value) && value.length > 0 && tuples.length * value.length <= MAX_ENTRIES ? value : null;
    const next = [];
    for (let t = 0; t < tuples.length; t++) {
      if (elements === null) next.push(tuples[t].concat([value]));
      else {
        multi = true;
        for (let e = 0; e < elements.length; e++) next.push(tuples[t].concat([elements[e]]));
      }
    }
    tuples = next;
  }
  return { tuples, multi };
};

// Whether two entries hold the same keys.
const sameKeys = (a, b) => {
  for (let i = 0; i < a.keys.length; i++) if (compare(a.keys[i], b.keys[i]) !== 0) return false;
  return true;
};

// A row with nothing indexed: what a record of a collection keeps while
// its definition changes (the caller indexes it again).
const bare = (row) => {
  const out = { type: row.type, v: row.v, encrypted: row.encrypted, fields: {} };
  if (row.gone) out.gone = true;
  return out;
};

class Catalog {
  #store;
  #rowStore;
  #defs = new Map();
  #indexKey;
  #rows = new Map();
  #byType = new Map();
  #eq = new Map();
  #unique = new Map();
  // Per type, per declared index (by its name): the entries `{ keys, id }` in key order, then id — what
  // a range, a prefix or a sort reads in order (`scan`).
  #keyed = new Map();
  #watchers = new Map();
  #dirty = 0;
  // The rows put since the last save, by id (null: removed), and whether the
  // rows store holds this catalog's rows already — what a row store writes.
  #changed = new Map();
  #loaded = false;
  #sorted = null;
  #sortedIds = new Map();
  #text;
  #textPending = new Map();
  #logger;
  // Moved by every put, a definition, an adoption, a load: what a query result is current as of.
  #generation = 0;

  constructor({ store = null, rows = null, fsi = null, path = null, entities, text = new Map(), logger = null }) {
    // A text store given (a kv namespace), a rows store (a native engine's:
    // `load()` → `{ indexes, stamp, rows }` | null, `save(indexes, stamp, { all,
    // changed, whole })` — the rows kept as they are, or a row at a time: `all()`
    // every row, `changed` the ids put since the last save, `whole` when the
    // store holds none of this catalog's rows), else the `index` directory of an fsi at `path`.
    this.#rowStore = rows;
    this.#store = store ?? (rows === null ? fsiNamespace(fsi, `${path}/index`) : null);
    this.#text = text;
    this.#logger = logger;
    for (const [name, def] of entities) this.#defs.set(name, defOf(def));
    this.#rekey();
  }

  // What a persisted catalog must have been built with to be reused: the
  // collections, their indexes, unique keys and search fields.
  #rekey() {
    const shape = [];
    for (const [name, def] of this.#defs) shape.push([name, def.index, def.indexes, def.unique, def.search]);
    this.#indexKey = keyOf(shape);
  }

  /** The declared indexes of a collection — the keys as field lists, the sorted indexes kept. Shared: read it, do not edit it. */
  indexes(type) {
    return this.#defs.get(type)?.indexes ?? [];
  }

  /**
   * The ids a plan (src/query/plan.js) reads from a sorted index, in its
   * order — the rows whose first keys are `prefix`, within `range` on the
   * key after it (`{ lower: { value, inclusive }, upper }`, either side
   * open), forward or backward (`desc`). A scan is bounded: a binary search
   * to each edge, the entries between.
   */
  scan(type, { index, prefix, range, desc }) {
    const held = this.#keyed.get(type)?.get(index.join(','));
    if (held === undefined) return { ids: [], sorted: true };
    const { entries } = held;
    const k = prefix.length;
    // Below the prefix (and the lower edge) / within or below the upper edge.
    const belowLower = (entry) => {
      for (let i = 0; i < k; i++) {
        const order = compare(entry.keys[i], prefix[i]);
        if (order !== 0) return order < 0;
      }
      if (range === null || range.lower === null) return false;
      const order = compare(entry.keys[k], range.lower.value);
      return order < 0 || (order === 0 && !range.lower.inclusive);
    };
    const withinUpper = (entry) => {
      for (let i = 0; i < k; i++) {
        const order = compare(entry.keys[i], prefix[i]);
        if (order !== 0) return order < 0;
      }
      if (range === null || range.upper === null) return true;
      const order = compare(entry.keys[k], range.upper.value);
      return order < 0 || (order === 0 && range.upper.inclusive);
    };
    const from = lowerBound(entries, belowLower);
    const to = lowerBound(entries, withinUpper);
    const ids = [];
    // An array keyed per element lists a row once per element in range: each id once.
    const seen = held.multi ? new Set() : null;
    const push = (id) => {
      if (seen !== null) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      ids.push(id);
    };
    if (!desc) for (let i = from; i < to; i++) push(entries[i].id);
    else {
      // Backwards by key, forwards by id within equal keys: the result's one order.
      let i = to - 1;
      while (i >= from) {
        let j = i;
        while (j > from && sameKeys(entries[j - 1], entries[i])) j--;
        for (let k = j; k <= i; k++) push(entries[k].id);
        i = j - 1;
      }
    }
    // Sorted by the index only where no key holds an array (an element's place is not the row's).
    return { ids, sorted: !held.multi };
  }

  // A row's entries into the type's sorted indexes, or out of them.
  #key(type, id, fields, def, into) {
    let byIndex = this.#keyed.get(type);
    if (byIndex === undefined) {
      if (!into) return;
      byIndex = new Map();
      for (let i = 0; i < def.indexes.length; i++) {
        byIndex.set(def.indexes[i].join(','), { fields: def.indexes[i], entries: [], multi: false });
      }
      this.#keyed.set(type, byIndex);
    }
    for (const held of byIndex.values()) {
      const { tuples, multi } = keysOf(fields, held.fields);
      if (multi && into) held.multi = true;
      const { entries } = held;
      for (let t = 0; t < tuples.length; t++) {
        const entry = { keys: tuples[t], id };
        const at = lowerBound(entries, (other) => compareEntries(other, entry) < 0);
        if (into) entries.splice(at, 0, entry);
        else if (at < entries.length && entries[at].id === id && sameKeys(entries[at], entry)) entries.splice(at, 1);
      }
    }
  }

  /**
   * Defines collection `name` after the catalog was built (`addCollections`),
   * or forgets its definition (`def` null, `removeCollection`): the rows of
   * the type keep their place and lose what was indexed of them — the caller
   * indexes the records again — and `$text` reads `index` from then on (null:
   * no search). A catalog saved before is not reused by a reopen under
   * other definitions: it is rebuilt from the records.
   */
  define(name, def, index = null) {
    const ids = [...(this.#byType.get(name) ?? [])];
    const rows = [];
    for (let i = 0; i < ids.length; i++) {
      const row = bare(this.#rows.get(ids[i]));
      // Under the definition the row was posted under: the postings go with it.
      this.#remove(ids[i]);
      rows.push(row);
    }
    if (def === null) this.#defs.delete(name);
    else this.#defs.set(name, defOf(def));
    this.#eq.delete(name);
    this.#unique.delete(name);
    this.#keyed.delete(name);
    if (index === null) this.#text.delete(name);
    else this.#text.set(name, index);
    for (const [id, pending] of this.#textPending) if (pending.type === name) this.#textPending.delete(id);
    for (let i = 0; i < ids.length; i++) {
      this.#insert(ids[i], rows[i]);
      this.#dirty++;
      this.#changed.set(ids[i], rows[i]);
    }
    this.#rekey();
    this.#generation++;
  }

  // The row's text into the entity's text index, or out of it. Derived
  // state never fails a write — the record is durable by now — so an index
  // that throws is logged (where there is a logger) and left as it is.
  // The text index follows the rows lazily: a put or a removal waits here,
  // the last one per id, until a `$text` query asks — re-indexing a text on
  // every keystroke cost the whole text each time.
  #index(id, row, kept) {
    if (row.text === undefined || !this.#text.has(row.type)) return;
    this.#textPending.set(id, { type: row.type, text: kept ? row.text : null });
  }

  #flushText() {
    if (this.#textPending.size === 0) return;
    for (const [id, { type, text }] of this.#textPending) {
      const index = this.#text.get(type);
      try {
        if (text === null) index.remove(id);
        else index.put(id, text);
      } catch (error) {
        this.#logger?.warn({ event: 'catalog.search', id, err: error });
      }
    }
    this.#textPending.clear();
  }

  get size() {
    return this.#rows.size;
  }

  /** A number that moves with every change of a record the catalog heard of: what a result is current as of. */
  get generation() {
    return this.#generation;
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
    this.#key(row.type, id, row.fields, def, false);
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
    this.#key(row.type, id, row.fields, def, true);
  }

  /**
   * Records what `id` is now: `null` for a record with no file any more,
   * `{ type, v, gone: true }` for a tombstone (deleted or purged, the file
   * stays), `{ type, v, encrypted: true }` for a sealed record, `{ type, v,
   * data }` for a live one — `data` as it reads (the lens applied).
   */
  put(id, view) {
    this.#generation++;
    const was = this.#rows.get(id);
    const before = was && !was.gone ? was.type : null;
    const gone = view !== null && view.gone === true;
    const type = view === null ? null : typeof view.type === 'string' ? view.type : null;
    let row = null;
    if (view !== null) {
      row = { type, v: view.v ?? null, encrypted: view.encrypted === true, fields: {} };
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
    }
    // The row the catalog holds already: nothing to post again, nothing to
    // sort or save — but a watcher reads more than the row, so it hears of
    // the change (`false`: the row stayed; a covered cursor need not run).
    if (was !== undefined && row !== null && sameRow(was, row)) {
      if (before !== null) this.#wake(before, false, id, 'update');
      return;
    }
    this.#remove(id);
    this.#dirty++;
    this.#changed.set(id, row);
    // The collection the record was of hears an update, or its leaving (gone,
    // or of another collection now); the one it joins hears an insert.
    if (before !== null) this.#wake(before, true, id, !gone && type === before ? 'update' : 'remove');
    if (!gone && type !== null && type !== before) this.#wake(type, true, id, 'insert');
    if (row !== null) this.#insert(id, row);
  }

  /**
   * A tombstone's file folded into its row (`@alexify/syncom/cleanup`): the
   * stamps that keep the record dead — `{ base, deleted, v }` — ride on the
   * row, and a read of the id rebuilds the tombstone from them (src/entries.js).
   * The row stays a tombstone's: listed by `all()`, never by `ids()`.
   */
  fold(id, stamps) {
    const was = this.#rows.get(id);
    if (was === undefined || !was.gone) return false;
    const row = { ...was, folded: { base: stamps.base, deleted: stamps.deleted, v: stamps.v ?? null } };
    this.#rows.set(id, row);
    this.#sorted = null;
    this.#dirty++;
    this.#generation++;
    this.#changed.set(id, row);
    return true;
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

  /**
   * Calls `fn(changed, id, action)` after every change to a record of
   * `type` — `changed` false when the record's catalog row stayed as it was,
   * `action` what the change was to the collection: `insert`, `update` or
   * `remove` (deleted, purged, encrypted, or of another collection now);
   * returns the unsubscribe.
   */
  subscribe(type, fn) {
    let fns = this.#watchers.get(type);
    if (!fns) this.#watchers.set(type, (fns = new Set()));
    fns.add(fn);
    return () => {
      fns.delete(fn);
      if (fns.size === 0) this.#watchers.delete(type);
    };
  }

  #wake(type, changed, id, action) {
    const fns = this.#watchers.get(type);
    if (fns) for (const fn of [...fns]) fn(changed, id, action);
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
    if (index !== undefined && typeof query.$text === 'string') this.#flushText();
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
    this.#loaded = false;
    this.#generation++;
    for (const [id, row] of rows) {
      this.#remove(id);
      this.#insert(id, row);
      this.#dirty++;
      this.#changed.set(id, row);
    }
  }

  // `strict: false` reuses a catalog saved under other indexes — a tag's,
  // where the rows say what existed and the indexes are those of its day.
  async load({ strict = true } = {}) {
    this.#generation++;
    if (this.#rowStore !== null) return this.#loadRows(strict);
    const text = await this.#store.get(FILE);
    if (text === null) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
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
      const [id, type, v, encrypted, fields, gone, text, folded] = row;
      this.#remove(id);
      const loaded = {
        type: typeof type === 'string' ? type : null,
        v: v ?? null,
        encrypted: encrypted === true,
        fields: isObject(fields) ? fields : {},
      };
      if (gone === true) {
        loaded.gone = true;
        if (isObject(folded) && Array.isArray(folded.deleted)) loaded.folded = folded;
      } else if (typeof text === 'string') loaded.text = text;
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
  // The rows a native engine kept, taken as they are: no text to parse.
  async #loadRows(strict) {
    const saved = await this.#rowStore.load();
    if (saved === null || (strict && saved.indexes !== this.#indexKey) || typeof saved.stamp !== 'string') return null;
    const rows = saved.rows;
    for (let i = 0; i < rows.length; i++) {
      const [id, row] = rows[i];
      this.#remove(id);
      this.#insert(id, row);
    }
    this.#dirty = 0;
    this.#changed.clear();
    this.#loaded = true;
    return { stamp: saved.stamp };
  }

  async save(stamp) {
    if (this.#rowStore !== null) {
      const saved = this.#dirty;
      const changed = this.#changed;
      this.#changed = new Map();
      try {
        await this.#rowStore.save(this.#indexKey, stamp, { all: () => this.rows(), changed, whole: !this.#loaded });
      } catch (error) {
        // What this save carried is still to save: back under what changed since.
        for (const [id, row] of changed) if (!this.#changed.has(id)) this.#changed.set(id, row);
        throw error;
      }
      this.#loaded = true;
      this.#dirty -= saved;
      return;
    }
    const rows = [];
    for (const [id, row] of this.#rows) {
      const cells = [id, row.type, row.v, row.encrypted, row.fields];
      if (row.gone) {
        cells.push(true);
        if (row.folded !== undefined) cells.push(null, row.folded);
      } else if (row.text !== undefined) cells.push(false, row.text);
      rows.push(cells);
    }
    const saved = this.#dirty;
    const text = JSON.stringify({ format: FORMAT, indexes: this.#indexKey, stamp, rows });
    await this.#store.put(FILE, text, { atomic: true });
    this.#dirty -= saved;
  }
}

module.exports = { Catalog, valueOf, textOf, isTextIndex, rankOf, compare };
