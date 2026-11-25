// The Hooks and events page (docs/guide/hooks.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { Server, defineRouter, WrpcClient } from '@alexify/wrpc';
import { createWrpcLink } from '@alexify/syncom/wrpc';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const schema = { entities: { Task: { index: ['done'] } } };

// #region before-write
import { createDatabase, HookError } from '@alexify/syncom/all';

const board = await createDatabase({
  path: 'board',
  schema: { entities: { Task: { index: ['done'] } } },
  hooks: {
    beforeWrite: ({ type, data, current }) => {
      // Only whole writes and updates carry fields; a counter, a set or a delete passes as it is.
      if (type !== 'write' && type !== 'set') return;
      const next = { ...current, ...data };
      if (typeof next.title !== 'string' || next.title === '') throw new Error('a task needs a title');
      // A plain object replaces the fields the write carries.
      return { ...data, updatedAt: Date.now() };
    },
  },
});

const task = await board.Task.insert({ title: 'Write the docs', done: false });
console.log(await board.Task.get(task.id));
// { title: 'Write the docs', done: false, $type: 'Task', updatedAt: 1763200000000 }
// #endregion before-write
const stamped = await board.Task.get(task.id);
assert.equal(typeof stamped.updatedAt, 'number');
assert.equal(stamped.title, 'Write the docs');

// #region hook-error
try {
  await board.Task.insert({ done: false });
} catch (error) {
  console.log(error instanceof HookError); // true
  console.log(error.code, error.hook); // 'ALX_ERR_HOOK_FAILED' 'beforeWrite'
  console.log(error.cause.message); // 'a task needs a title'
}
// #endregion hook-error
await assert.rejects(board.Task.insert({ done: false }), (error) => {
  assert.ok(error instanceof HookError);
  assert.equal(error.code, 'ALX_ERR_HOOK_FAILED');
  assert.equal(error.hook, 'beforeWrite');
  assert.equal(error.cause.message, 'a task needs a title');
  return true;
});
assert.equal((await board.Task.select({}).fetch()).length, 1);

// #region events
// A listener watches; it cannot change or refuse the write it hears about.
board.on('change', (op, via) => {
  console.log(op.type, op.id, via === null ? 'made here' : `from ${via.node}`);
});
board.Task.on('insert', ({ id }) => console.log('new task', id));
const stopTitle = board.observe(task.id, 'title', (changes) => console.log('title:', changes));

await board.Task.update(task.id, { title: 'Write the guide' });
// set <id> made here
// title: [ { id: <id>, action: 'put', field: 'title', value: 'Write the guide' } ]
// #endregion events
const heard = [];
const off = (op, via) => heard.push([op.type, via]);
board.on('change', off);
const inserts = [];
board.Task.on('insert', ({ id }) => inserts.push(id));
const titles = [];
const stopTitles = board.observe(task.id, 'title', (changes) => titles.push(changes));
await board.Task.update(task.id, { title: 'Write the guide, again' });
const second = await board.Task.insert({ title: 'Ship it', done: false });
await tick();
assert.deepEqual(heard, [
  ['set', null],
  ['write', null],
]);
assert.deepEqual(inserts, [second.id]);
assert.equal(titles.length, 1);
assert.equal(titles[0][0].value, 'Write the guide, again');
stopTitle();
stopTitles();
board.off('change', off);
await board.close();

// #region after-read
const people = await createDatabase({
  path: 'people',
  schema: { entities: { Person: {} } },
  hooks: {
    afterRead: (context, data) => {
      if (data === null || data.email === undefined) return; // undefined keeps what was read
      return { ...data, email: '***' };
    },
  },
});

const ada = await people.Person.insert({ name: 'Ada', email: 'ada@example.com' });
console.log((await people.Person.get(ada.id)).email); // '***'
console.log((await people.Person.select({}).fetch())[0].email); // 'ada@example.com': a query reads the record raw
// #endregion after-read
assert.equal((await people.Person.get(ada.id)).email, '***');
assert.equal((await ada.data()).email, '***');
assert.equal((await people.Person.select({}).fetch())[0].email, 'ada@example.com');
await people.close();

// #region before-apply
// archive.mjs: a node that keeps every task, even the ones deleted elsewhere
const archive = await createDatabase({
  path: 'archive',
  schema,
  hooks: {
    // false skips the op here: it is still logged and relayed, so peers behind this node get it.
    beforeApply: ({ op }) => op.type !== 'delete',
  },
});
const router = defineRouter({ syncom: archive.sync.unit({ access: 'public' }) });
const server = new Server({ router, host: '127.0.0.1', port: 8800, protocol: 'http' });
await server.listen();
// #endregion before-apply

// #region sync-hooks
const trustedHosts = new Set([archive.nodeId]);
const laptop = await createDatabase({
  path: 'laptop',
  schema,
  sync: {
    connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)),
    hooks: {
      // Dial only over TLS, except to this machine.
      beforeConnect: (node) => node.url.startsWith('wss://') || node.url.startsWith('ws://127.0.0.1'),
      // Refuse to replace this node's state with a whole snapshot from a host it does not know.
      beforeBootstrap: ({ node }) => trustedHosts.has(node),
    },
  },
});
// #endregion sync-hooks

await laptop.sync.addNode({ url: 'ws://127.0.0.1:8800/api' });
const old = await laptop.Task.insert({ title: 'An old task', done: true });
await laptop.sync.awaitInSync();
await tick();
assert.equal((await archive.Task.get(old.id)).title, 'An old task');

// #region skipped
await laptop.Task.delete(old.id);
await laptop.sync.awaitInSync();

console.log(await laptop.Task.get(old.id)); // null
console.log(await archive.Task.get(old.id)); // { title: 'An old task', done: true, $type: 'Task' }
// #endregion skipped
await tick();
assert.equal(await laptop.Task.get(old.id), null);
assert.deepEqual(await archive.Task.get(old.id), { title: 'An old task', done: true, $type: 'Task' });

await laptop.close();
await archive.close();
await server.close();
