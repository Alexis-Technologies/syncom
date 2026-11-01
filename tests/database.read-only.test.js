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
      assert.deepStrictEqual(writer.stats().lock, { kind: 'kv', mode: 'fail', expiresAt: null, lost: false });
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

  await t.test('a follower hears a record landed while it was opening: subscribed before the load', async () => {
    const client = createFakeMongo();
    const engine = mongoEngine({ client, name: 'gap' });
    // The writer's catalog is saved (its close), so the follower resumes it from its log rather than rebuild.
    const first = await createDatabase({ ...base, path: 'app', engine });
    const early = await first.insert({ title: 'Early', $type: 'Note' });
    await first.close();
    const writer = await createDatabase({ ...base, path: 'app', engine });
    // The writer lands a record the moment the follower has loaded the log: the
    // follower's log lacks it, its saved catalog too — the change stream alone tells.
    const logs = client.db('gap').collection('log');
    const find = logs.find.bind(logs);
    let late = null;
    let armed = true;
    logs.find = (...args) => {
      const cursor = find(...args);
      if (!armed) return cursor;
      armed = false;
      const toArray = cursor.toArray;
      cursor.toArray = async () => {
        const docs = await toArray();
        late = await writer.insert({ title: 'Late', $type: 'Note' });
        return docs;
      };
      return cursor;
    };
    const follower = await createDatabase({ ...base, path: 'app', engine, readOnly: true });
    logs.find = find;
    assert.ok(late !== null, 'landed during the open');
    await settle();
    assert.strictEqual(follower.hasRecord(early), true);
    assert.strictEqual(follower.hasRecord(late), true, 'heard from before the load');
    assert.strictEqual((await follower.get(late)).title, 'Late');
    assert.deepStrictEqual((await follower.list()).sort(), [early, late].sort());
    await follower.close();
    await writer.close();
  });

  await t.test(
    'a follower whose change stream ends hears FOLLOW_LOST once, reads every record again and follows on',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'broken' });
      const writer = await createDatabase({ ...base, path: 'app', engine });
      const kept = await writer.insert({ title: 'Kept', $type: 'Note' });
      const gone = await writer.insert({ title: 'Gone', $type: 'Note' });
      const follower = await createDatabase({ ...base, path: 'app', engine, readOnly: true });
      const errors = [];
      follower.on('error', (error) => errors.push(error));
      const live = await follower.document(kept);
      const records = client.db('broken').collection('records');
      // The stream falls silent (a deployment that changed under it) while the writer goes on, then errs.
      const [stream] = records.watchers;
      records.watchers.delete(stream);
      await writer.update(kept, { title: 'Changed' });
      const added = await writer.insert({ title: 'Added', $type: 'Note' });
      await writer.delete(gone);
      await settle();
      assert.strictEqual(live.title, 'Kept', 'deaf: nothing heard');
      assert.strictEqual(follower.hasRecord(added), false);
      stream.emit('error', new Error('the resume token is gone'));
      await settle(60);
      assert.strictEqual(errors.length, 1, 'told once');
      assert.deepStrictEqual([errors[0].code, errors[0].path], ['FOLLOW_LOST', 'app']);
      assert.match(errors[0].cause.message, /resume token/);
      assert.strictEqual(live.title, 'Changed', 'read again: the live Document refreshed');
      assert.strictEqual(follower.hasRecord(added), true);
      assert.strictEqual(follower.hasRecord(gone), false, 'a record removed meanwhile lost its row');
      assert.strictEqual(await follower.get(gone), null);
      assert.deepStrictEqual((await follower.list()).sort(), [kept, added].sort());
      // Subscribed again: what the writer lands from here on is heard.
      const more = await writer.insert({ title: 'More', $type: 'Note' });
      await settle();
      assert.strictEqual(follower.hasRecord(more), true, 'follows on');
      assert.strictEqual(errors.length, 1);
      await follower.close();
      await writer.close();
    },
  );
});

test('the lease an engine holds a database by (MongoDB)', async (t) => {
  await t.test(
    'LOCKED while another instance holds the lease; taken once it lapsed; waited for under lock: wait',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'leased' });
      const a = await createDatabase({ ...base, path: 'app', engine, lock: { staleAfter: 200 } });
      const { lock } = a.stats();
      assert.deepStrictEqual([lock.kind, lock.mode, lock.lost], ['native', 'fail', false]);
      assert.ok(lock.expiresAt > Date.now() && lock.expiresAt <= Date.now() + 200, 'when the lease lapses');
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
        .updateOne({ _id: 'app' }, { $set: { owner: 'gone', expires: new Date(Date.now() - 1) } });
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
    'the lease is on the server’s clock: a client a minute ahead or behind takes no live lease; a lapsed one is taken when the server says so, the generation one up',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'clock' });
      const locks = client.db('clock').collection('locks');
      const a = await createDatabase({ ...base, path: 'app', engine, lock: { staleAfter: 200 } });
      const first = await locks.findOne({ _id: 'app' });
      assert.strictEqual(first.gen, 1);
      assert.ok(first.expires instanceof Date, 'the expiry is a Date, set on the server’s clock');
      // A client whose clock is off: `Date.now` stands for it (the fake's server clock is its own).
      const skewed = async (ms, fn) => {
        const now = Date.now;
        Date.now = () => now() + ms;
        try {
          return await fn();
        } finally {
          Date.now = now;
        }
      };
      for (const ms of [60_000, -60_000]) {
        await skewed(ms, () =>
          assert.rejects(() => createDatabase({ ...base, path: 'app', engine }), { code: 'LOCKED', path: 'app' }),
        );
      }
      const still = await locks.findOne({ _id: 'app' });
      assert.deepStrictEqual([still.owner, still.gen], [first.owner, 1], 'a skewed client took nothing');
      const errors = [];
      a.on('error', (error) => errors.push(error.code));
      // The server's clock moves past the lease, whatever any client's says: the next opener takes it.
      client.advance(201);
      const b = await createDatabase({ ...base, path: 'app', engine });
      const second = await locks.findOne({ _id: 'app' });
      assert.strictEqual(second.gen, 2);
      assert.notStrictEqual(second.owner, first.owner);
      await settle(150);
      assert.deepStrictEqual(errors, ['LEASE_LOST'], 'the old holder’s renewal found the lease another’s');
      await b.close();
      await a.close();
      // A release leaves the document, lapsed: the next lease is a newer generation still.
      const released = await locks.findOne({ _id: 'app' });
      assert.strictEqual(released.gen, 2);
      assert.ok(released.expires.getTime() < Date.now());
      const c = await createDatabase({ ...base, path: 'app', engine });
      assert.strictEqual((await locks.findOne({ _id: 'app' })).gen, 3);
      await c.close();
    },
  );

  await t.test(
    'one renewal timer per engine: every lease it holds renewed in one bulk write a tick; a lease taken over is lost alone',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'many' });
      const locks = client.db('many').collection('locks');
      const lock = { staleAfter: 90, poll: 10 };
      const a = await createDatabase({ ...base, path: 'one', engine, lock });
      const b = await createDatabase({ ...base, path: 'two', engine, lock });
      const states = { one: [], two: [] };
      a.on('lease', (event) => states.one.push(event.state));
      b.on('lease', (event) => states.two.push(event.state));
      // The fake's bulk write runs its operations through `updateOne`: a single renewal is one made outside a bulk.
      const calls = { bulk: 0, single: 0 };
      let inBulk = false;
      const bulk = locks.bulkWrite.bind(locks);
      const single = locks.updateOne.bind(locks);
      locks.bulkWrite = async (...args) => {
        calls.bulk++;
        inBulk = true;
        try {
          return await bulk(...args);
        } finally {
          inBulk = false;
        }
      };
      locks.updateOne = (...args) => {
        if (!inBulk) calls.single++;
        return single(...args);
      };
      await settle(120);
      assert.ok(calls.bulk >= 2, `the leases renewed together: ${calls.bulk} bulk writes`);
      assert.strictEqual(calls.single, 0, 'no renewal of its own while the tick lands whole');
      assert.ok(states.one.includes('renewed') && states.two.includes('renewed'));
      // Another instance takes the second: the tick lands short, each lease renews on its own, and only the taken one is lost.
      await locks.updateOne({ _id: 'two' }, { $set: { owner: 'elsewhere', gen: 2 } });
      await settle(120);
      assert.strictEqual(states.two[states.two.length - 1], 'lost');
      assert.strictEqual(b.stats().lock.lost, true);
      assert.ok(!states.one.includes('lost'));
      assert.strictEqual(a.stats().lock.lost, false);
      await a.insert({ n: 1 });
      await b.close();
      // The one lease left renews on its own; the timer goes with the last release.
      const before = calls.single;
      await settle(60);
      assert.ok(calls.single > before, 'a single lease renews with its own statement');
      await a.close();
      await settle(60);
      const after = calls.single + calls.bulk;
      await settle(60);
      assert.strictEqual(calls.single + calls.bulk, after, 'nothing renews once every lease is let go');
    },
  );

  await t.test(
    'a renewal that fails is tried again every poll while two thirds of staleAfter are left: late once, then renewed; past that, lost',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'late' });
      const locks = client.db('late').collection('locks');
      const a = await createDatabase({ ...base, path: 'app', engine, lock: { staleAfter: 300, poll: 10 } });
      const states = [];
      const errors = [];
      a.on('lease', (event) => states.push(event.state));
      a.on('error', (error) => errors.push(error.code));
      // The network blinks: two renewals in a row fail, the third lands.
      const original = locks.updateOne.bind(locks);
      let failing = 2;
      locks.updateOne = async (...args) => {
        if (failing > 0) {
          failing--;
          throw new Error('the connection blinked');
        }
        return original(...args);
      };
      await settle(180);
      assert.deepStrictEqual(states.slice(0, 2), ['late', 'renewed'], 'late once for the run, then renewed');
      assert.ok(!states.includes('lost'));
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(a.readOnly, false);
      assert.strictEqual(a.stats().lock.lost, false);
      await a.insert({ n: 1 });
      // A renewal that keeps failing is given up a third of staleAfter before the lease lapses.
      failing = Infinity;
      await settle(320);
      assert.strictEqual(states[states.length - 1], 'lost');
      assert.deepStrictEqual(errors, ['LEASE_LOST']);
      assert.strictEqual(a.stats().lock.lost, true);
      assert.strictEqual(a.stats().lock.expiresAt, null);
      locks.updateOne = original;
      await a.close();
    },
  );

  await t.test(
    'a lease taken by another instance makes its holder read-only: LEASE_LOST once, READ_ONLY after',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'lost' });
      const a = await createDatabase({ ...base, path: 'app', engine, lock: { staleAfter: 60 } });
      const errors = [];
      const states = [];
      a.on('error', (error) => errors.push(error));
      a.on('lease', (event) => states.push(event.state));
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
      assert.deepStrictEqual(states, ['lost'], 'the lease event, once');
      assert.strictEqual(a.stats().readOnly, true);
      assert.deepStrictEqual(a.stats().lock, { kind: 'native', mode: 'fail', expiresAt: null, lost: true });
      await assert.rejects(() => a.insert({ n: 2 }), { code: 'READ_ONLY', lease: true });
      await assert.rejects(() => a.update(id, { n: 2 }), { code: 'READ_ONLY' });
      assert.deepStrictEqual(await a.get(id), { n: 1 }, 'reads go on');
      await a.close();
      const lock = await client.db('lost').collection('locks').findOne({ _id: 'app' });
      assert.strictEqual(lock.owner, 'other', 'a close never releases what another instance holds');
    },
  );
});
