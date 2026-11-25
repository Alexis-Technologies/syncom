// The sync protocol page (docs/guide/sync-protocol.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { MemoryLink } from '@alexify/syncom/testing';

const schema = { entities: { Task: {} } };
const wait = async (check) => {
  for (let i = 0; i < 250 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(await check());
};

// #region setup
const server = await createDatabase({
  path: 'server',
  schema,
  // a tiny retention, so this example compacts the server's log in a few writes
  sync: { retention: { ops: 10 }, log: { rollAfter: 2 } },
});
const unit = server.sync.unit({ access: 'public' });

let link = null;
const laptop = await createDatabase({
  path: 'laptop',
  schema,
  // the in-process link of @alexify/syncom/testing: a wrpc client, without the network
  sync: { connect: () => (link = new MemoryLink(unit)) },
});
// #endregion setup

const events = [];
// #region events
server.sync.on('hello', (hello) =>
  events.push(['hello', { node: hello.node, scopes: hello.scopes, schema: hello.schema }]),
);
laptop.sync.on('peer', ({ url, connected, node }) => events.push(['peer', { url, connected, node }]));
laptop.sync.on('sync', (event) => events.push(['sync', event]));
// #endregion events

await server.Task.insert({ title: 'Written on the server', done: false });
// #region dial
await laptop.Task.insert({ title: 'Written on the laptop', done: false });
await laptop.sync.addNode({ url: 'mem://server' });
await laptop.sync.awaitInSync();
// hello  { node: '<laptop>', scopes: [ '*' ], schema: { version: 1, hash: … } }
// peer   { url: 'mem://server', connected: true, node: '<server>' }
// sync   { url: 'mem://server', pushed: 1 }
// sync   { url: 'mem://server', received: 1, applied: 1, skipped: 0, duplicates: 0, gaps: 0, … }
// #endregion dial
await wait(() => events.some(([name, event]) => name === 'sync' && event.received === 1));
const kinds = events.map(([name]) => name);
assert.equal(kinds[0], 'hello');
assert.ok(kinds.includes('peer'));
const hello = events.find(([name]) => name === 'hello')[1];
assert.equal(hello.node, laptop.nodeId);
assert.deepEqual(hello.scopes, ['*']);
const peerEvent = events.find(([name]) => name === 'peer')[1];
assert.equal(peerEvent.node, server.nodeId);
assert.ok(events.some(([name, event]) => name === 'sync' && event.pushed === 1));
const received = events.find(([name, event]) => name === 'sync' && event.received === 1)[1];
assert.equal(received.applied, 1);
assert.equal(received.gaps, 0);

// #region peers
const [peer] = laptop.sync.peers();
console.log(peer.connected, peer.subscribed, peer.caughtUp, peer.cursor);
// true true true '<server epoch>.2'
// #endregion peers
assert.equal(peer.connected, true);
assert.equal(peer.subscribed, true);
assert.equal(peer.caughtUp, true);
assert.equal(peer.cursor, `${server.log.epoch}.2`);
assert.equal(laptop.sync.listNodes()[0].cursor, peer.cursor);

// #region resume
link.disconnect(); // the connection drops
await laptop.Task.insert({ title: 'Offline on the laptop', done: false });
await server.Task.insert({ title: 'Meanwhile on the server', done: false });
await link.reconnect(); // the link resumes the feed from its last event id
await laptop.sync.awaitInSync();
// #endregion resume
await wait(async () => (await server.Task.select({}).fetch()).length === 4);
await wait(async () => (await laptop.Task.select({}).fetch()).length === 4);

// The server compacts its log past where a new node could resume.
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < 10; i++) await server.Task.insert({ title: `Task ${round}.${i}`, done: false });
  await server.flush();
}
await wait(() => server.stats().log.floor > 1);

let phoneLink = null;
const phone = await createDatabase({
  path: 'phone',
  schema,
  logger: false,
  sync: { connect: () => (phoneLink = new MemoryLink(unit)) },
});
// #region bootstrap
phone.sync.on('bootstrap', ({ url, records }) => console.log(`joined ${records} records from ${url}`));
await phone.sync.addNode({ url: 'mem://server' });
await phone.sync.awaitInSync();
// joined 34 records from mem://server
// #endregion bootstrap
assert.ok(phoneLink.calls.includes('syncom/snapshot'));
await wait(async () => (await phone.Task.select({}).fetch()).length === 34);
// A bootstrap is transitive: the joined state is in the phone's own log as merge and advance ops.
const types = new Set();
for (const entry of phone.log.since(null)) types.add(entry.op.type);
assert.ok(types.has('merge') && types.has('advance'));
assert.ok(phone.vector[`${phone.nodeId}@~`] > 0);

await phone.close();
await laptop.close();
await server.close();

// #region by-hand
import * as core from '@alexify/syncom';

const a = await core.createDatabase({ path: 'a' }); // the core alone: no sync plugin
const b = await core.createDatabase({ path: 'b' });
await a.insert({ title: 'Carried by hand' });

// what `a` has that `b` lacks, by b's vector; then b applies it
const { ops } = core.outbound(a.log, { exclude: b.nodeId, vector: b.vector, own: a.nodeId });
const result = await b.applyRemote(ops);
console.log(result.applied); // 1
// #endregion by-hand
assert.equal(result.applied, 1);
assert.deepEqual(b.vector, a.vector);
await a.close();
await b.close();
