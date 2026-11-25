// The Connectors page (docs/guide/connectors.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The same reading whatever the order of the keys.
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const equal = (a, b) => canonical(a) === canonical(b);
const copy = (value) => (value === null ? null : structuredClone(value));

// A stand-in for your backend's API, in memory: documents with a change feed (`seq`), a bulk write that checks what
// the client assumed before it writes (a compare-and-set), and a notification on every change. Another app's writes
// go through `write()`.
const createApi = () => {
  const docs = new Map();
  const listeners = new Set();
  const refusing = new Map();
  let seq = 0;
  let failures = 0;
  const put = (id, data) => {
    docs.set(id, { data: copy(data), seq: ++seq });
    for (const listener of [...listeners]) listener(seq);
  };
  const held = (id) => docs.get(id)?.data ?? null;
  return {
    async changes({ since, limit }) {
      if (failures > 0) {
        failures--;
        throw new Error('503 Service Unavailable');
      }
      const changed = [...docs].filter(([, doc]) => doc.seq > since).sort((a, b) => a[1].seq - b[1].seq);
      const rows = changed
        .slice(0, limit)
        .map(([id, doc]) => (doc.data === null ? { id, deleted: true } : { id, data: copy(doc.data) }));
      return { rows, last: rows.length > 0 ? docs.get(rows.at(-1).id).seq : since };
    },
    async get(id) {
      return held(id) === null ? { id, deleted: true } : { id, data: copy(held(id)) };
    },
    // Each row written where `assumed` is what the API holds; the rest answered as the API holds them.
    async bulk(rows) {
      const refused = [];
      for (const row of rows) {
        if (refusing.has(row.id)) {
          refused.push({ id: row.id, error: refusing.get(row.id) });
          continue;
        }
        const current = held(row.id);
        if (row.assumed === undefined || !equal(current, row.assumed)) {
          refused.push(current === null ? { id: row.id, deleted: true } : { id: row.id, data: copy(current) });
          continue;
        }
        put(row.id, row.deleted ? null : row.data);
      }
      return refused;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    write: (id, data) => put(id, data),
    read: (id) => copy(held(id)),
    failNext: (count) => (failures = count),
    refuse: (id, error) => refusing.set(id, error),
    get listeners() {
      return listeners.size;
    },
  };
};

const api = createApi();
api.write('t1', { title: 'Plan the sprint', done: false });

// #region connect
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

// The two handlers the connector calls, over your backend's client.
const handlersFor = (client) => ({
  pull: {
    // The backend's documents changed since `checkpoint`, at most `batchSize`, and the position after them.
    async handler(checkpoint, batchSize) {
      const page = await client.changes({ since: checkpoint ?? 0, limit: batchSize });
      return { documents: page.rows, checkpoint: page.last };
    },
  },
  push: {
    // This node's records as they change; answers the rows the backend refused, as it holds them.
    async handler(rows) {
      return client.bulk(rows);
    },
  },
});

const replication = replicate(board, {
  name: 'tasks-api', // names the checkpoint: one per connector
  collection: 'Task',
  ...handlersFor(api),
});
await replication.awaitInitialReplication();

console.log(await board.Task.get('t1')); // { title: 'Plan the sprint', done: false, $type: 'Task' }
// #endregion connect
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });

// #region write
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync();
console.log(api.read(task.id)); // { title: 'Write the docs', done: false }
// #endregion write
assert.deepEqual(api.read(task.id), { title: 'Write the docs', done: false });

await board.Task.update(task.id, { done: true });
await replication.awaitInSync();
assert.deepEqual(api.read(task.id), { title: 'Write the docs', done: true });
await board.Task.delete(task.id);
await replication.awaitInSync();
assert.equal(api.read(task.id), null, 'a deletion goes out as a deletion');

// Without a stream, a live connector pulls every `retryTime` (5 s by default); reSync() pulls at once.
api.write('t2', { title: 'Review the PR', done: false });
await replication.reSync();
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR', done: false, $type: 'Task' });

// #region stream
await replication.cancel(); // one connector per backend: stop it, then create it again with a stream

const { pull, push } = handlersFor(api);
const live = replicate(board, {
  name: 'tasks-api', // the same name: it resumes from the checkpoint the first one saved
  collection: 'Task',
  push,
  pull: {
    handler: pull.handler,
    // Subscribed once the first pull is through, from the checkpoint it left; returns what stops it.
    stream(emit, { checkpoint }) {
      return api.subscribe(() => emit('RESYNC')); // something changed: pull from the checkpoint
    },
  },
});
// #endregion stream
await live.awaitInitialReplication();
assert.equal(api.listeners, 1, 'the stream is followed once the first pull is through');
api.write('t3', { title: 'Fix the build', done: false });
for (let i = 0; i < 100 && (await board.Task.get('t3')) === null; i++) await sleep(10);
assert.deepEqual(await board.Task.get('t3'), { title: 'Fix the build', done: false, $type: 'Task' });

// #region conflict
await live.cancel(); // no connector runs for a while, as when the app is offline

api.write('t2', { title: 'Review the PR today', done: false }); // another app edits t2
await board.Task.update('t2', { done: true }); // and so does this node, before it hears of that edit

const back = replicate(board, { name: 'tasks-api', collection: 'Task', ...handlersFor(api) });
back.on('conflict', ({ id, local, resolved }) => console.log(id, local.title, '->', resolved.title));
await back.awaitInSync();
// t2 Review the PR -> Review the PR today
console.log(await board.Task.get('t2')); // { title: 'Review the PR today', done: false, $type: 'Task' }
// #endregion conflict
assert.equal(api.listeners, 0, 'cancel() stops the stream');
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR today', done: false, $type: 'Task' });
assert.deepEqual(api.read('t2'), { title: 'Review the PR today', done: false }, 'nothing of the edit went back');
assert.equal(back.stats().conflicts, 1);

// #region resolve
await back.cancel(); // offline again, and both sides edit t3

api.write('t3', { title: 'Fix the build first', done: false });
await board.Task.update('t3', { done: true });

const merging = replicate(board, {
  name: 'tasks-api',
  collection: 'Task',
  ...handlersFor(api),
  // Keep the backend's fields but this node's `done`. Return null to delete; undefined takes the backend's state.
  resolve({ local, remote, deleted }) {
    if (deleted || local === null) return undefined;
    return { ...remote, done: local.done };
  },
});
await merging.awaitInSync();
console.log(api.read('t3')); // { title: 'Fix the build first', done: true }
// #endregion resolve
assert.deepEqual(api.read('t3'), { title: 'Fix the build first', done: true });
assert.deepEqual(await board.Task.get('t3'), { title: 'Fix the build first', done: true, $type: 'Task' });
assert.equal(merging.stats().conflicts, 1);

const legacy = createApi();
legacy.write('l1', { name: 'An old task', completed: true });

// #region modifier
// The older API names the fields `name` and `completed`; the collection says `title` and `done`.
const shaped = replicate(board, {
  name: 'legacy-api',
  collection: 'Task',
  ...handlersFor(legacy),
  modifier: {
    pull: ({ name, completed, ...rest }) => ({ ...rest, title: name, done: completed }),
    push: ({ title, done, ...rest }) => ({ ...rest, name: title, completed: done }),
  },
});
await shaped.awaitInitialReplication();
console.log(await board.Task.get('l1')); // { title: 'An old task', done: true, $type: 'Task' }
console.log(legacy.read('t3')); // { name: 'Fix the build first', completed: true }
// #endregion modifier
assert.deepEqual(await board.Task.get('l1'), { title: 'An old task', done: true, $type: 'Task' });
assert.deepEqual(legacy.read('t3'), { name: 'Fix the build first', completed: true });
await shaped.cancel();

// #region events
merging.on('received', ({ documents, applied }) => console.log(`pulled ${documents}, ${applied} changed a record`));
merging.on('sent', ({ rows }) => console.log(`pushed ${rows}`));
merging.on('refused', ({ direction, id, reason }) => console.log(`${direction} refused ${id}: ${reason}`));
merging.on('error', (error) => console.log(error.code, error.direction, `retry in ${error.retryIn} ms`));
// #endregion events
const seen = { errors: [], refused: [] };
merging.on('error', (error) => seen.errors.push(error));
merging.on('refused', (event) => seen.refused.push(event));

// A pull that fails is told and tried again after the backoff (5 s, a quarter either way); nothing is skipped.
api.failNext(1);
api.write('t4', { title: 'Answer issues', done: false });
await merging.reSync();
assert.equal(seen.errors.length, 1);
assert.equal(seen.errors[0].code, 'ALX_ERR_REPLICATION_FAILED');
assert.equal(seen.errors[0].direction, 'pull');
assert.ok(seen.errors[0].retryIn >= 3750 && seen.errors[0].retryIn <= 6250);
assert.equal(merging.errors.length, 1);
assert.equal(await board.Task.get('t4'), null, 'the failed page has not landed');
await merging.reSync(); // the retry, without waiting for it: the checkpoint did not move
assert.deepEqual(await board.Task.get('t4'), { title: 'Answer issues', done: false, $type: 'Task' });

// #region refused
api.refuse('huge', { code: 'too_large', message: 'the body is over 1 MB' });
await board.Task.set('huge', { title: 'A task with a very long description', done: false });
await merging.awaitInSync();
// push refused huge: too_large
console.log(merging.stats().parked); // 1: set aside until the record changes again or reSync()
console.log(merging.parked); // [ { id: 'huge', reason: 'too_large' } ]
// #endregion refused
assert.equal(merging.stats().parked, 1);
assert.deepEqual(merging.parked, [{ id: 'huge', reason: 'too_large' }]);
assert.deepEqual(
  seen.refused.map(({ direction, id, reason }) => [direction, id, reason]),
  [['push', 'huge', 'too_large']],
);
assert.equal(api.read('huge'), null);

// #region restart
await board.close(); // cancels the database's connectors too

// While the node is away, both sides move on.
api.write('t5', { title: 'Written while the node was away', done: false });
const reopened = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });
const offline = await reopened.Task.insert({ title: 'Written offline', done: false });

const resumed = replicate(reopened, { name: 'tasks-api', collection: 'Task', ...handlersFor(api) });
await resumed.awaitInitialReplication();
console.log(await reopened.Task.get('t5')); // pulled from the saved checkpoint
console.log(api.read(offline.id)); // pushed from the log: { title: 'Written offline', done: false }
console.log(resumed.parked); // [ { id: 'huge', reason: 'too_large' } ]: still set aside, and not pushed again
// #endregion restart
assert.deepEqual(resumed.parked, [{ id: 'huge', reason: 'too_large' }]);
assert.equal(resumed.stats().parked, 1);
assert.equal(api.read('huge'), null);
assert.deepEqual(await reopened.Task.get('t5'), {
  title: 'Written while the node was away',
  done: false,
  $type: 'Task',
});
assert.deepEqual(api.read(offline.id), { title: 'Written offline', done: false });
assert.deepEqual(resumed.errors, []);

// #region adapter
// An adapter: a function of the client the application hands in, answering the two handlers.
const tasksApi = ({ client }) => ({
  pull: {
    async handler(checkpoint, batchSize) {
      const page = await client.changes({ since: checkpoint ?? 0, limit: batchSize });
      return { documents: page.rows, checkpoint: page.last };
    },
    stream: (emit) => client.subscribe(() => emit('RESYNC')),
  },
  push: {
    async handler(rows) {
      const answers = [];
      const writes = [];
      for (const row of rows) {
        // A probe asks what the backend holds: answer it as the backend holds it, and write nothing.
        if (row.assumed === undefined) answers.push(await client.get(row.id));
        else writes.push(row);
      }
      if (writes.length > 0) answers.push(...(await client.bulk(writes)));
      return answers;
    },
  },
});

await resumed.cancel(); // one connector per backend: the adapter's replaces the one above
const adapted = replicate(reopened, { name: 'tasks-api', collection: 'Task', ...tasksApi({ client: api }) });
// #endregion adapter
await adapted.awaitInitialReplication();
api.write('t6', { title: 'Through the adapter', done: false });
for (let i = 0; i < 100 && (await reopened.Task.get('t6')) === null; i++) await sleep(10);
assert.deepEqual(await reopened.Task.get('t6'), { title: 'Through the adapter', done: false, $type: 'Task' });
await reopened.Task.update('t6', { done: true });
await adapted.awaitInSync();
assert.deepEqual(api.read('t6'), { title: 'Through the adapter', done: true });

// #region cancel
await adapted.cancel(); // the stream stopped, what is in flight finished, the checkpoint saved
console.log(adapted.canceled); // true for good: replicate() again, with the same name, to go on
// #endregion cancel
assert.equal(adapted.canceled, true);
await reopened.close();
