// The Connectors page (docs/guide/connectors.md) shows the region of this file: a pull handler written by hand over
// a backend that resumes by a timestamp, looking back so that a write which becomes visible late is not missed.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

// A stand-in for your backend's API, in memory: rows stamped `updatedAt`, and a change feed ordered by that stamp,
// then by id — `changedAfter({ at, id }, limit)` answers the rows after that position. `write()` plays the backend's
// own writers, which may stamp a row before it becomes visible.
const createApi = () => {
  const rows = new Map();
  const after = (row, { at, id }) => row.updatedAt > at || (row.updatedAt === at && row.id > id);
  const order = (a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1);
  return {
    async changedAfter(position, limit) {
      const found = [...rows.values()].filter((row) => after(row, position)).sort(order);
      return structuredClone(found.slice(0, limit));
    },
    write: (id, data, updatedAt = Date.now()) => rows.set(id, { id, data, deleted: data === null, updatedAt }),
  };
};

const api = createApi();
api.write('t1', { title: 'Plan the sprint', done: false }, Date.now() - 60_000);
api.write('t2', { title: 'Write the docs', done: false }, Date.now() - 1000);

// #region lookback
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });
const LOOKBACK = 30_000; // how late a write may become visible, in ms

const replication = replicate(board, {
  name: 'tasks-by-time',
  collection: 'Task',
  pull: {
    // The checkpoint is the newest position pulled through: `{ at, id }`, the stamp and the id that breaks its ties.
    async handler(checkpoint, batchSize) {
      const mark = checkpoint ?? { at: 0, id: '' };
      // A run under way reads on after its last page; a new one starts LOOKBACK before the checkpoint.
      const rows = await api.changedAfter(mark.from ?? { at: mark.at - LOOKBACK, id: '' }, batchSize);
      const last = rows.at(-1);
      const ahead = last !== undefined && last.updatedAt > mark.at;
      const newest = ahead ? { at: last.updatedAt, id: last.id } : { at: mark.at, id: mark.id };
      return {
        documents: rows.map(({ id, data, deleted }) => (deleted ? { id, deleted } : { id, data })),
        // Never behind the checkpoint handed in. A full page says where the next one reads on.
        checkpoint: rows.length === batchSize ? { ...newest, from: { at: last.updatedAt, id: last.id } } : newest,
        // How many of the documents, the first ones, are at or behind that checkpoint: read again.
        reread: rows.filter((row) => row.updatedAt <= mark.at).length,
      };
    },
  },
});
await replication.awaitInitialReplication();

// A write that becomes visible late: stamped ten seconds ago, after this node pulled past that time.
api.write('t3', { title: 'Committed late', done: false }, Date.now() - 10_000);
await replication.reSync(); // the next pull, at once
console.log(await board.Task.get('t3')); // { title: 'Committed late', done: false, $type: 'Task' }
console.log(replication.stats().pulled); // 3: each document once, whatever the pulls read again
// #endregion lookback
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });
assert.deepEqual(await board.Task.get('t3'), { title: 'Committed late', done: false, $type: 'Task' });
assert.equal(replication.stats().pulled, 3);
assert.equal(replication.stats().applied, 3);

// A pull that only reads again moves no count and makes no write; the checkpoint stays where it was.
const before = { stats: replication.stats(), checkpoint: replication.checkpoint.pull, log: board.log.length };
await replication.reSync();
assert.deepEqual(replication.stats(), { ...before.stats, pulls: before.stats.pulls + 1 });
assert.deepEqual(replication.checkpoint.pull, before.checkpoint);
assert.equal(board.log.length, before.log);
await replication.cancel();

// Without the lookback the same late write is never pulled: the feed is asked from the checkpoint on.
api.write('t4', { title: 'Also late', done: false }, Date.now() - 10_000);
const plain = replicate(board, {
  name: 'tasks-by-time',
  collection: 'Task',
  live: false,
  pull: {
    async handler(checkpoint, batchSize) {
      const mark = checkpoint ?? { at: 0, id: '' };
      const rows = await api.changedAfter(mark, batchSize);
      const last = rows.at(-1);
      return {
        documents: rows.map(({ id, data, deleted }) => (deleted ? { id, deleted } : { id, data })),
        checkpoint: last === undefined ? mark : { at: last.updatedAt, id: last.id },
      };
    },
  },
});
await plain.awaitInitialReplication();
assert.equal(await board.Task.get('t4'), null, 'behind the checkpoint: missed');
await plain.cancel();
await board.close();
