'use strict';

// An engine served over a message port and used from the other side: the
// contract suite over a MessageChannel, a database over it with the chain,
// pieces, tags and a reopen, a failed append and a scrub crossing the port,
// errors with their codes, a change stream and a lease pushed back — and a
// worker thread serving the engine in memory.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createDatabase, memoryEngine } = require('../src/all/all.js');
const { mongoEngine } = require('../src/mongodb/mongodb.js');
const { createFakeMongo } = require('./utils/fake-mongo.js');
const { serveEngine, remoteEngine, connectEngine } = require('../src/engines/engines.js');
const { runEngineTests, stored } = require('./suites/engine.js');

let n = 0;
const vroot = async () => `/remote-${++n}`;
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// An engine served over a fresh channel, and the proxy over the other end.
const served = (inner = memoryEngine()) => {
  const { port1, port2 } = new MessageChannel();
  const server = serveEngine(inner, port1);
  const engine = remoteEngine(port2, { name: inner.name, capabilities: inner.capabilities });
  return { inner, server, engine };
};

test('an engine over a message port', async (t) => {
  const open = [];
  t.after(async () => {
    for (const { server, engine } of open) {
      await engine.close();
      await server.close();
    }
  });
  await t.test('the contract, over a MessageChannel', async (t2) => {
    await runEngineTests(t2, {
      create: () => {
        const pair = served();
        open.push(pair);
        return pair.engine;
      },
      root: vroot,
    });
  });

  await t.test(
    'a database over the proxy: writes, pieces, tags, the chain, a reopen; the served side holds it all',
    async () => {
      const { inner, server, engine } = served();
      const options = { path: 'app', engine, logger: false, defer: 0, lock: false };
      const db = await createDatabase(options);
      const id = await db.insert({ title: 'Draft' });
      await db.push(id, 'body', 'x'.repeat(3000));
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
      const local = await inner.open('app');
      assert.deepStrictEqual((await local.records.get(id)).data.title, 'Final', 'the served engine holds the record');
      assert.strictEqual(await local.kv.has('', 'node.json'), true);
      await engine.remove('app');
      assert.strictEqual(await (await inner.open('app')).records.get(id), null, 'removed on the served side');
      await engine.close();
      await server.close();
    },
  );

  await t.test(
    'the log over the port: a reopen replays, a roll seals, compaction drops, a scrub rewrites',
    async () => {
      const { server, engine } = served();
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
      assert.ok(db.stats().log.segments > 0, 'the proxy reads the served segments');
      await db.purge(ids[11]);
      const { floor, next, length } = db.stats().log;
      await db.close();
      const again = await createDatabase(options);
      const reopened = again.stats().log;
      assert.deepStrictEqual([reopened.floor, reopened.next, reopened.length], [floor, next, length]);
      assert.deepStrictEqual(await again.get(ids[10]), { n: 10 });
      assert.strictEqual(await again.get(ids[11]), null);
      await again.close();
      await engine.close();
      await server.close();
    },
  );

  await t.test(
    'an error crosses with its code; a failed append fails its group; a lease and a change stream push back',
    async () => {
      const client = createFakeMongo();
      const inner = mongoEngine({ client, name: 'remote' });
      const { server, engine } = served(inner);
      const db = await engine.open('/p');
      await db.kv.create('', 'lock.json', '1');
      await assert.rejects(() => db.kv.create('', 'lock.json', '2'), { code: 'EEXIST' });
      await db.write({ records: [{ id: 'torn', text: '{"data":' }] });
      await assert.rejects(() => db.records.get('torn'), { name: 'SyncomError', code: 'INTEGRITY', id: 'torn' });
      await assert.rejects(() => db.log.drop({ from: 1, to: 2 }), { name: 'TypeError', message: /no such segment/ });
      // The served side's lease, held from here; lost there, heard here.
      const lost = [];
      const held = await db.lock({ staleAfter: 60, onLost: (error) => lost.push(error) });
      await assert.rejects(() => db.lock({ staleAfter: 60 }), { code: 'LOCKED' });
      await client
        .db('remote')
        .collection('locks')
        .updateOne({ _id: '/p' }, { $set: { owner: 'other' } });
      await settle(80);
      assert.strictEqual(lost.length, 1);
      assert.match(lost[0].message, /taken/);
      await held.release();
      // Another instance's writes, heard through the port.
      // Another instance (its own writer token) over the same database: what the proxy's subscriber hears.
      const other = await mongoEngine({ client, name: 'remote' }).open('/p');
      const heard = [];
      const stop = db.changes.subscribe((message) => heard.push(message));
      await settle();
      await other.write({ records: [{ id: 'r', stored: stored({}) }] });
      await settle();
      assert.deepStrictEqual(heard, [{ p: '/p', records: ['r'] }]);
      stop();
      await settle();
      await other.write({ records: [{ id: 's', stored: stored({}) }] });
      await settle();
      assert.strictEqual(heard.length, 1, 'unsubscribed');
      // A group the served store cannot write fails here, through onFail.
      const failing = {
        ...inner,
        open: async (p) => {
          const real = await inner.open(p);
          return {
            ...real,
            log: {
              ...real.log,
              append: async (_e, _h, { onFail }) => {
                onFail(new Error('disk full'));
                return false;
              },
            },
          };
        },
      };
      const { port1, port2 } = new MessageChannel();
      const failServer = serveEngine(failing, port1);
      const failEngine = remoteEngine(port2, { name: 'mongodb', capabilities: inner.capabilities });
      const failDb = await failEngine.open('/q');
      const failures = [];
      const landed = await failDb.log.append([{ seq: 1 }], null, {
        first: 1,
        last: 1,
        onFail: (e) => failures.push(e),
      });
      assert.strictEqual(landed, false);
      assert.match(failures[0].message, /disk full/);
      await failEngine.close();
      await failServer.close();
      await engine.close();
      await server.close();
    },
  );

  await t.test(
    'remoteEngine() is refused without a name and capabilities; connectEngine() asks the served side',
    async () => {
      const { port1, port2 } = new MessageChannel();
      assert.throws(() => remoteEngine(port2), { name: 'TypeError', message: /connectEngine/ });
      assert.throws(() => remoteEngine({}, { name: 'x', capabilities: {} }), {
        name: 'TypeError',
        message: /postMessage/,
      });
      const server = serveEngine(memoryEngine(), port1);
      const engine = await connectEngine(port2);
      assert.strictEqual(engine.name, 'memory');
      assert.strictEqual(engine.capabilities.atomicBatch, true);
      assert.strictEqual(engine.capabilities.exclusiveCreate, true);
      await engine.close();
      await server.close();
    },
  );

  await t.test('a worker thread serves the engine in memory; the database lives in the main thread', async () => {
    const worker = new Worker(path.join(__dirname, 'utils', 'engine-worker.js'));
    const engine = await connectEngine(worker);
    assert.strictEqual(engine.name, 'memory');
    const db = await createDatabase({ path: 'threaded', engine, logger: false, defer: 0, lock: false });
    const id = await db.insert({ title: 'In a worker' });
    await db.transact(async (tx) => {
      for (let i = 0; i < 20; i++) await tx.insert({ n: i });
    });
    assert.strictEqual((await db.list()).length, 21);
    await db.close();
    const again = await createDatabase({ path: 'threaded', engine, logger: false, defer: 0, lock: false });
    assert.strictEqual((await again.get(id)).title, 'In a worker');
    await again.close();
    await engine.close();
    await worker.terminate();
  });
});
