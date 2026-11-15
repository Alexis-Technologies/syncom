// RxDB's side of the HTTP page's "Coming from RxDB" code group (docs/guide/replication-http.md), run by
// `pnpm docs:examples:rxdb` against the rxdb of bench/compare. The server outside the region speaks RxDB's shapes:
// documents with their primary key and `_deleted`, push rows with `assumedMasterState` and `newDocumentState`.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';

const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
};
const fieldsOf = (doc) => {
  if (!doc) return null;
  const { _meta, _rev, _attachments, ...rest } = doc;
  return rest;
};
const tasks = new Map();
let changes = 0;
const listeners = new Set();
const save = (doc) => {
  tasks.set(doc.id, { doc, change: ++changes });
  for (const res of listeners) res.write(`data: ${changes}\n\n`);
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/tasks/pull') {
    const since = Number(url.searchParams.get('since') ?? 0);
    const page = [...tasks.values()]
      .filter((task) => task.change > since)
      .sort((a, b) => a.change - b.change)
      .slice(0, Number(url.searchParams.get('limit') ?? 100));
    const checkpoint = { change: page.length > 0 ? page.at(-1).change : since };
    return res.end(JSON.stringify({ documents: page.map((task) => task.doc), checkpoint }));
  }
  if (url.pathname === '/tasks/push') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const conflicts = [];
    for (const { assumedMasterState, newDocumentState } of JSON.parse(body)) {
      const held = tasks.get(newDocumentState.id)?.doc ?? null;
      if (canonical(fieldsOf(held)) !== canonical(fieldsOf(assumedMasterState))) conflicts.push(held);
      else save(fieldsOf(newDocumentState));
    }
    return res.end(JSON.stringify(conflicts));
  }
  if (url.pathname === '/tasks/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': connected\n\n');
    listeners.add(res);
    return req.on('close', () => listeners.delete(res));
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(8401, '127.0.0.1', resolve));
save({ id: 't1', title: 'Plan the sprint', done: false, _deleted: false });

const base = 'http://127.0.0.1:8401/tasks';
const board = await createRxDatabase({ name: 'board', storage: getRxStorageMemory() });
await board.addCollections({
  tasks: {
    schema: {
      version: 0,
      primaryKey: 'id',
      type: 'object',
      properties: { id: { type: 'string', maxLength: 100 }, title: { type: 'string' }, done: { type: 'boolean' } },
      required: ['id'],
    },
  },
});

// #region client
import { Subject } from 'rxjs';
import { replicateRxCollection } from 'rxdb/plugins/replication';

const pullStream$ = new Subject();
const events = new AbortController();
(async () => {
  const response = await fetch(`${base}/events`, { signal: events.signal });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    if (read.value.includes('data:')) pullStream$.next('RESYNC');
  }
})().catch(() => {});

const replication = replicateRxCollection({
  replicationIdentifier: 'tasks-http',
  collection: board.tasks,
  pull: {
    async handler(checkpoint, batchSize) {
      const response = await fetch(`${base}/pull?since=${checkpoint?.change ?? 0}&limit=${batchSize}`);
      return response.json(); // { documents, checkpoint }
    },
    stream$: pullStream$.asObservable(),
  },
  push: {
    async handler(rows) {
      const response = await fetch(`${base}/push`, { method: 'POST', body: JSON.stringify(rows) });
      return response.json(); // the conflicts, as the server holds them
    },
  },
});
await replication.awaitInitialReplication();
// #endregion client

assert.equal((await board.tasks.findOne('t1').exec()).title, 'Plan the sprint');
await board.tasks.insert({ id: 't2', title: 'Write the docs', done: false });
await replication.awaitInSync();
assert.equal(tasks.get('t2').doc.title, 'Write the docs');
save({ id: 't3', title: 'Review the PR', done: false, _deleted: false });
for (let i = 0; i < 200 && (await board.tasks.findOne('t3').exec()) === null; i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal((await board.tasks.findOne('t3').exec()).title, 'Review the PR');
events.abort();
await replication.cancel();
await board.close();
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
