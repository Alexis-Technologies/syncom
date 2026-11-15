// The operation log page (docs/guide/operation-log.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';
import { memoryEngine, MemoryLink } from '@alexify/syncom/testing';

// #region change
const laptop = await createDatabase({ path: 'laptop', schema: { entities: { Task: {} } } });

laptop.on('change', (op, via, { seq }) => {
  console.log(seq, op.type, op.id, op.data ?? op.value);
});
const task = await laptop.Task.insert({ title: 'Write the docs', done: false });
await laptop.Task.update(task.id, { done: true });
await laptop.inc(task.id, 'votes', 1);
// 1 write <id> { title: 'Write the docs', done: false, '$type': 'Task' }
// 2 set <id> { done: true }
// 3 inc <id> 1
// #endregion change
await new Promise((resolve) => setTimeout(resolve, 20));

// #region op
const [, second] = laptop.log.since(null);
console.log(second.op);
// {
//   origin: 'pX3k…',          the node that made it (its id)
//   seq: 2,                   its place in that node's stream
//   ts: 1793087684846,        its stamp
//   type: 'set',
//   id: '<the task id>',
//   v: 1,                     the schema version it was written under
//   data: { done: true },
//   prev: 'SmNV…',            the fingerprint of the op before it
//   nonce: '…', digest: '…', sig: '…'   its signature
// }
// #endregion op
const entries = laptop.log.since(null);
assert.equal(entries.length, 3);
assert.equal(second.op.origin, laptop.nodeId);
assert.equal(second.op.seq, 2);
assert.equal(second.op.type, 'set');
assert.deepEqual(second.op.data, { done: true });
assert.equal(typeof second.op.sig, 'string');
assert.ok(entries[0].op.ts < entries[1].op.ts && entries[1].op.ts < entries[2].op.ts);

// #region chain
const [first, next] = laptop.log.since(null);
console.log(next.op.prev === first.fp); // true: each op names the one before it
// #endregion chain
assert.equal(next.op.prev, first.fp);
assert.equal(first.op.prev, undefined);

// #region vector
console.log(laptop.vector); // { 'pX3k…': 3 }: the highest seq applied from each stream
console.log(laptop.log.lastEventId); // 'mwh…q.3': this log's epoch and its last position
// #endregion vector
assert.deepEqual(laptop.vector, { [laptop.nodeId]: 3 });
assert.equal(laptop.log.lastEventId, `${laptop.log.epoch}.3`);

// #region streams
const scoped = await createDatabase({
  path: 'scoped',
  sync: { scope: (id, data) => data.team ?? '*' },
});
await scoped.insert({ title: 'Company holiday' }); // global: the stream is the node id
await scoped.insert({ title: 'Fix the login page', team: 'web' });
await scoped.insert({ title: 'Rotate the keys', team: 'ops' });
await scoped.insert({ title: 'Ship the release', team: 'web' });
console.log(scoped.vector);
// { 'Qa7…': 1, 'Qa7…@web': 2, 'Qa7…@ops': 1 }: one stream per scope, each counted from 1
// #endregion streams
assert.deepEqual(scoped.vector, {
  [scoped.nodeId]: 1,
  [`${scoped.nodeId}@web`]: 2,
  [`${scoped.nodeId}@ops`]: 1,
});
await scoped.close();

// Two nodes: the phone takes the laptop's ops, and its own write is stamped after them.
const server = await createDatabase({ path: 'server', engine: memoryEngine(), logger: false });
const unit = server.sync.unit({ access: 'public' });
const phone = await createDatabase({
  path: 'phone',
  schema: { entities: { Task: {} } },
  logger: false,
  sync: { connect: () => new MemoryLink(unit) },
});
const laptopLink = await createDatabase({
  path: 'laptop-2',
  schema: { entities: { Task: {} } },
  logger: false,
  sync: { connect: () => new MemoryLink(unit) },
});
await laptopLink.sync.addNode({ url: 'mem://server' });
await phone.sync.addNode({ url: 'mem://server' });
const shared = await laptopLink.Task.insert({ title: 'Plan', done: false });
await laptopLink.sync.awaitInSync();
for (let i = 0; i < 100 && !phone.hasRecord(shared.id); i++) await new Promise((resolve) => setTimeout(resolve, 20));
await phone.sync.awaitInSync();

// #region vectors-two
console.log(phone.vector);
// { '<laptop>': 1 }: the phone applied op 1 of the laptop's stream
await phone.Task.update(shared.id, { done: true });
console.log(phone.vector);
// { '<laptop>': 1, '<phone>': 1 }
// #endregion vectors-two
assert.equal(phone.vector[laptopLink.nodeId], 1);
assert.equal(phone.vector[phone.nodeId], 1);
const phoneOp = phone.log.since(null).at(-1).op;
const laptopOp = phone.log.since(null)[0].op;
assert.ok(phoneOp.ts > laptopOp.ts, 'a write after a read is stamped after what it read');

// #region stats
console.log(laptop.stats().log);
// { length: 3, floor: 1, next: 4, epoch: 'mwh…q', segments: 0, … }
// #endregion stats
const stats = laptop.stats().log;
assert.equal(stats.length, 3);
assert.equal(stats.floor, 1);
assert.equal(stats.next, 4);
assert.equal(stats.epoch, laptop.log.epoch);

await phone.close();
await laptopLink.close();
await server.close();
await laptop.close();
