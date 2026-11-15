// The HTTP page (docs/guide/replication-http.md) shows the regions of this file: a small Node.js server with a pull,
// a push and an events endpoint, and a syncom node that replicates a collection with it through a connector.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const waitUntil = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil: timed out');
};

// #region store
// server.mjs
import http from 'node:http';

// Every task the server holds, with the change number of its last write; `data: null` keeps a deletion.
const tasks = new Map();
let changes = 0;
const listeners = new Set(); // the open event streams

const save = (id, data) => {
  tasks.set(id, { data, change: ++changes });
  for (const res of listeners) res.write(`data: ${changes}\n\n`);
};

// Two JSON values the same whatever the order of their keys.
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const same = (a, b) => canonical(a) === canonical(b);
// #endregion store

// #region pull-endpoint
// GET /tasks/pull?since=<change>&limit=<n>: the tasks written after a change number, oldest first.
const pull = (url, res) => {
  const since = Number(url.searchParams.get('since') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const page = [...tasks]
    .filter(([, task]) => task.change > since)
    .sort((a, b) => a[1].change - b[1].change)
    .slice(0, limit);
  const documents = page.map(([id, task]) => (task.data === null ? { id, deleted: true } : { id, data: task.data }));
  const checkpoint = page.length > 0 ? page.at(-1)[1].change : since;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ documents, checkpoint }));
};
// #endregion pull-endpoint

// #region push-endpoint
// POST /tasks/push { rows }: each row written only over what the client assumed the server holds.
const push = async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { rows } = JSON.parse(body);
  const conflicts = [];
  for (const row of rows) {
    const held = tasks.get(row.id)?.data ?? null;
    // JSON has no undefined, so a probe arrives without `assumed`: answer it, write nothing.
    if (!('assumed' in row) || !same(held, row.assumed)) {
      conflicts.push(held === null ? { id: row.id, deleted: true } : { id: row.id, data: held });
      continue;
    }
    save(row.id, row.deleted ? null : row.data);
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ conflicts }));
};
// #endregion push-endpoint

// #region events-endpoint
// GET /tasks/events: Server-Sent Events, one message per write.
const events = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(': connected\n\n');
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
};
// #endregion events-endpoint

// #region listen
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/tasks/pull') return pull(url, res);
  if (req.method === 'POST' && url.pathname === '/tasks/push') return push(req, res);
  if (req.method === 'GET' && url.pathname === '/tasks/events') return events(req, res);
  res.writeHead(404).end();
});
server.listen(8400, '127.0.0.1');
// #endregion listen
await new Promise((resolve) => server.once('listening', resolve));
save('t1', { title: 'Plan the sprint', done: false });

// #region client
// client.mjs
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';

const base = 'http://127.0.0.1:8400/tasks';
const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

const replication = replicate(board, {
  name: 'tasks-http',
  collection: 'Task',
  pull: {
    async handler(checkpoint, batchSize) {
      const response = await fetch(`${base}/pull?since=${checkpoint ?? 0}&limit=${batchSize}`);
      if (!response.ok) throw new Error(`pull answered ${response.status}`);
      return response.json(); // { documents, checkpoint }
    },
    // Every Server-Sent Event means "something changed": pull from the checkpoint.
    stream(emit) {
      const controller = new AbortController();
      (async () => {
        const response = await fetch(`${base}/events`, { signal: controller.signal });
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          if (read.value.includes('data:')) emit('RESYNC');
        }
        emit('END'); // the server closed the stream: the connector follows again after a backoff
      })().catch(() => {
        if (!controller.signal.aborted) emit('END');
      });
      return () => controller.abort();
    },
  },
  push: {
    async handler(rows) {
      const response = await fetch(`${base}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      if (!response.ok) throw new Error(`push answered ${response.status}`);
      return (await response.json()).conflicts;
    },
  },
});
await replication.awaitInitialReplication();
// #endregion client
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });

// #region use
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync();
console.log(tasks.get(task.id).data); // { title: 'Write the docs', done: false }: on the server

save('t2', { title: 'Review the PR', done: false }); // another client writes through the server
// ...the events endpoint tells the connector, which pulls it:
// { title: 'Review the PR', done: false, $type: 'Task' }
// #endregion use
assert.deepEqual(tasks.get(task.id).data, { title: 'Write the docs', done: false });
await waitUntil(async () => (await board.Task.get('t2')) !== null);
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR', done: false, $type: 'Task' });

// A deletion goes out as one, and the server keeps it for the next pull.
await board.Task.delete('t1');
await replication.awaitInSync();
assert.equal(tasks.get('t1').data, null);

// Another client changes a task while this node's own edit of it waits: the server refuses the push, the server wins.
await replication.cancel();
const quiet = replicate(board, {
  name: 'tasks-http',
  collection: 'Task',
  live: false,
  pull: {
    handler: (checkpoint, batchSize) =>
      fetch(`${base}/pull?since=${checkpoint ?? 0}&limit=${batchSize}`).then((response) => response.json()),
  },
  push: {
    handler: (rows) =>
      fetch(`${base}/push`, { method: 'POST', body: JSON.stringify({ rows }) })
        .then((response) => response.json())
        .then((body) => body.conflicts),
  },
});
await quiet.awaitInitialReplication();
save('t2', { title: 'Review the PR today', done: false });
await board.Task.update('t2', { done: true });
await quiet.awaitInSync();
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR today', done: false, $type: 'Task' });
assert.deepEqual(tasks.get('t2').data, { title: 'Review the PR today', done: false });
assert.equal(quiet.stats().conflicts, 1);
await quiet.cancel();

await board.close();
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
