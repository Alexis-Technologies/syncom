'use strict';

// The engine over IndexedDB (fake-indexeddb under Node): the contract suite,
// what a write costs the medium, a reopen, another instance's writes heard
// through the channel, and a database over it.

const test = require('node:test');
const assert = require('node:assert');
const { IDBFactory, IDBKeyRange, IDBDatabase } = require('fake-indexeddb');
const { createDatabase } = require('../src/all/all.js');
const { idbEngine } = require('../src/idb/idb.js');
const { runEngineTests, stored } = require('./suites/engine.js');

let n = 0;
const vroot = async () => `/idb-${++n}`;
// One factory per engine, so the suite's databases never meet another test's.
const fresh = (options = {}) => idbEngine({ indexedDB: new IDBFactory(), IDBKeyRange, channel: null, ...options });

// How many readwrite transactions the engine opens while `fn` runs (a read is a transaction too, not a write).
const transactions = async (fn) => {
  const original = IDBDatabase.prototype.transaction;
  let count = 0;
  IDBDatabase.prototype.transaction = function (...args) {
    if (args[1] === 'readwrite') count++;
    return original.apply(this, args);
  };
  try {
    await fn();
  } finally {
    IDBDatabase.prototype.transaction = original;
  }
  return count;
};

test('IndexedDB engine', async (t) => {
  await runEngineTests(t, { create: fresh, root: vroot });

  await t.test(
    'capabilities and names: atomic write sets, exclusive create, a channel where the platform has one',
    () => {
      const engine = fresh();
      assert.strictEqual(engine.name, 'idb');
      assert.strictEqual(engine.capabilities.atomicBatch, true);
      assert.strictEqual(engine.capabilities.exclusiveCreate, true);
      assert.strictEqual(engine.capabilities.changeStream, false, 'channel: null');
      assert.strictEqual(fresh({ channel: BroadcastChannel }).capabilities.changeStream, true);
      assert.throws(() => idbEngine({ indexedDB: null, IDBKeyRange }), { name: 'TypeError', message: /no indexedDB/ });
      assert.throws(() => idbEngine({ indexedDB: new IDBFactory(), IDBKeyRange: null }), {
        name: 'TypeError',
        message: /no IDBKeyRange/,
      });
    },
  );

  await t.test(
    'a write set is ONE transaction; a database’s write costs two (the log group, the landing)',
    async () => {
      const engine = fresh();
      const db = await engine.open('/one');
      // The connection and its upgrade first: what is counted is the write's own.
      await db.kv.has('', 'warm');
      const count = await transactions(() =>
        db.write({
          records: [
            { id: 'a', stored: stored({ n: 1 }), pieces: { put: [['a~1.json', '{}']] } },
            { id: 'b', stored: stored({ n: 2 }) },
          ],
          kv: { put: [['blockchain', 'h.json', '{}', undefined]] },
          copies: { put: [['v1', 'a', '{}']] },
        }),
      );
      assert.strictEqual(count, 1);
      const database = await createDatabase({
        path: '/app',
        engine,
        logger: false,
        defer: 0,
        lock: false,
        chain: false,
      });
      const perWrite = await transactions(() => database.insert({ title: 'x' }));
      assert.strictEqual(perWrite, 2, 'the log group and the landing (an insert reads once besides: is the id free)');
      const perTransaction = await transactions(() =>
        database.transact(async (tx) => {
          for (let i = 0; i < 50; i++) await tx.insert({ n: i });
        }),
      );
      assert.strictEqual(perTransaction, 2, 'fifty records: the same two');
      await database.close();
      // With the chain on, the block and its tail ride in the landing's write set: still two.
      const chained = await createDatabase({ path: '/chained', engine, logger: false, defer: 0, lock: false });
      await chained.insert({ title: 'warm' });
      const withChain = await transactions(() => chained.insert({ title: 'x' }));
      assert.strictEqual(withChain, 2, 'the chain block and its tail ride in the landing');
      assert.strictEqual(await chained.validate(), true);
      await chained.close();
      await engine.close();
    },
  );

  await t.test(
    'a database over the engine survives a reopen and the engine’s close; remove(path) takes it; destroy() takes the IndexedDB database',
    async () => {
      const factory = new IDBFactory();
      const engine = idbEngine({ indexedDB: factory, IDBKeyRange, channel: null, name: 'app' });
      const options = { path: 'store', engine, logger: false, defer: 0, lock: false };
      const db = await createDatabase(options);
      const id = await db.insert({ title: 'Draft' });
      await db.push(id, 'body', 'y'.repeat(3000));
      await db.tag('v1');
      await db.update(id, { title: 'Final' });
      await db.close();
      await engine.close();
      const again = await createDatabase(options);
      assert.strictEqual(again.nodeId, db.nodeId);
      assert.deepStrictEqual((await again.get(id)).title, 'Final');
      assert.strictEqual((await again.get(id)).body.length, 3000);
      assert.deepStrictEqual((await again.at('v1').get(id)).title, 'Draft');
      assert.strictEqual(await again.validate(), true, 'the chain reads back');
      await again.close();
      await engine.remove('store');
      const empty = await createDatabase(options);
      assert.deepStrictEqual(await empty.list(), []);
      await empty.close();
      await engine.destroy();
      const names = await factory.databases();
      assert.strictEqual(
        names.some((entry) => entry.name === 'app'),
        false,
      );
    },
  );

  await t.test('another instance over the same database hears a write set and a log group, never its own', async () => {
    const factory = new IDBFactory();
    const a = idbEngine({ indexedDB: factory, IDBKeyRange, name: 'shared' });
    const b = idbEngine({ indexedDB: factory, IDBKeyRange, name: 'shared' });
    const other = idbEngine({ indexedDB: factory, IDBKeyRange, name: 'other' });
    const heard = [];
    const own = [];
    const dbA = await a.open('/p');
    const dbB = await b.open('/p');
    const dbOther = await other.open('/p');
    const stop = dbB.changes.subscribe((message) => heard.push(message));
    const stopOwn = dbA.changes.subscribe((message) => own.push(message));
    await dbA.write({ records: [{ id: 'r', stored: stored({}) }] });
    await dbA.log.append([{ seq: 1, op: { type: 'write', id: 'r' } }], null, { first: 1, last: 1, onFail() {} });
    await dbOther.write({ records: [{ id: 'elsewhere', stored: stored({}) }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(
      heard.map((m) => ({ p: m.p, records: m.records, log: m.log })),
      [
        { p: '/p', records: ['r'], log: undefined },
        { p: '/p', records: undefined, log: [1, 1] },
      ],
    );
    assert.deepStrictEqual(own, [], 'an instance never hears itself');
    stop();
    stopOwn();
    await a.close();
    await b.close();
    await other.close();
  });

  await t.test(
    'the log over rows: a reopen replays the unsealed groups, a roll seals a range, compaction drops rows',
    async () => {
      const engine = fresh();
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
      // The purge is one more op; its roll may move the floor again. A reopen reads the same counters.
      const { floor, next, length } = db.stats().log;
      await db.close();
      const again = await createDatabase(options);
      const reopened = again.stats().log;
      assert.deepStrictEqual([reopened.floor, reopened.next, reopened.length], [floor, next, length]);
      assert.deepStrictEqual(await again.get(ids[10]), { n: 10 });
      assert.strictEqual(await again.get(ids[11]), null);
      await again.close();
    },
  );
});
