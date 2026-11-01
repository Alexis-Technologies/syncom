'use strict';

// The engine in memory: the contract suite, a database over it, a reopen
// through the same engine, and what it keeps as objects.

const test = require('node:test');
const assert = require('node:assert');
const { createDatabase, memoryEngine } = require('../src/all/all.js');
const { runEngineTests, stored } = require('./suites/engine.js');

let n = 0;
const vroot = async () => `/mem-${++n}`;

test('memory engine', async (t) => {
  await runEngineTests(t, { create: memoryEngine, root: vroot });

  await t.test('capabilities: atomic write sets, exclusive create, no indexes; paths lists the databases', async () => {
    const engine = memoryEngine();
    assert.strictEqual(engine.name, 'memory');
    assert.strictEqual(engine.capabilities.atomicBatch, true);
    assert.strictEqual(engine.capabilities.exclusiveCreate, true);
    assert.strictEqual(engine.capabilities.indexes, false);
    assert.deepStrictEqual(engine.paths, []);
    await engine.open('b');
    await engine.open('a');
    assert.deepStrictEqual(engine.paths, ['a', 'b']);
    await engine.remove('b');
    assert.deepStrictEqual(engine.paths, ['a']);
  });

  await t.test('a record is kept as the object it was handed; raw() stringifies on demand', async () => {
    const db = await memoryEngine().open('objects');
    const record = stored({ title: 'x' });
    await db.write({ records: [{ id: 'r', stored: record }] });
    assert.strictEqual(await db.records.get('r'), record, 'the same object');
    assert.strictEqual(await db.records.raw('r'), JSON.stringify(record));
    assert.strictEqual(db.size, 1);
  });

  await t.test('a database in memory: writes, pieces, tags and a reopen through the same engine', async () => {
    const engine = memoryEngine();
    const options = { path: 'app', engine, logger: false, defer: 0, lock: false };
    const db = await createDatabase(options);
    const id = await db.insert({ title: 'Draft' });
    await db.update(id, { title: 'Final' });
    await db.push(id, 'body', 'x'.repeat(2000));
    await db.tag('v1');
    await db.update(id, { title: 'After the tag' });
    assert.deepStrictEqual((await db.at('v1').get(id)).title, 'Final');
    assert.strictEqual((await db.get(id)).body.length, 2000);
    assert.deepStrictEqual(db.stats().log.journaled ?? false, false);
    await db.close();
    // The engine keeps the database: a reopen reads it, log and tags included.
    const again = await createDatabase(options);
    assert.deepStrictEqual((await again.get(id)).title, 'After the tag');
    assert.deepStrictEqual((await again.at('v1').get(id)).title, 'Final');
    assert.strictEqual(again.nodeId, db.nodeId, 'the identity survives the reopen');
    assert.deepStrictEqual(again.vector, db.vector);
    await again.close();
    await engine.remove('app');
    const fresh = await createDatabase(options);
    assert.deepStrictEqual(await fresh.list(), []);
    assert.notStrictEqual(fresh.nodeId, db.nodeId, 'a removed database is a new node');
    await fresh.close();
  });

  await t.test(
    'the log rolls and compacts in memory: segments are ranges, the floor moves, a purge scrubs',
    async () => {
      const engine = memoryEngine();
      const db = await createDatabase({
        path: 'log',
        engine,
        logger: false,
        defer: 0,
        lock: false,
        sync: { log: { rollAfter: 2 }, retention: { ops: 6 } },
      });
      const ids = [];
      for (let i = 0; i < 12; i++) ids.push(await db.insert({ n: i }));
      await db.flush();
      assert.ok(db.stats().log.floor > 1, 'compacted');
      assert.ok(db.stats().log.segments >= 1);
      await db.purge(ids[11]);
      assert.strictEqual(await db.get(ids[11]), null);
      assert.deepStrictEqual(await db.get(ids[10]), { n: 10 }, 'a live record stays whatever the log compacted');
      await db.close();
    },
  );
});
