'use strict';

// The sync of ops as a block: without `@alexify/syncom/sync` the storage has
// no manager, and a transport of the application's own carries ops with the
// core's updates API — outbound() on one side, applyRemote() on the other.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { sync } = require('../src/sync/sync.js');

test('sync as a plugin', async (t) => {
  await t.test(
    'without the plugin storage.sync is PLUGIN_MISSING; two nodes converge by hand through outbound and applyRemote',
    async (t2) => {
      const fsi = memory();
      const a = await core.open({ path: 'a', fsi, logger: false });
      const b = await core.open({ path: 'b', fsi, logger: false });
      t2.after(() => Promise.all([a.close(), b.close()]).catch(() => {}));
      assert.throws(() => a.sync, {
        name: 'TypeError',
        code: 'PLUGIN_MISSING',
        message: "storage.sync needs the sync plugin: open({ plugins: [sync] }) from '@alexify/syncom/sync'",
      });
      assert.deepStrictEqual(a.plugins, []);
      const id = await a.insert({ title: 'x' });
      await a.inc(id, 'hits', 2);
      const other = await b.insert({ from: 'b' });
      // The selection a push makes, by hand: what a has that b lacks.
      const toB = core.outbound(a.log, { exclude: b.nodeId, vector: b.vector, own: a.nodeId });
      assert.strictEqual(toB.ops.length, 2);
      assert.deepStrictEqual(Object.values(toB.first), [1], 'the first seq retained of the own stream');
      assert.strictEqual((await b.applyRemote(toB.ops)).applied, 2);
      const toA = core.outbound(b.log, { exclude: a.nodeId, vector: a.vector, own: b.nodeId });
      assert.strictEqual((await a.applyRemote(toA.ops)).applied, 1);
      assert.deepStrictEqual([await b.get(id), await a.get(other)], [{ title: 'x', hits: 2 }, { from: 'b' }]);
      // Nothing more to send either way.
      assert.deepStrictEqual(core.outbound(a.log, { exclude: b.nodeId, vector: b.vector, own: a.nodeId }).ops, []);
      assert.deepStrictEqual(core.outbound(b.log, { exclude: a.nodeId, vector: a.vector, own: b.nodeId }).ops, []);
      assert.deepStrictEqual(a.vector, b.vector);
    },
  );

  await t.test('with the plugin the storage has its manager, built once the log is open', async (t2) => {
    const fsi = memory();
    const storage = await core.open({
      path: 'managed',
      fsi,
      logger: false,
      plugins: [sync],
      sync: { autoStart: false },
    });
    t2.after(() => storage.close());
    assert.deepStrictEqual([storage.plugins, storage.kinds], [['sync'], []]);
    assert.strictEqual(storage.sync.storage, storage);
    assert.strictEqual(storage.sync.started, false);
    assert.strictEqual(storage.sync.pendingOps(), 0);
    assert.deepStrictEqual(storage.sync.listNodes(), []);
    assert.strictEqual(typeof storage.sync.unit().hello.handler, 'function');
  });
});
