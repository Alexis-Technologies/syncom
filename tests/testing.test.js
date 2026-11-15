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
    assert.strictEqual(mesh.links.get('mem://B').down, true, 'a dropped page took the link down');
    await assert.rejects(() => waitUntil(() => false, { timeout: 30, step: 5 }), { message: /not met/ });
    let polls = 0;
    await waitUntil(async () => ++polls === 3, { step: 1 });
    assert.strictEqual(polls, 3);
    await mesh.close();
  });

  await t.test(
    'a dropped page takes the link down: nothing after it arrives, and a reconnect resumes from the last page delivered',
    async () => {
      // A feed of three tracked pages that resumes after the event id it is handed, as the host's does.
      const TRACKED = Symbol.for('wrpc.tracked');
      const unit = {
        changes: {
          async *handler(context, args, { lastEventId }) {
            const from = lastEventId === undefined ? 0 : Number(lastEventId.slice(1));
            for (let i = from + 1; i <= 3; i++) yield { [TRACKED]: true, id: `e${i}`, data: { n: i } };
          },
        },
      };
      let lose = true;
      const link = new MemoryLink(unit, { drop: (page) => lose && page.n === 2 });
      const closes = [];
      link.on('close', () => closes.push('link'));
      link.client.on('close', () => closes.push('client'));
      const delivered = [];
      let ended = false;
      const handle = link.subscribe(
        'syncom/changes',
        {},
        { onData: (data, id) => void delivered.push(id), onEnd: () => void (ended = true) },
      );
      await waitUntil(() => link.down);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepStrictEqual(delivered, ['e1'], 'the page after the dropped one never arrived');
      assert.strictEqual(handle.lastEventId, 'e1', 'the last page delivered, not the dropped one');
      assert.strictEqual(ended, false, 'cut, not ended');
      assert.deepStrictEqual(closes, ['client', 'link'], 'close announced, as a socket that died');
      await assert.rejects(() => link.call('syncom/changes', {}), { code: 503 });
      lose = false;
      await link.reconnect();
      await waitUntil(() => ended);
      assert.deepStrictEqual(delivered, ['e1', 'e2', 'e3'], 'resumed from e1: the dropped page comes again');
    },
  );

  await t.test(
    'a page dropped, a write while the link is down, then a reconnect converges, with a fresh client or the same one',
    async () => {
      for (const freshClient of [true, false]) {
        const engine = memoryEngine();
        let lose = false;
        let lost = 0;
        const mesh = await createMesh(['server', 'laptop'], [['laptop', 'server']], {
          createStorage: (name, options) =>
            createDatabase({
              ...options,
              path: name,
              engine,
              lock: false,
              logger: false,
              schema: { entities: { Task: {} } },
            }),
          // The next page with ops is lost — once: the socket dies with it.
          link: {
            drop: (page) => {
              if (!lose || !(page?.ops?.length > 0)) return false;
              lose = false;
              lost++;
              return true;
            },
          },
        });
        await mesh.get('server').Task.insert({ title: 'first' });
        await settle(mesh.storages);
        const link = mesh.links.get('mem://server');
        lose = true;
        await mesh.get('server').Task.insert({ title: 'lost on the way' });
        await waitUntil(() => lost === 1);
        assert.strictEqual(link.down, true);
        await mesh.get('server').Task.insert({ title: 'written while the link is down' });
        await assert.rejects(() => settle(mesh.storages, { timeout: 100, step: 5 }), { message: /did not settle/ });
        await link.reconnect({ freshClient });
        await settle(mesh.storages);
        assert.strictEqual(await mesh.get('laptop').Task.select({}).count(), 3);
        assert.ok(sameVectors(mesh.storages));
        await mesh.close();
      }
    },
  );

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
