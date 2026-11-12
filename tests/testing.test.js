'use strict';

// The testing subpath as an application's test would use it: the memory engine, a mesh from an adjacency list,
// settle(), the hazards of a link, withDatabase(). The repository's own tests run on the same code through
// tests/utils/mesh.js and tests/utils/memory-link.js, so what is checked here is the surface of its own.

const test = require('node:test');
const assert = require('node:assert');
const { createDatabase } = require('../src/all/all.js');
const testing = require('../src/testing/testing.js');

const { createMesh, settle, waitUntil, sameVectors, prng, withDatabase, memoryEngine, MemoryLink } = testing;

test('@alexify/syncom/testing', async (t) => {
  await t.test(
    'a mesh from an adjacency list over the memory engine converges; settle() takes the Map; close() closes every node',
    async () => {
      const engine = memoryEngine();
      const mesh = await createMesh(
        ['A', 'B', 'C'],
        [
          ['A', 'B'],
          ['C', 'B'],
        ],
        {
          createStorage: (name, options) =>
            createDatabase({ ...options, path: name, engine, lock: false, logger: false }),
        },
      );
      const a = mesh.get('A');
      const c = mesh.get('C');
      const id = await a.insert({ title: 'from A' });
      await settle(mesh.storages);
      assert.deepStrictEqual(await c.get(id), { title: 'from A' });
      assert.ok(sameVectors(mesh.storages));
      assert.ok(sameVectors([a, mesh.get('B'), c]));
      assert.ok(mesh.links.get('mem://B') instanceof MemoryLink);
      assert.strictEqual(mesh.servers.size, 1, 'one host server for B');
      assert.strictEqual(mesh.servers.get('B').links.size, 2, 'both dialers of B on its server');
      await mesh.close();
      await assert.rejects(() => a.insert({ title: 'after close' }), { code: 'CLOSED' });
    },
  );

  await t.test('createMesh() refuses a call without createStorage and a dial to a host that is not there', async () => {
    await assert.rejects(() => createMesh(['A'], [], {}), { name: 'TypeError' });
    const engine = memoryEngine();
    const mesh = await createMesh(['A'], [], {
      createStorage: (name, options) => createDatabase({ ...options, path: name, engine, lock: false, logger: false }),
    });
    assert.throws(() => mesh.connect({ url: 'mem://nobody' }), { name: 'TypeError', message: /no host nobody/ });
    await mesh.close();
  });

  await t.test('settle() rejects past its timeout where a link drops every page; waitUntil() too', async () => {
    const engine = memoryEngine();
    const mesh = await createMesh(['A', 'B'], [['A', 'B']], {
      createStorage: (name, options) => createDatabase({ ...options, path: name, engine, lock: false, logger: false }),
      link: { drop: () => true },
    });
    await mesh.get('B').insert({ n: 1 });
    await assert.rejects(() => settle(mesh.storages, { timeout: 150, step: 5 }), { message: /did not settle/ });
    await assert.rejects(() => waitUntil(() => false, { timeout: 30, step: 5 }), { message: /not met/ });
    let polls = 0;
    await waitUntil(async () => ++polls === 3, { step: 1 });
    assert.strictEqual(polls, 3);
    await mesh.close();
  });

  await t.test('withDatabase() closes the database after fn, whatever fn does; prng() is deterministic', async () => {
    const engine = memoryEngine();
    const open = () => createDatabase({ engine, path: 'solo', lock: false, logger: false });
    let kept = null;
    const n = await withDatabase(open, async (db) => {
      kept = db;
      await db.insert({ n: 1 });
      return (await db.list()).length;
    });
    assert.strictEqual(n, 1);
    await assert.rejects(() => kept.insert({ n: 2 }), { code: 'CLOSED' });
    const opened = await open();
    await assert.rejects(
      () =>
        withDatabase(opened, () => {
          throw new Error('inside');
        }),
      { message: 'inside' },
    );
    await assert.rejects(() => opened.insert({ n: 2 }), { code: 'CLOSED' }, 'closed although fn threw');
    const first = prng(42);
    const second = prng(42);
    const a = [first(), first(), first()];
    const b = [second(), second(), second()];
    assert.deepStrictEqual(a, b);
    assert.ok(a.every((x) => x >= 0 && x < 1));
  });
});
