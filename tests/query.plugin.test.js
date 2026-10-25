'use strict';

// Queries as a block: without `@alexify/syncom/query` a collection has no
// cursor — select() and count() throw PLUGIN_MISSING — while the catalog
// keeps indexing; with it the lean core answers a query from the catalog.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { query } = require('../src/query/query.js');
const { schema } = require('../src/schema/schema.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('query as a plugin', async (t) => {
  await t.test('without the plugin select() and count() are PLUGIN_MISSING; the catalog still indexes', async (t2) => {
    const fsi = memory();
    const definition = { entities: { Post: { index: ['title'] } } };
    const storage = await core.open({ path: 'typed', fsi, logger: false, plugins: [schema], schema: definition });
    t2.after(() => storage.close().catch(() => {}));
    await storage.Post.insert({ title: 'a' });
    assert.throws(() => storage.Post.select({ title: 'a' }), {
      name: 'TypeError',
      code: 'PLUGIN_MISSING',
      message: "select() needs the query plugin: open({ plugins: [query] }) from '@alexify/syncom/query'",
    });
    assert.throws(() => storage.Post.count(), { code: 'PLUGIN_MISSING' });
    assert.strictEqual((await storage.list()).length, 1);
    assert.strictEqual((await storage.stats()).catalog.entries, 1);
    await storage.close();
    // The plugin arriving reads what the catalog indexed all along.
    const again = await core.open({ path: 'typed', fsi, logger: false, plugins: [schema, query], schema: definition });
    t2.after(() => again.close().catch(() => {}));
    assert.strictEqual(await again.Post.count({ title: 'a' }), 1);
  });

  await t.test('with the plugin the lean core answers a query from the catalog, and watches it', async (t2) => {
    const fsi = memory();
    const storage = await core.open({
      path: 'q',
      fsi,
      logger: false,
      plugins: [schema, query],
      schema: { entities: { Post: { index: ['n'] } } },
    });
    t2.after(() => storage.close().catch(() => {}));
    assert.deepStrictEqual(storage.plugins, ['schema', 'query']);
    for (let n = 1; n <= 5; n++) await storage.Post.insert({ n });
    const rows = await storage.Post.select({ n: { $gt: 2 } })
      .order('n')
      .limit(2)
      .fetch();
    assert.deepStrictEqual(
      rows.map((row) => row.n),
      [3, 4],
    );
    assert.strictEqual(await storage.Post.count({ n: { $lte: 2 } }), 2);
    const seen = [];
    const stop = storage.Post.select({ n: { $gte: 5 } }).watch((matched) => seen.push(matched.length));
    await tick();
    await storage.Post.insert({ n: 6 });
    await tick();
    stop();
    assert.deepStrictEqual(seen, [1, 2]);
  });
});
