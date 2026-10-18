'use strict';

// Queries over a collection: a Mango-style predicate compiled once, and a
// cursor that plans how to answer it — from the catalog alone when every
// field it reads is indexed, from the records otherwise. No requires beyond
// the engine's own: this file ships to the browser.

const { deepEqual } = require('./ops.js');
const { valueOf } = require('./catalog.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// A total order for sorting: nothing, then booleans, numbers, strings, then
// everything else (left where it was). Comparisons in a query are stricter —
// they hold only between values of one of the three ordered kinds.
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

// Equality as a query means it: the value itself, or — for an array field
// and a scalar — any of its elements.
const matches = (actual, expected) =>
  deepEqual(actual, expected) ||
  (Array.isArray(actual) && !Array.isArray(expected) && actual.some((item) => deepEqual(item, expected)));

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
  return (value) => (Array.isArray(value) ? value.some(holds) : holds(value));
};

const regexOf = (expected, options) => {
  const flags = (options ?? (expected instanceof RegExp ? expected.flags : '')).replaceAll(/[gy]/g, '');
  const source = expected instanceof RegExp ? expected.source : expected;
  if (typeof source !== 'string') throw new TypeError('select(): $regex takes a RegExp or a string');
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new TypeError(`select(): $regex is invalid — ${error.message}`);
  }
};

const compileField = (path, condition) => {
  const operators = isObject(condition) ? Object.keys(condition).filter((key) => key.startsWith('$')) : [];
  if (operators.length === 0) return (row) => matches(valueOf(row, path), condition);
  const tests = [];
  const options = typeof condition.$options === 'string' ? condition.$options : undefined;
  for (const op of operators) {
    const expected = condition[op];
    if (op === '$eq') tests.push((value) => matches(value, expected));
    else if (op === '$ne') tests.push((value) => !matches(value, expected));
    else if (op === '$in' || op === '$nin') {
      if (!Array.isArray(expected)) throw new TypeError(`select(): ${op} takes an array`);
      const hit = (value) => expected.some((item) => matches(value, item));
      tests.push(op === '$in' ? hit : (value) => !hit(value));
    } else if (op === '$gt' || op === '$gte' || op === '$lt' || op === '$lte') tests.push(comparison(op, expected));
    else if (op === '$exists') {
      if (typeof expected !== 'boolean') throw new TypeError('select(): $exists takes a boolean');
      tests.push((value) => (value !== undefined) === expected);
    } else if (op === '$regex') {
      const regex = regexOf(expected, options);
      const hit = (value) => typeof value === 'string' && regex.test(value);
      tests.push((value) => (Array.isArray(value) ? value.some(hit) : hit(value)));
    } else if (op !== '$options') throw new TypeError(`select(): unknown operator ${op}`);
  }
  return (row) => {
    const value = valueOf(row, path);
    return tests.every((test) => test(value));
  };
};

/**
 * A query as a predicate over `{ id, ...data }`: `{ field: value }` is
 * equality (dotted paths reach into the record), `{ field: { $op } }` the
 * operators, `$and` / `$or` take arrays of queries, `$not` one. A malformed
 * query is a TypeError here, at `select()`, not at `fetch()`.
 */
const compileQuery = (query = {}) => {
  if (!isObject(query)) throw new TypeError('select() takes a query object');
  const tests = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value)) throw new TypeError(`select(): ${key} takes an array of queries`);
      const subs = value.map((sub) => compileQuery(sub));
      tests.push(key === '$and' ? (row) => subs.every((sub) => sub(row)) : (row) => subs.some((sub) => sub(row)));
    } else if (key === '$not') {
      const sub = compileQuery(value);
      tests.push((row) => !sub(row));
    } else if (key.startsWith('$')) throw new TypeError(`select(): unknown operator ${key}`);
    else tests.push(compileField(key, value));
  }
  return (row) => tests.every((test) => test(row));
};

// The fields a query reads, dotted paths as given — what decides whether
// the catalog alone can answer it.
const fieldsOf = (query, into = new Set()) => {
  for (const key of Object.keys(query)) {
    if (key === '$and' || key === '$or') for (const sub of query[key]) fieldsOf(sub, into);
    else if (key === '$not') fieldsOf(query[key], into);
    else into.add(key);
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

const count = (name, value) => {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name}() takes a non-negative integer`);
  return value;
};

/**
 * The cursor of `collection.select(query)`: builders return it, `fetch()`,
 * `count()`, `one()` and `watch()` run it. `source` is the storage's seam —
 * `candidates`, `ids`, `row`, `indexed`, `load`, `subscribe`, `logger`.
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

  constructor(source, entity, query = {}) {
    this.#source = source;
    this.#entity = entity;
    this.#query = query;
    this.#predicate = compileQuery(query);
  }

  #key(field, desc) {
    if (typeof field !== 'string' || field.length === 0) throw new TypeError('order() takes a field name');
    this.#order.push({ field, desc });
    return this;
  }

  order(field) {
    return this.#key(field, false);
  }

  desc(field) {
    return this.#key(field, true);
  }

  limit(n) {
    this.#limit = count('limit', n);
    return this;
  }

  offset(n) {
    this.#offset = count('offset', n);
    return this;
  }

  /** A predicate over the loaded row — the query reaches the record, this reaches the code. */
  filter(fn) {
    if (typeof fn !== 'function') throw new TypeError('filter() takes a function');
    this.#filter = fn;
    return this;
  }

  /** The fields each row carries (plus `id`); a dotted field comes back under its dotted name. */
  projection(fields) {
    if (!Array.isArray(fields) || !fields.every((field) => typeof field === 'string')) {
      throw new TypeError('projection() takes an array of field names');
    }
    this.#projection = fields;
    return this;
  }

  // Covered: everything the cursor reads — the query's fields, the order's,
  // the projection's — is in the catalog, and no filter asks for the record.
  #covered(needsRows) {
    if (this.#filter !== null) return false;
    if (needsRows && this.#projection === null) return false;
    const indexed = this.#source.indexed(this.#entity);
    const fields = fieldsOf(this.#query);
    for (const { field } of this.#order) fields.add(field);
    if (needsRows) for (const field of this.#projection) fields.add(field);
    for (const field of fields) if (!indexed.has(field)) return false;
    return true;
  }

  // Without an order, a limit is reached as soon as enough rows matched —
  // `one()` on a loaded cursor reads up to the first match, not the table.
  async #matching(needsRows) {
    const { candidates, ids, row, load } = this.#source;
    const found = candidates(this.#entity, this.#query) ?? ids(this.#entity);
    const enough = needsRows && this.#order.length === 0 ? this.#offset + this.#limit : Infinity;
    const rows = [];
    if (this.#covered(needsRows)) {
      for (const id of found) {
        if (rows.length >= enough) break;
        const indexed = row(id);
        if (indexed === null || indexed.encrypted) continue;
        const candidate = { id, ...indexed.fields };
        if (this.#predicate(candidate)) rows.push(candidate);
      }
      return rows;
    }
    for (const id of found) {
      if (rows.length >= enough) break;
      const data = await load(id);
      if (data === null) continue;
      const candidate = { id, ...data };
      if (this.#predicate(candidate) && (this.#filter === null || this.#filter(candidate))) rows.push(candidate);
    }
    return rows;
  }

  #project(row) {
    if (this.#projection === null) return row;
    const projected = { id: row.id };
    for (const field of this.#projection) projected[field] = valueOf(row, field);
    return projected;
  }

  async fetch() {
    let rows = await this.#matching(true);
    if (this.#order.length > 0) rows.sort(compareRows(this.#order));
    if (this.#offset > 0 || this.#limit !== Infinity) rows = rows.slice(this.#offset, this.#offset + this.#limit);
    return rows.map((row) => this.#project(row));
  }

  async count() {
    return (await this.#matching(false)).length;
  }

  async one() {
    const [row = null] = await this.limit(1).fetch();
    return row;
  }

  /**
   * Runs the cursor now and again after every change to the collection,
   * coalescing the changes that land while a run is in flight; returns the
   * stop function. A failing run goes to `onError`, or to the logger.
   */
  watch(listener, { onError = null } = {}) {
    if (typeof listener !== 'function') throw new TypeError('watch() takes a listener');
    const { logger, subscribe } = this.#source;
    let stopped = false;
    let running = false;
    let dirty = false;
    const run = async () => {
      if (stopped) return;
      running = true;
      dirty = false;
      try {
        const rows = await this.fetch();
        if (!stopped) listener(rows);
      } catch (error) {
        if (onError) onError(error);
        else logger.debug({ event: 'watch.error', entity: this.#entity, err: error });
      } finally {
        running = false;
        if (dirty && !stopped) queueMicrotask(run);
      }
    };
    const wake = () => {
      if (dirty) return;
      dirty = true;
      if (!running) queueMicrotask(run);
    };
    const unsubscribe = subscribe(this.#entity, wake);
    queueMicrotask(run);
    return () => {
      stopped = true;
      unsubscribe();
    };
  }

  async *[Symbol.asyncIterator]() {
    for (const row of await this.fetch()) yield row;
  }
}

module.exports = { compileQuery, compareRows, fieldsOf, Cursor };
