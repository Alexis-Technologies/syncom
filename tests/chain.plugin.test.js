'use strict';

// The chain as a block: without `@alexify/syncom/chain` no block is written
// and nothing is checked on a cold read; with it, as it was — and
// `open({ chain: false })` keeps it off with the plugin registered.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const all = require('../src/all/all.js');
const { chain } = require('../src/chain/chain.js');

test('chain as a plugin', async (t) => {
  await t.test(
    'without the plugin no block is written, stats().chain is null and validate() names the plugin',
    async (t2) => {
      const fsi = core.createMemoryFsi();
      const storage = await core.open({ path: 'bare', fsi, logger: false });
      t2.after(() => storage.close().catch(() => {}));
      const id = await storage.insert({ a: 1 });
      assert.strictEqual(JSON.parse(await fsi.read('bare/data', `${id}.json`)).block, null);
      assert.strictEqual(await fsi.exists('bare/blockchain', '.blockchain.json'), false);
      assert.strictEqual((await storage.stats()).chain, null);
      await assert.rejects(() => storage.validate(), {
        name: 'TypeError',
        code: 'NO_CHAIN',
        message:
          /the chain plugin is not registered \(open\(\{ plugins: \[chain\] \}\) from '@alexify\/syncom\/chain'\)/,
      });
      // Asking for the chain in so many words is refused, not ignored.
      await assert.rejects(() => core.open({ path: 'asked', fsi, logger: false, chain: true }), {
        name: 'TypeError',
        code: 'PLUGIN_MISSING',
        message:
          "open({ chain: true }) needs the chain plugin: open({ plugins: [chain] }) from '@alexify/syncom/chain'",
      });
    },
  );

  await t.test(
    'with the plugin every write has its block and validate() walks them; chain: false keeps it off',
    async (t2) => {
      const fsi = core.createMemoryFsi();
      const storage = await core.open({ path: 'chained', fsi, logger: false, plugins: [chain] });
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
      const reopened = await core.open({ path: 'chained', fsi, logger: false, plugins: [chain] });
      t2.after(() => reopened.close().catch(() => {}));
      await assert.rejects(() => reopened.get(id), { code: 'INTEGRITY' });
      // /all registers it; chain: false is the opt-out it always was.
      const off = await all.open({ path: 'off', fsi, logger: false, chain: false });
      t2.after(() => off.close().catch(() => {}));
      const other = await off.insert({ b: 1 });
      assert.strictEqual(JSON.parse(await fsi.read('off/data', `${other}.json`)).block, null);
      assert.strictEqual((await off.stats()).chain, null);
      await assert.rejects(() => off.validate(), { code: 'NO_CHAIN', message: /open\(\{ chain: false \}\)/ });
    },
  );
});
