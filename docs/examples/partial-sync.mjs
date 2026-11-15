// The Partial sync page (docs/guide/partial-sync.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { createMesh, memoryEngine, waitUntil } from '@alexify/syncom/testing';

// #region scope
const schema = { entities: { Task: { index: ['board'] } } };

// A record's scope, read from its data. Every node uses the same function.
const scope = (id, data) => data.board ?? '*';
// #endregion scope

// #region authorize
// Which boards each token may claim. hello.scopes is what the node asked for:
// once authorized, it is what that node may read AND write on this host.
const boards = { ada: ['design', 'web'], bob: ['mobile'], reports: ['*'] };
const authorize = (context, hello) => hello.scopes.every((board) => boards[hello.token]?.includes(board));
// #endregion authorize

// #region mesh
// One process stands in for the network: every node is a database with `sync: { scope }`,
// and the server hosts server.sync.unit({ access: 'public', authorize }) at mem://server.
const engine = memoryEngine();
const mesh = await createMesh(['server', 'laptop', 'phone', 'reports', 'tablet'], [], {
  createStorage: (name, options) => createDatabase({ ...options, engine, path: name, schema }),
  sync: { scope },
  unit: { access: 'public', authorize },
});
const [server, laptop, phone, reports, tablet] = mesh.storages.values();
// #endregion mesh

// #region dial
await laptop.sync.addNode({ url: 'mem://server', token: 'ada', scopes: ['design', 'web'] });
await phone.sync.addNode({ url: 'mem://server', token: 'bob', scopes: ['mobile'] });
// #endregion dial
await laptop.sync.awaitInitialReplication();
await phone.sync.awaitInitialReplication();

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
await tablet.sync.addNode({ url: 'mem://server', token: 'bob', scopes: ['design'] });
// 403 Not authorized to sync
// #endregion refused
const refusedHello = await tablet.sync.toPromise('error');
assert.equal(refusedHello.code, 403);
assert.equal(await tablet.Task.count({}), 0);

// #region pull
await reports.sync.addNode({ url: 'mem://server', token: 'reports', direction: 'pull' });
await reports.sync.awaitInitialReplication();
console.log(await reports.Task.count({})); // 4: every board, and nothing of its own goes back
// #endregion pull
assert.equal(await reports.Task.count({}), 4);
const local = await reports.Task.insert({ title: 'A note that stays here', done: false });
await reports.sync.awaitInSync();
assert.equal(await server.Task.get(local.id), null);

// #region revoke
laptop.sync.on('error', (error) => {
  if (error.code === 'REVOKED') console.log('lost', error.scopes); // lost [ 'design' ]
});
server.sync.revoke(laptop.nodeId, ['design']); // Ada left the design team
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

await mesh.close();
