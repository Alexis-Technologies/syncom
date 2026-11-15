// The syncom server replication page (docs/guide/replication-server.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { settle, waitUntil } from '@alexify/syncom/testing';

process.env.SYNC_TOKEN = 'board-secret';
const schema = { entities: { Task: { index: ['done'] } } };

// #region host
// server.mjs
import { Server, defineRouter } from '@alexify/wrpc';
import { createDatabase } from '@alexify/syncom/all';

const server = await createDatabase({ path: 'server', schema });

const router = defineRouter({
  syncom: server.sync.unit({
    access: 'public',
    authorize: (context, hello) => hello.token === process.env.SYNC_TOKEN,
    // Devices may edit tasks but not delete them: the server's own code does that.
    authorizeWrite: ({ op }) => op.type !== 'delete',
  }),
});
const http = new Server({ router, host: '127.0.0.1', port: 8200, protocol: 'http' });
await http.listen();
// #endregion host

// #region dial
// laptop.mjs
import { WrpcClient } from '@alexify/wrpc';
import { createWrpcLink } from '@alexify/syncom/wrpc';

const laptop = await createDatabase({
  path: 'laptop',
  schema,
  sync: {
    connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)),
  },
});
if (laptop.sync.listNodes().length === 0) {
  await laptop.sync.addNode({ url: 'ws://127.0.0.1:8200/api', token: process.env.SYNC_TOKEN });
}
await laptop.sync.awaitInitialReplication();
// #endregion dial

// #region both-ways
const fromLaptop = await laptop.Task.insert({ title: 'Written on the laptop', done: false });
const fromServer = await server.Task.insert({ title: 'Written on the server', done: false });
await laptop.sync.awaitDocumentPushed(fromLaptop.id);
// #endregion both-ways
await settle([server, laptop], { timeout: 10_000 });
assert.deepEqual(await server.Task.get(fromLaptop.id), { title: 'Written on the laptop', done: false, $type: 'Task' });
assert.deepEqual(await laptop.Task.get(fromServer.id), { title: 'Written on the server', done: false, $type: 'Task' });

// #region write-rule
laptop.sync.on('error', (error) => {
  if (error.code === 'WRITE_REFUSED') console.log(error.message);
  // ws://127.0.0.1:8200/api refused <op> on <id>; reverted to what it holds
});
await laptop.Task.delete(fromServer.id);
// #endregion write-rule
const refusedWrite = await laptop.sync.toPromise('error');
assert.equal(refusedWrite.code, 'WRITE_REFUSED');
await waitUntil(async () => (await laptop.Task.get(fromServer.id)) !== null);
assert.deepEqual(await laptop.Task.get(fromServer.id), { title: 'Written on the server', done: false, $type: 'Task' });
assert.notEqual(await server.Task.get(fromServer.id), null);

// #region refused
const stranger = await createDatabase({
  path: 'stranger',
  schema,
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
stranger.sync.on('error', (error) => console.log(error.code, error.message)); // 403 Not authorized to sync
await stranger.sync.addNode({ url: 'ws://127.0.0.1:8200/api', token: 'guess' });
// #endregion refused
const refused = await stranger.sync.toPromise('error');
assert.equal(refused.code, 403);
await waitUntil(() => stranger.sync.peers()[0]?.lastError?.code === 403);
assert.equal(await stranger.Task.get(fromServer.id), null);
await stranger.close();

// #region hello-event
server.sync.on('hello', ({ node, scopes }) => console.log('greeted', node, 'for', scopes));
console.log(server.sync.hosted()); // [ { node: <the laptop's id>, scopes: [ '*' ], since: …, cursor: … } ]
// #endregion hello-event
assert.equal(server.sync.hosted().length, 1);
assert.equal(server.sync.hosted()[0].node, laptop.nodeId);

// #region restart
await laptop.close();
const again = await createDatabase({
  path: 'laptop',
  schema,
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
console.log(again.sync.listNodes().map((node) => node.url)); // [ 'ws://127.0.0.1:8200/api' ]: kept on disk
// #endregion restart
assert.deepEqual(
  again.sync.listNodes().map((node) => node.url),
  ['ws://127.0.0.1:8200/api'],
);
await again.sync.awaitInitialReplication();
assert.notEqual(await again.Task.get(fromServer.id), null);

await again.close();
await server.close();
await http.close();
