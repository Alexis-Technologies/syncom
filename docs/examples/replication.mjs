// The Sync engine page (docs/guide/replication.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { settle } from '@alexify/syncom/testing';

// #region nodes
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';
import { MemoryLink } from '@alexify/syncom/testing';

const engine = memoryEngine(); // every node keeps its data in memory
const schema = { entities: { Task: {} } };

// The server hosts: its unit answers the nodes that dial it.
const server = await createDatabase({ engine, path: 'server', schema });
const unit = server.sync.unit({ access: 'public' }); // any connection may say hello

// A node that dials the server. MemoryLink is a test stand-in for the network: an app's
// connect returns createWrpcLink(await WrpcClient.connect(node.url)) instead.
const links = {};
const open = async (name) => {
  const db = await createDatabase({
    engine,
    path: name,
    schema,
    sync: { connect: () => (links[name] = new MemoryLink(unit)) },
  });
  await db.sync.addNode({ url: 'mem://server' });
  await db.sync.awaitInitialReplication(); // the node's first sync with the server
  return db;
};

const laptop = await open('laptop');
const phone = await open('phone');
// #endregion nodes

// #region write
const stop = phone.Task.select({ done: false }).watch((rows) => {
  console.log('phone sees', rows.length, 'open tasks');
});
// phone sees 0 open tasks

const task = await laptop.Task.insert({ title: 'Write the docs', done: false });
await laptop.sync.awaitDocumentPushed(task.id); // the server holds it now
// phone sees 1 open tasks   (the server's feed brought it)
// #endregion write
await settle([server, laptop, phone]);
assert.deepEqual(await phone.Task.get(task.id), { title: 'Write the docs', done: false, $type: 'Task' });
stop();

// #region offline
links.phone.disconnect(); // the phone loses its signal

await phone.Task.update(task.id, { done: true }); // Bob ticks the task off on the train
await phone.inc(task.id, 'votes', 1);
await laptop.Task.update(task.id, { title: 'Write the sync docs' }); // Ada renames it meanwhile
await laptop.inc(task.id, 'votes', 1);
await laptop.sync.awaitDocumentPushed(task.id); // the laptop is online: the server has Ada's edits

await links.phone.reconnect(); // the signal is back
await phone.sync.awaitInSync();
console.log(await phone.Task.get(task.id));
// { title: 'Write the sync docs', done: true, $type: 'Task', votes: 2 }
// #endregion offline
assert.deepEqual(await phone.Task.get(task.id), {
  title: 'Write the sync docs',
  done: true,
  $type: 'Task',
  votes: 2,
});
await settle([server, laptop, phone]);
assert.deepEqual(await laptop.Task.get(task.id), await phone.Task.get(task.id));
assert.deepEqual(await server.Task.get(task.id), await phone.Task.get(task.id));

// #region same-field
links.phone.disconnect();
await phone.Task.update(task.id, { title: 'Docs: sync' });
await new Promise((resolve) => setTimeout(resolve, 5)); // the laptop writes a moment later
await laptop.Task.update(task.id, { title: 'Docs: replication' });
await laptop.sync.awaitDocumentPushed(task.id);
await links.phone.reconnect();
await phone.sync.awaitInSync();
console.log((await phone.Task.get(task.id)).title); // 'Docs: replication': the later write wins on every node
// #endregion same-field
assert.equal((await phone.Task.get(task.id)).title, 'Docs: replication');
await settle([server, laptop, phone]);
assert.equal((await laptop.Task.get(task.id)).title, 'Docs: replication');

// #region events
laptop.sync.on('peer', ({ url, connected, reconnected }) => {
  console.log(url, connected ? (reconnected ? 'back' : 'connected') : 'offline');
});
laptop.sync.on('sync', ({ url, pushed, applied }) => {
  if (pushed !== undefined) console.log('pushed', pushed, 'ops to', url);
  else console.log('applied', applied, 'ops from', url);
});
laptop.sync.on('error', (error) => console.error(error.url, error.code, error.message));
// #endregion events
const seen = [];
laptop.sync.on('peer', (event) => seen.push(event));
links.laptop.disconnect();
await links.laptop.reconnect();
await laptop.sync.awaitInSync();
assert.ok(seen.some((event) => event.connected === false));
assert.ok(seen.some((event) => event.reconnected === true));

// #region control
const url = 'mem://server';
console.log(laptop.sync.peers()[0]);
// { url, node, connected: true, subscribed: true, pending: 0, behind: false, caughtUp: true, … }

await laptop.sync.enableNode(url, false); // keep the server in the registry, but hang up
await laptop.Task.insert({ title: 'Written while paused', done: false });
await laptop.sync.enableNode(url, true); // dial again: the cursor is remembered, nothing is replayed twice
await laptop.sync.awaitInSync();

await laptop.sync.stop(); // close every link (start() dials every enabled node again)
// #endregion control
const [view] = laptop.sync.listNodes();
assert.equal(view.url, url);
assert.equal(view.enabled, true);
await laptop.sync.start();
await settle([server, laptop, phone]);
assert.equal((await phone.Task.select({}).fetch()).length, 2);

await laptop.close();
await phone.close();
await server.close();
