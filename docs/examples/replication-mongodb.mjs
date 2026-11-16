// The MongoDB replication page (docs/guide/replication-mongodb.md) shows the regions of this file. The MongoDB here is
// a stand-in in memory for the driver's `client.db().collection()`: `find` (with `$or`, `$gt`, `sort`, `limit`),
// `findOne`, `replaceOne` (with `upsert` and a duplicate key error), `updateOne` (`$set`, `$inc`) and a change stream.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const waitUntil = async (check) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil: timed out');
};

const createCollection = () => {
  const docs = new Map();
  const streams = new Set();
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const test = (doc, filter) =>
    Object.entries(filter).every(([key, cond]) => {
      if (key === '$or') return cond.some((inner) => test(doc, inner));
      const value = doc?.[key];
      if (cond !== null && typeof cond === 'object') {
        if ('$gt' in cond) return value !== undefined && value > cond.$gt;
        if ('$exists' in cond) return (value !== undefined) === cond.$exists;
      }
      return value === cond;
    });
  const changed = () => {
    for (const listeners of streams) for (const listener of listeners.change ?? []) listener({});
  };
  return {
    find(filter, { sort = {}, limit = 0 } = {}) {
      const keys = Object.keys(sort);
      let rows = [...docs.values()].filter((doc) => test(doc, filter));
      rows.sort((a, b) => {
        for (const key of keys) if (compare(a[key], b[key]) !== 0) return compare(a[key], b[key]) * sort[key];
        return 0;
      });
      if (limit > 0) rows = rows.slice(0, limit);
      return { toArray: async () => structuredClone(rows) };
    },
    async findOne(filter) {
      for (const doc of docs.values()) if (test(doc, filter)) return structuredClone(doc);
      return null;
    },
    async replaceOne(filter, replacement, { upsert = false } = {}) {
      const held = docs.get(filter._id);
      if (held !== undefined && test(held, filter)) {
        docs.set(filter._id, structuredClone(replacement));
        changed();
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (!upsert) return { matchedCount: 0, upsertedCount: 0 };
      if (held !== undefined) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      docs.set(filter._id, structuredClone(replacement));
      changed();
      return { matchedCount: 0, upsertedCount: 1 };
    },
    async updateOne(filter, { $set = {}, $inc = {} }, { upsert = false } = {}) {
      const held = docs.get(filter._id);
      if (held === undefined && !upsert) return { matchedCount: 0 };
      const doc = { _id: filter._id, ...structuredClone(held ?? {}), ...structuredClone($set) };
      for (const [key, by] of Object.entries($inc)) doc[key] = (doc[key] ?? 0) + by;
      docs.set(filter._id, doc);
      changed();
      return { matchedCount: held === undefined ? 0 : 1 };
    },
    watch() {
      const listeners = {};
      streams.add(listeners);
      return {
        on(event, listener) {
          (listeners[event] ??= []).push(listener);
          return this;
        },
        async close() {
          streams.delete(listeners);
        },
      };
    },
    get streams() {
      return streams.size;
    },
  };
};

const collections = new Map();
const client = {
  db: () => ({ collection: (name) => collections.get(name) ?? collections.set(name, createCollection()).get(name) }),
};
await client
  .db('app')
  .collection('tasks')
  .updateOne(
    { _id: 't1' },
    { $set: { title: 'Plan the sprint', done: false, _deleted: false, _updated: Date.now() }, $inc: { _rev: 1 } },
    { upsert: true },
  );

// #region replicate
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';
import { mongodb } from '@alexify/syncom/connector/mongodb';

// const client = await MongoClient.connect('mongodb://localhost:27017/?replicaSet=rs0'); // from 'mongodb'
const tasks = client.db('app').collection('tasks');
const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

const replication = replicate(board, {
  name: 'mongo',
  collection: 'Task',
  ...mongodb({ collection: tasks }),
});
await replication.awaitInitialReplication();
// #endregion replicate
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });
assert.equal(tasks.streams, 1, 'the change stream is open');

// #region use
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync();
console.log(await tasks.findOne({ _id: task.id }));
// { _id: '…', _rev: 1, _updated: 1794700000000, title: 'Write the docs', done: false }
// #endregion use
const stored = await tasks.findOne({ _id: task.id });
assert.equal(stored._rev, 1);
assert.equal(typeof stored._updated, 'number');
assert.deepEqual({ title: stored.title, done: stored.done }, { title: 'Write the docs', done: false });

// #region other-writer
// Another app writes the same collection and keeps the adapter's three fields up to date. It deletes by marking:
await tasks.updateOne({ _id: 't1' }, { $set: { _deleted: true, _updated: Date.now() }, $inc: { _rev: 1 } });
// and writes with the next `_rev` and the current time:
await tasks.updateOne(
  { _id: 't2' },
  { $set: { title: 'Review the PR', done: false, _deleted: false, _updated: Date.now() }, $inc: { _rev: 1 } },
  { upsert: true },
);
// #endregion other-writer
await waitUntil(async () => (await board.Task.get('t2')) !== null && (await board.Task.get('t1')) === null);
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR', done: false, $type: 'Task' });

// A local deletion is a `_deleted` document too.
await board.Task.delete(task.id);
await replication.awaitInSync();
assert.equal((await tasks.findOne({ _id: task.id }))._deleted, true);
await replication.cancel();
assert.equal(tasks.streams, 0, 'cancel() closes the change stream');

// A change made while this node's edit waits: replaceOne matches no `_rev`, the collection wins.
const quiet = replicate(board, { name: 'mongo', collection: 'Task', live: false, ...mongodb({ collection: tasks }) });
await quiet.awaitInitialReplication();
await tasks.updateOne(
  { _id: 't2' },
  { $set: { title: 'Review the PR today', _updated: Date.now() }, $inc: { _rev: 1 } },
);
await board.Task.update('t2', { done: true });
await quiet.awaitInSync();
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR today', done: false, $type: 'Task' });
assert.equal(quiet.stats().conflicts, 1);
await quiet.cancel();

// A writer whose clock runs two seconds behind: its `_updated` is behind what this node pulled through, and
// without a lookback the pull never sees its document.
const late = (id, title) =>
  tasks.updateOne(
    { _id: id },
    { $set: { title, done: false, _deleted: false, _updated: Date.now() - 2000 }, $inc: { _rev: 1 } },
    { upsert: true },
  );
await late('t3', 'Stamped by a slow clock');
const missing = replicate(board, { name: 'mongo', collection: 'Task', live: false, ...mongodb({ collection: tasks }) });
await missing.awaitInitialReplication();
assert.equal(await board.Task.get('t3'), null, 'behind the checkpoint: missed');
await missing.cancel();

// #region lookback
const careful = replicate(board, {
  name: 'mongo',
  collection: 'Task',
  // Each pull starts five seconds before its checkpoint: a document stamped by a clock that runs behind is pulled.
  ...mongodb({ collection: tasks, lookback: 5000 }),
});
await careful.awaitInitialReplication();
// #endregion lookback
assert.deepEqual(await board.Task.get('t3'), { title: 'Stamped by a slow clock', done: false, $type: 'Task' });
const counted = careful.stats();
assert.equal(counted.applied, 1, 't3 alone: what the connector knew of the window made no write');
await late('t4', 'Stamped late too');
await waitUntil(async () => (await board.Task.get('t4')) !== null);
await careful.awaitInSync();
assert.equal(careful.stats().pulled, counted.pulled + 1, 'a late document is counted once');
await careful.cancel();

// #region standalone
// A standalone server has no change streams: the connector pulls every `retryTime` instead.
const polling = replicate(board, {
  name: 'mongo',
  collection: 'Task',
  retryTime: 10_000,
  ...mongodb({ collection: tasks, changes: false }),
});
// #endregion standalone
await polling.awaitInitialReplication();
assert.equal(tasks.streams, 0);
await polling.cancel();
await board.close();
