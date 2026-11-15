// The Sync engine page (docs/guide/replication.md) shows the regions of this file: a node that comes back after
// the host compacted its log, and a brand-new node, both bootstrap from a snapshot.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { MemoryLink, memoryEngine, settle } from '@alexify/syncom/testing';

const engine = memoryEngine();
const schema = { entities: { Task: {} } };
// #region retention
// A tiny log, so this example shows a snapshot: the default keeps the last 10 000 ops.
// (`defer: 0` lands every write at once, so the log compacts as it goes.)
const server = await createDatabase({
  engine,
  path: 'server',
  schema,
  defer: 0,
  sync: { retention: { ops: 4 }, log: { rollAfter: 2 } },
});
// #endregion retention
const unit = server.sync.unit({ access: 'public' });
const links = {};
const dial = (name) => () => (links[name] = new MemoryLink(unit));
const open = (name) => createDatabase({ engine, path: name, schema, sync: { connect: dial(name) } });

const phone = await open('phone');
await phone.sync.addNode({ url: 'wss://board.example.com/api' });
await phone.sync.awaitInitialReplication();
const snapshots = [];
phone.sync.on('bootstrap', (event) => snapshots.push(event));

// #region long-gone
phone.sync.on('bootstrap', ({ url, records }) => console.log('snapshot from', url, 'with', records, 'records'));

links.phone.disconnect(); // the phone sits in a drawer for a month
const offline = await phone.Task.insert({ title: 'Written in the drawer', done: false });
for (let i = 0; i < 30; i++) await server.Task.insert({ title: `Task ${i}`, done: false });

await links.phone.reconnect(); // its place in the server's log is gone: a snapshot instead
await phone.sync.awaitInSync();
// snapshot from wss://board.example.com/api with 31 records
// #endregion long-gone
await settle([server, phone]);
assert.equal(snapshots.length, 1);
assert.equal((await phone.Task.select({}).fetch()).length, 31);
assert.deepEqual(await server.Task.get(offline.id), { title: 'Written in the drawer', done: false, $type: 'Task' });

// #region newcomer
const tablet = await open('tablet');
const joined = tablet.sync.toPromise('bootstrap');
await tablet.sync.addNode({ url: 'wss://board.example.com/api' });
await tablet.sync.awaitInitialReplication();
console.log(await joined); // { url: 'wss://board.example.com/api', records: 31 }
// #endregion newcomer
assert.deepEqual(await joined, { url: 'wss://board.example.com/api', records: 31 });
assert.equal((await tablet.Task.select({}).fetch()).length, 31);

await tablet.close();
await phone.close();
await server.close();
