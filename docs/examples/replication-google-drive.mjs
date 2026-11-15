// The Google Drive page (docs/guide/replication-google-drive.md) shows the regions of this file. The Drive here is a
// stand-in in memory behind `fetch`, set as the global `fetch`: files with an id, a name, a creation order and an ETag
// that moves at every write, the routes the adapter calls (`files.list` by name, the v2 metadata for the ETag,
// `alt=media`, `files.create`, `files.delete`, the media upload under `If-Match`, 412 on a stale ETag).
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';

const accessToken = 'an-oauth-access-token';

const createDrive = (endpoint) => {
  const files = new Map();
  let ids = 0;
  let etags = 0;
  const answer = (status, body, { text = null, etag = null } = {}) => ({
    ok: status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
    json: async () => structuredClone(body),
    text: async () => text ?? JSON.stringify(body),
  });
  const byName = (name) => [...files.values()].filter((file) => file.name === name);
  return {
    files,
    file: (name) => byName(name)[0],
    async fetch(target, init = {}) {
      const url = new URL(target);
      const method = init.method ?? 'GET';
      if (init.headers?.authorization !== `Bearer ${accessToken}`) return answer(401, { error: 'unauthenticated' });
      if (!target.startsWith(endpoint)) return answer(404, {});
      if (url.pathname === '/drive/v3/files' && method === 'GET') {
        const name = /name = '((?:\\.|[^'])*)'/.exec(url.searchParams.get('q'))[1];
        return answer(200, { files: byName(name).map(({ id }) => ({ id })) }); // oldest first (orderBy=createdTime)
      }
      if (url.pathname === '/drive/v3/files' && method === 'POST') {
        const { name } = JSON.parse(init.body);
        const file = { id: `f${++ids}`, name, text: '', etag: `"e${++etags}"` };
        files.set(file.id, file);
        return answer(200, { id: file.id });
      }
      const [, kind, id] = /^\/(?:upload\/)?drive\/(v2|v3)\/files\/([^/]+)$/.exec(url.pathname) ?? [];
      const file = files.get(id);
      if (!file) return answer(404, { error: 'notFound' });
      if (kind === 'v2') return answer(200, { id, etag: file.etag });
      if (method === 'GET') return answer(200, null, { text: file.text });
      if (method === 'DELETE') return files.delete(id) && answer(204, null, { text: '' });
      if (init.headers['if-match'] !== file.etag) return answer(412, { error: 'conditionNotMet' });
      Object.assign(file, { text: init.body, etag: `"e${++etags}"` });
      return answer(200, { id }, { etag: file.etag });
    },
  };
};

const drive = createDrive('https://www.googleapis.com');
globalThis.fetch = drive.fetch;

// #region replicate
import { createDatabase } from '@alexify/syncom/all';
import { replicate } from '@alexify/syncom/connector';
import { gdrive } from '@alexify/syncom/connector/gdrive';

const laptop = await createDatabase({ path: 'laptop', schema: { entities: { Task: {} } } });

// accessToken: an OAuth token with the drive.appdata scope, from Google Identity Services
const replication = replicate(laptop, {
  name: 'drive',
  collection: 'Task',
  ...gdrive({ token: accessToken, name: 'tasks.json', poll: 30_000 }),
});
await replication.awaitInitialReplication();
// #endregion replicate

// #region use
const task = await laptop.Task.insert({ title: 'Write the docs', done: false });
await replication.awaitInSync(); // the file is made at the first push

console.log(JSON.parse(drive.file('tasks.json').text));
// { seq: 1, docs: { '…': { n: 1, data: { title: 'Write the docs', done: false } } } }
// #endregion use
const file = JSON.parse(drive.file('tasks.json').text);
assert.deepEqual(file, { seq: 1, docs: { [task.id]: { n: 1, data: { title: 'Write the docs', done: false } } } });

// #region devices
// The phone replicates the same file; its first pull reads what the laptop wrote.
const phone = await createDatabase({ path: 'phone', schema: { entities: { Task: {} } } });
const onPhone = replicate(phone, {
  name: 'drive',
  collection: 'Task',
  ...gdrive({ token: accessToken, name: 'tasks.json', poll: 30_000 }),
});
await onPhone.awaitInitialReplication();
await phone.Task.update(task.id, { done: true });
await onPhone.awaitInSync(); // written under the file's ETag

await replication.reSync(); // or wait for the next probe of the ETag
console.log(await laptop.Task.get(task.id)); // { title: 'Write the docs', done: true, $type: 'Task' }
// #endregion devices
assert.deepEqual(await laptop.Task.get(task.id), { title: 'Write the docs', done: true, $type: 'Task' });

// Both devices write before either has read the other's write: the second upload's ETag is stale (412), the adapter
// reads the file again and writes both.
const fromLaptop = await laptop.Task.insert({ title: 'From the laptop', done: false });
const fromPhone = await phone.Task.insert({ title: 'From the phone', done: false });
await Promise.all([replication.awaitInSync(), onPhone.awaitInSync()]);
const both = JSON.parse(drive.file('tasks.json').text);
assert.ok(both.docs[fromLaptop.id] && both.docs[fromPhone.id], 'one file holds both writes');
await Promise.all([replication.reSync(), onPhone.reSync()]);
assert.deepEqual(await laptop.Task.get(fromPhone.id), { title: 'From the phone', done: false, $type: 'Task' });
assert.deepEqual(await phone.Task.get(fromLaptop.id), { title: 'From the laptop', done: false, $type: 'Task' });

// Two devices that start on an empty drive at the same time each make a file; the oldest wins and holds both. A
// device that read the drive before the file existed and pushes after the other made it reads that file and writes
// into it at once (a 412 inside the adapter): no error, no wait for its next pull.
const store = createDrive('https://www.googleapis.com');
globalThis.fetch = store.fetch;
const a = await createDatabase({ path: 'a', schema: { entities: { Task: {} } } });
const b = await createDatabase({ path: 'b', schema: { entities: { Task: {} } } });
const fresh = () => gdrive({ token: accessToken, name: 'tasks.json' });
const ra = replicate(a, { name: 'drive', collection: 'Task', ...fresh() });
const rb = replicate(b, { name: 'drive', collection: 'Task', ...fresh() });
const failures = [];
for (const r of [ra, rb]) r.on('error', (error) => failures.push(error));
await Promise.all([ra.awaitInitialReplication(), rb.awaitInitialReplication()]);
const [ta, tb] = await Promise.all([
  a.Task.insert({ title: 'A', done: false }),
  b.Task.insert({ title: 'B', done: false }),
]);
await Promise.all([ra.awaitInSync(), rb.awaitInSync()]);
assert.equal(store.files.size, 1, 'one collection file');
const one = JSON.parse([...store.files.values()][0].text);
assert.ok(one.docs[ta.id] && one.docs[tb.id]);
assert.deepEqual(failures, [], 'no push refused on the way');

// A device whose last read found no file pushes after the other made it: the file is read, the row written into it.
const late = await createDatabase({ path: 'late', schema: { entities: { Task: {} } } });
const elsewhere = createDrive('https://www.googleapis.com');
globalThis.fetch = elsewhere.fetch;
const rl = replicate(late, { name: 'drive', collection: 'Task', live: false, ...fresh() });
rl.on('error', (error) => failures.push(error));
await rl.awaitInitialReplication(); // no file yet
const made = await createDatabase({ path: 'made', schema: { entities: { Task: {} } } });
const rm = replicate(made, { name: 'drive', collection: 'Task', live: false, ...fresh() });
await rm.awaitInitialReplication();
await made.Task.insert({ title: 'Made the file', done: false });
await rm.awaitInSync();
const fromLate = await late.Task.insert({ title: 'Late', done: false });
await rl.awaitInSync();
assert.ok(JSON.parse(elsewhere.file('tasks.json').text).docs[fromLate.id], 'into the file the other device made');
assert.deepEqual(failures, []);

for (const r of [replication, onPhone, ra, rb, rl, rm]) await r.cancel();
for (const db of [laptop, phone, a, b, late, made]) await db.close();
