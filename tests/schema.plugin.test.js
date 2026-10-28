'use strict';

// The schema as a block: without `@alexify/syncom/schema` a schema or a
// validator given to open() is refused, records are untyped and migrate()
// and check() are PLUGIN_MISSING; with it on the lean core the definitions
// are read once and the core applies them.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { schema, ValidationError } = require('../src/schema/schema.js');
const { query } = require('../src/query/query.js');

const validator = (data) => {
  if (typeof data.title !== 'string') throw new Error('title must be a string');
  return { ...data, title: data.title.trim() };
};

test('schema as a plugin', async (t) => {
  await t.test('without the plugin a schema or a validator is PLUGIN_MISSING, records are untyped', async (t2) => {
    const fsi = memory();
    await assert.rejects(() => core.open({ path: 'typed', fsi, logger: false, schema: { entities: { Post: {} } } }), {
      name: 'TypeError',
      code: 'PLUGIN_MISSING',
      message: "open({ schema }) needs the schema plugin: open({ plugins: [schema] }) from '@alexify/syncom/schema'",
    });
    await assert.rejects(
      () => core.open({ path: 'compiled', fsi, logger: false, validator: { compile: () => () => true } }),
      {
        code: 'PLUGIN_MISSING',
        message: /open\(\{ validator \}\) needs the schema plugin/,
      },
    );
    const plain = await core.open({ path: 'plain', fsi, logger: false });
    t2.after(() => plain.close().catch(() => {}));
    assert.strictEqual(plain.schema, null);
    assert.strictEqual(plain.schemaInfo, null);
    assert.strictEqual(plain.Post, undefined);
    await assert.rejects(() => plain.migrate(), {
      code: 'PLUGIN_MISSING',
      message: /migrate\(\) needs the schema plugin/,
    });
    await assert.rejects(() => plain.check('Post', {}), {
      code: 'PLUGIN_MISSING',
      message: /check\(\) needs the schema plugin/,
    });
    // $type is a field like any other: nothing validates, nothing collects.
    const id = await plain.insert({ $type: 'Post', title: 42 });
    assert.deepStrictEqual(await plain.get(id), { $type: 'Post', title: 42 });
    const ops = [];
    plain.on('change', (op) => ops.push(op));
    await plain.update(id, { title: 'later' });
    assert.strictEqual(ops[0].v ?? null, null, 'no schema version stamped');
  });

  await t.test(
    'with the plugin the lean core has its collections, validates and reads through the lens',
    async (t2) => {
      const fsi = memory();
      const options = {
        path: 'typed',
        fsi,
        logger: false,
        plugins: [schema, query],
        schema: {
          version: 2,
          entities: { Post: { schema: validator, index: ['title'] } },
          migrations: { 2: { Post: { up: (data) => ({ ...data, title: data.title ?? data.name }) } } },
        },
      };
      const storage = await core.open(options);
      t2.after(() => storage.close().catch(() => {}));
      assert.deepStrictEqual([storage.plugins, storage.kinds], [['schema', 'query'], []]);
      assert.deepStrictEqual(storage.schemaInfo, { version: 2, hash: null, previous: null, held: null });
      const { id } = await storage.Post.insert({ title: '  Hello  ' });
      assert.deepStrictEqual(
        await storage.Post.get(id),
        { $type: 'Post', title: 'Hello' },
        'what the validator gives back is what the op carries',
      );
      await assert.rejects(
        () => storage.Post.insert({ title: 7 }),
        (error) => {
          assert.ok(error instanceof ValidationError);
          assert.strictEqual(error.entity, 'Post');
          return true;
        },
      );
      assert.deepStrictEqual(await storage.check('Post', { title: ' x ' }), { title: 'x' });
      assert.deepStrictEqual(
        await storage.Post.select({ title: 'Hello' })
          .fetch()
          .then((rows) => rows.map((r) => r.id)),
        [id],
      );
      // A record written under version 1 reads through the migration.
      const old = {
        origin: 'peer',
        seq: 1,
        ts: Date.now(),
        type: 'write',
        id: 'p1',
        data: { $type: 'Post', name: 'Old' },
        v: 1,
      };
      assert.strictEqual((await storage.applyRemote([old])).applied, 1);
      assert.deepStrictEqual(await storage.get('p1'), { $type: 'Post', title: 'Old', name: 'Old' });
      assert.deepStrictEqual(await storage.migrate(), {
        migrated: 1,
        counters: 0,
        sets: 0,
        lists: 0,
        texts: 0,
        trees: 0,
      });
    },
  );
});
