'use strict';

// A MongoDB driver in memory, as much of it as the engine speaks: a client
// with databases of collections, `findOne`/`find(...).toArray()` with
// projections, sorts and limits, `insertOne` (E11000 on a key held),
// `bulkWrite` (replaceOne upsert, insertOne, deleteOne, deleteMany,
// updateOne — an upsert whose filter misses a held `_id` is E11000 too),
// `deleteMany`, `updateOne`, `findOneAndUpdate` (an update document, or a
// pipeline of `$set` stages over `$field`, `$$NOW`, `$add`, `$ifNull`),
// `createIndex`, `countDocuments`, `drop`, sessions whose `withTransaction`
// undoes what the callback wrote when it throws, and change streams
// (`watch(pipeline, { fullDocument })`: a `$match` over the event and a
// `$project` of exclusions; an insert, a replace, an update — its document
// only under `updateLookup` — and a delete) that hear every write once it is
// committed, and err on `breakStreams(error)`. Filters: equality,
// `$gt/$gte/$lt/$lte`, `$in/$nin`, `$ne`, `$exists`, `$not`, `$regex`, `$or`,
// `$and`, `$expr` (`$lt`/`$gt`/`$lte`/`$gte`/`$eq` over Dates and numbers). The
// server's clock (`$$NOW`) is the client's `advance(ms)` past the real one —
// never `Date.now`, which a test may skew to stand for a client's clock.
// What it lacks, it throws on, so a test never passes on a method the real
// driver would not have.

const { EventEmitter } = require('node:events');

const clone = (value) => structuredClone(value);
// The real clock, taken before any test replaces `Date.now`.
const realNow = Date.now;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const valueAt = (doc, path) => {
  let value = doc;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (value === null || typeof value !== 'object') return undefined;
    value = value[parts[i]];
  }
  return value;
};

const OPERATORS = new Set(['$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$ne', '$exists', '$eq', '$not', '$regex']);

// The field at a dotted `path` of `doc` removed, where its parent is there.
const exclude = (doc, path) => {
  const parts = path.split('.');
  let parent = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parent === null || typeof parent !== 'object') return;
    parent = parent[parts[i]];
  }
  if (parent !== null && typeof parent === 'object') delete parent[parts[parts.length - 1]];
};

// A Date and a number compare as instants in `$expr`; anything else as it is.
const instant = (value) => (value instanceof Date ? value.getTime() : value);

// An aggregation expression over `doc`: a field path, `$$NOW`, a literal, or one operator.
const evaluate = (expr, doc, clock) => {
  if (typeof expr === 'string') {
    if (expr === '$$NOW') return clock();
    if (expr.startsWith('$$')) throw new Error(`fake-mongo: variable ${expr} is not supported`);
    return expr.startsWith('$') ? valueAt(doc, expr.slice(1)) : expr;
  }
  if (Array.isArray(expr)) return expr.map((item) => evaluate(item, doc, clock));
  if (expr === null || typeof expr !== 'object' || expr instanceof Date) return expr;
  const keys = Object.keys(expr);
  if (keys.length !== 1 || !keys[0].startsWith('$')) return clone(expr);
  const [op] = keys;
  const args = evaluate(expr[op], doc, clock);
  switch (op) {
    case '$add': {
      let sum = 0;
      let date = false;
      for (const arg of args) {
        if (arg instanceof Date) date = true;
        sum += instant(arg);
      }
      return date ? new Date(sum) : sum;
    }
    case '$ifNull':
      for (const arg of args) if (arg !== null && arg !== undefined) return arg;
      return null;
    case '$lt':
      return instant(args[0]) < instant(args[1]);
    case '$lte':
      return instant(args[0]) <= instant(args[1]);
    case '$gt':
      return instant(args[0]) > instant(args[1]);
    case '$gte':
      return instant(args[0]) >= instant(args[1]);
    case '$eq':
      return instant(args[0]) === instant(args[1]);
    default:
      throw new Error(`fake-mongo: expression ${op} is not supported`);
  }
};

const matchesCondition = (value, condition) => {
  if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
    const keys = Object.keys(condition);
    if (keys.length > 0 && keys.every((key) => OPERATORS.has(key))) {
      for (const key of keys) {
        const expected = condition[key];
        switch (key) {
          case '$gt':
            if (!(value !== undefined && compare(value, expected) > 0)) return false;
            break;
          case '$gte':
            if (!(value !== undefined && compare(value, expected) >= 0)) return false;
            break;
          case '$lt':
            if (!(value !== undefined && compare(value, expected) < 0)) return false;
            break;
          case '$lte':
            if (!(value !== undefined && compare(value, expected) <= 0)) return false;
            break;
          case '$in':
            if (!expected.some((item) => same(item, value))) return false;
            break;
          case '$nin':
            if (expected.some((item) => same(item, value))) return false;
            break;
          case '$ne':
            if (same(value, expected)) return false;
            break;
          case '$eq':
            if (!same(value, expected)) return false;
            break;
          case '$exists':
            if ((value !== undefined) !== Boolean(expected)) return false;
            break;
          case '$not':
            if (matchesCondition(value, expected)) return false;
            break;
          case '$regex':
            if (!(typeof value === 'string' && new RegExp(expected).test(value))) return false;
            break;
          default:
            throw new Error(`fake-mongo: operator ${key} is not supported`);
        }
      }
      return true;
    }
  }
  return same(value, condition);
};

const matches = (doc, filter, clock = () => new Date()) => {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or') {
      if (!condition.some((branch) => matches(doc, branch, clock))) return false;
    } else if (key === '$and') {
      if (!condition.every((branch) => matches(doc, branch, clock))) return false;
    } else if (key === '$expr') {
      if (!evaluate(condition, doc, clock)) return false;
    } else if (key.startsWith('$')) {
      throw new Error(`fake-mongo: filter ${key} is not supported`);
    } else if (!matchesCondition(valueAt(doc, key), condition)) return false;
  }
  return true;
};

const project = (doc, projection) => {
  if (projection === undefined || projection === null) return clone(doc);
  const out = {};
  let includes = false;
  for (const [key, on] of Object.entries(projection)) if (on && key !== '_id') includes = true;
  if (includes) {
    if (projection._id !== 0) out._id = doc._id;
    for (const [key, on] of Object.entries(projection)) if (on && key in doc) out[key] = clone(doc[key]);
    return out;
  }
  const copy = clone(doc);
  for (const [key, on] of Object.entries(projection)) if (!on) delete copy[key];
  return copy;
};

const duplicate = (_id) =>
  Object.assign(new Error(`E11000 duplicate key error collection: fake index: _id_ dup key: { _id: "${_id}" }`), {
    code: 11000,
  });

// The fields `update` sets: `$set` (and `$setOnInsert` at an upsert's insert),
// `$unset`, `$inc` — or a pipeline, a `$set` stage per element, each field an
// expression over the document as the stage finds it.
const applyUpdate = (doc, update, inserting, clock) => {
  if (Array.isArray(update)) {
    let next = { ...doc };
    for (const stage of update) {
      const keys = Object.keys(stage);
      if (keys.length !== 1 || keys[0] !== '$set') {
        throw new Error(`fake-mongo: pipeline stage ${keys[0]} is not supported`);
      }
      const staged = { ...next };
      for (const [key, expr] of Object.entries(stage.$set)) staged[key] = evaluate(expr, next, clock);
      next = staged;
    }
    return next;
  }
  const next = { ...doc };
  for (const [op, fields] of Object.entries(update)) {
    if (op === '$set' || (op === '$setOnInsert' && inserting)) Object.assign(next, clone(fields));
    else if (op === '$setOnInsert') continue;
    else if (op === '$unset') for (const key of Object.keys(fields)) delete next[key];
    else if (op === '$inc') for (const [key, by] of Object.entries(fields)) next[key] = (next[key] ?? 0) + by;
    else throw new Error(`fake-mongo: update ${op} is not supported`);
  }
  return next;
};

class FakeChangeStream extends EventEmitter {
  #collection;
  #filter;
  #excluded;
  #lookup;
  #clock;
  constructor(collection, { filter, excluded, lookup, clock }) {
    super();
    this.#collection = collection;
    this.#filter = filter;
    this.#excluded = excluded;
    this.#lookup = lookup;
    this.#clock = clock;
    collection.watchers.add(this);
  }
  // An event as the pipeline shapes it: an update carries its document only
  // looked up, the `$match` is over the event, the `$project` takes fields off it.
  deliver(event) {
    const shaped = clone(event);
    if (shaped.operationType === 'update' && !this.#lookup) delete shaped.fullDocument;
    if (this.#filter !== null && !matches(shaped, this.#filter, this.#clock)) return;
    for (const path of this.#excluded) exclude(shaped, path);
    this.emit('change', shaped);
  }
  async close() {
    this.#collection.watchers.delete(this);
    this.emit('close');
  }
}

class FakeCollection {
  docs = new Map();
  watchers = new Set();
  #name;
  // The server's clock: what `$$NOW` reads.
  #clock;
  constructor(name, clock = () => new Date()) {
    this.#name = name;
    this.#clock = clock;
  }
  get collectionName() {
    return this.#name;
  }

  // Every change goes through here: the session's undo log first, the
  // watchers (after the transaction commits, or at once) after. `how` is
  // what a change to a held document is: a `replace` or an `update`.
  #change(_id, next, session, how = 'replace') {
    const before = this.docs.get(_id);
    if (session?.inTransaction) session.undo.push([this, _id, before]);
    if (next === undefined) this.docs.delete(_id);
    else this.docs.set(_id, next);
    const event =
      next === undefined
        ? { operationType: 'delete', documentKey: { _id } }
        : {
            operationType: before === undefined ? 'insert' : how,
            documentKey: { _id },
            fullDocument: clone(next),
          };
    if (session?.inTransaction) session.events.push([this, event]);
    else this.publish(event);
  }
  publish(event) {
    for (const watcher of this.watchers) setImmediate(() => watcher.deliver(event));
  }
  /** Every change stream on this collection errs, as one does when its resume token is gone or the deployment changed. */
  breakStreams(error) {
    for (const watcher of this.watchers) watcher.emit('error', error);
  }

  #all(filter) {
    const found = [];
    for (const doc of this.docs.values()) if (matches(doc, filter, this.#clock)) found.push(doc);
    return found;
  }

  async findOne(filter, options = {}) {
    const docs = this.#all(filter);
    return docs.length === 0 ? null : project(docs[0], options.projection);
  }

  find(filter, options = {}) {
    let { sort, limit, projection } = options;
    const run = () => {
      let docs = this.#all(filter);
      if (sort !== undefined) {
        const entries = Object.entries(sort);
        docs.sort((a, b) => {
          for (const [field, direction] of entries) {
            const order = compare(valueAt(a, field), valueAt(b, field));
            if (order !== 0) return direction < 0 ? -order : order;
          }
          return 0;
        });
      }
      if (limit !== undefined && limit > 0) docs = docs.slice(0, limit);
      return docs.map((doc) => project(doc, projection));
    };
    const cursor = {
      sort(by) {
        sort = by;
        return cursor;
      },
      limit(n) {
        limit = n;
        return cursor;
      },
      project(by) {
        projection = by;
        return cursor;
      },
      toArray: async () => run(),
      async *[Symbol.asyncIterator]() {
        yield* run();
      },
    };
    return cursor;
  }

  async countDocuments(filter = {}) {
    return this.#all(filter).length;
  }

  async insertOne(doc, options = {}) {
    const copy = clone(doc);
    if (copy._id === undefined) copy._id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    if (this.docs.has(copy._id)) throw duplicate(copy._id);
    this.#change(copy._id, copy, options.session);
    return { acknowledged: true, insertedId: copy._id };
  }

  async insertMany(docs, options = {}) {
    for (const doc of docs) await this.insertOne(doc, options);
    return { acknowledged: true, insertedCount: docs.length };
  }

  async replaceOne(filter, replacement, options = {}) {
    const found = this.#all(filter);
    if (found.length === 0) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const doc = clone(replacement);
      if (doc._id === undefined) doc._id = filter._id;
      if (this.docs.has(doc._id)) throw duplicate(doc._id);
      this.#change(doc._id, doc, options.session);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id };
    }
    const doc = { ...clone(replacement), _id: found[0]._id };
    this.#change(doc._id, doc, options.session);
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }

  async updateOne(filter, update, options = {}) {
    const found = this.#all(filter);
    if (found.length === 0) {
      if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const seed = {};
      for (const [key, value] of Object.entries(filter)) {
        if (!key.startsWith('$') && !isCondition(value)) seed[key] = value;
      }
      const doc = applyUpdate(seed, update, true, this.#clock);
      if (doc._id === undefined) doc._id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      if (this.docs.has(doc._id)) throw duplicate(doc._id);
      this.#change(doc._id, doc, options.session);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id };
    }
    const doc = applyUpdate(found[0], update, false, this.#clock);
    this.#change(doc._id, doc, options.session, 'update');
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const found = this.#all(filter);
    const before = found.length === 0 ? null : clone(found[0]);
    const result = await this.updateOne(filter, update, options);
    if (found.length === 0 && result.upsertedCount === 0) return null;
    const _id = found.length === 0 ? result.upsertedId : found[0]._id;
    return options.returnDocument === 'after' ? clone(this.docs.get(_id)) : before;
  }

  async deleteOne(filter, options = {}) {
    const found = this.#all(filter);
    if (found.length === 0) return { deletedCount: 0 };
    this.#change(found[0]._id, undefined, options.session);
    return { deletedCount: 1 };
  }

  async deleteMany(filter, options = {}) {
    const found = this.#all(filter);
    for (const doc of found) this.#change(doc._id, undefined, options.session);
    return { deletedCount: found.length };
  }

  async bulkWrite(operations, options = {}) {
    if (!options.ordered && options.ordered !== undefined) throw new Error('fake-mongo: ordered bulk writes only');
    const result = { insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0 };
    for (const operation of operations) {
      const [kind] = Object.keys(operation);
      const op = operation[kind];
      if (kind === 'replaceOne') {
        const r = await this.replaceOne(op.filter, op.replacement, { upsert: op.upsert, session: options.session });
        result.matchedCount += r.matchedCount;
        result.modifiedCount += r.modifiedCount;
        result.upsertedCount += r.upsertedCount;
      } else if (kind === 'insertOne') {
        await this.insertOne(op.document, { session: options.session });
        result.insertedCount++;
      } else if (kind === 'deleteOne') {
        result.deletedCount += (await this.deleteOne(op.filter, { session: options.session })).deletedCount;
      } else if (kind === 'deleteMany') {
        result.deletedCount += (await this.deleteMany(op.filter, { session: options.session })).deletedCount;
      } else if (kind === 'updateOne') {
        const r = await this.updateOne(op.filter, op.update, { upsert: op.upsert, session: options.session });
        result.matchedCount += r.matchedCount;
        result.modifiedCount += r.modifiedCount;
        result.upsertedCount += r.upsertedCount;
      } else throw new Error(`fake-mongo: bulk operation ${kind} is not supported`);
    }
    return result;
  }

  async createIndex(keys) {
    return Object.entries(keys)
      .map(([field, direction]) => `${field}_${direction}`)
      .join('_');
  }

  watch(pipeline = [], options = {}) {
    let filter = null;
    const excluded = [];
    for (const stage of pipeline) {
      const keys = Object.keys(stage);
      if (keys.length !== 1) throw new Error('fake-mongo: a pipeline stage is one operator');
      if (keys[0] === '$match') filter = stage.$match;
      else if (keys[0] === '$project') {
        for (const [path, on] of Object.entries(stage.$project)) {
          if (on !== 0) throw new Error(`fake-mongo: $project ${path}: exclusions only`);
          excluded.push(path);
        }
      } else throw new Error(`fake-mongo: change stream stage ${keys[0]} is not supported`);
    }
    const lookup = options.fullDocument === 'updateLookup';
    return new FakeChangeStream(this, { filter, excluded, lookup, clock: this.#clock });
  }

  async drop() {
    for (const _id of [...this.docs.keys()]) this.#change(_id, undefined, undefined);
    return true;
  }
}

const isCondition = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).some((key) => OPERATORS.has(key));

class FakeSession {
  inTransaction = false;
  undo = [];
  events = [];
  async withTransaction(fn) {
    this.inTransaction = true;
    this.undo = [];
    this.events = [];
    try {
      const value = await fn(this);
      this.inTransaction = false;
      for (const [collection, event] of this.events) collection.publish(event);
      return value;
    } catch (error) {
      this.inTransaction = false;
      for (let i = this.undo.length - 1; i >= 0; i--) {
        const [collection, _id, before] = this.undo[i];
        if (before === undefined) collection.docs.delete(_id);
        else collection.docs.set(_id, before);
      }
      throw error;
    } finally {
      this.undo = [];
      this.events = [];
    }
  }
  async endSession() {}
}

class FakeDb {
  #collections = new Map();
  #clock;
  databaseName;
  constructor(name, clock = () => new Date()) {
    this.databaseName = name;
    this.#clock = clock;
  }
  collection(name) {
    let collection = this.#collections.get(name);
    if (collection === undefined) this.#collections.set(name, (collection = new FakeCollection(name, this.#clock)));
    return collection;
  }
  async dropDatabase() {
    for (const collection of this.#collections.values()) await collection.drop();
    this.#collections.clear();
    return true;
  }
  async listCollections() {
    return [...this.#collections.keys()];
  }
}

class FakeMongoClient {
  #dbs = new Map();
  // How far the server's clock is past the real one — what `advance(ms)` moves.
  #skew = 0;
  closed = false;
  db(name = 'test') {
    let db = this.#dbs.get(name);
    if (db === undefined) this.#dbs.set(name, (db = new FakeDb(name, () => new Date(realNow() + this.#skew))));
    return db;
  }
  /** Moves the server's clock (`$$NOW`) forward by `ms`, the client's untouched. */
  advance(ms) {
    this.#skew += ms;
  }
  startSession() {
    return new FakeSession();
  }
  async connect() {
    return this;
  }
  async close() {
    this.closed = true;
  }
}

/** A fresh in-memory MongoDB client. */
const createFakeMongo = () => new FakeMongoClient();

module.exports = { createFakeMongo, FakeMongoClient, FakeDb, FakeCollection, matches };
