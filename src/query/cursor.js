'use strict';

// Queries over a collection (the query plugin's, ./query.js): a Mango-style
// predicate compiled once, and a cursor that plans how to answer it — from
// the catalog alone when every field it reads is indexed, from the records
// otherwise. No requires beyond the engine's own: this file ships to the
// browser.

const { deepEqual } = require('../shape.js');
const { valueOf } = require('../catalog.js');

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const MAX_REGEX = 1000;
const MAX_TEXT = 1000;
// How many records a loaded cursor reads at once.
const CONCURRENCY = 16;

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
    throw new TypeError(`select(): $regex is invalid — ${error.message}`);
  }
};

const compileField = (path, condition) => {
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
    } else if (op !== '$options') throw new TypeError(`select(): unknown operator ${op}`);
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
 * operators, `$and` / `$or` take arrays of queries, `$not` one, `$text` (at
 * the top level only) a full-text search the catalog answers. A malformed
 * query is a TypeError here, at `select()`, not at `fetch()`.
 */
const compileQuery = (query = {}, nested = false) => {
  if (!isObject(query)) throw new TypeError('select() takes a query object');
  const tests = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value)) throw new TypeError(`select(): ${key} takes an array of queries`);
      const subs = [];
      for (let i = 0; i < value.length; i++) subs.push(compileQuery(value[i], true));
      tests.push(key === '$and' ? allOf(subs) : anyOf(subs));
    } else if (key === '$not') {
      const sub = compileQuery(value, true);
      tests.push((row) => !sub(row));
    } else if (key === '$text') {
      // Inside $and/$or/$not it could neither narrow nor keep a rank order.
      if (nested) throw new TypeError('select(): $text is only allowed at the top level of the query');
      checkText(value);
    } else if (key.startsWith('$')) throw new TypeError(`select(): unknown operator ${key}`);
    else tests.push(compileField(key, value));
  }
  return allOf(tests);
};

// The fields a query reads, dotted paths as given — what decides whether
// the catalog alone can answer it. `$text` reads no field.
const fieldsOf = (query, into = new Set()) => {
  for (const key of Object.keys(query)) {
    if (key === '$and' || key === '$or') for (const sub of query[key]) fieldsOf(sub, into);
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

const count = (name, value) => {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name}() takes a non-negative integer`);
  return value;
};

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
    if (query.$text !== undefined && !source.searches(entity)) {
      throw new TypeError(`select(): $text needs search fields on ${entity} (schema.entities.${entity}.search)`);
    }
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
    let valid = Array.isArray(fields);
    for (let i = 0; valid && i < fields.length; i++) valid = typeof fields[i] === 'string' && fields[i] !== '__proto__';
    if (!valid) throw new TypeError('projection() takes an array of field names');
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

  // The matching rows. Without an order, a limit is reached as soon as
  // enough rows matched — `one()` on a loaded cursor reads up to the first
  // match, not the table; with one, only the best `offset + limit` are kept
  // (`sorted` says so). The records are read CONCURRENCY at a time, in
  // candidate order, so the rows come in that order whatever the backend —
  // and for `$text` the candidate order is the index's ranking, which an
  // unordered cursor hands out as it is.
  async #matching(needsRows, limit = this.#limit) {
    // A source that reads its catalog at first use (a tag's) hands `ready`.
    if (this.#source.ready !== undefined) await this.#source.ready();
    const { candidates, ids, row, load } = this.#source;
    const found = candidates(this.#entity, this.#query) ?? ids(this.#entity);
    const ordered = needsRows && this.#order.length > 0;
    const wanted = this.#offset + limit;
    const enough = needsRows && !ordered ? wanted : Infinity;
    const sink = ordered && wanted !== Infinity ? new TopK(compareRows(this.#order), wanted) : new Every();
    const take = (candidate) => {
      if (this.#predicate(candidate) && (this.#filter === null || this.#filter(candidate))) sink.push(candidate);
    };
    if (this.#covered(needsRows)) {
      for (const id of found) {
        if (sink.size >= enough) break;
        const indexed = row(id);
        if (indexed === null || indexed.encrypted) continue;
        take({ id, ...indexed.fields });
      }
      return { rows: sink.rows, sorted: sink instanceof TopK };
    }
    // A batch is as wide as what is still wanted, CONCURRENCY at most: a
    // `one()` reads one record at a time and stops at the first match, a
    // scan reads sixteen.
    const batch = [];
    const read = async () => {
      const pending = [];
      for (let i = 0; i < batch.length; i++) pending.push(load(batch[i]));
      const records = await Promise.all(pending);
      for (let i = 0; i < batch.length; i++) if (records[i] !== null) take({ id: batch[i], ...records[i] });
      batch.length = 0;
    };
    for (const id of found) {
      if (sink.size >= enough) break;
      batch.push(id);
      if (batch.length >= Math.min(CONCURRENCY, Math.max(1, enough - sink.size))) await read();
    }
    if (batch.length > 0 && sink.size < enough) await read();
    return { rows: sink.rows, sorted: sink instanceof TopK };
  }

  #project(row) {
    if (this.#projection === null) return row;
    const projected = { id: row.id };
    for (const field of this.#projection) projected[field] = valueOf(row, field);
    return projected;
  }

  // Rows leave as copies (JSON, like everything that crosses the storage's
  // boundary): the candidates were read raw from the cache, and a caller
  // that edits a row must not be editing the cache.
  fetch() {
    return this.#fetch(this.#limit);
  }

  // `limit` is the call's own: `one()` asks for one row without leaving a
  // limit on the cursor for the next `fetch()`.
  async #fetch(limit) {
    const { rows, sorted } = await this.#matching(true, limit);
    if (this.#order.length > 0 && !sorted) rows.sort(compareRows(this.#order));
    const start = this.#offset;
    const end = Math.min(start + limit, rows.length);
    const out = [];
    for (let i = start; i < end; i++) out.push(JSON.parse(JSON.stringify(this.#project(rows[i]))));
    return out;
  }

  async count() {
    return (await this.#matching(false)).rows.length;
  }

  async one() {
    const [row = null] = await this.#fetch(Math.min(this.#limit, 1));
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
        else logger.warn({ event: 'watch.error', entity: this.#entity, err: error });
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
