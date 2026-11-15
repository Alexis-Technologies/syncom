// The OneDrive page (docs/guide/replication-onedrive.md) shows the regions of this file. Microsoft Graph here is a
// stand-in in memory behind `fetch`, set as the global `fetch`: files by path with an eTag that moves at every write,
// the routes the adapter calls (`root:/<path>` for the item, `/items/<id>/content`, `PUT root:/<path>:/content` under
// `If-Match` (412 on a stale eTag) or `@microsoft.graph.conflictBehavior=fail` (409 where the file is there)).
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const accessToken = 'a-graph-access-token';

const createGraph = (endpoint) => {
  const files = new Map(); // path → { id, text, eTag }
  let ids = 0;
  let etags = 0;
  const answer = (status, body, text = null) => ({
    ok: status < 300,
    status,
    json: async () => structuredClone(body),
    text: async () => text ?? JSON.stringify(body),
  });
  return {
    files,
    async fetch(target, init = {}) {
      if (init.headers?.authorization !== `Bearer ${accessToken}`) return answer(401, { error: 'unauthenticated' });
      const url = new URL(target);
      const method = init.method ?? 'GET';
      const path = decodeURIComponent(url.pathname.slice(new URL(endpoint).pathname.length));
      const item = /^\/me\/drive\/root:\/(.+?)(:\/content)?$/.exec(path);
      if (item && method === 'GET') {
        const file = files.get(item[1]);
        return file ? answer(200, { id: file.id, eTag: file.eTag }) : answer(404, { error: { code: 'itemNotFound' } });
      }
      if (item && method === 'PUT') {
        const file = files.get(item[1]);
        const ifMatch = init.headers['if-match'];
        if (url.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail' && file) {
          return answer(409, { error: { code: 'nameAlreadyExists' } });
        }
        if (file && ifMatch !== file.eTag) return answer(412, { error: { code: 'resourceModified' } });
        const saved = { id: file?.id ?? `i${++ids}`, text: init.body, eTag: `"e${++etags}"` };
        files.set(item[1], saved);
        return answer(201, { id: saved.id, eTag: saved.eTag });
      }
      const content = /^\/me\/drive\/items\/([^/]+)\/content$/.exec(path);
      const file = content && [...files.values()].find((candidate) => candidate.id === content[1]);
      return file ? answer(200, null, file.text) : answer(404, { error: { code: 'itemNotFound' } });
    },
  };
};

const graph = createGraph('https://graph.microsoft.com/v1.0');
globalThis.fetch = graph.fetch;

// #region replicate
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';
import { onedrive } from '@alexify/syncom/connector/onedrive';

const laptop = await createDatabase({ path: 'laptop', schema: { entities: { Task: {} } } });

// accessToken: a Microsoft Graph token with Files.ReadWrite, from MSAL
const replication = replicate(laptop, {
  name: 'onedrive',
  collection: 'Task',
  ...onedrive({ token: accessToken, path: 'Apps/TaskBoard/tasks.json', poll: 30_000 }),
});
await replication.awaitInitialReplication();
// #endregion replicate

// #region use
const task = await laptop.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync(); // the file is made at the first push, failing if it already exists

const phone = await createDatabase({ path: 'phone', schema: { entities: { Task: {} } } });
const onPhone = replicate(phone, {
  name: 'onedrive',
  collection: 'Task',
  ...onedrive({ token: accessToken, path: 'Apps/TaskBoard/tasks.json', poll: 30_000 }),
});
await onPhone.awaitInitialReplication();
console.log(await phone.Task.get(task.id)); // { title: 'Write the docs', done: false, $type: 'Task' }
// #endregion use
assert.deepEqual(await phone.Task.get(task.id), { title: 'Write the docs', done: false, $type: 'Task' });
const file = JSON.parse(graph.files.get('Apps/TaskBoard/tasks.json').text);
assert.deepEqual(file.docs[task.id], { n: 1, data: { title: 'Write the docs', done: false } });

// Both devices write before either read the other's write: the second PUT's eTag is stale (412), the adapter reads
// the file again and writes both.
await phone.Task.update(task.id, { done: true });
const fromLaptop = await laptop.Task.insert({ title: 'From the laptop', done: false });
await Promise.all([replication.awaitInSync(), onPhone.awaitInSync()]);
await Promise.all([replication.reSync(), onPhone.reSync()]);
assert.deepEqual(await laptop.Task.get(task.id), { title: 'Write the docs', done: true, $type: 'Task' });
assert.deepEqual(await phone.Task.get(fromLaptop.id), { title: 'From the laptop', done: false, $type: 'Task' });

// A change made in the file while this node's edit waits: the file wins.
await replication.cancel();
const quiet = replicate(laptop, {
  name: 'onedrive',
  collection: 'Task',
  live: false,
  ...onedrive({ token: accessToken, path: 'Apps/TaskBoard/tasks.json' }),
});
await quiet.awaitInitialReplication();
await phone.Task.update(task.id, { title: 'Write the docs today' });
await onPhone.awaitInSync();
await laptop.Task.update(task.id, { done: false });
await quiet.awaitInSync();
assert.deepEqual(await laptop.Task.get(task.id), { title: 'Write the docs today', done: true, $type: 'Task' });
assert.equal(quiet.stats().conflicts, 1);

await quiet.cancel();
await onPhone.cancel();
await laptop.close();
await phone.close();
