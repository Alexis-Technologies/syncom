'use strict';

// Two hubs, two clients on different hubs: what alioth runs behind sticky
// sessions. Ops cross the hub-to-hub edge, a client moves between hubs, a
// hub restarts and its clients resume from their cursors.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');

test('Hub mesh', async (t) => {
  const dirs = new Map();
  const createStorage = async (t2, name, options = {}) => {
    const key = `${t2.name}:${name}`;
    if (!dirs.has(key)) {
      dirs.set(key, await createTemp());
      t2.after(() => cleanupTemp(dirs.get(key)));
    }
    const storage = await syncom.open({ path: dirs.get(key), logger: false, ...options });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };

  await t.test('clients on different hubs converge, move between hubs, and survive a hub restart', async (t2) => {
    const mesh = await createMesh(
      t2,
      ['H1', 'H2', 'C1', 'C2'],
      [
        ['H1', 'H2'],
        ['C1', 'H1'],
        ['C2', 'H2'],
      ],
      createStorage,
    );
    const [h1, h2, c1, c2] = ['H1', 'H2', 'C1', 'C2'].map((name) => mesh.get(name));
    await waitUntil(() => [h1, c1, c2].every((s) => s.sync.peers()[0]?.subscribed));
    const first = await c1.insert({ from: 'C1' });
    const second = await c2.insert({ from: 'C2' });
    await settle([h1, h2, c1, c2]);
    assert.deepStrictEqual(await c2.get(first), { from: 'C1' }, 'across both hubs');
    assert.deepStrictEqual(await c1.get(second), { from: 'C2' });

    // H2 restarts: its clients' cursors still name its log, so they resume.
    const bootstraps = [];
    c2.sync.on('bootstrap', (event) => bootstraps.push(event));
    await h2.close();
    const h2again = await createStorage(t2, 'H2', { sync: { connect: mesh.connect, autoStart: false } });
    mesh.units.set('H2', h2again.sync.unit({ access: 'public' }));
    for (const storage of [h1, c2]) {
      await storage.sync.enableNode('mem://H2', false);
      await storage.sync.enableNode('mem://H2', true);
    }
    await waitUntil(() => c2.sync.peers()[0]?.subscribed && h1.sync.peers()[0]?.subscribed);
    const third = await c1.insert({ from: 'C1', n: 3 });
    await settle([h1, h2again, c1, c2]);
    assert.deepStrictEqual(await c2.get(third), { from: 'C1', n: 3 });
    assert.deepStrictEqual(bootstraps, [], 'resumed, not bootstrapped');
    assert.strictEqual(h2again.nodeId, h2.nodeId);

    // C2 moves to H1 (a sticky session elsewhere): it catches up from there.
    await c2.sync.removeNode('mem://H2');
    await c2.sync.addNode({ url: 'mem://H1' });
    await waitUntil(() => c2.sync.peers()[0]?.subscribed);
    const fourth = await c1.insert({ from: 'C1', n: 4 });
    const fifth = await c2.insert({ from: 'C2', n: 5 });
    await settle([h1, h2again, c1, c2]);
    assert.deepStrictEqual(await c2.get(fourth), { from: 'C1', n: 4 });
    assert.deepStrictEqual(await h2again.get(fifth), { from: 'C2', n: 5 }, 'H2 hears of it through H1');
    assert.deepStrictEqual(await c1.get(fifth), { from: 'C2', n: 5 });
  });
});
