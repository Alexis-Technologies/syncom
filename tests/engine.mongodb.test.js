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
const until = async (check, what, timeout = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await settle();
  }
};

// Every document of every collection, by `_id`: what a comparison before and after reads.
// Every document of the database at `path`, by collection — the lease document included: what a fence test
// compares, and nothing of another path's (over the driver one database serves every test of the file).
const dump = async (database, path) => {
  const out = [];
  for (const name of ['kv', 'records', 'pieces', 'copies', 'log', 'meta', 'catalog', 'locks']) {
    const filter = name === 'locks' ? { _id: path } : { p: path };
    const docs = await database.collection(name).find(filter).toArray();
    docs.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    out.push([name, docs]);
  }
  return out;
};
const docIn = (dumped, collection, _id) => {
  for (const [name, docs] of dumped) if (name === collection) for (const doc of docs) if (doc._id === _id) return doc;
  return null;
};

// Another instance finding the lease lapsed and taking it — what `lock()` does, by hand.
const takeOver = (database, path) =>
  database
    .collection('locks')
    .findOneAndUpdate({ _id: path }, [
      { $set: { owner: 'other', gen: { $add: [{ $ifNull: ['$gen', 0] }, 1] }, expires: { $add: ['$$NOW', 60_000] } } },
    ]);

// S-2: the fence — every document a handle writes carries its lease's
// generation, and none of a newer lease is written over, removed or sealed
// by an older one; the same over the fake and the driver, with and without
// transactions.
const fenceHolds = async (client, name, path, transactions) => {
  const database = client.db(name);
  const engine = mongoEngine({ client, name, transactions });
  const old = await engine.open(path);
  const lost = [];
  const lease = await old.lock({ staleAfter: 60, onLost: (error) => lost.push(error) });
  assert.strictEqual(lease.gen, 1);
  const set = (n) => ({
    records: [{ id: 'r', stored: stored({ n }), pieces: { put: [['r~1.json', `{"n":${n}}`]] } }],
    kv: { put: [['', 'node.json', `{"n":${n}}`, undefined]] },
    copies: { put: [['v1', 'r', `{"n":${n}}`]] },
  });
  await old.write(set(1));
  await old.log.append([{ seq: 1, op: { type: 'write', id: 'r', n: 1 } }], null, { first: 1, last: 1, onFail() {} });
  await old.log.saveIndex({ floor: 1, n: 1 });
  await old.log.seal([{ seq: 1 }], 1, 1);
  for (const [collection, docs] of await dump(database, path)) {
    if (collection !== 'locks') for (const doc of docs) assert.strictEqual(doc.gen, 1, `${collection} ${doc._id}`);
  }
  await takeOver(database, path);
  await until(() => lost.length === 1, 'the lease lost');
  // A handle opened now writes as the generation the lease document holds — the new holder's.
  const next = await engine.open(path);
  await next.write(set(2));
  await next.log.append([{ seq: 1, op: { type: 'write', id: 'r', n: 2 } }], null, { first: 1, last: 1, onFail() {} });
  await next.log.saveIndex({ floor: 1, n: 2 });
  await next.log.seal([{ seq: 1 }], 1, 1);
  const before = await dump(database, path);
  for (const [collection, docs] of before) {
    if (collection !== 'locks') for (const doc of docs) assert.strictEqual(doc.gen, 2, `${collection} ${doc._id}`);
  }
  // The old generation over the new one's documents: every statement refused, nothing moved.
  const refused = { code: 'LEASE_LOST', path };
  await assert.rejects(() => old.write(set('stale')), refused);
  await assert.rejects(() => old.kv.put('', 'node.json', '{"n":"stale"}'), refused);
  await assert.rejects(() => old.copies.put('v1', 'r', '{"n":"stale"}'), refused);
  const failures = [];
  const appended = await old.log.append([{ seq: 1, op: { type: 'write', id: 'r', n: 'stale' } }], null, {
    first: 1,
    last: 1,
    onFail: (error) => failures.push(error),
  });
  assert.deepStrictEqual([appended, failures.length, failures[0]?.code], [false, 1, 'LEASE_LOST']);
  await assert.rejects(() => old.log.saveIndex({ floor: 1, n: 'stale' }), refused);
  await assert.rejects(() => old.log.seal([{ seq: 1 }], 1, 1), refused);
  if (transactions) {
    // The lease is checked first, inside the transaction: nothing of an old generation lands, a removal or a document nobody newer wrote included.
    await assert.rejects(() => old.write({ remove: ['r'], kv: { remove: [['', 'node.json']] } }), refused);
    await assert.rejects(() => old.copies.drop('v1'), refused);
    await assert.rejects(() => old.write({ records: [{ id: 'fresh', stored: stored({}) }] }), refused);
  } else {
    // The fence is per document: a removal of a newer document is nothing, and where nothing newer sits the old generation lands.
    await old.write({ remove: ['r'], kv: { remove: [['', 'node.json']] } });
    await old.copies.drop('v1');
    await old.write({ records: [{ id: 'fresh', stored: stored({}) }] });
    const fresh = JSON.stringify([path, 'fresh']);
    assert.strictEqual((await database.collection('records').findOne({ _id: fresh })).gen, 1);
    await database.collection('records').deleteOne({ _id: fresh });
  }
  await lease.release();
  assert.deepStrictEqual(
    await dump(database, path),
    before,
    'no document of the newer lease was written over, removed or sealed',
  );
  assert.strictEqual(
    (await database.collection('locks').findOne({ _id: path })).owner,
    'other',
    'a release lets go of nothing another holds',
  );
};

// S-2, the database: a writer whose lease was lost writes nothing more — not at its close either.
const lostLeaseWritesNothing = async (client, name, path) => {
  const database = client.db(name);
  const engine = mongoEngine({ client, name });
  const options = { path, engine, logger: false, lock: { staleAfter: 60 } };
  const a = await createDatabase({ ...options, defer: 1000 });
  const errors = [];
  a.on('error', (error) => errors.push(error));
  const r = await a.insert({ title: 'first' });
  await a.flush();
  // Logged; its file waits in the deferred window.
  const x = await a.insert({ title: 'deferred' });
  assert.strictEqual(a.stats().deferred, 1);
  await takeOver(database, path);
  await until(() => errors.length === 1, 'LEASE_LOST');
  assert.strictEqual(errors[0].code, 'LEASE_LOST');
  assert.strictEqual(a.readOnly, true);
  // The new holder — a database that never locks writes as the generation the lease document holds — replays the tail and writes on.
  const b = await createDatabase({ ...options, lock: false, defer: 0 });
  assert.strictEqual((await b.get(x)).title, 'deferred', 'the log held x: the new holder replayed it');
  await b.update(r, { title: 'second' });
  await b.close();
  const before = await dump(database, path);
  assert.strictEqual(docIn(before, 'records', JSON.stringify([path, r])).gen, 2);
  assert.strictEqual(docIn(before, 'records', JSON.stringify([path, x])).gen, 2);
  assert.strictEqual(docIn(before, 'meta', JSON.stringify([path, 'index'])).gen, 2);
  // The old holder closes: no roll, no index, no catalog, the deferred window held as UNPERSISTED — nothing written.
  await a.close();
  assert.strictEqual(errors.length, 2);
  assert.strictEqual(errors[1].code, 'UNPERSISTED');
  assert.deepStrictEqual(errors[1].ids, [x]);
  assert.deepStrictEqual(await dump(database, path), before, 'the old holder’s close wrote nothing');
};

test('MongoDB engine (the driver in memory)', async (t) => {
  await t.test('the contract, in order', async (t2) => {
    await runEngineTests(t2, { create: () => fresh(), root: vroot });
  });
  await t.test('the contract, in transactions', async (t2) => {
    await runEngineTests(t2, { create: () => fresh({ transactions: true }), root: vroot });
  });

  await t.test(
    'a blob past one document is chunked and read back whole; has, list and remove see one blob',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, name: 'chunked' });
      const db = await engine.open('/c', { logger: null });
      const collection = engine.database.collection('blobs');
      const CHUNK = 15 * 1024 * 1024;
      // Two parts and a byte: three documents of bytes and a head — none past the driver's 16 MiB.
      const big = new Uint8Array(2 * CHUNK + 1);
      for (let i = 0; i < big.length; i += 4099) big[i] = (i / 4099) & 255;
      big[big.length - 1] = 77;
      const digest = 'c'.repeat(64);
      await db.blobs.put(digest, big);
      assert.strictEqual(await collection.countDocuments({ p: '/c', digest }), 4);
      const head = await collection.findOne({ _id: JSON.stringify(['/c', digest, 0]) });
      assert.deepStrictEqual(
        { parts: head.parts, length: head.length, n: head.n },
        { parts: 3, length: big.length, n: 0 },
      );
      const parts = await collection.find({ p: '/c', digest, n: { $gte: 1 } }).toArray();
      assert.ok(parts.every((doc) => doc.b.length <= CHUNK));
      const back = await db.blobs.get(digest);
      assert.strictEqual(back.length, big.length);
      assert.strictEqual(back[big.length - 1], 77);
      assert.strictEqual(back[4099 * 5000], 5000 & 255, 'a byte of the second part, where it was');
      assert.ok(Buffer.from(back).equals(Buffer.from(big)), 'read back whole, in order');
      // Small blobs are a part and a head; has, list and remove see a blob, never its parts.
      const small = 'd'.repeat(64);
      await db.blobs.put(small, new Uint8Array([1, 2, 3]));
      await db.blobs.put('e'.repeat(64), new Uint8Array(0));
      assert.strictEqual(await collection.countDocuments({ p: '/c', digest: small }), 2);
      assert.strictEqual(
        await collection.countDocuments({ p: '/c', digest: 'e'.repeat(64) }),
        1,
        'an empty blob is its head',
      );
      assert.strictEqual(await db.blobs.has(digest), true);
      assert.strictEqual(await db.blobs.has(small), true);
      assert.deepStrictEqual(await db.blobs.list(), [digest, small, 'e'.repeat(64)]);
      assert.deepStrictEqual([...(await db.blobs.get('e'.repeat(64)))], []);
      await db.blobs.remove(digest);
      assert.strictEqual(await collection.countDocuments({ p: '/c', digest }), 0, 'every part gone');
      assert.strictEqual(await db.blobs.has(digest), false);
      assert.strictEqual(await db.blobs.get(digest), null);
      assert.deepStrictEqual(await db.blobs.list(), [small, 'e'.repeat(64)]);
      // A head without its parts (a put cut short the other way round never happens: the head goes last) reads as none.
      await collection.deleteMany({ p: '/c', digest: small, n: 1 });
      assert.strictEqual(await db.blobs.get(small), null);
      // The room is the server's to know: nothing said.
      assert.strictEqual(db.estimate, undefined);
      await db.close();
    },
  );

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
    // The order is the files engine's: kv puts, a tag's copies, the pieces a record makes, the records, the pieces
    // it drops, kv removals — a failure at the records leaves the copy and the pieces, never a changed record alone.
    await assert.rejects(() => bulkWrites(() => ordered.write(set), { failing: 'records' }), { message: /refused/ });
    assert.strictEqual(await ordered.records.get('r'), null, 'the record did not land');
    assert.strictEqual(await ordered.pieces.get('r', 'r~1.json'), '{}', 'the pieces it makes came before it');
    assert.strictEqual(await ordered.kv.get('', 'new.json'), '2');
    assert.strictEqual(await ordered.copies.get('v1', 'r'), '{}', 'the tag’s copy came before the record');
    assert.strictEqual(await ordered.kv.get('', 'kept.json'), '1', 'the kv removals come last: not yet');
    await ordered.write(set);
    assert.deepStrictEqual(
      (await ordered.records.get('r')).data,
      { n: 1 },
      'landed again whole: the same set, idempotent',
    );
    assert.strictEqual(await ordered.kv.get('', 'kept.json'), null);
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
    'a lease taken by another instance fences the old holder: every statement over a newer document is LEASE_LOST, in order and in transactions',
    async () => {
      await fenceHolds(createFakeMongo(), 'fence', '/app', false);
      await fenceHolds(createFakeMongo(), 'fence', '/app', true);
    },
  );

  await t.test(
    'a writer whose lease was lost writes nothing more, not at its close: the deferred window is UNPERSISTED',
    async () => {
      await lostLeaseWritesNothing(createFakeMongo(), 'lost', '/app');
    },
  );

  await t.test(
    'another instance over the same database hears a record document, never its own; a removal once; the stream’s end as an error',
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
        { p: '/p', records: ['r'] },
      ]);
      assert.deepStrictEqual(own, [], 'an instance never hears itself, its removals included');
      stop();
      stopOwn();
      await dbB.write({ records: [{ id: 's', stored: stored({}) }] });
      await settle();
      assert.strictEqual(heard.length, 2, 'unsubscribed');
      // The stream watches `records` of this path alone, without the record's text; an update is looked up.
      const records = client.db('shared').collection('records');
      const raw = [];
      const stream = records.watch([{ $match: { 'fullDocument.p': '/p' } }, { $project: { 'fullDocument.t': 0 } }], {
        fullDocument: 'updateLookup',
      });
      stream.on('change', (event) => raw.push(event));
      await dbA.write({ records: [{ id: 'u', stored: stored({ n: 1 }) }] });
      await dbA.write({ records: [{ id: 'u', stored: stored({ n: 2 }) }] });
      await settle();
      assert.deepStrictEqual(
        raw.map((event) => [event.operationType, event.fullDocument.id, 't' in event.fullDocument]),
        [
          ['insert', 'u', false],
          ['update', 'u', false],
        ],
      );
      await stream.close();
      // The stream's end — an error — reaches the subscriber once as `{ error }`, and the subscription is over.
      const ended = [];
      dbB.changes.subscribe((message) => ended.push(message));
      records.breakStreams(new Error('the resume token is gone'));
      await settle();
      await dbA.write({ records: [{ id: 'after', stored: stored({}) }] });
      await settle();
      assert.strictEqual(ended.length, 1);
      assert.strictEqual(ended[0].p, '/p');
      assert.match(ended[0].error.message, /resume token/);
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
test('MongoDB engine (the driver in memory): the catalog and what does not read', async (t) => {
  await t.test(
    'the catalog is a document a record: a save writes what changed, a reopen reads them, other indexes replace them',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, changes: false });
      const schema = { entities: { Note: { index: ['kind'] } } };
      const options = { path: 'cat', engine, logger: false, defer: 0, lock: false, chain: false, schema };
      const rows = async () => client.db('syncom').collection('catalog').find({ p: 'cat' }).toArray();
      const db = await createDatabase(options);
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push(await db.insert({ $type: 'Note', kind: i % 2 ? 'a' : 'b' }));
      await db.close();
      assert.strictEqual((await rows()).length, 5, 'a document a record');
      const again = await createDatabase(options);
      assert.strictEqual(
        (await again.Note.select({ kind: 'a' }).fetch()).length,
        2,
        'read from the documents, not rebuilt',
      );
      await again.update(ids[1], { kind: 'b' });
      await again.delete(ids[0]);
      await again.close();
      const after = await rows();
      assert.strictEqual(
        JSON.parse(after.find((doc) => doc.id === ids[1]).row).fields.kind,
        'b',
        'the row that changed was written',
      );
      assert.strictEqual(
        JSON.parse(after.find((doc) => doc.id === ids[0]).row).gone,
        true,
        'a tombstone is a row flagged gone',
      );
      const other = { ...options, schema: { entities: { Note: { index: ['kind', 'title'] } } } };
      const rebuilt = await createDatabase(other);
      await rebuilt.insert({ $type: 'Note', kind: 'c', title: 't' });
      await rebuilt.close();
      assert.strictEqual((await rows()).length, 6, 'other indexes: every document replaced, none left over');
    },
  );

  await t.test(
    'a log document that does not parse is counted corrupt and left out; a meta document that does not is none',
    async () => {
      const client = createFakeMongo();
      const engine = mongoEngine({ client, changes: false });
      const options = { path: 'rows', engine, logger: false, defer: 0, lock: false, chain: false };
      const db = await createDatabase(options);
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await db.insert({ n: i }));
      await db.close();
      const log = client.db('syncom').collection('log');
      await log.updateOne({ p: 'rows', seq: 2 }, { $set: { e: 'garbage' } });
      await client
        .db('syncom')
        .collection('meta')
        .updateOne({ p: 'rows', key: 'index' }, { $set: { v: '{not json' } });
      const warned = [];
      const logger = { warn: (event) => warned.push(event.event), info() {}, error() {}, debug() {} };
      const again = await createDatabase({ ...options, logger });
      const { corrupt, lost } = again.stats().log;
      assert.deepStrictEqual([corrupt, lost], [1, true]);
      assert.ok(warned.includes('log.row.unreadable') && warned.includes('log.meta.unreadable'), warned.join(','));
      for (const id of ids) assert.ok(await again.get(id), 'the records are on their documents still');
      await again.close();
    },
  );
});

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

  await t.test('a lease taken by another instance fences the old holder (the driver)', async () => {
    await fenceHolds(client, name, '/fence-ordered', false);
    await fenceHolds(client, name, '/fence-transactions', true);
  });

  await t.test('a writer whose lease was lost writes nothing more, not at its close (the driver)', async () => {
    await lostLeaseWritesNothing(client, name, '/lost');
  });

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
        heard.every((message) => message.log === undefined && message.error === undefined),
        'the records alone, and no error',
      );
    },
  );
});
