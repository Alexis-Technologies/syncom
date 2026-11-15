// The Sync engine page (docs/guide/replication.md) shows the regions of this file: a node that comes back after
// the host compacted its log, and a brand-new node, both bootstrap from a snapshot. `open()` is the helper of the
// page's `nodes` region (docs/examples/replication.mjs), dialing this file's server.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine } from '@alexify/syncom/memory';
import { MemoryLink, settle } from '@alexify/syncom/testing';

const engine = memoryEngine();
const schema = { entities: { Task: {} } };
// #region retention
// A tiny log, so this example shows a snapshot: the default keeps the last 10 000 ops.
const server = await createDatabase({
  engine,
  path: 'server',
  schema,
  defer: 0, // land every write at once, so the log can compact as it goes
  sync: {
    retention: { ops: 4 }, // keep only the newest 4 ops…
    log: { rollAfter: 2 }, // …and seal a log segment every 2 appends, so old segments can be dropped
  },
});
const unit = server.sync.unit({ access: 'public' });
// #endregion retention
const links = {};
const open = async (name) => {
  const db = await createDatabase({
    engine,
    path: name,
    schema,
    sync: { connect: () => (links[name] = new MemoryLink(unit)) },
  });
  await db.sync.addNode({ url: 'mem://server' });
  await db.sync.awaitInitialReplication();
  return db;
};

const phone = await open('phone');
const snapshots = [];
phone.sync.on('bootstrap', (event) => snapshots.push(event));

// #region long-gone
phone.sync.on('bootstrap', ({ url, records }) => console.log('snapshot from', url, 'with', records, 'records'));

links.phone.disconnect(); // the phone sits in a drawer for a month
const offline = await phone.Task.insert({ title: 'Written in the drawer', done: false });
for (let i = 0; i < 30; i++) await server.Task.insert({ title: `Task ${i}`, done: false });

await links.phone.reconnect(); // its place in the server's log is gone: a snapshot instead
await phone.sync.awaitInSync();
// snapshot from mem://server with 31 records
// #endregion long-gone
await settle([server, phone]);
assert.deepEqual(snapshots, [{ url: 'mem://server', records: 31 }]);
assert.equal((await phone.Task.select({}).fetch()).length, 31);
assert.deepEqual(await server.Task.get(offline.id), { title: 'Written in the drawer', done: false, $type: 'Task' });

// #region newcomer
const tablet = await open('tablet'); // a new device: its first sync joins a snapshot
console.log(await tablet.Task.count({})); // 31
// #endregion newcomer
assert.equal(await tablet.Task.count({}), 31);
// A node that bootstrapped keeps the joined records in a stream of its own (`<origin>@~`).
assert.ok(Object.keys(tablet.vector).some((key) => key.endsWith('@~')));

await tablet.close();
await phone.close();
await server.close();
