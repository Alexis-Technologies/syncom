// The MongoDB page (docs/guide/storage-mongodb.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory: against MONGODB_URL when it is set
// (a replica set), against the in-memory driver the repository's tests run on otherwise. The connection itself is
// storage-mongodb-connect.mjs.
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createFakeMongo } from '../../tests/utils/fake-mongo.js';

const client = process.env.MONGODB_URL ? await new MongoClient(process.env.MONGODB_URL).connect() : createFakeMongo();
const unique = `board_${Date.now().toString(36)}`;

// #region engine
import { createDatabase } from '@alexify/syncom/all';
import { mongoEngine } from '@alexify/syncom/mongodb';

const engine = mongoEngine({ client, name: unique, transactions: true });
const schema = { entities: { Task: { index: ['done'] } } };

const db = await createDatabase({ path: 'board', schema, engine });
await db.Task.insert({ title: 'Stored in MongoDB', done: false });
// #endregion engine
assert.equal(await db.Task.count({}), 1);
await db.flush();

// #region locked
// A second service instance over the same path: the lease is taken.
const second = mongoEngine({ client, name: unique, transactions: true });
try {
  await createDatabase({ path: 'board', schema, engine: second });
} catch (error) {
  console.log(error.code); // 'LOCKED'
}
// #endregion locked
await assert.rejects(() => createDatabase({ path: 'board', schema, engine: second }), { code: 'LOCKED' });

// #region lease
db.on('lease', ({ state }) => console.log('lease', state)); // 'renewed', 'late' or 'lost'
db.on('error', (error) => {
  if (error.code === 'LEASE_LOST') console.log('another instance took over; this one is read-only now');
});
console.log(db.stats().lock); // { kind: 'native', mode: 'fail', expiresAt: <ms>, lost: false }
// #endregion lease
const lock = db.stats().lock;
assert.equal(lock.kind, 'native');
assert.equal(lock.lost, false);
assert.ok(lock.expiresAt > Date.now());

// #region follower
// The second instance reads instead: it follows what the writer lands, through a change stream.
const follower = await createDatabase({ path: 'board', schema, engine: second, readOnly: true });
follower.Task.select({}).watch((rows) => console.log('tasks:', rows.length));
// tasks: 1
await db.Task.insert({ title: 'Landed by the writer', done: false });
// tasks: 2
// #endregion follower
const deadline = Date.now() + 3000;
while ((await follower.Task.count({})) < 2 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(await follower.Task.count({}), 2);
await assert.rejects(() => follower.Task.insert({ title: 'no', done: false }), { code: 'READ_ONLY' });

// #region close
await follower.close();
await db.close(); // lets the lease go
await client.close(); // the driver is yours to close
// #endregion close
await engine.destroy();

// #region standalone
// A standalone server has neither transactions nor change streams.
const standalone = mongoEngine({ client, name: 'board', changes: false });
// #endregion standalone
assert.equal(standalone.capabilities.atomicBatch, false);
assert.equal(standalone.capabilities.changeStream, false);
