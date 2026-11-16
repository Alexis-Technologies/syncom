// The Scaling page (docs/guide/server-scaling.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { Server, defineRouter, WrpcClient } from '@alexify/wrpc';
import { MemoryBroker } from '@alexify/wrpc/broker';
import { createDatabase } from '@alexify/syncom/all';
import { createWrpcLink } from '@alexify/syncom/wrpc';
import { memoryEngine } from '@alexify/syncom/memory';
import { attachments } from '@alexify/syncom/attachments';

const schema = { entities: { Task: { index: ['done'] } } };
const connect = async (node) => createWrpcLink(await WrpcClient.connect(node.url));
const wait = async (check) => {
  for (let i = 0; i < 250 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(await check());
};
const serve = async (db, port, options = {}) => {
  const router = defineRouter({ syncom: db.sync.unit({ access: 'public', ...options }) });
  const server = new Server({ router, host: '127.0.0.1', port, protocol: 'http', logger: false });
  await server.listen();
  return server;
};

// Two hubs that dial each other, each with a client of its own.
const hub1 = await createDatabase({ path: 'hub-1', schema, logger: false });
const server1 = await serve(hub1, 8301);
// #region mesh
// hub-2: a full node like hub-1, which it dials as any client would
const hub2 = await createDatabase({ path: 'hub-2', schema, sync: { connect } });
await hub2.sync.addNode({ url: 'ws://127.0.0.1:8301/api', scopes: ['*'] });
// #endregion mesh
const server2 = await serve(hub2, 8302);
const laptop = await createDatabase({ path: 'laptop', schema, logger: false, sync: { connect } });
const phone = await createDatabase({ path: 'phone', schema, logger: false, sync: { connect } });
await laptop.sync.addNode({ url: 'ws://127.0.0.1:8301/api' });
await phone.sync.addNode({ url: 'ws://127.0.0.1:8302/api' });
const fromLaptop = await laptop.Task.insert({ title: 'Written on the laptop', done: false });
await wait(async () => (await phone.Task.get(fromLaptop.id)) !== null);
assert.equal((await phone.Task.get(fromLaptop.id)).title, 'Written on the laptop');
// Each hub has an epoch of its own: a cursor names a position in one hub's log.
assert.notEqual(hub1.log.epoch, hub2.log.epoch);
assert.equal(laptop.sync.listNodes()[0].remote.epoch, hub1.log.epoch);
assert.equal(phone.sync.listNodes()[0].remote.epoch, hub2.log.epoch);
for (const db of [laptop, phone, hub2, hub1]) await db.close();
await server1.close();
await server2.close();

// Two hubs over one broker's log: a client moves between them and resumes.
// #region shared
// Every hub process: its own database, the same broker.
const broker = new MemoryBroker(); // in production: createRedisBroker(), NATS, Kafka or AMQP
const hub = await createDatabase({ path: 'hub-a', schema, sync: { sharedLog: broker.log } });
const router = defineRouter({ syncom: hub.sync.unit({ access: 'public' }) });
// #endregion shared
const hubA = hub;
const serverA = new Server({ router, host: '127.0.0.1', port: 8303, protocol: 'http', logger: false });
await serverA.listen();
const hubB = await createDatabase({ path: 'hub-b', schema, logger: false, sync: { sharedLog: broker.log } });
const serverB = await serve(hubB, 8304);
let behindBalancer = 'ws://127.0.0.1:8303/api';
const client = await createDatabase({
  path: 'client',
  schema,
  logger: false,
  sync: { connect: async () => createWrpcLink(await WrpcClient.connect(behindBalancer)) },
});
await client.sync.addNode({ url: 'wss://hubs.example.com/api' });
await client.sync.awaitInSync();
const first = await client.Task.insert({ title: 'Through hub A', done: false });
await wait(async () => (await hubB.Task.get(first.id)) !== null);
const bootstraps = [];
client.sync.on('bootstrap', (event) => bootstraps.push(event));
// #region epoch
console.log(client.sync.listNodes()[0].remote.epoch); // 'shared:syncom', the same on every hub
// #endregion epoch
assert.equal(client.sync.listNodes()[0].remote.epoch, 'shared:syncom');
// The balancer sends the client to hub B: same url, another hub, the cursor still a position in the log.
behindBalancer = 'ws://127.0.0.1:8304/api';
await client.sync.enableNode('wss://hubs.example.com/api', false);
await client.sync.enableNode('wss://hubs.example.com/api', true);
await wait(() => client.sync.peers()[0]?.subscribed && client.sync.peers()[0].node === hubB.nodeId);
const later = await hubA.Task.insert({ title: 'Landed on hub A after the move', done: false });
await wait(async () => (await client.Task.get(later.id)) !== null);
assert.deepEqual(bootstraps, [], 'resumed from its cursor on hub B');
assert.ok(hubA.sync.shared().relayed >= 1);
for (const db of [client, hubB, hubA]) await db.close();
await serverA.close();
await serverB.close();
broker.close();

// One writer and a read-only follower over one database and one log.
const engine = memoryEngine();
const log = new MemoryBroker({ logger: false }).log;
// The writer holds the database and lands every op; a follower reads the records it lands and hosts over the log
// (server-scaling-mongodb.mjs, which the page shows, does the same over MongoDB).
const plugins = [attachments()];
const writer = await createDatabase({ path: 'hub', engine, schema, plugins, sync: { sharedLog: log } });
const follower = await createDatabase({
  path: 'hub',
  engine,
  schema,
  plugins,
  readOnly: true,
  sync: { sharedLog: log },
});
const followerRouter = defineRouter({ syncom: follower.sync.unit({ access: 'public' }) });
const serverW = await serve(writer, 8305);
const serverF = new Server({ router: followerRouter, host: '127.0.0.1', port: 8306, protocol: 'http', logger: false });
await serverF.listen();
// A client that synced once through the writer moves to the follower and keeps its cursor.
let tabletTarget = 'ws://127.0.0.1:8305/api';
const tablet = await createDatabase({
  path: 'tablet',
  schema,
  plugins,
  logger: false,
  sync: { connect: async () => createWrpcLink(await WrpcClient.connect(tabletTarget)) },
});
await tablet.sync.addNode({ url: 'wss://hubs.example.com/api' });
await tablet.sync.awaitInSync();
const seed = await writer.Task.insert({ title: 'From the writer', done: false });
await wait(async () => (await tablet.Task.get(seed.id)) !== null);
tabletTarget = 'ws://127.0.0.1:8306/api';
await tablet.sync.enableNode('wss://hubs.example.com/api', false);
await tablet.sync.enableNode('wss://hubs.example.com/api', true);
await wait(() => tablet.sync.peers()[0]?.subscribed && tablet.sync.peers()[0].node === follower.nodeId);
// Its push goes to the follower, which forwards it to the inbox; the writer lands it.
const viaFollower = await tablet.Task.insert({ title: 'Pushed to the follower', done: false });
await wait(async () => (await writer.Task.get(viaFollower.id)) !== null);
await wait(async () => (await follower.Task.get(viaFollower.id)) !== null);
assert.ok(follower.sync.shared().forwarded >= 1);
// An attachment goes up through the follower too. It forwards the entry, answers "not yet" until the writer has
// landed it, then takes the bytes — a stream over the WebSocket — into the database's blob store, the one the
// writer reads.
const uploadErrors = [];
tablet.sync.on('error', (error) => uploadErrors.push(error));
const photo = new Uint8Array(200_000).fill(7);
await tablet.attachments.put(viaFollower.id, 'photo.jpg', photo, { type: 'image/jpeg' });
await wait(() => writer.attachments.has(viaFollower.id, 'photo.jpg'));
assert.equal((await writer.attachments.get(viaFollower.id, 'photo.jpg', { fetch: false })).bytes.length, 200_000);
assert.deepEqual(uploadErrors, [], 'the wait for the writer is not reported');
// A fresh client cannot bootstrap from a follower: it serves no snapshot.
const fresh = await createDatabase({ path: 'fresh', schema, logger: false, sync: { connect } });
const freshErrors = [];
fresh.sync.on('error', (error) => freshErrors.push(error));
await fresh.sync.addNode({ url: 'ws://127.0.0.1:8306/api' });
await wait(() => freshErrors.length > 0);
assert.equal(freshErrors[0].code, 403);
await fresh.close();
await tablet.close();
await follower.close();
await writer.close();
await serverF.close();
await serverW.close();
