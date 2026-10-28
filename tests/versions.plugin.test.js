'use strict';

// Versions as a block: without `@alexify/syncom/versions` the storage has
// no past to read — get(id, { at }), history(), diff(), restore() and the
// tags throw PLUGIN_MISSING, stats().tags is null, a directory that holds
// tags is refused — while applyPatches() and compact(), the present's, are
// the core's; with it the lean core reads the past as /all does.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { versions } = require('../src/versions/versions.js');

test('versions as a plugin', async (t) => {
  await t.test(
    'without the plugin the past is PLUGIN_MISSING, the present and its patches are the core',
    async (t2) => {
      const fsi = memory();
      const storage = await core.open({ path: 'plain', fsi, logger: false });
      t2.after(() => storage.close().catch(() => {}));
      const id = await storage.insert({ n: 1 });
      await storage.update(id, { n: 2 });
      const refused = (what) => (error) => {
        assert.strictEqual(error.code, 'PLUGIN_MISSING', what);
        assert.ok(error.message.startsWith(`${what} needs the versions plugin`), error.message);
        return true;
      };
      await assert.rejects(() => storage.get(id, { at: 1 }), refused('get(id, { at })'));
      await assert.rejects(() => storage.history(id), refused('history()'));
      await assert.rejects(() => storage.diff(id, 1), refused('diff()'));
      await assert.rejects(() => storage.restore(id, 1), refused('restore()'));
      await assert.rejects(() => storage.tag('v1'), refused('tag()'));
      await assert.rejects(() => storage.untag('v1'), refused('untag()'));
      assert.throws(() => storage.tags(), { code: 'PLUGIN_MISSING' });
      assert.throws(() => storage.at('v1'), { code: 'PLUGIN_MISSING' });
      assert.strictEqual((await storage.stats()).tags, null);
      // The present's patches land as ops, plugin or not.
      assert.strictEqual(await storage.applyPatches(id, [{ action: 'put', field: 'n', value: 3 }]), 1);
      assert.deepStrictEqual(await storage.get(id), { n: 3 });
      assert.strictEqual(await storage.compact(id), 1);
      assert.deepStrictEqual(await storage.get(id), { n: 3 });
    },
  );

  await t.test('a directory that holds tags is refused without the plugin, and reads them with it', async (t2) => {
    const fsi = memory();
    const tagged = await core.open({ path: 'tagged', fsi, logger: false, plugins: [versions] });
    const id = await tagged.insert({ n: 1 });
    await tagged.tag('v1');
    await tagged.update(id, { n: 2 });
    assert.deepStrictEqual(await tagged.get(id, { at: { tag: 'v1' } }), { n: 1 });
    await tagged.close();
    await assert.rejects(() => core.open({ path: 'tagged', fsi, logger: false }), {
      name: 'TypeError',
      code: 'PLUGIN_MISSING',
      message:
        "a storage with tags needs the versions plugin: open({ plugins: [versions] }) from '@alexify/syncom/versions'",
    });
    const again = await core.open({ path: 'tagged', fsi, logger: false, plugins: [versions] });
    t2.after(() => again.close().catch(() => {}));
    assert.deepStrictEqual(
      again.tags().map((tag) => tag.name),
      ['v1'],
    );
    assert.deepStrictEqual(await again.get(id, { at: { tag: 'v1' } }), { n: 1 });
    assert.deepStrictEqual((await again.stats()).tags, { count: 1, corrupt: false });
    await again.untag('v1');
    await again.close();
    // No tag left: the core alone opens it again.
    const plain = await core.open({ path: 'tagged', fsi, logger: false });
    t2.after(() => plain.close().catch(() => {}));
    assert.deepStrictEqual(await plain.get(id), { n: 2 });
  });

  await t.test('with the plugin the lean core reads the past, diffs it and restores it', async (t2) => {
    const fsi = memory();
    const storage = await core.open({ path: 'past', fsi, logger: false, plugins: [versions] });
    t2.after(() => storage.close().catch(() => {}));
    assert.deepStrictEqual([storage.plugins, storage.kinds], [['versions'], []]);
    const id = await storage.insert({ title: 'Draft' });
    await storage.update(id, { title: 'Final' });
    const { versions: list, complete, exact } = await storage.history(id);
    assert.deepStrictEqual([list.length, complete, exact], [2, true, true]);
    assert.deepStrictEqual(await storage.get(id, { at: list[1].eventId }), { title: 'Draft' });
    assert.deepStrictEqual(await storage.diff(id, list[1].eventId), [
      { action: 'put', field: 'title', value: 'Final' },
    ]);
    assert.strictEqual(await storage.restore(id, list[1].eventId), 1);
    assert.deepStrictEqual(await storage.get(id), { title: 'Draft' });
  });
});
