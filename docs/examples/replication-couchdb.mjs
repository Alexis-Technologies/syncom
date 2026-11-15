// The CouchDB page (docs/guide/replication-couchdb.md) shows the regions of this file. The CouchDB here is a stand-in
// in memory behind `fetch` (its `_changes` with a long poll, `_bulk_docs` with the `_rev` check, `GET /<id>`), set as
// the global `fetch` so the regions read as they would against a real server.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const waitUntil = async (check) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil: timed out');
};

const createCouch = (base) => {
  const docs = new Map();
  const feed = [];
  const waiters = new Set();
  const requests = [];
  let revs = 0;
  const json = (status, body) => ({
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const store = (doc) => {
    const held = docs.get(doc._id);
    const saved = { ...structuredClone(doc), _rev: `${(held ? Number(held._rev.split('-')[0]) : 0) + 1}-r${++revs}` };
    docs.set(doc._id, saved);
    feed.push(doc._id);
    for (const wake of [...waiters]) wake();
    return saved;
  };
  const changes = (since, limit) => {
    const results = [];
    for (let seq = since + 1; seq <= feed.length && results.length < limit; seq++) {
      const id = feed[seq - 1];
      if (feed.indexOf(id, seq) !== -1) continue; // one row per document: its newest change
      const doc = docs.get(id);
      results.push({ seq, id, ...(doc._deleted ? { deleted: true } : {}), doc: structuredClone(doc) });
    }
    return { results, last_seq: results.length > 0 ? results.at(-1).seq : since };
  };
  return {
    requests,
    write: (id, data) => store({ _id: id, ...data, _rev: docs.get(id)?._rev }),
    read: (id) => {
      const doc = docs.get(id);
      if (!doc || doc._deleted) return null;
      const { _id, _rev, ...data } = doc;
      return data;
    },
    async fetch(url, init = {}) {
      requests.push({ url, headers: init.headers });
      if (!url.startsWith(base)) return json(404, { error: 'not_found' });
      const [route, query = ''] = url.slice(base.length).split('?');
      const params = new URLSearchParams(query);
      if (route === '/_changes') {
        const since = Number(params.get('since') ?? 0);
        if (params.get('feed') === 'longpoll' && since >= feed.length) {
          await new Promise((resolve) => {
            const wake = () => {
              waiters.delete(wake);
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(wake, 200);
            waiters.add(wake);
            init.signal?.addEventListener('abort', wake, { once: true });
          });
          if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        }
        return json(200, changes(since, Number(params.get('limit') ?? 100)));
      }
      if (route === '/_bulk_docs') {
        const results = [];
        for (const doc of JSON.parse(init.body).docs) {
          if (doc._id.startsWith('_')) {
            results.push({
              id: doc._id,
              error: 'bad_request',
              reason: 'Only reserved document ids may start with underscore.',
            });
          } else if (docs.get(doc._id)?._rev !== doc._rev) {
            results.push({ id: doc._id, error: 'conflict', reason: 'Document update conflict.' });
          } else results.push({ ok: true, id: doc._id, rev: store(doc)._rev });
        }
        return json(201, results);
      }
      const doc = docs.get(decodeURIComponent(route.slice(1)));
      return doc ? json(200, structuredClone(doc)) : json(404, { error: 'not_found', reason: 'missing' });
    },
  };
};

const couch = createCouch('https://couch.example.com/tasks');
globalThis.fetch = couch.fetch;
couch.write('t1', { title: 'Plan the sprint', done: false });

// #region replicate
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';
import { couchdb } from '@alexify/syncom/connector/couchdb';

const board = await createDatabase({ path: 'board', schema: { entities: { Task: {} } } });

const replication = replicate(board, {
  name: 'couch',
  collection: 'Task',
  ...couchdb({ url: 'https://couch.example.com/tasks' }),
});
await replication.awaitInitialReplication();
// #endregion replicate
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint', done: false, $type: 'Task' });

// #region use
const task = await board.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync(); // in CouchDB now, with a _rev of its own

couch.write('t2', { title: 'Review the PR', done: false }); // another client writes to CouchDB
// the long poll answers, and t2 lands here
// #endregion use
assert.deepEqual(couch.read(task.id), { title: 'Write the docs', done: false });
await waitUntil(async () => (await board.Task.get('t2')) !== null);
assert.deepEqual(await board.Task.get('t2'), { title: 'Review the PR', done: false, $type: 'Task' });

// A deletion goes out as a `_deleted` document, and comes in from one.
await board.Task.delete(task.id);
await replication.awaitInSync();
assert.equal(couch.read(task.id), null);
couch.write('t2', { _deleted: true });
await waitUntil(async () => (await board.Task.get('t2')) === null);

// An id CouchDB keeps for itself is refused by name and parked; the rest goes on.
const refused = [];
replication.on('refused', (event) => refused.push(event));
await board.Task.set('_design', { title: 'Not a design document' });
await replication.awaitInSync();
assert.deepEqual(
  refused.map(({ direction, id, reason }) => [direction, id, reason]),
  [['push', '_design', 'bad_request']],
);
await replication.cancel();

// #region credentials
const signedIn = couchdb({ url: 'https://admin:secret@couch.example.com/tasks' });
// the same as couchdb({ url: 'https://couch.example.com/tasks', headers: { authorization: 'Basic YWRtaW46c2VjcmV0' } })
// #endregion credentials
await signedIn.pull.handler(null, 10);
const last = couch.requests.at(-1);
assert.equal(last.url.includes('secret'), false, 'no request url carries the credentials');
assert.equal(last.headers.authorization, `Basic ${btoa('admin:secret')}`);

// A change made in CouchDB while this node's edit of the same task waits: CouchDB refuses the `_rev`, CouchDB wins.
const adapter = couchdb({ url: 'https://couch.example.com/tasks' });
const quiet = replicate(board, { name: 'couch', collection: 'Task', live: false, ...adapter });
await quiet.awaitInitialReplication();
couch.write('t1', { title: 'Plan the sprint on Monday', done: false });
await board.Task.update('t1', { done: true });
await quiet.awaitInSync();
assert.deepEqual(await board.Task.get('t1'), { title: 'Plan the sprint on Monday', done: false, $type: 'Task' });
assert.deepEqual(couch.read('t1'), { title: 'Plan the sprint on Monday', done: false });
assert.equal(quiet.stats().conflicts, 1);
assert.match(adapter.revisionOf('t1'), /^\d+-/);
await quiet.cancel();
await board.close();
