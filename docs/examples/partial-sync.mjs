// The Partial sync page (docs/guide/partial-sync.md) shows the regions of this file. Its server listens on port 8218.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { waitUntil } from '@alexify/syncom/testing';

// #region scope
const schema = { entities: { Task: { index: ['board'] } } };

// A record's scope, read from its data. Every node uses the same function.
const scope = (id, data) => data.board ?? '*';
// #endregion scope

// #region authorize
// Which boards each token may claim. hello.scopes is what the node asked for:
// once authorized, it is what that node may read AND write on this host.
const boards = { ada: ['design', 'web'], bob: ['mobile'], reports: ['*'] };
const tokenOf = new Map(); // node id → token: which nodes are whose, to revoke them later

const authorize = (context, hello) => {
  if (!hello.scopes.every((board) => boards[hello.token]?.includes(board))) return false;
  tokenOf.set(hello.node, hello.token);
  return true;
};
// #endregion authorize

// #region nodes
import { createDatabase } from '@alexify/syncom/all';
import { createWrpcLink } from '@alexify/syncom/wrpc';
import { Server, WrpcClient, defineRouter } from '@alexify/wrpc';

// The server hosts its unit on a wrpc server, with the authorize above.
const server = await createDatabase({ path: 'server', schema, sync: { scope } });
const router = defineRouter({ syncom: server.sync.unit({ access: 'public', authorize }) });
const http = new Server({ router, host: '127.0.0.1', port: 8218, protocol: 'http' });
await http.listen();

// Every node scopes records with the same function, and dials over a wrpc client.
const open = (name) =>
  createDatabase({
    path: name,
    schema,
    sync: { scope, connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
  });
const laptop = await open('laptop');
const phone = await open('phone');
const reports = await open('reports');
const tablet = await open('tablet');
const url = 'ws://127.0.0.1:8218/api'; // the server's endpoint, as the nodes dial it
// #endregion nodes

// #region dial
await laptop.sync.addNode({ url, token: 'ada', scopes: ['design', 'web'] });
await phone.sync.addNode({ url, token: 'bob', scopes: ['mobile'] });
await laptop.sync.awaitInitialReplication();
await phone.sync.awaitInitialReplication();
// #endregion dial

// #region boards
const logo = await server.Task.insert({ title: 'Draw the logo', board: 'design', done: false });
const landing = await server.Task.insert({ title: 'Ship the landing page', board: 'web', done: false });
const login = await server.Task.insert({ title: 'Fix the login screen', board: 'mobile', done: false });
const retro = await server.Task.insert({ title: 'Book the retro', done: false }); // no board: global
// #endregion boards
await waitUntil(async () => (await laptop.Task.get(retro.id)) !== null && (await phone.Task.get(retro.id)) !== null);

// #region read
console.log((await laptop.Task.select({}).order('title').fetch()).map((task) => task.title));
// [ 'Book the retro', 'Draw the logo', 'Ship the landing page' ]
console.log((await phone.Task.select({}).order('title').fetch()).map((task) => task.title));
// [ 'Book the retro', 'Fix the login screen' ]
// #endregion read
assert.deepEqual(
  (await laptop.Task.select({}).order('title').fetch()).map((task) => task.title),
  ['Book the retro', 'Draw the logo', 'Ship the landing page'],
);
assert.deepEqual(
  (await phone.Task.select({}).order('title').fetch()).map((task) => task.title),
  ['Book the retro', 'Fix the login screen'],
);
assert.equal(await laptop.Task.get(login.id), null);

// #region refused
tablet.sync.on('error', (error) => console.log(error.code, error.message));
await tablet.sync.addNode({ url, token: 'bob', scopes: ['design'] });
// 403 Not authorized to sync
// #endregion refused
const refusedHello = await tablet.sync.toPromise('error');
assert.equal(refusedHello.code, 403);
assert.equal(await tablet.Task.count({}), 0);

// #region pull
await reports.sync.addNode({ url, token: 'reports', direction: 'pull' });
await reports.sync.awaitInitialReplication();
console.log(await reports.Task.count({})); // 4: every board, and nothing of its own goes back
// #endregion pull
assert.equal(await reports.Task.count({}), 4);
const local = await reports.Task.insert({ title: 'A note that stays here', done: false });
await reports.sync.awaitInSync();
assert.equal(await server.Task.get(local.id), null);

// #region revoke
// On the laptop: the host's word arrives as an error event.
laptop.sync.on('error', (error) => {
  if (error.code === 'REVOKED') console.log('lost', error.scopes); // lost [ 'design' ]
});

// On the server: Ada left the design team, so every node she signed in from loses the scope.
for (const [node, token] of tokenOf) if (token === 'ada') server.sync.revoke(node, ['design']);
// #endregion revoke
await waitUntil(async () => (await laptop.Task.get(logo.id)) === null);

// #region forgotten
console.log(await laptop.Task.get(logo.id)); // null: forgotten here, still on the server
console.log(laptop.sync.listNodes()[0].scopes); // [ 'web' ]
// #endregion forgotten
assert.equal(await laptop.Task.get(logo.id), null);
assert.notEqual(await server.Task.get(logo.id), null);
assert.deepEqual(laptop.sync.listNodes()[0].scopes, ['web']);
assert.equal((await laptop.Task.get(landing.id)).title, 'Ship the landing page');
// The feed is open again under what is left: a new web task still arrives.
const lateLogo = await server.Task.insert({ title: 'Redraw the logo', board: 'design', done: false });
const later = await server.Task.insert({ title: 'Write the web copy', board: 'web', done: false });
await waitUntil(async () => (await laptop.Task.get(later.id)) !== null);
assert.equal(await laptop.Task.get(lateLogo.id), null);
assert.deepEqual(await laptop.Task.get(retro.id), { title: 'Book the retro', done: false, $type: 'Task' });

await tablet.close();
await reports.close();
await phone.close();
await laptop.close();
await server.close();
await http.close();
