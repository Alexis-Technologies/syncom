// The NATS and brokers page (docs/guide/replication-nats.md) shows the regions of this file: two hubs over one
// broker's log, wrpc's in-process MemoryBroker standing in for NATS JetStream, Redis, Kafka or AMQP.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { MemoryLink, memoryEngine, waitUntil } from '@alexify/syncom/testing';

// No server holds this process open, and the hubs' timers do not: a timer of our own does, until the end.
const keepAlive = setInterval(() => {}, 1000);
const engine = memoryEngine();
const schema = { entities: { Task: {} } };

// #region hubs
import { MemoryBroker } from '@alexify/wrpc/broker';

const broker = new MemoryBroker(); // in production: createNatsBroker(), createRedisBroker(), …

// Every hub process opens the same way: the broker's log is what they share.
const hub1 = await createDatabase({ engine, path: 'hub-1', schema, sync: { sharedLog: broker.log } });
const hub2 = await createDatabase({ engine, path: 'hub-2', schema, sync: { sharedLog: broker.log } });
// #endregion hubs

// #region balancer
// A load balancer in front of the hubs: one url, whichever hub answers. Each hub mounts its
// unit as usual; here an in-process link stands in for the balancer and the WebSocket.
const units = { hub1: hub1.sync.unit({ access: 'public' }), hub2: hub2.sync.unit({ access: 'public' }) };
let behind = 'hub1';
const laptop = await createDatabase({
  engine,
  path: 'laptop',
  schema,
  sync: { connect: () => new MemoryLink(units[behind]) },
});
await laptop.sync.addNode({ url: 'wss://board.example.com/api' });
await laptop.sync.awaitInitialReplication();
// #endregion balancer

// #region across
const fromLaptop = await laptop.Task.insert({ title: 'Pushed to hub 1', done: false });
const fromHub2 = await hub2.Task.insert({ title: 'Written on hub 2', done: false });
// laptop → hub 1 → the broker's log → hub 2, and hub 2 → the log → hub 1 → laptop
// #endregion across
await waitUntil(async () => (await hub2.Task.get(fromLaptop.id)) !== null && laptop.hasRecord(fromHub2.id));
assert.deepEqual(await hub2.Task.get(fromLaptop.id), { title: 'Pushed to hub 1', done: false, $type: 'Task' });
assert.deepEqual(await laptop.Task.get(fromHub2.id), { title: 'Written on hub 2', done: false, $type: 'Task' });

// #region move
const snapshots = [];
laptop.sync.on('bootstrap', (event) => snapshots.push(event));
console.log(laptop.sync.listNodes()[0].remote.epoch); // 'shared:syncom': a position in the log, not in a hub

behind = 'hub2'; // the balancer sends the next connection to hub 2
await laptop.sync.enableNode('wss://board.example.com/api', false);
await laptop.sync.enableNode('wss://board.example.com/api', true);
await laptop.sync.awaitInitialReplication();
console.log(snapshots.length); // 0: resumed from its cursor, no snapshot
// #endregion move
await waitUntil(() => laptop.sync.peers()[0]?.subscribed && laptop.sync.peers()[0].node === hub2.nodeId);
assert.equal(laptop.sync.listNodes()[0].remote.epoch, 'shared:syncom');
const later = await hub1.Task.insert({ title: 'Written on hub 1 later', done: false });
await waitUntil(() => laptop.hasRecord(later.id));
assert.deepEqual(snapshots, []);
console.log(hub1.sync.shared().relayed > 0, hub2.sync.shared().applied > 0);

await laptop.close();
await hub1.close();
await hub2.close();
await broker.close();
clearInterval(keepAlive);
