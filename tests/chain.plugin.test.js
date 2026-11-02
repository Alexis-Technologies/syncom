'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

// The chain as a block: without `@alexify/syncom/chain` no block is written
// and nothing is checked on a cold read; with it, as it was — and
// `createDatabase({ chain: false })` keeps it off with the plugin registered.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const all = require('../src/all/all.js');
const { chain } = require('../src/chain/chain.js');
const { memory } = require('../src/memory/memory.js');

test('chain as a plugin', async (t) => {
  await t.test(
    'without the plugin no block is written, stats().chain is null and validate() names the plugin',
    async (t2) => {
      const fsi = memory();
      const storage = await core.createDatabase({ defer: 0, path: 'bare', fsi, logger: false });
      t2.after(() => storage.close().catch(() => {}));
      const id = await storage.insert({ a: 1 });
      assert.strictEqual(JSON.parse(await fsi.read('bare/data', `${id}.json`)).block, null);
      assert.strictEqual(await fsi.exists('bare/blockchain', '.blockchain.json'), false);
      assert.strictEqual((await storage.stats()).chain, null);
      await assert.rejects(() => storage.validate(), {
        name: 'TypeError',
        code: 'NO_CHAIN',
        message:
          /the chain plugin is not registered \(createDatabase\(\{ plugins: \[chain\] \}\) from '@alexify\/syncom\/chain'\)/,
      });
      // Asking for the chain in so many words is refused, not ignored.
      await assert.rejects(() => core.createDatabase({ defer: 0, path: 'asked', fsi, logger: false, chain: true }), {
        name: 'TypeError',
        code: 'PLUGIN_MISSING',
        message:
          "createDatabase({ chain: true }) needs the chain plugin: createDatabase({ plugins: [chain] }) from '@alexify/syncom/chain'",
      });
    },
  );

  await t.test('the records of one batch are verified against their block parsed and hashed once', async (t2) => {
    const fsi = memory();
    const blockReads = [];
    const counted = {
      read: (dir, name) => {
        if (dir.endsWith('blockchain')) blockReads.push(name);
        return fsi.read(dir, name);
      },
      write: (dir, name, content, options) => fsi.write(dir, name, content, options),
      append: (dir, name, content) => fsi.append(dir, name, content),
      exists: (dir, name) => fsi.exists(dir, name),
      remove: (dir, name) => fsi.remove(dir, name),
      list: (dir) => fsi.list(dir),
    };
    const options = {
      defer: 0,
      path: 'batch',
      fsi: counted,
      logger: false,
      schema: { entities: { Post: {} } },
    };
    const storage = await all.createDatabase(options);
    const rows = [];
    for (let i = 0; i < 300; i++) rows.push({ i });
    const { success: ids } = await storage.Post.bulkInsert(rows);
    assert.strictEqual(ids.length, 300);
    await storage.close();
    // Cold: every record of the batch read and verified — the one block they share read once, not 300 times.
    const reopened = await all.createDatabase(options);
    t2.after(() => reopened.close().catch(() => {}));
    blockReads.length = 0;
    for (let i = 0; i < ids.length; i++) assert.strictEqual((await reopened.get(ids[i])).i, i);
    assert.strictEqual(blockReads.length, 1, `the block read ${blockReads.length} times`);
    // A record edited under the block is still INTEGRITY, however many of its batch read well.
    await reopened.close();
    const file = JSON.parse(await fsi.read('batch/data', `${ids[7]}.json`));
    file.data.i = -1;
    await fsi.write('batch/data', `${ids[7]}.json`, JSON.stringify(file));
    const again = await all.createDatabase(options);
    t2.after(() => again.close().catch(() => {}));
    assert.strictEqual((await again.get(ids[0])).i, 0);
    await assert.rejects(() => again.get(ids[7]), { code: 'INTEGRITY' });
  });

  await t.test(
    'with the plugin every write has its block and validate() walks them; chain: false keeps it off',
    async (t2) => {
      const fsi = memory();
      const storage = await core.createDatabase({ defer: 0, path: 'chained', fsi, logger: false, plugins: [chain] });
      t2.after(() => storage.close().catch(() => {}));
      assert.deepStrictEqual([storage.plugins, storage.kinds], [['chain'], []]);
      const id = await storage.insert({ a: 1 });
      await storage.inc(id, 'hits', 2);
      assert.match(JSON.parse(await fsi.read('chained/data', `${id}.json`)).block, /^[0-9a-f]{64}$/);
      assert.strictEqual(await fsi.exists('chained/blockchain', '.blockchain.json'), true);
      assert.strictEqual(await storage.validate(), true);
      assert.match((await storage.stats()).chain.tail, /^[0-9a-f]{64}$/);
      // Verified on a cold read: the file edited under its block is INTEGRITY.
      await storage.close();
      const file = JSON.parse(await fsi.read('chained/data', `${id}.json`));
      file.data.a = 2;
      await fsi.write('chained/data', `${id}.json`, JSON.stringify(file));
      const reopened = await core.createDatabase({ defer: 0, path: 'chained', fsi, logger: false, plugins: [chain] });
      t2.after(() => reopened.close().catch(() => {}));
      await assert.rejects(() => reopened.get(id), { code: 'INTEGRITY' });
      // /all registers it; chain: false is the opt-out it always was.
      const off = await all.createDatabase({ defer: 0, path: 'off', fsi, logger: false, chain: false });
      t2.after(() => off.close().catch(() => {}));
      const other = await off.insert({ b: 1 });
      assert.strictEqual(JSON.parse(await fsi.read('off/data', `${other}.json`)).block, null);
      assert.strictEqual((await off.stats()).chain, null);
      await assert.rejects(() => off.validate(), { code: 'NO_CHAIN', message: /createDatabase\(\{ chain: false \}\)/ });
    },
  );
});
