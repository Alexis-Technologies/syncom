'use strict';

// A follower (`readOnly: true`) over the engine another instance writes
// through: it reads, refuses every write, holds no lock, and — over an engine
// with a change stream — hears what the writer lands. And the lease an engine
// holds a database by (MongoDB): LOCKED while held, taken once lapsed, lost
// to its holder when another instance takes it.

const test = require('node:test');
const assert = require('node:assert');
// node:sqlite is experimental: Node says so once per process at the require, which this test is not about.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.error(warning.stack);
});
const { createDatabase, memoryEngine, memory, filesEngine } = require('../src/all/all.js');
const { mongoEngine } = require('../src/mongodb/mongodb.js');
const { sqliteEngine } = require('../src/sqlite/sqlite.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const base = { logger: false, defer: 0, schema: { entities: { Note: {} } } };

test('a read-only database', async (t) => {
  await t.test(
    'a follower opens beside the writer without a lock, reads what it wrote and refuses every write with READ_ONLY',
    async () => {
      const engine = memoryEngine();
      const writer = await createDatabase({ ...base, path: 'app', engine });
      const id = await writer.insert({ title: 'Draft', $type: 'Note' });
      await writer.push(id, 'body', 'x'.repeat(2000));
      await writer.tag('v1');
      const follower = await createDatabase({ ...base, path: 'app', engine, readOnly: true });
      assert.strictEqual(follower.stats().readOnly, true);
      assert.strictEqual(follower.stats().lock, null, 'no lock of its own: the writer holds the database');
      assert.strictEqual(follower.nodeId, writer.nodeId, 'the same node: it is the same database');
      assert.strictEqual((await follower.get(id)).title, 'Draft');
      assert.strictEqual((await follower.get(id)).body.length, 2000);
      assert.deepStrictEqual(await follower.list(), [id]);
      assert.strictEqual(follower.hasRecord(id), true);
      assert.deepStrictEqual((await follower.at('v1').get(id)).title, 'Draft');
      assert.strictEqual((await follower.Note.select({ title: 'Draft' }).fetch()).length, 1);
      const refused = { code: 'READ_ONLY', path: 'app', lease: false };
      await assert.rejects(() => follower.insert({ title: 'no' }), refused);
      await assert.rejects(() => follower.update(id, { title: 'no' }), refused);
      await assert.rejects(() => follower.delete(id), refused);
      await assert.rejects(() => follower.transact(async (tx) => tx.insert({})), refused);
      await assert.rejects(() => follower.tag('v2'), refused);
      await assert.rejects(() => follower.repair(id), refused);
      await assert.rejects(() => follower.applyRemote([]), refused);
      assert.strictEqual((await writer.get(id)).title, 'Draft', 'the writer saw nothing of it');
      await assert.rejects(
        () => createDatabase({ ...base, path: 'app', engine, readOnly: true, sync: { connect: () => null } }),
        { name: 'TypeError', message: /does not dial/ },
      );
      assert.throws(() => createDatabase({ ...base, readOnly: 'yes' }), { name: 'TypeError', message: /boolean/ });
      await follower.close();
      await writer.update(id, { title: 'Still the writer’s' });
      await writer.close();
      const again = await createDatabase({ ...base, path: 'app', engine });
      assert.strictEqual((await again.get(id)).title, 'Still the writer’s', 'the follower wrote nothing');
      assert.strictEqual(again.stats().log.unapplied, 0);
      await again.close();
    },
  );

  await t.test(
    'a follower is refused over an engine that is not shared: the files engine and SQLite, a TypeError naming the engine',
    async () => {
      const files = filesEngine(memory());
      assert.strictEqual(files.capabilities.shared, false);
      assert.strictEqual(sqliteEngine().capabilities.shared, false);
      assert.strictEqual(memoryEngine().capabilities.shared, true);
      assert.strictEqual(mongoEngine({ client: createFakeMongo() }).capabilities.shared, true);
      const writer = await createDatabase({ ...base, path: 'app', engine: files });
      await writer.insert({ title: 'Draft' });
      await assert.rejects(() => createDatabase({ ...base, path: 'app', engine: files, readOnly: true }), {
        name: 'TypeError',
        message: /the files engine is not shared/,
      });
      await writer.close();
      const sqlite = sqliteEngine();
      await assert.rejects(() => createDatabase({ ...base, path: 'app', engine: sqlite, readOnly: true }), {
        name: 'TypeError',
        message: /the sqlite engine is not shared/,
      });
      await sqlite.close();
      // The writer's files are as it left them: the refusal came before the engine opened anything.
      const again = await createDatabase({ ...base, path: 'app', engine: files });
      assert.strictEqual((await again.list()).length, 1);
      await again.close();
    },
  );

  await t.test('a follower neither dials nor hosts: sync.unit() is READ_ONLY with reason hosting', async () => {
    const engine = memoryEngine();
    const writer = await createDatabase({ ...base, path: 'app', engine });
    const follower = await createDatabase({ ...base, path: 'app', engine, readOnly: true });
    assert.strictEqual(follower.readOnly, true);
    assert.strictEqual(writer.readOnly, false);
    assert.throws(() => follower.sync.unit({ access: 'public' }), {
      code: 'READ_ONLY',
      path: 'app',
      lease: false,
      reason: 'hosting',
    });
    assert.strictEqual(typeof writer.sync.unit({ access: 'public' }), 'object', 'the writer hosts');
    await follower.close();
    await writer.close();
  });

  await t.test('a follower hears what the writer lands through the engine’s change stream', async () => {
    const client = createFakeMongo();
    const writer = await createDatabase({ ...base, path: 'app', engine: mongoEngine({ client, name: 'shared' }) });
    const follower = await createDatabase({
      ...base,
      path: 'app',
      engine: mongoEngine({ client, name: 'shared' }),
      readOnly: true,
    });
    const id = await writer.insert({ title: 'Draft', $type: 'Note' });
    await settle();
    assert.strictEqual((await follower.get(id)).title, 'Draft', 'a record it never saw');
    assert.strictEqual(follower.hasRecord(id), true, 'the catalog row came with it');
    const live = await follower.document(id);
    const seen = [];
    const stop = follower.Note.select({}).watch((rows) => seen.push(rows.length));
    await settle();
    await writer.update(id, { title: 'Final' });
    const other = await writer.insert({ title: 'Another', $type: 'Note' });
    await settle();
    assert.strictEqual(live.title, 'Final', 'the live Document refreshed');
    assert.strictEqual((await follower.get(other)).title, 'Another');
    assert.deepStrictEqual((await follower.list()).sort(), [id, other].sort());
    assert.strictEqual(seen[seen.length - 1], 2, 'the watcher woke');
    await writer.delete(other);
    await settle();
    assert.strictEqual(await follower.get(other), null);
    assert.strictEqual(follower.hasRecord(other), false);
    stop();
    await follower.close();
    await writer.close();
  });
});

test('the lease an engine holds a database by (MongoDB)', async (t) => {
  await t.test(
    'LOCKED while another instance holds the lease; taken once it lapsed; waited for under lock: wait',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'leased' });
      const a = await createDatabase({ ...base, path: 'app', engine, lock: { staleAfter: 200 } });
      assert.deepStrictEqual(a.stats().lock, { mode: 'fail' });
      await assert.rejects(() => createDatabase({ ...base, path: 'app', engine }), { code: 'LOCKED', path: 'app' });
      await assert.rejects(
        () => createDatabase({ ...base, path: 'app', engine, lock: { mode: 'wait', timeout: 60 } }),
        {
          code: 'LOCKED',
        },
      );
      await a.close();
      // A lapsed lease (its holder gone without a close) is taken over.
      await client
        .db('leased')
        .collection('locks')
        .insertOne({ _id: 'app', owner: 'gone', expires: Date.now() - 1 });
      const b = await createDatabase({ ...base, path: 'app', engine });
      await b.insert({ n: 1 });
      // `wait` outlasts a holder that lets go.
      const waiting = createDatabase({ ...base, path: 'app', engine, lock: { mode: 'wait', poll: 10 } });
      await settle(40);
      await b.close();
      const c = await waiting;
      assert.deepStrictEqual(await c.list().then((ids) => ids.length), 1);
      await c.close();
    },
  );

  await t.test(
    'a lease taken by another instance makes its holder read-only: LEASE_LOST once, READ_ONLY after',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'lost' });
      const a = await createDatabase({ ...base, path: 'app', engine, lock: { staleAfter: 60 } });
      const errors = [];
      a.on('error', (error) => errors.push(error));
      const id = await a.insert({ n: 1 });
      // Another instance took the lease (as one does when it finds the lease lapsed).
      await client
        .db('lost')
        .collection('locks')
        .updateOne({ _id: 'app' }, { $set: { owner: 'other' } });
      await settle(80);
      assert.strictEqual(errors.length, 1, 'heard once');
      assert.strictEqual(errors[0].code, 'LEASE_LOST');
      assert.strictEqual(errors[0].path, 'app');
      assert.strictEqual(a.stats().readOnly, true);
      await assert.rejects(() => a.insert({ n: 2 }), { code: 'READ_ONLY', lease: true });
      await assert.rejects(() => a.update(id, { n: 2 }), { code: 'READ_ONLY' });
      assert.deepStrictEqual(await a.get(id), { n: 1 }, 'reads go on');
      await a.close();
      const lock = await client.db('lost').collection('locks').findOne({ _id: 'app' });
      assert.strictEqual(lock.owner, 'other', 'a close never releases what another instance holds');
    },
  );
});
