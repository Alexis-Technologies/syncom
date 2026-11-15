// The Firestore page (docs/guide/replication-firestore.md) shows the regions of this file. `sdk` here is a stand-in
// in memory for the modular SDK (`firebase/firestore`): the calls the adapter makes (`query`, `orderBy`, `limit`,
// `startAfter`, `documentId`, `getDocs`, `doc`, `runTransaction`, `serverTimestamp`, `Timestamp`, `onSnapshot`) and
// the two an app makes (`collection`, `setDoc`), over one database stamped by a server clock in microseconds.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const waitUntil = async (check) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil: timed out');
};

const createSdk = () => {
  const SERVER = Symbol('serverTimestamp');
  class Timestamp {
    constructor(seconds, nanoseconds) {
      Object.assign(this, { seconds, nanoseconds });
    }
    static fromMillis(ms) {
      return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
    }
    toMillis() {
      return this.seconds * 1000 + Math.round(this.nanoseconds / 1e6);
    }
  }
  const docs = new Map();
  const versions = new Map();
  const listeners = new Set();
  let clock = 0;
  const copy = (value) =>
    value instanceof Timestamp || value === null || typeof value !== 'object'
      ? value
      : Array.isArray(value)
        ? value.map(copy)
        : Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, copy(inner)]));
  const commit = (id, data) => {
    const stamped = copy(data);
    for (const key of Object.keys(stamped)) {
      if (stamped[key] !== SERVER) continue;
      clock = Math.max(Date.now() * 1000, clock + 1);
      stamped[key] = new Timestamp(Math.floor(clock / 1e6), (clock % 1e6) * 1000);
    }
    docs.set(id, stamped);
    versions.set(id, (versions.get(id) ?? 0) + 1);
  };
  const changed = () => {
    for (const listener of [...listeners]) queueMicrotask(listener);
  };
  const snap = (id) => ({ id, exists: () => docs.has(id), data: () => copy(docs.get(id)) });
  const rank = (value) => (value instanceof Timestamp ? value.seconds * 1e9 + value.nanoseconds : value);
  const valueOf = (id, field) => (field === '__name__' ? id : rank(docs.get(id)[field]));
  const run = ({ constraints }) => {
    const orders = constraints.filter((c) => c.type === 'orderBy');
    const after = constraints.find((c) => c.type === 'startAfter');
    const limit = constraints.find((c) => c.type === 'limit');
    const compare = (a, b) => {
      for (const { field, dir } of orders) {
        const [x, y] = [valueOf(a, field), valueOf(b, field)];
        if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    };
    let ids = [...docs.keys()].sort(compare);
    if (after) {
      ids = ids.filter((id) => {
        for (let i = 0; i < orders.length; i++) {
          const [x, y] = [valueOf(id, orders[i].field), rank(after.values[i])];
          if (x !== y) return x > y;
        }
        return false;
      });
    }
    return (limit ? ids.slice(0, limit.n) : ids).map(snap);
  };
  return {
    Timestamp,
    collection: (_database, name) => ({ name }),
    query: (ref, ...constraints) => ({ ref, constraints }),
    orderBy: (field, dir = 'asc') => ({ type: 'orderBy', field, dir }),
    limit: (n) => ({ type: 'limit', n }),
    startAfter: (...values) => ({ type: 'startAfter', values }),
    documentId: () => '__name__',
    doc: (_ref, id) => {
      if (id.includes('/') || /^__.*__$/.test(id)) {
        throw Object.assign(new Error(`Invalid document id ${id}`), { code: 'invalid-argument' });
      }
      return { id };
    },
    serverTimestamp: () => SERVER,
    getDocs: async (q) => ({ docs: run(q) }),
    async setDoc(ref, data) {
      commit(ref.id, data);
      changed();
    },
    async runTransaction(_database, fn) {
      for (;;) {
        const read = new Map();
        const writes = [];
        await fn({
          get: async (ref) => {
            read.set(ref.id, versions.get(ref.id) ?? 0);
            return snap(ref.id);
          },
          set: (ref, data) => writes.push([ref.id, data]),
        });
        // A document read moved before the commit: Firestore runs the function again.
        if ([...read].some(([id, version]) => (versions.get(id) ?? 0) !== version)) continue;
        for (const [id, data] of writes) commit(id, data);
        if (writes.length > 0) changed();
        return;
      }
    },
    onSnapshot(q, next) {
      const listener = () => next({ docs: run(q), metadata: { hasPendingWrites: false } });
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read(id) {
      const doc = docs.get(id);
      if (!doc || doc._deleted) return null;
      const { serverTimestamp, _deleted, ...data } = copy(doc);
      return data;
    },
    get listeners() {
      return listeners.size;
    },
  };
};

const sdk = createSdk();
const database = {};
await sdk.setDoc(sdk.doc(sdk.collection(database, 'tasks'), 't1'), {
  title: 'Plan the sprint',
  done: false,
  _deleted: false,
  serverTimestamp: sdk.serverTimestamp(),
});

// #region replicate
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';
import { firestore } from '@alexify/syncom/connector/firestore';

// import * as sdk from 'firebase/firestore'; const database = sdk.getFirestore(app);
const tasks = sdk.collection(database, 'tasks');
const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

const replication = replicate(board, {
  name: 'firestore',
  collection: 'Task',
  ...firestore({ sdk, database, collection: tasks }),
});
await replication.awaitInitialReplication();
// #endregion replicate
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });
assert.equal(sdk.listeners, 1, 'onSnapshot is listening');

// #region use
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync();
console.log(sdk.read(task.id)); // { title: 'Write the docs', done: false }

// Another client writes with the two fields the adapter reads:
await sdk.setDoc(sdk.doc(tasks, 't2'), {
  title: 'Review the PR',
  done: false,
  _deleted: false,
  serverTimestamp: sdk.serverTimestamp(),
});
// onSnapshot fires, the connector pulls, and t2 lands here
// #endregion use
assert.deepEqual(sdk.read(task.id), { title: 'Write the docs', done: false });
await waitUntil(async () => (await board.Task.get('t2')) !== null);
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR', done: false, $type: 'Task' });

// A deletion is a document with `_deleted: true`, both ways.
await board.Task.delete(task.id);
await replication.awaitInSync();
assert.equal(sdk.read(task.id), null);
await sdk.setDoc(sdk.doc(tasks, 't1'), { _deleted: true, serverTimestamp: sdk.serverTimestamp() });
await waitUntil(async () => (await board.Task.get('t1')) === null);

// An id Firestore keeps for itself (`__…__`) is refused by name and parked; the rest goes on.
const refused = [];
replication.on('refused', (event) => refused.push([event.direction, event.id, event.reason]));
await board.Task.set('__draft__', { title: 'Not for Firestore' });
await replication.awaitInSync();
assert.deepEqual(refused, [['push', '__draft__', 'invalid-argument']]);
assert.equal(replication.stats().parked, 1);
await replication.cancel();
assert.equal(sdk.listeners, 0);

// A change made while this node's edit waits: the transaction reads another state, Firestore's wins.
const quiet = replicate(board, {
  name: 'firestore',
  collection: 'Task',
  live: false,
  ...firestore({ sdk, database, collection: tasks }),
});
await quiet.awaitInitialReplication();
await sdk.setDoc(sdk.doc(tasks, 't2'), {
  title: 'Review the PR today',
  done: false,
  _deleted: false,
  serverTimestamp: sdk.serverTimestamp(),
});
await board.Task.update('t2', { done: true });
await quiet.awaitInSync();
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR today', done: false, $type: 'Task' });
assert.equal(quiet.stats().conflicts, 1);
await quiet.cancel();

// #region fields
const renamed = firestore({
  sdk,
  database,
  collection: tasks,
  stampField: 'updatedAt', // the field the server stamps on every write
  deletedField: 'isDeleted',
  stream: false, // no onSnapshot: the connector pulls every `retryTime`
});
// #endregion fields
assert.equal(renamed.pull.stream, undefined);
await board.close();
