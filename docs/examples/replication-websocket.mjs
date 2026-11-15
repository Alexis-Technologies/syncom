// The WebSocket page (docs/guide/replication-websocket.md) shows the regions of this file. Its server listens on
// port 8203. tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { settle, waitUntil } from '@alexify/syncom/testing';

const schema = { entities: { Task: { index: ['done'] } } };

// #region host
import { Server, defineRouter } from '@alexify/wrpc';

const server = await createDatabase({ path: 'server', schema });
const router = defineRouter({ syncom: server.sync.unit({ access: 'public', query: true }) });
let http = new Server({ router, host: '127.0.0.1', port: 8203, protocol: 'http' });
await http.listen();
// #endregion host

// #region link
import { WrpcClient } from '@alexify/wrpc';
import { createWrpcLink } from '@alexify/syncom/wrpc';

const laptop = await createDatabase({
  path: 'laptop',
  schema,
  sync: {
    // One client per dial: wrpc reconnects it, backs off, and resumes the feed.
    connect: async (node) =>
      createWrpcLink(await WrpcClient.connect(node.url, { reconnect: { minDelay: 250, maxDelay: 10_000 } })),
  },
});
await laptop.sync.addNode({ url: 'ws://127.0.0.1:8203/api' });
await laptop.sync.awaitInitialReplication();
// #endregion link
const first = await server.Task.insert({ title: 'Before the restart', done: false });
await settle([server, laptop], { timeout: 10_000 });
assert.notEqual(await laptop.Task.get(first.id), null);

// #region restart
const events = [];
laptop.sync.on('peer', ({ connected, reconnected }) => events.push({ connected, reconnected }));
laptop.sync.on('bootstrap', () => events.push({ bootstrap: true }));

await http.close(); // the server goes down for a deploy
await waitUntil(() => laptop.sync.peers()[0].connected === false);
const offline = await laptop.Task.insert({ title: 'Written while the server was down', done: false });

http = new Server({ router, host: '127.0.0.1', port: 8203, protocol: 'http' });
await http.listen(); // back on the same address: wrpc reconnects by itself
await waitUntil(() => laptop.sync.peers()[0].connected && laptop.sync.peers()[0].subscribed);
await laptop.sync.awaitInSync();
// events: { connected: false }, { connected: true, reconnected: true }, … and no bootstrap
// #endregion restart
await settle([server, laptop], { timeout: 15_000 });
assert.deepEqual(await server.Task.get(offline.id), {
  title: 'Written while the server was down',
  done: false,
  $type: 'Task',
});
assert.ok(events.some((event) => event.connected === false));
assert.ok(events.some((event) => event.reconnected === true));
assert.ok(!events.some((event) => event.bootstrap), 'resumed from the cursor');

// #region sse
import '@alexify/wrpc/sse'; // registers the client's 'sse' transport

const kiosk = await createDatabase({
  path: 'kiosk',
  schema,
  sync: {
    connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url, { transport: 'sse' })),
  },
});
await kiosk.sync.addNode({ url: 'http://127.0.0.1:8203/api' }); // the same server, its HTTP side
await kiosk.sync.awaitInitialReplication();
// #endregion sse
await waitUntil(async () => (await kiosk.Task.count({})) === 2, { timeout: 10_000 });
const fromKiosk = await kiosk.Task.insert({ title: 'Written over SSE', done: false });
await waitUntil(() => server.hasRecord(fromKiosk.id), { timeout: 10_000 });

// #region thin
// A script that keeps no database: one HTTP request per call, the hello carried in it.
const client = await WrpcClient.connect('http://127.0.0.1:8203/api', { transport: 'http' });
const hello = { node: 'nightly-report' };
const { rows } = await client.call('syncom/query', {
  hello,
  entity: 'Task',
  query: { done: false },
  order: ['title'],
  limit: 50,
});
const { count } = await client.call('syncom/count', { hello, entity: 'Task', query: { done: false } });
console.log(
  count,
  rows.map((row) => row.title),
);
// 3 [ 'Before the restart', 'Written over SSE', 'Written while the server was down' ]
// #endregion thin
assert.equal(count, 3);
assert.deepEqual(
  rows.map((row) => row.title),
  ['Before the restart', 'Written over SSE', 'Written while the server was down'],
);
client.close();

await kiosk.close();
await laptop.close();
await server.close();
await http.close();
