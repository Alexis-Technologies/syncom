// The Appwrite page (docs/guide/replication-appwrite.md) shows the regions of this file. `Client`, `Databases` and
// `Query` here are stand-ins in memory for the `appwrite` SDK's: one collection whose documents the "server" stamps
// with `$updatedAt`, `listDocuments` with the query builder's `equal`, `greaterThan`, `orderAsc`, `limit`, `or`,
// `and`, `createDocument` (409 on a duplicate, 400 on an id past 36 characters), `updateDocument`, `getDocument`,
// and Realtime's `client.subscribe`.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const waitUntil = async (check) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil: timed out');
};

class AppwriteException extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const Query = {
  equal: (attribute, values) => JSON.stringify({ method: 'equal', attribute, values: [values].flat() }),
  greaterThan: (attribute, value) => JSON.stringify({ method: 'greaterThan', attribute, values: [value] }),
  orderAsc: (attribute) => JSON.stringify({ method: 'orderAsc', attribute }),
  limit: (n) => JSON.stringify({ method: 'limit', values: [n] }),
  or: (queries) => JSON.stringify({ method: 'or', values: queries.map((q) => JSON.parse(q)) }),
  and: (queries) => JSON.stringify({ method: 'and', values: queries.map((q) => JSON.parse(q)) }),
};
const MATCHERS = {
  equal: (doc, q) => q.values.includes(doc[q.attribute]),
  greaterThan: (doc, q) => doc[q.attribute] > q.values[0],
  or: (doc, q) => q.values.some((inner) => matches(doc, inner)),
  and: (doc, q) => q.values.every((inner) => matches(doc, inner)),
};
const matches = (doc, q) => (Object.hasOwn(MATCHERS, q.method) ? MATCHERS[q.method](doc, q) : true);
const server = { docs: new Map(), listeners: new Set(), last: 0 };
const stamp = () => new Date((server.last = Math.max(Date.now(), server.last + 1))).toISOString();
const told = (doc) => {
  for (const listener of [...server.listeners]) listener({ events: ['databases.*.documents.*.update'], payload: doc });
};
class Client {
  setEndpoint() {
    return this;
  }
  setProject() {
    return this;
  }
  subscribe(_channels, callback) {
    server.listeners.add(callback);
    return () => server.listeners.delete(callback);
  }
}
class Databases {
  async listDocuments(_db, _col, queries = []) {
    const parsed = queries.map((q) => JSON.parse(q));
    const orders = parsed.filter((q) => q.method === 'orderAsc').map((q) => q.attribute);
    const limit = parsed.find((q) => q.method === 'limit')?.values[0] ?? 25;
    const rows = [...server.docs.values()].filter((doc) => parsed.every((q) => matches(doc, q)));
    rows.sort((a, b) => {
      for (const key of orders) {
        if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
      }
      return 0;
    });
    return { total: rows.length, documents: structuredClone(rows.slice(0, limit)) };
  }
  async createDocument(_db, _col, id, data) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(id)) {
      throw new AppwriteException(400, 'Invalid `documentId` param: UID must contain at most 36 chars.');
    }
    if (server.docs.has(id)) throw new AppwriteException(409, 'Document with the requested ID already exists.');
    const doc = { $id: id, $updatedAt: stamp(), ...structuredClone(data) };
    server.docs.set(id, doc);
    told(doc);
    return structuredClone(doc);
  }
  async updateDocument(_db, _col, id, data) {
    const held = server.docs.get(id);
    if (!held) throw new AppwriteException(404, 'Document with the requested ID could not be found.');
    const doc = { ...held, ...structuredClone(data), $updatedAt: stamp() };
    server.docs.set(id, doc);
    told(doc);
    return structuredClone(doc);
  }
  async getDocument(_db, _col, id) {
    const held = server.docs.get(id);
    if (!held) throw new AppwriteException(404, 'Document with the requested ID could not be found.');
    return structuredClone(held);
  }
}
const read = (id) => {
  const doc = server.docs.get(id);
  if (!doc || doc.deleted) return null;
  return Object.fromEntries(Object.entries(doc).filter(([key]) => key[0] !== '$' && key !== 'deleted'));
};
await new Databases().createDocument('main', 'tasks', 't1', { title: 'Plan the sprint', done: false, deleted: false });

// #region replicate
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';
import { appwrite } from '@alexify/syncom/connector/appwrite';
// import { Client, Databases, Query } from 'appwrite';

const client = new Client().setEndpoint('https://cloud.appwrite.io/v1').setProject('task-board');
const databases = new Databases(client);
const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

const replication = replicate(board, {
  name: 'appwrite',
  collection: 'Task',
  ...appwrite({ client, databases, Query, databaseId: 'main', collectionId: 'tasks' }),
});
await replication.awaitInitialReplication();
// #endregion replicate
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });
assert.equal(server.listeners.size, 1, 'Realtime is subscribed');

// #region use
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync();
// in Appwrite now: { $id: '…', $updatedAt: '…', title: 'Write the docs', done: false, deleted: false }

await databases.createDocument('main', 'tasks', 't2', { title: 'Review the PR', done: false, deleted: false });
// Realtime fires, the connector pulls, and t2 lands here
// #endregion use
assert.deepEqual(read(task.id), { title: 'Write the docs', done: false });
await waitUntil(async () => (await board.Task.get('t2')) !== null);
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR', done: false, $type: 'Task' });

// A deletion sets `deleted`, both ways.
await board.Task.delete(task.id);
await replication.awaitInSync();
assert.equal(read(task.id), null);
assert.equal(server.docs.get(task.id).deleted, true);
await databases.updateDocument('main', 'tasks', 't1', { deleted: true });
await waitUntil(async () => (await board.Task.get('t1')) === null);

// #region long-id
// An id past Appwrite's 36 characters: refused by name, parked, reported; the rest goes on.
replication.on('refused', ({ id, reason }) => console.log(`refused ${id}: ${reason}`));
await board.Task.set('task-with-an-id-longer-than-thirty-six-characters', { title: 'Too long an id', done: false });
await replication.awaitInSync();
// refused task-with-an-id-longer-than-thirty-six-characters: 400
// #endregion long-id
assert.equal(replication.stats().parked, 1);
await replication.cancel();
assert.equal(server.listeners.size, 0);

// A change made while this node's edit waits: the read shows another state, Appwrite's wins.
const quiet = replicate(board, {
  name: 'appwrite',
  collection: 'Task',
  live: false,
  ...appwrite({ client, databases, Query, databaseId: 'main', collectionId: 'tasks' }),
});
await quiet.awaitInitialReplication();
await databases.updateDocument('main', 'tasks', 't2', { title: 'Review the PR today' });
await board.Task.update('t2', { done: true });
await quiet.awaitInSync();
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR today', done: false, $type: 'Task' });
assert.equal(quiet.stats().conflicts, 1);
await quiet.cancel();

// A document that becomes visible with an `$updatedAt` behind the checkpoint (a server whose clock runs behind):
// without a lookback the pull never sees it.
const late = (id, title) => {
  const doc = { $id: id, $updatedAt: new Date(Date.now() - 2000).toISOString(), title, done: false, deleted: false };
  server.docs.set(id, doc);
  told(doc);
};
late('t3', 'Stamped late');
const missing = replicate(board, {
  name: 'appwrite',
  collection: 'Task',
  live: false,
  ...appwrite({ client, databases, Query, databaseId: 'main', collectionId: 'tasks' }),
});
await missing.awaitInitialReplication();
assert.equal(await board.Task.get('t3'), null, 'behind the checkpoint: missed');
await missing.cancel();

// #region lookback
const careful = replicate(board, {
  name: 'appwrite',
  collection: 'Task',
  // Each pull starts five seconds before its checkpoint: a document that became visible late is pulled.
  ...appwrite({ client, databases, Query, databaseId: 'main', collectionId: 'tasks', lookback: 5000 }),
});
await careful.awaitInitialReplication();
// #endregion lookback
assert.deepEqual(await board.Task.get('t3'), { title: 'Stamped late', done: false, $type: 'Task' });
const counted = careful.stats();
assert.equal(counted.applied, 1, 't3 alone: what the connector knew of the window made no write');
late('t4', 'Stamped late too');
await waitUntil(async () => (await board.Task.get('t4')) !== null);
await careful.awaitInSync();
assert.equal(careful.stats().pulled, counted.pulled + 1, 'a late document is counted once');
await careful.cancel();
await board.close();
