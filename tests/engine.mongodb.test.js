'use strict';

// The engine over MongoDB: the contract suite over the driver in memory
// (tests/utils/fake-mongo.js) with and without transactions, what a write
// costs the medium, a set that fails midway, another instance's change
// stream, a database over it, the log over documents — and the same contract
// over the real driver when MONGODB_URL names a replica set.

const test = require('node:test');
const assert = require('node:assert');
const { createDatabase, memoryEngine } = require('../src/all/all.js');
const { outbound } = require('../index.js');
const { mongoEngine } = require('../src/mongodb/mongodb.js');
const { createFakeMongo, FakeCollection } = require('./utils/fake-mongo.js');
const { runEngineTests, stored } = require('./suites/engine.js');

// A database whose `log` collection, once `arm()`ed, lands the next bulk
// write and then reports it failed — the acknowledgement lost on the way
// back; the driver's Db and the fake's alike.
const ackLostOnce = (database) => {
  let armed = false;
  const db = {
    collection(name) {
      const collection = database.collection(name);
      if (name !== 'log') return collection;
      return new Proxy(collection, {
        get(target, key) {
          if (key !== 'bulkWrite') {
            const member = target[key];
            return typeof member === 'function' ? member.bind(target) : member;
          }
          return async (...args) => {
            const result = await target.bulkWrite(...args);
            if (!armed) return result;
            armed = false;
            throw new Error('the acknowledgement was lost after the group landed');
          };
        },
      });
    },
    dropDatabase: () => database.dropDatabase(),
  };
  return {
    db,
    arm: () => {
      armed = true;
    },
  };
};

// R-16: a group that failed after it landed is not a group — the same over the fake and the driver.
const failedGroupIsNoGroup = async (database, path) => {
  const lossy = ackLostOnce(database);
  const engine = mongoEngine({ db: lossy.db });
  const options = { path, engine, logger: false, defer: 0, lock: false, chain: false };
  const db = await createDatabase(options);
  const a = await db.insert({ n: 'a' });
  lossy.arm();
  await assert.rejects(
    () =>
      db.transact(async (tx) => {
        await tx.insert({ n: 'p1' });
        await tx.insert({ n: 'p2' });
        await tx.insert({ n: 'p3' });
      }),
    { message: /acknowledgement was lost/ },
  );
  assert.strictEqual(db.stats().log.appendFailures, 1);
  const b = await db.insert({ n: 'b' });
  await db.close();
  const again = await createDatabase(options);
  const values = [];
  for (const id of await again.list()) values.push((await again.get(id)).n);
  assert.deepStrictEqual(values.sort(), ['a', 'b'], 'nothing of the rejected transaction came back');
  assert.deepStrictEqual((await again.list()).sort(), [a, b].sort());
  const docs = await database
    .collection('log')
    .find({ p: path }, { sort: { seq: 1 } })
    .toArray();
  const seqs = [];
  for (const doc of docs) seqs.push([doc.seq, doc.first, doc.last]);
  assert.deepStrictEqual(seqs, [
    [1, 1, 1],
    [2, 2, 2],
  ]);
  // The stream chains whole: a peer takes every op.
  const peer = await createDatabase({ path: 'peer', engine: memoryEngine(), logger: false, defer: 0, lock: false });
  const errors = [];
  peer.on('error', (error) => errors.push(error.code));
  const toPeer = outbound(again.log, { exclude: peer.nodeId, vector: peer.vector, own: again.nodeId });
  const result = await peer.applyRemote(toPeer.ops);
  assert.deepStrictEqual([result.applied, result.equivocations, errors], [toPeer.ops.length, 0, []]);
  assert.deepStrictEqual((await peer.list()).sort(), [a, b].sort());
  await again.close();
  await peer.close();
};

let n = 0;
const vroot = async () => `/mongo-${++n}`;
const fresh = (options = {}) => mongoEngine({ client: createFakeMongo(), ...options });

// How many bulk writes the fake's collections took while `fn` ran; `failing` names a collection whose bulk writes throw.
const bulkWrites = async (fn, { failing = null } = {}) => {
  const original = FakeCollection.prototype.bulkWrite;
  let count = 0;
  FakeCollection.prototype.bulkWrite = function (...args) {
    if (this.collectionName === failing) throw new Error(`refused: ${failing}`);
    count++;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    FakeCollection.prototype.bulkWrite = original;
  }
  return count;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('MongoDB engine (the driver in memory)', async (t) => {
  await t.test('the contract, in order', async (t2) => {
    await runEngineTests(t2, { create: () => fresh(), root: vroot });
  });
  await t.test('the contract, in transactions', async (t2) => {
    await runEngineTests(t2, { create: () => fresh({ transactions: true }), root: vroot });
  });

  await t.test(
    'capabilities and names: atomic with transactions, exclusive create, a change stream unless told not',
    () => {
      const engine = fresh();
      assert.strictEqual(engine.name, 'mongodb');
      assert.strictEqual(engine.capabilities.atomicBatch, false);
      assert.strictEqual(engine.capabilities.exclusiveCreate, true);
      assert.strictEqual(engine.capabilities.changeStream, true);
      assert.strictEqual(fresh({ transactions: true }).capabilities.atomicBatch, true);
      assert.strictEqual(fresh({ changes: false }).capabilities.changeStream, false);
      const client = createFakeMongo();
      assert.strictEqual(mongoEngine({ client, name: 'named' }).database, client.db('named'));
      assert.strictEqual(mongoEngine({ db: client.db('given') }).database, client.db('given'));
      assert.throws(() => mongoEngine(), { name: 'TypeError', message: /client|database/ });
      assert.throws(() => mongoEngine({ client: {} }), { name: 'TypeError', message: /client/ });
      assert.throws(() => mongoEngine({ db: client.db('x'), transactions: true }), {
        name: 'TypeError',
        message: /sessions/,
      });
      assert.throws(() => mongoEngine({ db: {} }), { name: 'TypeError', message: /no collection/ });
    },
  );

  await t.test(
    'a write set is a bulk write per collection, in the files engine’s order; a database’s write costs two (the log group, the landing)',
    async () => {
      const engine = fresh();
      const db = await engine.open('/p');
      const count = await bulkWrites(() =>
        db.write({
          records: [
            { id: 'a', stored: stored({ n: 1 }), pieces: { put: [['a~1.json', '{}']] } },
            { id: 'b', stored: stored({ n: 2 }) },
          ],
          kv: { put: [['blockchain', 'h.json', '{}', undefined]] },
          copies: { put: [['v1', 'a', '{}']] },
        }),
      );
      assert.strictEqual(count, 4, 'kv, pieces, records, copies');
      assert.strictEqual(await bulkWrites(() => db.write({})), 0, 'an empty write set is nothing');
      const plain = await createDatabase({ path: '/app', engine, logger: false, defer: 0, lock: false, chain: false });
      await plain.insert({ title: 'warm' });
      assert.strictEqual(await bulkWrites(() => plain.insert({ title: 'x' })), 2, 'the log group and the landing');
      const perTransaction = await bulkWrites(() =>
        plain.transact(async (tx) => {
          for (let i = 0; i < 50; i++) await tx.insert({ n: i });
        }),
      );
      assert.strictEqual(perTransaction, 2, 'fifty records: the same two');
      await plain.close();
      const chained = await createDatabase({ path: '/chained', engine, logger: false, defer: 0, lock: false });
      await chained.insert({ title: 'warm' });
      const withChain = await bulkWrites(() => chained.insert({ title: 'x' }));
      assert.strictEqual(withChain, 3, 'the chain block and its tail are the kv collection’s bulk write');
      assert.strictEqual(await chained.validate(), true);
      await chained.close();
    },
  );

  await t.test('a set that fails midway lands in order without transactions and not at all with them', async () => {
    const set = {
      kv: { put: [['', 'new.json', '2', undefined]], remove: [['', 'kept.json']] },
      records: [{ id: 'r', stored: stored({ n: 1 }), pieces: { put: [['r~1.json', '{}']] } }],
      copies: { put: [['v1', 'r', '{}']] },
    };
    const ordered = await fresh().open('/p');
    await ordered.kv.put('', 'kept.json', '1');
    await assert.rejects(() => bulkWrites(() => ordered.write(set), { failing: 'copies' }), { message: /refused/ });
    assert.deepStrictEqual((await ordered.records.get('r')).data, { n: 1 }, 'what came before the failure landed');
    assert.strictEqual(await ordered.pieces.get('r', 'r~1.json'), '{}');
    assert.strictEqual(await ordered.kv.get('', 'new.json'), '2');
    assert.strictEqual(await ordered.kv.get('', 'kept.json'), '1', 'the kv removals come last: not yet');
    assert.strictEqual(await ordered.copies.get('v1', 'r'), null);
    await ordered.write(set);
    assert.strictEqual(await ordered.kv.get('', 'kept.json'), null, 'landed again whole: the same set, idempotent');
    assert.strictEqual(await ordered.copies.get('v1', 'r'), '{}');
    const atomic = await fresh({ transactions: true }).open('/p');
    await atomic.kv.put('', 'kept.json', '1');
    await assert.rejects(() => bulkWrites(() => atomic.write(set), { failing: 'copies' }), { message: /refused/ });
    assert.strictEqual(await atomic.records.get('r'), null, 'nothing of the set');
    assert.strictEqual(await atomic.pieces.get('r', 'r~1.json'), null);
    assert.strictEqual(await atomic.kv.get('', 'new.json'), null);
    assert.strictEqual(await atomic.kv.get('', 'kept.json'), '1');
    await atomic.write(set);
    assert.deepStrictEqual((await atomic.records.get('r')).data, { n: 1 }, 'the next set lands');
  });

  await t.test(
    'a log group whose write failed after it landed is wiped, never replayed: the seqs it left are the next group’s',
    async () => {
      await failedGroupIsNoGroup(createFakeMongo().db('r16'), '/app');
    },
  );

  await t.test(
    'another instance over the same database hears a record and a log document, never its own; a removal once',
    async () => {
      const client = createFakeMongo();
      const a = mongoEngine({ client, name: 'shared' });
      const b = mongoEngine({ client, name: 'shared' });
      const other = mongoEngine({ client, name: 'other' });
      const heard = [];
      const own = [];
      const dbA = await a.open('/p');
      const dbB = await b.open('/p');
      const dbOther = await other.open('/p');
      const elsewhere = await a.open('/q');
      const stop = dbB.changes.subscribe((message) => heard.push(message));
      const stopOwn = dbA.changes.subscribe((message) => own.push(message));
      await dbA.write({ records: [{ id: 'r', stored: stored({}) }] });
      await dbA.log.append([{ seq: 1, op: { type: 'write', id: 'r' } }], null, { first: 1, last: 1, onFail() {} });
      await dbOther.write({ records: [{ id: 'elsewhere', stored: stored({}) }] });
      await elsewhere.write({ records: [{ id: 'q', stored: stored({}) }] });
      await dbA.write({ remove: ['r'] });
      await settle();
      assert.deepStrictEqual(heard, [
        { p: '/p', records: ['r'] },
        { p: '/p', log: [1, 1] },
        { p: '/p', records: ['r'] },
      ]);
      assert.deepStrictEqual(own, [], 'an instance never hears itself, its removals included');
      stop();
      stopOwn();
      await dbB.write({ records: [{ id: 's', stored: stored({}) }] });
      await settle();
      assert.strictEqual(heard.length, 3, 'unsubscribed');
    },
  );

  await t.test(
    'a database over the engine: writes, pieces, tags, the chain; a reopen through another engine over the client; remove(path); destroy()',
    async () => {
      const client = createFakeMongo();
      const first = mongoEngine({ client, name: 'app', transactions: true });
      const options = { path: 'store', logger: false, defer: 0, lock: false };
      const db = await createDatabase({ ...options, engine: first });
      const id = await db.insert({ title: 'Draft' });
      await db.push(id, 'body', 'y'.repeat(3000));
      await db.tag('v1');
      await db.update(id, { title: 'Final' });
      await db.close();
      await first.close();
      const second = mongoEngine({ client, name: 'app' });
      const again = await createDatabase({ ...options, engine: second });
      assert.strictEqual(again.nodeId, db.nodeId);
      assert.strictEqual((await again.get(id)).title, 'Final');
      assert.strictEqual((await again.get(id)).body.length, 3000);
      assert.deepStrictEqual((await again.at('v1').get(id)).title, 'Draft');
      assert.strictEqual(await again.validate(), true, 'the chain reads back');
      await again.close();
      await second.remove('store');
      const empty = await createDatabase({ ...options, engine: second });
      assert.deepStrictEqual(await empty.list(), []);
      await empty.close();
      await second.destroy();
      assert.deepStrictEqual(await client.db('app').listCollections(), []);
    },
  );

  await t.test(
    'the log over documents: a reopen replays the unsealed groups, a roll seals a range, compaction drops documents',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'log' });
      const options = {
        path: '/log',
        engine,
        logger: false,
        defer: 0,
        lock: false,
        sync: { log: { rollAfter: 2 }, retention: { ops: 6 } },
      };
      const db = await createDatabase(options);
      const ids = [];
      for (let i = 0; i < 12; i++) ids.push(await db.insert({ n: i }));
      await db.flush();
      assert.ok(db.stats().log.floor > 1, 'compacted');
      await db.purge(ids[11]);
      const { floor, next, length } = db.stats().log;
      await db.close();
      const again = await createDatabase(options);
      const reopened = again.stats().log;
      assert.deepStrictEqual([reopened.floor, reopened.next, reopened.length], [floor, next, length]);
      assert.deepStrictEqual(await again.get(ids[10]), { n: 10 });
      assert.strictEqual(await again.get(ids[11]), null);
      const kept = await client.db('log').collection('log').countDocuments({ p: '/log' });
      assert.strictEqual(kept, length, 'a document per retained entry');
      await again.close();
    },
  );
});

const url = process.env.MONGODB_URL;
test('MongoDB engine (the driver)', { skip: url ? false : 'MONGODB_URL unset' }, async (t) => {
  const { MongoClient } = require('mongodb');
  const client = await new MongoClient(url).connect();
  const name = `syncom-test-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  t.after(async () => {
    await client.db(name).dropDatabase();
    await client.close();
  });
  await runEngineTests(t, { create: () => mongoEngine({ client, name, transactions: true }), root: vroot });

  await t.test(
    'a log group whose write failed after it landed is wiped, never replayed: the seqs it left are the next group’s (the driver)',
    async () => {
      await failedGroupIsNoGroup(client.db(name), '/r16');
    },
  );

  await t.test(
    'a database over the driver: writes, pieces, tags, the chain, a reopen; a follower hears it',
    async () => {
      const engine = mongoEngine({ client, name, transactions: true });
      const follower = mongoEngine({ client, name });
      const heard = [];
      const stop = (await follower.open('real')).changes.subscribe((message) => heard.push(message));
      const options = { path: 'real', engine, logger: false, defer: 0, lock: false };
      const db = await createDatabase(options);
      const id = await db.insert({ title: 'Draft' });
      await db.push(id, 'body', 'y'.repeat(3000));
      await db.tag('v1');
      await db.update(id, { title: 'Final' });
      await db.close();
      const again = await createDatabase(options);
      assert.strictEqual(again.nodeId, db.nodeId);
      assert.strictEqual((await again.get(id)).title, 'Final');
      assert.strictEqual((await again.get(id)).body.length, 3000);
      assert.deepStrictEqual((await again.at('v1').get(id)).title, 'Draft');
      assert.strictEqual(await again.validate(), true);
      await again.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      stop();
      assert.ok(
        heard.some((message) => message.records?.[0] === id),
        'the follower heard the record',
      );
      assert.ok(
        heard.some((message) => message.log !== undefined),
        'and the log',
      );
    },
  );
});
