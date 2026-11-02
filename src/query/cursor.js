'use strict';

// Queries over a collection (the query plugin's, ./query.js): a Mango-style
// predicate compiled once, and a cursor that plans how to answer it — from
// the catalog alone when every field it reads is indexed, from the records
// otherwise. No requires beyond the engine's own: this file ships to the
// browser.

const { deepEqual, MAX_BATCH } = require('../shape.js');
const { valueOf, rankOf, compare } = require('../catalog.js');
const { Live } = require('./live.js');
const { keyOf } = require('./cache.js');
const { plan } = require('./plan.js');
const { DISTANCES, isVector } = require('../search/distance.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const MAX_REGEX = 1000;
const MAX_TEXT = 1000;
// How deep a query nests ($and/$or/$nor/$not/$elemMatch within one another): past it a TypeError, never a RangeError.
const MAX_QUERY_DEPTH = 32;
// How many records a loaded cursor reads at once.
const CONCURRENCY = 16;
// On a row, the object it was built from — the record as it reads, or its catalog row's fields —
// held until the record changes: what a live result tells a change of the row by. A symbol: a copy
// of the row (JSON) leaves it behind. The row's `id` is the record's, laid LAST: a data field named
// `id` never stands for another record in a query, a write by query or an `ifMatch`.
const VIEW = Symbol('syncom.view');
const rowOf = (id, view) => {
  const row = { ...view, id };
  row[VIEW] = view;
  return row;
};

// A pull over a list or a set of ids, from `start`: an id, or null past the last.
const pullOf = (found, start) => {
  if (Array.isArray(found)) {
    let i = start;
    return () => (i < found.length ? found[i++] : null);
  }
  const iterator = found[Symbol.iterator]();
  return () => {
    const step = iterator.next();
    return step.done ? null : step.value;
  };
};

// Every id a pull has left, as an array.
const drained = (next) => {
  const out = [];
  for (let id = next(); id !== null; id = next()) out.push(id);
  return out;
};

// The first index of a sorted id list whose id lies above `id`: a binary search.
const aboveId = (sorted, id) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] <= id) low = mid + 1;
    else high = mid;
  }
  return low;
};

// The order of values — nothing, then booleans, numbers, strings, then the rest — is the catalog's
// (`compare`, `rankOf`): the sorted indexes keep it, so a scan comes in the order a sort would give.

// Equality as a query means it: the value itself, or — for an array field
// and a scalar — any of its elements.
const matches = (actual, expected) => {
  if (deepEqual(actual, expected)) return true;
  if (!Array.isArray(actual) || Array.isArray(expected)) return false;
  for (let i = 0; i < actual.length; i++) if (deepEqual(actual[i], expected)) return true;
  return false;
};

// The predicates together: every one of them, or any one.
const allOf = (tests) => {
  if (tests.length === 1) return tests[0];
  return (value) => {
    for (let i = 0; i < tests.length; i++) if (!tests[i](value)) return false;
    return true;
  };
};

const anyOf = (tests) => (value) => {
  for (let i = 0; i < tests.length; i++) if (tests[i](value)) return true;
  return false;
};

const comparison = (op, expected) => {
  const rank = rankOf(expected);
  if (rank === 0 || rank === 4) throw new TypeError(`select(): ${op} takes a number, a string or a boolean`);
  const holds = (value) => {
    if (rankOf(value) !== rank) return false;
    if (op === '$gt') return value > expected;
    if (op === '$gte') return value >= expected;
    if (op === '$lt') return value < expected;
    return value <= expected;
  };
  return (value) => {
    if (!Array.isArray(value)) return holds(value);
    for (let i = 0; i < value.length; i++) if (holds(value[i])) return true;
    return false;
  };
};

const regexOf = (expected, options) => {
  const flags = (options ?? (expected instanceof RegExp ? expected.flags : '')).replaceAll(/[gy]/g, '');
  const source = expected instanceof RegExp ? expected.source : expected;
  if (typeof source !== 'string') throw new TypeError('select(): $regex takes a RegExp or a string');
  // A query is the application's, but a pattern the size of a document is
  // never one: a bound keeps a pasted-in pattern from being a denial.
  if (source.length > MAX_REGEX) throw new TypeError(`select(): $regex is longer than ${MAX_REGEX} characters`);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new TypeError(`select(): $regex is invalid — ${error.message}`, { cause: error });
  }
};

// `$type`: what a value is, in JSON's terms — `null` its own, an array its own.
const TYPES = new Set(['null', 'boolean', 'number', 'string', 'array', 'object']);
const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

// `$elemMatch`: a query over an element — an object element matched by a
// query of its fields, a scalar one by the operators as a field's value.
const elemMatch = (condition, depth) => {
  if (!isObject(condition)) throw new TypeError('select(): $elemMatch takes a query');
  let operators = 0;
  for (const key of Object.keys(condition)) if (key.startsWith('$')) operators++;
  const sub = operators > 0 ? compileField('', condition, depth + 1) : compileQuery(condition, true, depth + 1);
  const test = operators > 0 ? (element) => sub({ '': element }) : sub;
  return (value) => {
    if (!Array.isArray(value)) return false;
    for (let i = 0; i < value.length; i++) if (test(value[i])) return true;
    return false;
  };
};

const compileField = (path, condition, depth = 0) => {
  if (depth > MAX_QUERY_DEPTH) throw new TypeError(`select(): a query nests deeper than ${MAX_QUERY_DEPTH} levels`);
  if (!isObject(condition)) return (row) => matches(valueOf(row, path), condition);
  const tests = [];
  const options = typeof condition.$options === 'string' ? condition.$options : undefined;
  let operators = 0;
  for (const op of Object.keys(condition)) {
    if (!op.startsWith('$')) continue;
    operators++;
    const expected = condition[op];
    if (op === '$eq') tests.push((value) => matches(value, expected));
    else if (op === '$ne') tests.push((value) => !matches(value, expected));
    else if (op === '$in' || op === '$nin') {
      if (!Array.isArray(expected)) throw new TypeError(`select(): ${op} takes an array`);
      const hit = (value) => {
        for (let i = 0; i < expected.length; i++) if (matches(value, expected[i])) return true;
        return false;
      };
      tests.push(op === '$in' ? hit : (value) => !hit(value));
    } else if (op === '$gt' || op === '$gte' || op === '$lt' || op === '$lte') tests.push(comparison(op, expected));
    else if (op === '$exists') {
      if (typeof expected !== 'boolean') throw new TypeError('select(): $exists takes a boolean');
      tests.push((value) => (value !== undefined) === expected);
    } else if (op === '$regex') {
      const regex = regexOf(expected, options);
      const hit = (value) => typeof value === 'string' && regex.test(value);
      tests.push((value) => {
        if (!Array.isArray(value)) return hit(value);
        for (let i = 0; i < value.length; i++) if (hit(value[i])) return true;
        return false;
      });
    } else if (op === '$type') {
      if (!TYPES.has(expected)) {
        throw new TypeError('select(): $type takes null, boolean, number, string, array or object');
      }
      tests.push((value) => value !== undefined && typeOf(value) === expected);
    } else if (op === '$size') {
      if (!Number.isInteger(expected) || expected < 0) {
        throw new TypeError('select(): $size takes a non-negative integer');
      }
      tests.push((value) => Array.isArray(value) && value.length === expected);
    } else if (op === '$mod') {
      const ok = Array.isArray(expected) && expected.length === 2 && Number.isFinite(expected[0]) && expected[0] !== 0;
      if (!ok || !Number.isFinite(expected[1])) throw new TypeError('select(): $mod takes [divisor, remainder]');
      const [divisor, remainder] = expected;
      tests.push((value) => typeof value === 'number' && value % divisor === remainder);
    } else if (op === '$all') {
      if (!Array.isArray(expected)) throw new TypeError('select(): $all takes an array');
      tests.push((value) => {
        if (!Array.isArray(value)) return false;
        for (let i = 0; i < expected.length; i++) if (!matches(value, expected[i])) return false;
        return true;
      });
    } else if (op === '$elemMatch') tests.push(elemMatch(expected, depth));
    else if (op !== '$options') throw new TypeError(`select(): unknown operator ${op}`);
  }
  if (operators === 0) return (row) => matches(valueOf(row, path), condition);
  const test = allOf(tests);
  return (row) => test(valueOf(row, path));
};

// `$text` is a string, bounded like a pattern; it is the catalog's to
// answer (the text index ranks the candidates), so it compiles to no test.
const checkText = (value) => {
  if (typeof value !== 'string') throw new TypeError('select(): $text takes a string');
  if (value.length > MAX_TEXT) throw new TypeError(`select(): $text is longer than ${MAX_TEXT} characters`);
};

/**
 * A query as a predicate over `{ id, ...data }`: `{ field: value }` is
 * equality (dotted paths reach into the record), `{ field: { $op } }` the
 * operators, `$and` / `$or` / `$nor` take arrays of queries, `$not` one,
 * `$text` (at the top level only) a full-text search the catalog answers.
 * A malformed query is a TypeError here, at `select()`, not at `fetch()`.
 */
const compileQuery = (query = {}, nested = false, depth = 0) => {
  if (depth > MAX_QUERY_DEPTH) throw new TypeError(`select(): a query nests deeper than ${MAX_QUERY_DEPTH} levels`);
  if (!isObject(query)) throw new TypeError('select() takes a query object');
  const tests = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (key === '$and' || key === '$or' || key === '$nor') {
      if (!Array.isArray(value)) throw new TypeError(`select(): ${key} takes an array of queries`);
      const subs = [];
      for (let i = 0; i < value.length; i++) subs.push(compileQuery(value[i], true, depth + 1));
      if (key === '$and') tests.push(allOf(subs));
      else if (key === '$or') tests.push(anyOf(subs));
      else {
        const any = anyOf(subs);
        tests.push((row) => !any(row));
      }
    } else if (key === '$not') {
      const sub = compileQuery(value, true, depth + 1);
      tests.push((row) => !sub(row));
    } else if (key === '$text') {
      // Inside $and/$or/$not it could neither narrow nor keep a rank order.
      if (nested) throw new TypeError('select(): $text is only allowed at the top level of the query');
      checkText(value);
    } else if (key.startsWith('$')) throw new TypeError(`select(): unknown operator ${key}`);
    else tests.push(compileField(key, value, depth));
  }
  return allOf(tests);
};

// The fields a query reads, dotted paths as given — what decides whether
// the catalog alone can answer it. `$text` reads no field.
const fieldsOf = (query, into = new Set()) => {
  for (const key of Object.keys(query)) {
    if (key === '$and' || key === '$or' || key === '$nor') for (const sub of query[key]) fieldsOf(sub, into);
    else if (key === '$not') fieldsOf(query[key], into);
    else if (key !== '$text') into.add(key);
  }
  return into;
};

const compareRows = (keys) => (a, b) => {
  for (const { field, desc } of keys) {
    const order = compare(valueOf(a, field), valueOf(b, field));
    if (order !== 0) return desc ? -order : order;
  }
  return 0;
};

// The one order a result has: the keys, then the id — so two rows never tie, a page has an edge
// and a live result places a row where a run would.
const compareFully = (keys) => {
  const byKeys = compareRows(keys);
  return (a, b) => {
    const order = byKeys(a, b);
    if (order !== 0) return order;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
};

const count = (name, value) => {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name}() takes a non-negative integer`);
  return value;
};

// What `nearest()` takes at most: the `k` best kept, the length of a vector it measures.
const MAX_NEAREST = 1000;
const MAX_VECTOR = 4096;

// The `k` rows nearest to a vector, measured as they come: a TopK of `{ distance, row }`, a row without a vector
// of the length skipped, one farther than the k-th kept never allocated for.
class Nearest {
  #field;
  #vector;
  #metric;
  #top;

  constructor(field, vector, metric, k) {
    this.#field = field;
    this.#vector = vector;
    this.#metric = metric;
    this.#top = new TopK((a, b) => a.distance - b.distance, k);
  }

  get size() {
    return 0;
  }

  get rows() {
    return this.#top.rows;
  }

  push(row) {
    const value = valueOf(row, this.#field);
    if (!isVector(value) || value.length !== this.#vector.length) return;
    const distance = this.#metric(this.#vector, value);
    const { rows } = this.#top;
    if (rows.length > 0 && rows.length === this.#top.k && distance >= rows[rows.length - 1].distance) return;
    this.#top.push({ distance, row });
  }
}

// Every matching row, in the order it came.
class Every {
  rows = [];

  get size() {
    return this.rows.length;
  }

  push(row) {
    this.rows.push(row);
  }
}

// The first `k` rows by `compare`, kept sorted as they come: a binary search
// and a bounded splice per match, instead of a sort of every match when only
// one page is wanted. Stable, like the sort it replaces — of two equal rows
// the one that came first stays.
class TopK {
  rows = [];
  #compare;
  #k;

  constructor(compare, k) {
    this.#compare = compare;
    this.#k = k;
  }

  get size() {
    return this.rows.length;
  }

  get k() {
    return this.#k;
  }

  push(row) {
    const { rows } = this;
    if (rows.length === this.#k && (this.#k === 0 || this.#compare(row, rows[rows.length - 1]) >= 0)) return;
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#compare(rows[mid], row) <= 0) low = mid + 1;
      else high = mid;
    }
    rows.splice(low, 0, row);
    if (rows.length > this.#k) rows.pop();
  }
}

/**
 * The cursor of `collection.select(query)`: a builder — `order`, `desc`,
 * `limit`, `offset`, `filter`, `projection`, `populate` — hands back a NEW
 * cursor and leaves this one as it was, so one may be built on twice;
 * `fetch()`, `count()`, `one()` and `watch()` run it. `source` is the
 * storage's seam — `candidates`, `ids`, `row`, `indexed`, `load`,
 * `subscribe`, `logger`.
 */
class Cursor {
  #source;
  #entity;
  #query;
  #predicate;
  #order = [];
  #limit = Infinity;
  #offset = 0;
  #filter = null;
  #projection = null;
  #populate = null;
  // Keyset paging: the row the page starts after — its order keys and its id — or null.
  #after = null;
  // The fields the query reads (`fieldsOf`), once per cursor: what `#covered` asks of every run.
  #fields = null;
  // The cache key, once built, and the definitions it was built under.
  #cacheKeyText = null;
  #cacheKeyAt = 0;
  // The plan (./plan.js), made once per cursor at its first run — and again where the collection's definitions
  // moved since (`addCollections()`, `removeCollection()`: another index to scan, or none).
  #planned = null;
  #plannedAt = 0;
  // The query cache (./cache.js) of the database, null at a tag's source.
  #cache;

  constructor(source, entity, query = {}, predicate = null, cache = null) {
    this.#source = source;
    this.#entity = entity;
    this.#query = query;
    this.#predicate = predicate ?? compileQuery(query);
    this.#cache = cache;
    if (predicate === null && query.$text !== undefined && !source.searches(entity)) {
      throw new TypeError(`select(): $text needs search fields on ${entity} (schema.entities.${entity}.search)`);
    }
  }

  // A cursor like this one, to build on: the predicate is shared (compiled once), the rest copied.
  #clone() {
    const copy = new Cursor(this.#source, this.#entity, this.#query, this.#predicate, this.#cache);
    copy.#order = this.#order.slice();
    copy.#limit = this.#limit;
    copy.#offset = this.#offset;
    copy.#filter = this.#filter;
    copy.#projection = this.#projection;
    copy.#populate = this.#populate;
    copy.#after = this.#after;
    copy.#fields = this.#fields;
    return copy;
  }

  // The row a page starts after, as a row the order compares: its keys under the order's fields.
  #edge() {
    const { keys, id } = this.#after;
    const row = { id };
    for (let i = 0; i < this.#order.length; i++) row[this.#order[i].field] = keys[i];
    return row;
  }

  // The token of the page that comes after `row`: the row's order keys and its id.
  #next(row) {
    const keys = [];
    for (let i = 0; i < this.#order.length; i++) keys.push(valueOf(row, this.#order[i].field));
    return { keys, id: row.id };
  }

  /**
   * The cursor from after the row `next` names — what `page()` handed back
   * as `next`: keyset paging, in the result's one order (the keys, then the
   * id), so a page is never read twice and a row that came or went
   * meanwhile is taken where it sorts. A `$text` query without an order has
   * no edge to page by. `offset` does not apply from here.
   */
  after(next) {
    const valid = isObject(next) && Array.isArray(next.keys) && typeof next.id === 'string';
    if (!valid || next.keys.length !== this.#order.length) throw new TypeError('after() takes the next of a page()');
    if (this.#ranked()) throw new TypeError('after(): a $text query without an order has no edge to page by');
    const copy = this.#clone();
    copy.#after = { keys: next.keys.slice(), id: next.id };
    copy.#offset = 0;
    return copy;
  }

  /**
   * One page: `{ rows, next }` — `limit` rows at most (every row when there
   * is none), and the token of the page after, null at the last one (fewer
   * rows than the limit). `cursor.after(next).page()` is the next page.
   */
  async page() {
    if (this.#ranked() && this.#limit !== Infinity) {
      throw new TypeError('page(): a $text query without an order has no edge to page by');
    }
    const top = await this.#top();
    const rows = top.slice(this.#offset);
    const out = await this.#deliver(rows);
    const next = this.#limit !== Infinity && rows.length === this.#limit ? this.#next(rows[rows.length - 1]) : null;
    return { rows: out, next };
  }

  /**
   * The distinct values of `field` among the matches, in the sort order
   * (nothing, booleans, numbers, strings, then the rest), each once —
   * compared as the predicate compares them. From the catalog alone where
   * the field is indexed and the query covered.
   */
  async distinct(field) {
    const groups = await this.#groups(field, 'distinct');
    const out = [];
    for (let i = 0; i < groups.length; i++) out.push(groups[i].value);
    return out;
  }

  /** The distinct values of `field` with how many matches hold each: `[{ value, count }]`, in the sort order. */
  countBy(field) {
    return this.#groups(field, 'countBy');
  }

  async #groups(field, method) {
    if (typeof field !== 'string' || field.length === 0) throw new TypeError(`${method}() takes a field name`);
    const { rows } = await this.projection([field]).#matching(true, Infinity);
    const groups = new Map();
    for (let i = 0; i < rows.length; i++) {
      const value = valueOf(rows[i], field);
      const key = value === undefined ? undefined : keyOf(value);
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, { value: value === undefined ? null : JSON.parse(JSON.stringify(value)), count: 1 });
      } else group.count++;
    }
    const out = [...groups.values()];
    out.sort((a, b) => compare(a.value, b.value));
    return out;
  }

  /**
   * The `k` matches nearest to `vector` by `field` (an array of numbers of
   * the vector's length): `[{ distance, row }]`, nearest first, by
   * `distance` — `'cosine'` (the default), `'euclidean'`, `'manhattan'`,
   * `'dot'`, or a function of two vectors. Every match is read and
   * measured as it comes, the `k` best kept (`k` at most 1000, a vector of
   * at most 4096 numbers): a scan that holds `k` rows, never every match.
   */
  async nearest(field, vector, k, { distance = 'cosine' } = {}) {
    if (typeof field !== 'string' || field.length === 0) throw new TypeError('nearest() takes a field name');
    if (!isVector(vector) || vector.length > MAX_VECTOR) {
      throw new TypeError(`nearest() takes a vector: an array of 1 to ${MAX_VECTOR} finite numbers`);
    }
    if (count('nearest', k) > MAX_NEAREST) throw new TypeError(`nearest() takes k of at most ${MAX_NEAREST}`);
    const metric = typeof distance === 'function' ? distance : DISTANCES[distance];
    if (typeof metric !== 'function') {
      throw new TypeError("nearest(): distance is 'cosine', 'euclidean', 'manhattan', 'dot' or a function");
    }
    // The records themselves: a catalog row (a covered projection) holds no vector.
    const whole = this.#clone();
    whole.#projection = null;
    const best = new Nearest(field, vector, metric, k);
    await whole.#matching(true, Infinity, best);
    const out = [];
    for (let i = 0; i < best.rows.length; i++) {
      const { distance: d, row } = best.rows[i];
      out.push({ distance: d, row: JSON.parse(JSON.stringify(this.#project(row))) });
    }
    return out;
  }

  #key(field, desc) {
    if (typeof field !== 'string' || field.length === 0) throw new TypeError('order() takes a field name');
    const copy = this.#clone();
    copy.#order.push({ field, desc });
    return copy;
  }

  order(field) {
    return this.#key(field, false);
  }

  desc(field) {
    return this.#key(field, true);
  }

  limit(n) {
    const copy = this.#clone();
    copy.#limit = count('limit', n);
    return copy;
  }

  offset(n) {
    const copy = this.#clone();
    copy.#offset = count('offset', n);
    return copy;
  }

  /** A predicate over the loaded row — the query reaches the record, this reaches the code. */
  filter(fn) {
    if (typeof fn !== 'function') throw new TypeError('filter() takes a function');
    const copy = this.#clone();
    copy.#filter = fn;
    return copy;
  }

  /** The fields each row carries (plus `id`); a dotted field comes back under its dotted name. */
  projection(fields) {
    let valid = Array.isArray(fields);
    for (let i = 0; valid && i < fields.length; i++) valid = typeof fields[i] === 'string' && fields[i] !== '__proto__';
    if (!valid) throw new TypeError('projection() takes an array of field names');
    const copy = this.#clone();
    copy.#projection = fields;
    return copy;
  }

  /** Whether `doc` — a record's data, with or without `id` — matches the cursor's query (the filter aside). */
  matches(doc) {
    if (!isObject(doc)) throw new TypeError('matches() takes an object');
    return this.#predicate(doc);
  }

  /**
   * The declared references (`refs`) of `fields` resolved on every row: the
   * record the field names, as `{ id, ...data }` (null when it is not there),
   * or an array of them where the reference is to many — one read of the
   * targets per field per page. A field that is no declared reference is a TypeError.
   */
  populate(fields) {
    let valid = Array.isArray(fields) && fields.length > 0;
    for (let i = 0; valid && i < fields.length; i++) valid = typeof fields[i] === 'string';
    if (!valid) throw new TypeError('populate() takes an array of field names');
    const def = this.#source.definition?.(this.#entity) ?? null;
    for (let i = 0; i < fields.length; i++) {
      if (def === null || def.refs === null || !Object.hasOwn(def.refs, fields[i])) {
        throw new TypeError(`populate(): ${fields[i]} is not a declared reference of ${this.#entity} (refs)`);
      }
    }
    const copy = this.#clone();
    copy.#populate = fields;
    return copy;
  }

  // The rows' references laid in: the ids every populated field names on the
  // page, read once per field, each replaced by the record (or null).
  async #populated(rows) {
    const refs = this.#source.definition(this.#entity).refs;
    for (let f = 0; f < this.#populate.length; f++) {
      const field = this.#populate[f];
      const { many, entity } = refs[field];
      const ids = [];
      const seen = new Set();
      const want = (value) => {
        if (typeof value !== 'string' || seen.has(value)) return;
        seen.add(value);
        ids.push(value);
      };
      for (let i = 0; i < rows.length; i++) {
        const value = rows[i][field];
        if (many && Array.isArray(value)) for (let k = 0; k < value.length; k++) want(value[k]);
        else want(value);
      }
      const found = await this.#source.loadMany(ids);
      // The record the id names — of the declared collection; another collection's record is not it.
      const record = (value) => {
        if (typeof value !== 'string') return null;
        const data = found.get(value) ?? null;
        return data === null || data.$type !== entity ? null : { ...data, id: value };
      };
      for (let i = 0; i < rows.length; i++) {
        const value = rows[i][field];
        if (!Object.hasOwn(rows[i], field)) continue;
        if (!many) rows[i][field] = record(value);
        else if (Array.isArray(value)) {
          const out = [];
          for (let k = 0; k < value.length; k++) out.push(record(value[k]));
          rows[i][field] = out;
        }
      }
    }
    return rows;
  }

  // How the cursor is answered (./plan.js): over the collection's declared indexes, once.
  #plan() {
    const definitions = this.#source.definitions?.() ?? 0;
    if (this.#planned === null || this.#plannedAt !== definitions) {
      this.#plannedAt = definitions;
      const indexes = this.#source.indexes?.(this.#entity) ?? [];
      const source = this.#source;
      const entity = this.#entity;
      const made = plan({
        query: this.#query,
        order: this.#order,
        indexes,
        indexed: source.indexed(entity),
        covered: this.#covered(true),
        wanted: this.#offset + this.#limit,
        // The catalog's counts — a tag's source, which reads its catalog at first use, may have none to give yet.
        estimate: source.estimate === undefined ? null : (candidate) => source.estimate(entity, candidate),
        cardinality:
          source.cardinality === undefined ? null : (field, values) => source.cardinality(entity, field, values),
        size: source.live === undefined ? null : () => source.live(entity),
      });
      // A filter reads the record and decides for itself: nothing the index decided is final.
      if (this.#filter !== null) made.residual = true;
      this.#planned = made;
      // Told to whoever advises on indexes (@alexify/syncom/inspect indexAdvisor).
      this.#source.planned?.(this.#entity, made);
    }
    return this.#planned;
  }

  /**
   * How the cursor is answered: `{ scan, index, prefix, range, desc,
   * sortedByIndex, covered, residual }` — the index chosen (its fields) and
   * how it is entered (an equality prefix, a range on the field after),
   * whether the rows come sorted by it (a window is then read as far as
   * `offset + limit`), whether only the catalog is read, whether the
   * predicate still runs. A copy: edit it as you like.
   */
  explain() {
    const made = this.#plan();
    return JSON.parse(JSON.stringify({ ...made, index: made.index === null ? null : made.index.slice() }));
  }

  // The cache key of this cursor's result: what it reads and how; null with a filter (a function has
  // no name) or without a cache (a tag's source).
  #cacheKey() {
    if (this.#cache === null || this.#filter !== null) return null;
    // The definitions ride in the key: a result read under other indexes is another result. The cursor never
    // changes, so the key is built once — again only under other definitions.
    const definitions = this.#source.definitions?.() ?? 0;
    if (this.#cacheKeyText !== null && this.#cacheKeyAt === definitions) return this.#cacheKeyText;
    const window = [this.#limit === Infinity ? null : this.#limit, this.#offset, this.#after];
    this.#cacheKeyAt = definitions;
    this.#cacheKeyText = keyOf([
      this.#entity,
      this.#query,
      this.#order,
      window,
      this.#projection,
      this.#populate,
      definitions,
    ]);
    return this.#cacheKeyText;
  }

  // Whether the rows come in the text index's order: a `$text` query without an order of its own.
  #ranked() {
    return this.#order.length === 0 && this.#query.$text !== undefined;
  }

  // Covered: everything the cursor reads — the query's fields, the order's,
  // the projection's — is in the catalog, and no filter asks for the record.
  #covered(needsRows) {
    if (this.#filter !== null) return false;
    if (needsRows && this.#populate !== null) return false;
    if (needsRows && this.#projection === null) return false;
    const indexed = this.#source.indexed(this.#entity);
    if (this.#fields === null) this.#fields = fieldsOf(this.#query);
    for (const field of this.#fields) if (!indexed.has(field)) return false;
    for (const { field } of this.#order) if (!indexed.has(field)) return false;
    if (needsRows) for (const field of this.#projection) if (!indexed.has(field)) return false;
    return true;
  }

  // The matching rows. Without an order, a limit is reached as soon as
  // enough rows matched — `one()` on a loaded cursor reads up to the first
  // match, not the table; with one, only the best `offset + limit` are kept
  // (`sorted` says so). The candidates are pulled one at a time: a scan's
  // lazy source (entered after a page's edge where the rows come in the
  // index's order), a posting set, or the collection's list — in id order,
  // from after the edge by id, where an unordered cursor stops at a window.
  // The records are read CONCURRENCY at a time, in candidate order, so the
  // rows come in that order whatever the backend — and for `$text` the
  // candidate order is the index's ranking, which an unordered cursor hands
  // out as it is.
  async #matching(needsRows, limit = this.#limit, into = null) {
    // A source that reads its catalog at first use (a tag's) hands `ready`.
    if (this.#source.ready !== undefined) await this.#source.ready();
    const { candidates, ids, row, load, scan } = this.#source;
    const made = this.#plan();
    const ordered = needsRows && this.#order.length > 0;
    const wanted = this.#offset + limit;
    // By the plan: an index scanned in its order, the posting lists, or every record of the collection.
    const scanned = made.scan === 'index' ? scan(this.#entity, made, made.sortedByIndex ? this.#after : null) : null;
    // Sorted by the index already (a key that holds arrays is not): enough rows is the window, read as
    // far as it and no further.
    const byIndex = needsRows && scanned !== null && scanned.sorted && made.sortedByIndex;
    const enough = needsRows && (!ordered || byIndex) ? wanted : Infinity;
    const windowed = enough !== Infinity && !byIndex && !this.#ranked();
    let next;
    let byId = false;
    if (scanned !== null && !windowed) next = scanned.next;
    else {
      let found =
        scanned !== null ? drained(scanned.next) : (candidates(this.#entity, this.#query) ?? ids(this.#entity));
      // An unordered cursor that stops at enough rows reads its candidates in id order — the result's
      // order without keys — so what it stops at is the window a run of every candidate would give: a
      // scan's ids come in key order and a posting set in none, both are sorted by id first; the
      // collection's list is in id order already.
      if (windowed && (scanned !== null || !Array.isArray(found))) found = [...found].sort();
      byId = windowed && !ordered;
      // After a page's edge, by id: the first id above it.
      const start = byId && this.#after !== null ? aboveId(found, this.#after.id) : 0;
      next = pullOf(found, start);
    }
    // The indexed equalities the index did not decide: their posting lists, tested before a record is read.
    let narrowed = null;
    if (scanned !== null && made.narrow.length > 0) {
      narrowed = [];
      for (let i = 0; i < made.narrow.length; i++) {
        const set = this.#source.posting(this.#entity, made.narrow[i].field, made.narrow[i].values);
        if (set.size === 0) return { rows: [], sorted: true };
        narrowed.push(set);
      }
    }
    const admits = (id) => {
      if (narrowed === null) return true;
      for (let i = 0; i < narrowed.length; i++) if (!narrowed[i].has(id)) return false;
      return true;
    };
    // The rows go into the sink given (`nearest()`'s), else a TopK where one page of an order no index serves is
    // wanted, else every row.
    const sink =
      into ?? (ordered && !byIndex && wanted !== Infinity ? new TopK(compareFully(this.#order), wanted) : new Every());
    // From after the edge of the page before, where there is one (the scan or the id seek took it already where
    // the rows come in the result's order; the check stays for a TopK).
    const edge = this.#after === null ? null : this.#edge();
    const byOrder = edge === null ? null : compareFully(this.#order);
    const take = (candidate) => {
      if (!this.#predicate(candidate) || (this.#filter !== null && !this.#filter(candidate))) return;
      if (edge !== null && byOrder(candidate, edge) <= 0) return;
      sink.push(candidate);
    };
    const inOrder = sink instanceof TopK || byIndex || byId;
    if (this.#covered(needsRows)) {
      for (let id = next(); id !== null && sink.size < enough; id = next()) {
        if (!admits(id)) continue;
        const indexed = row(id);
        if (indexed === null || indexed.encrypted) continue;
        take(rowOf(id, indexed.fields));
      }
      return { rows: sink.rows, sorted: inOrder };
    }
    // A batch is as wide as what is still wanted, CONCURRENCY at most: a
    // `one()` reads one record at a time and stops at the first match, a
    // scan reads sixteen.
    const batch = [];
    const read = async () => {
      const pending = [];
      for (let i = 0; i < batch.length; i++) pending.push(load(batch[i]));
      const records = await Promise.all(pending);
      for (let i = 0; i < batch.length; i++) if (records[i] !== null) take(rowOf(batch[i], records[i]));
      batch.length = 0;
    };
    for (let id = next(); id !== null && sink.size < enough; id = next()) {
      if (!admits(id)) continue;
      batch.push(id);
      if (batch.length >= Math.min(CONCURRENCY, Math.max(1, enough - sink.size))) await read();
    }
    if (batch.length > 0 && sink.size < enough) await read();
    return { rows: sink.rows, sorted: inOrder };
  }

  #project(row) {
    if (this.#projection === null) return row;
    const projected = { id: row.id };
    for (const field of this.#projection) projected[field] = valueOf(row, field);
    return projected;
  }

  // The rows from the top of the result, in its one order — the keys then
  // the id; a `$text` query without keys in the index's ranking — as many
  // as the window asks (`offset + limit`), raw: what a run of the cursor is.
  async #top(limit = this.#limit) {
    const { rows, sorted } = await this.#matching(true, limit);
    if (!sorted && !this.#ranked()) rows.sort(compareFully(this.#order));
    const wanted = this.#offset + limit;
    return sorted || rows.length <= wanted ? rows : rows.slice(0, wanted);
  }

  // What leaves: copies (JSON, like everything that crosses the storage's
  // boundary — the rows were read raw from the cache, and a caller that
  // edits a row must not be editing the cache), projected, populated.
  async #deliver(rows) {
    const out = [];
    for (let i = 0; i < rows.length; i++) out.push(JSON.parse(JSON.stringify(this.#project(rows[i]))));
    return this.#populate === null ? out : this.#populated(out);
  }

  /** The rows, as copies: from the cache where the catalog has not moved since the key was read, else a run. */
  fetch() {
    return this.#fetch(this.#limit);
  }

  // `limit` is the call's own: `one()` asks for one row without leaving a
  // limit on the cursor for the next `fetch()` — and without the cache.
  async #fetch(limit) {
    const key = limit === this.#limit ? this.#cacheKey() : null;
    if (key !== null) {
      const kept = this.#cache.rows(key, this.#source.generation(this.#entity));
      if (kept !== null) return this.#deliver(kept.slice(this.#offset));
    }
    const generation = key === null ? 0 : this.#source.generation(this.#entity);
    const top = await this.#top(limit);
    if (key !== null) this.#cache.keep(key, generation, top);
    return this.#deliver(top.slice(this.#offset));
  }

  /**
   * How many records match. A sorted index entered by a prefix or a range,
   * with every conjunct decided by it and no filter, answers from its
   * entries alone — no record is read.
   */
  async count() {
    if (this.#source.ready !== undefined) await this.#source.ready();
    const made = this.#plan();
    const decided = made.scan === 'index' && !made.residual && made.narrow.length === 0 && this.#filter === null;
    if (decided && (made.prefix.length > 0 || made.range !== null)) {
      const scanned = this.#source.scan(this.#entity, made, null);
      if (scanned.sorted) return scanned.estimate;
    }
    return (await this.#matching(false)).rows.length;
  }

  // The ids the cursor matches now, in its order and window — what a write
  // by query runs over: the rows read once, offset and limit applied.
  async #ids() {
    // The ids alone: each record is read again inside the transaction, so where the query and the order are the
    // catalog's the run is covered and reads no record.
    const bare = this.#clone();
    bare.#projection = [];
    bare.#populate = null;
    const top = await bare.#top();
    const ids = [];
    for (let i = this.#offset; i < top.length; i++) ids.push(top[i].id);
    return ids;
  }

  // A write over every record the cursor matches, as ONE transaction: the
  // matches are taken when it starts, and each is matched AGAIN inside the
  // queue, over the record as it reads there, before it is written as
  // `write(tx, id)` says — a record gone or no longer a match meanwhile is
  // skipped (`written` counts the rest). A view at a tag reads alone.
  async #write(method, options, write) {
    const { transact } = this.#source;
    if (typeof transact !== 'function') throw new TypeError(`${method}(): a cursor at a tag is read-only`);
    const ids = await this.#ids();
    if (ids.length > MAX_BATCH) {
      throw new TypeError(
        `${method}(): ${ids.length} matches, at most ${MAX_BATCH} in one transaction — narrow the query or limit() the cursor`,
      );
    }
    let written = 0;
    await transact(
      async (tx) => {
        for (let i = 0; i < ids.length; i++) {
          const view = await tx.get(ids[i]);
          if (view === null) continue;
          const candidate = rowOf(ids[i], view);
          if (!this.#predicate(candidate) || (this.#filter !== null && !this.#filter(candidate))) continue;
          await write(tx, ids[i]);
          written++;
        }
      },
      { actor: options.actor, message: options.message, source: options.source },
    );
    return { matched: ids.length, written };
  }

  /** Every match updated — fields, or the operators — as one transaction: `{ matched, written }`. */
  update(delta, options = {}) {
    return this.#write('update', options, (tx, id) => tx.update(id, delta, { actor: options.actor }));
  }

  /** Every match changed by `fn` (see `modify()`), as one transaction: `{ matched, written }`. */
  modify(fn, options = {}) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('modify() takes a function'));
    return this.#write('modify', options, (tx, id) => tx.modify(id, fn, { actor: options.actor }));
  }

  /** Every match deleted, as one transaction: `{ matched, written }`; `data` rides on each tombstone. */
  delete(options = {}) {
    const { actor, data } = options;
    return this.#write('delete', options, (tx, id) => tx.delete(id, data === undefined ? { actor } : { actor, data }));
  }

  async one() {
    const [row = null] = await this.#fetch(Math.min(this.#limit, 1));
    return row;
  }

  // What a live run (./live.js) of this cursor is made of: how a record
  // reads as a row (the catalog's row where covered, the record otherwise),
  // whether it matches, where it sorts, the window, a run, the delivery.
  #spec(needsRows, onRows) {
    const covered = this.#covered(needsRows);
    const { row, load } = this.#source;
    const read = covered
      ? (id) => {
          const indexed = row(id);
          return indexed === null || indexed.encrypted ? null : rowOf(id, indexed.fields);
        }
      : async (id) => {
          const data = await load(id);
          return data === null ? null : rowOf(id, data);
        };
    return {
      entity: this.#entity,
      wanted: this.#offset + this.#limit,
      offset: this.#offset,
      compare: compareFully(this.#order),
      covered,
      textual: this.#ranked(),
      rowOf: read,
      matches: (candidate) => this.#predicate(candidate) && (this.#filter === null || this.#filter(candidate)),
      // The object a row was built from: the one the record reads as, held until it changes.
      identityOf: (candidate) => candidate[VIEW] ?? candidate,
      project: (candidate) => this.#project(candidate),
      // A count is of every match: the window does not apply to it.
      top: () => this.#top(needsRows ? this.#limit : Infinity),
      deliver: (rows) => this.#deliver(rows),
      // One row's copy, where nothing is populated: what a live run hands out again while the row stays.
      deliverOne: this.#populate === null ? (candidate) => JSON.parse(JSON.stringify(this.#project(candidate))) : null,
      onRows,
    };
  }

  // A live run of this cursor, or of its count: the one the cache keeps for the key — shared by every
  // `watch()` of the key — or this call's own where the cursor has no key.
  #live(listener, onError, mode) {
    if (typeof listener !== 'function') {
      throw new TypeError(`${mode === 'count' ? 'watchCount' : 'watch'}() takes a listener`);
    }
    const key = this.#cacheKey();
    if (key === null) {
      const live = new Live(
        this.#source,
        this.#spec(mode === 'rows', () => {}),
        mode,
      );
      return live.subscribe(listener, onError);
    }
    const cacheKey = mode === 'count' ? `${key}#count` : key;
    const live = this.#cache.live(cacheKey, (entry) => {
      // The run's rows are the key's result for as long as it runs, as of now.
      const onRows = (rows) => {
        entry.rows = rows;
        entry.generation = this.#source.generation(this.#entity);
      };
      return new Live(this.#source, this.#spec(mode === 'rows', mode === 'rows' ? onRows : () => {}), mode, () =>
        this.#cache.release(cacheKey),
      );
    });
    return live.subscribe(listener, onError);
  }

  /**
   * Calls `listener(rows)` now and whenever the rows change — kept as the
   * collection changes, without running the cursor again: the record that
   * changed is read once, matched and placed (a full window that lost a row
   * runs the cursor again, as does a `$text` query); emits only when an id
   * came, went or moved, or a row reads as another. Every `watch()` of one
   * query (the same entity, query, order, window, projection) shares one
   * run. Returns the stop function. A failure goes to `onError`, or to the logger.
   */
  watch(listener, { onError = null } = {}) {
    return this.#live(listener, onError, 'rows');
  }

  /**
   * Calls `listener(count)` now and whenever the number of matches moves —
   * the matching ids kept, one in or out per change, never counted again.
   * Returns the stop function.
   */
  watchCount(listener, { onError = null } = {}) {
    return this.#live(listener, onError, 'count');
  }

  /**
   * The rows `fetch()` would give — the window applied — read lazily, `batch`
   * at a time by keyset (each page after the last row of the one before,
   * sought in the index or by id), so a result of any size is walked in
   * bounded memory where the order is the index's or there is none; an order
   * no index sorts, or a `$text` query without one, is one run handed out in
   * batches. `for await (const row of cursor)` is this.
   */
  async *stream({ batch = 100 } = {}) {
    const size = count('stream', batch);
    if (size === 0) throw new TypeError('stream() takes a batch of one or more');
    // A `$text` query without an order has no edge; an order no index sorts would cost a run of the result a page:
    // one run, handed out `batch` at a time (an unordered cursor pages by id; `indexAdvisor` names the key).
    if (this.#ranked() || (this.#order.length > 0 && !this.#plan().sortedByIndex)) {
      const rows = await this.fetch();
      for (let i = 0; i < rows.length; i++) yield rows[i];
      return;
    }
    let remaining = this.#limit;
    let cursor = this.limit(Math.min(size, remaining));
    for (;;) {
      const { rows, next } = await cursor.page();
      for (let i = 0; i < rows.length; i++) yield rows[i];
      remaining -= rows.length;
      if (next === null || remaining <= 0) return;
      cursor = cursor.after(next).limit(Math.min(size, remaining));
    }
  }

  [Symbol.asyncIterator]() {
    return this.stream();
  }
}

module.exports = { compileQuery, compareRows, fieldsOf, Cursor };
