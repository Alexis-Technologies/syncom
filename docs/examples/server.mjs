// The Hosting a node page (docs/guide/server.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { Server, defineRouter, WrpcClient } from '@alexify/wrpc';
import { createWrpcLink } from '@alexify/syncom/wrpc';

const wait = async (check) => {
  for (let i = 0; i < 250 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(await check());
};

// #region open
import { createDatabase } from '@alexify/syncom/all';

const server = await createDatabase({
  path: 'server',
  schema: { entities: { Task: { index: ['done'] } } },
});
// #endregion open

// #region authorize
// One token per device, issued by your own sign-in flow.
const devices = new Map([
  ['laptop-secret', 'ada'],
  ['reports-secret', 'reports'],
]);
const authorize = (context, hello) => devices.has(hello.token);
// #endregion authorize

// #region rules
// Clients add and edit tasks; only the server deletes them.
const authorizeWrite = ({ op }) => op.type !== 'delete';
// #endregion rules

// #region limits
const limits = { opsPerPush: 500, bytesPerPush: 1 << 20, opsPerSecond: 200 };
// #endregion limits

// #region mount
const router = defineRouter({
  syncom: server.sync.unit({ access: 'public', authorize, authorizeWrite, limits, query: true }),
});
const http = new Server({ router, host: '127.0.0.1', port: 8300, protocol: 'http' });
await http.listen();
// #endregion mount

const hellos = [];
const refusals = [];
// #region observe
server.sync.on('hello', ({ node, scopes }) => hellos.push({ node, scopes }));
server.sync.on('refused', ({ node, reason, count }) => refusals.push({ node, reason, count }));
// #endregion observe

// #region dial
const laptop = await createDatabase({
  path: 'laptop',
  schema: { entities: { Task: { index: ['done'] } } },
  sync: {
    connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)),
  },
});
await laptop.sync.addNode({ url: 'ws://127.0.0.1:8300/api', token: 'laptop-secret' });
await laptop.sync.awaitInSync();
// #endregion dial
assert.equal(hellos.length, 1);
assert.equal(hellos[0].node, laptop.nodeId);
assert.deepEqual(hellos[0].scopes, ['*']);

// A device without a valid token is refused at hello.
const stranger = await createDatabase({
  path: 'stranger',
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
const strangerErrors = [];
stranger.sync.on('error', (error) => strangerErrors.push(error));
await stranger.sync.addNode({ url: 'ws://127.0.0.1:8300/api', token: 'guess' });
await wait(() => strangerErrors.length > 0);
assert.equal(strangerErrors[0].code, 403);
assert.equal(stranger.sync.peers()[0].lastError.code, 403);
await stranger.close();

const task = await server.Task.insert({ title: 'Review the release notes', done: false });
await wait(async () => (await laptop.Task.get(task.id)) !== null);
assert.equal((await laptop.Task.get(task.id)).title, 'Review the release notes');

// #region refused
laptop.sync.on('error', (error) => {
  if (error.code === 'ALX_ERR_WRITE_REFUSED') console.log(`${error.id}: the server kept it`);
});
await laptop.Task.delete(task.id);
// ...a moment later, once the server answered the push:
// <id>: the server kept it
// #endregion refused
const refused = await laptop.sync.toPromise('error');
assert.equal(refused.code, 'ALX_ERR_WRITE_REFUSED');
assert.equal(refused.id, task.id);
await wait(async () => (await laptop.Task.get(task.id)) !== null);
assert.equal((await laptop.Task.get(task.id)).title, 'Review the release notes');
assert.equal((await server.Task.get(task.id)).title, 'Review the release notes');
assert.ok(refusals.some((event) => event.reason === 'rule' && event.node === laptop.nodeId));

// An update passes the rule and lands on the server.
await laptop.Task.update(task.id, { done: true });
await laptop.sync.awaitInSync();
await wait(async () => (await server.Task.get(task.id)).done === true);
assert.equal((await server.Task.get(task.id)).done, true);

await server.Task.insert({ title: 'Plan the sprint', done: false });

// #region thin
// reports.mjs: a script that keeps no database of its own
const client = await WrpcClient.connect('http://127.0.0.1:8300/api', { transport: 'http' });
const hello = { node: 'reports-1', token: 'reports-secret' };
const { rows } = await client.call('syncom/query', {
  hello,
  entity: 'Task',
  query: { done: false },
  order: ['title'],
  limit: 50,
});
const { count } = await client.call('syncom/count', { hello, entity: 'Task', query: { done: true } });
console.log(
  rows.map((row) => row.title),
  count,
); // [ 'Plan the sprint' ] 1
// #endregion thin
assert.deepEqual(
  rows.map((row) => row.title),
  ['Plan the sprint'],
);
assert.equal(count, 1);
await assert.rejects(
  () => client.call('syncom/query', { hello: { node: 'x', token: 'nope' }, entity: 'Task' }),
  (error) => error.code === 403,
);
await assert.rejects(
  () => client.call('syncom/query', { hello, entity: 'Task', query: { title: { $regex: '^Plan' } } }),
  (error) => error.code === 400,
);
client.close();

// #region mirror
// A read-only mirror: peers read its feed and snapshots, and every push is refused (403).
const mirror = server.sync.unit({ access: 'public', authorize, allow: { push: false } });
// #endregion mirror
assert.equal(typeof mirror.push.handler, 'function');

// #region hook
// A bucket per client and per procedure; the limit rides on the unit's procedures.
const buckets = new WeakMap();
const rateLimit = (context) => {
  const config = context.procedure.meta?.rateLimit;
  if (!config) return;
  let perClient = buckets.get(context.client);
  if (!perClient) buckets.set(context.client, (perClient = new Map()));
  let bucket = perClient.get(context.procedure);
  const now = Date.now();
  if (!bucket || now - bucket.start >= config.windowMs) {
    perClient.set(context.procedure, (bucket = { start: now, used: 0 }));
  }
  if (++bucket.used > config.limit) {
    const error = new Error('Rate limit exceeded');
    error.code = 429;
    error.expose = true;
    throw error;
  }
};

const limited = defineRouter(
  {
    syncom: server.sync.unit({
      access: 'public',
      authorize,
      meta: { rateLimit: { limit: 200, windowMs: 1000 } },
    }),
  },
  { hooks: { onRequest: rateLimit } },
);
// #endregion hook
assert.ok(limited);
const fakeClient = {};
const fakeProcedure = { meta: { rateLimit: { limit: 2, windowMs: 1000 } } };
rateLimit({ client: fakeClient, procedure: fakeProcedure });
rateLimit({ client: fakeClient, procedure: fakeProcedure });
assert.throws(() => rateLimit({ client: fakeClient, procedure: fakeProcedure }), { code: 429 });

const hosted = server.sync.hosted();
assert.equal(hosted.length, 1);
assert.equal(hosted[0].node, laptop.nodeId);

await laptop.close();
await http.close();
await server.close();
