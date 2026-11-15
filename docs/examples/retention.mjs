// The Retention and acknowledgements page (docs/guide/retention.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { cp, rm } from 'node:fs/promises';
import { createDatabase } from '@alexify/syncom/all';
import { MemoryLink } from '@alexify/syncom/testing';

const schema = { entities: { Task: {} } };
const wait = async (check) => {
  for (let i = 0; i < 250 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(await check());
};
// Writes in a few landings, so the log seals several segments.
const writeMany = async (db, prefix, rounds = 3) => {
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < 10; i++) await db.Task.insert({ title: `${prefix} ${round}.${i}`, done: false });
    await db.flush();
  }
};

// #region options
const server = await createDatabase({
  path: 'server',
  schema,
  sync: { retention: { ops: 50_000, days: 30 } },
});
// #endregion options
const unit = server.sync.unit({ access: 'public' });

// #region log-event
server.on('log', ({ sealed, dropped, floor }) => {
  if (dropped > 0) console.log(`dropped ${dropped} segment(s); a cursor below ${floor} must bootstrap`);
});
// #endregion log-event

let link = null;
// #region kept
const laptop = await createDatabase({
  path: 'laptop',
  schema,
  // a tiny retention, so this example compacts in a few writes
  sync: { connect: () => (link = new MemoryLink(unit)), retention: { ops: 10 }, log: { rollAfter: 2 } },
});
await laptop.sync.addNode({ url: 'mem://server' }); // registered before it goes offline
await laptop.sync.awaitInSync();
// #endregion kept

// #region offline
link.disconnect();
await writeMany(laptop, 'Offline'); // 30 writes, three times the retention
console.log(laptop.stats().log.floor); // 1: nothing of its own was dropped
await link.reconnect();
await laptop.sync.awaitInSync();
console.log(laptop.sync.listNodes()[0].acked); // { '<laptop>': 30 }: the server holds them all
// #endregion offline
await wait(async () => (await server.Task.select({}).fetch()).length === 30);
assert.equal(laptop.sync.listNodes()[0].acked[laptop.nodeId], 30);
// Acknowledged, the laptop's ops are retained like any other: the next rolls compact them.
const rolls = [];
laptop.on('log', (event) => rolls.push(event));
await writeMany(laptop, 'Online', 2);
await laptop.sync.awaitInSync();
await wait(() => laptop.stats().log.floor > 1);
assert.ok(rolls.some((event) => event.dropped > 0 && event.floor === laptop.stats().log.floor));
await wait(async () => (await server.Task.select({}).fetch()).length === 50);

// A node that wrote, compacted, and only then registered a host.
// #region undeliverable
const tablet = await createDatabase({
  path: 'tablet',
  schema,
  logger: false,
  sync: { connect: () => new MemoryLink(unit), retention: { ops: 10 }, log: { rollAfter: 2 } },
});
await writeMany(tablet, 'Before any host'); // compacted: no host was registered to wait for
tablet.sync.on('error', (error) => {
  if (error.code === 'UNDELIVERABLE') console.log(error.message);
});
await tablet.sync.addNode({ url: 'mem://server' });
// #endregion undeliverable
const undeliverable = await tablet.sync.toPromise('error');
assert.equal(undeliverable.code, 'UNDELIVERABLE');
assert.ok(tablet.stats().log.floor > 1);
const afterHello = await tablet.Task.insert({ title: 'After the hello', done: false });
await new Promise((resolve) => setTimeout(resolve, 300));
// The stream stays at the tablet: neither the compacted writes nor the later one reach this host.
assert.equal(await server.Task.get(afterHello.id), null);
assert.equal(server.vector[tablet.nodeId], undefined);
await tablet.close();

// A directory restored from an older copy.
const desk = await createDatabase({
  path: 'desk',
  schema,
  logger: false,
  sync: { connect: () => new MemoryLink(unit) },
});
await desk.sync.addNode({ url: 'mem://server' });
await desk.Task.insert({ title: 'Before the backup', done: false });
await desk.sync.awaitInSync();
await desk.close();
await cp('desk', 'desk-backup', { recursive: true });
const reopened = await createDatabase({
  path: 'desk',
  schema,
  logger: false,
  sync: { connect: () => new MemoryLink(unit) },
});
const lost = await reopened.Task.insert({ title: 'After the backup', done: false });
await reopened.sync.awaitInSync();
await wait(async () => (await server.Task.get(lost.id)) !== null);
await reopened.close();
await rm('desk', { recursive: true });
await cp('desk-backup', 'desk', { recursive: true });

// #region rewound
const restored = await createDatabase({
  path: 'desk',
  schema,
  sync: { connect: () => new MemoryLink(unit) },
});
restored.sync.on('error', (error) => {
  if (error.code === 'REWOUND') console.log(error.adopted); // { '<desk>': 2 }: moved past what the server holds
});
// #endregion rewound
const rewound = await restored.sync.toPromise('error');
assert.equal(rewound.code, 'REWOUND');
assert.equal(rewound.adopted[restored.nodeId], 2);
// It bootstraps from the server and gets back what the lost op wrote.
await wait(async () => (await restored.Task.get(lost.id)) !== null);
// Its next op takes a seq the server has never seen.
const next = await restored.Task.insert({ title: 'After the restore', done: false });
await restored.sync.awaitInSync();
await wait(async () => (await server.Task.get(next.id)) !== null);
assert.equal(restored.vector[restored.nodeId], 3);

await restored.close();
await laptop.close();
await server.close();
