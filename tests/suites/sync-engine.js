'use strict';

// The convergence properties of the sync engine, over memory links, against
// whichever storage half the caller builds: `createStorage(t, name, options)`
// must return an open Storage and give the SAME directory for the same name
// within one subtest (that is how the reopen case works).

const { createMesh, settle, waitUntil, prng } = require('../utils/mesh.js');

// Two nodes' clocks are independent: a write on B one tick after a write on
// A is only "later" once the millisecond has moved on.
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

const runSyncEngineTests = async (t, assert, createStorage) => {
  const dump = async (storage) => {
    const out = {};
    for (const id of (await storage.list()).sort()) out[id] = await storage.get(id);
    return out;
  };

  const assertConverged = async (storages) => {
    const [first, ...rest] = storages;
    const expected = await dump(first);
    for (const other of rest) assert.deepStrictEqual(await dump(other), expected);
    return expected;
  };

  await t.test('two nodes converge in both directions', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const fromA = await a.insert({ who: 'A' });
    const fromB = await b.insert({ who: 'B' });
    await b.update(fromB, { seen: true });
    await settle([a, b]);
    const state = await assertConverged([a, b]);
    assert.deepStrictEqual(state[fromA], { who: 'A' });
    assert.deepStrictEqual(state[fromB], { who: 'B', seen: true });
    // Nothing was applied twice: every op sits in each log exactly once.
    for (const storage of [a, b]) {
      const keys = storage.log.since(storage.log.formatId(0)).map(({ op }) => `${op.origin}:${op.seq}`);
      assert.strictEqual(new Set(keys).size, keys.length);
    }
    const [peer] = a.sync.peers();
    assert.strictEqual(peer.connected, true);
    assert.strictEqual(peer.subscribed, true);
    assert.strictEqual(peer.node, b.nodeId);
    assert.ok(peer.cursor, 'the cursor is remembered');
    assert.strictEqual(b.sync.peers().length, 0, 'the host dials nobody');
  });

  await t.test('ops relay across a line and around a cycle', async (t2) => {
    const line = await createMesh(
      t2,
      ['A', 'B', 'C'],
      [
        ['A', 'B'],
        ['C', 'B'],
      ],
      createStorage,
    );
    const [a, b, c] = ['A', 'B', 'C'].map((name) => line.get(name));
    const idA = await a.insert({ from: 'A' });
    const idC = await c.insert({ from: 'C' });
    await settle([a, b, c]);
    await assertConverged([a, b, c]);
    assert.deepStrictEqual(await c.get(idA), { from: 'A' });
    assert.deepStrictEqual(await a.get(idC), { from: 'C' });

    const ring = await createMesh(
      t2,
      ['X', 'Y', 'Z'],
      [
        ['X', 'Y'],
        ['Y', 'Z'],
        ['Z', 'X'],
      ],
      createStorage,
    );
    const [x, y, z] = ['X', 'Y', 'Z'].map((name) => ring.get(name));
    const applied = new Map([x, y, z].map((s) => [s, 0]));
    for (const s of [x, y, z]) s.on('change', () => applied.set(s, applied.get(s) + 1));
    await x.insert({ n: 1 });
    await y.insert({ n: 2 });
    await z.insert({ n: 3 });
    await settle([x, y, z]);
    await assertConverged([x, y, z]);
    // Three ops exist; each node applied each exactly once — no echo storm.
    for (const s of [x, y, z]) assert.strictEqual(applied.get(s), 3);
  });

  await t.test('concurrent writes converge: registers by last writer, counters by sum', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    // A counter is created by inc(): a field initialised in insert() is a register.
    const id = await a.insert({ title: 'v0' });
    await settle([a, b]);
    const link = mesh.links.get('mem://B');

    // Partition, then write on both sides.
    link.disconnect();
    await a.update(id, { title: 'from A', tag: 'a' });
    await tick();
    await b.update(id, { title: 'from B' });
    await a.inc(id, 'hits', 2);
    await b.inc(id, 'hits', 3);
    await link.reconnect();
    await settle([a, b]);
    const state = await assertConverged([a, b]);
    assert.strictEqual(state[id].tag, 'a');
    assert.strictEqual(state[id].hits, 5);
    assert.strictEqual(state[id].title, 'from B', 'the later write wins on both nodes');
    // The register/counter rule holds across the wire too.
    await assert.rejects(() => b.update(id, { hits: 9 }), /counter/);
  });

  await t.test('delete versus a concurrent write converges either way', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const first = await a.insert({ n: 1 });
    const second = await a.insert({ n: 2 });
    await settle([a, b]);
    const link = mesh.links.get('mem://B');
    link.disconnect();
    await a.delete(first);
    await tick();
    await b.update(first, { n: 10 }); // newer than the delete: revives
    await b.delete(second);
    await tick();
    await a.update(second, { n: 20 }); // newer than B's delete: revives
    await link.reconnect();
    await settle([a, b]);
    const state = await assertConverged([a, b]);
    assert.deepStrictEqual(state[first], { n: 10 });
    assert.deepStrictEqual(state[second], { n: 20 });
    // Now a delete that is genuinely last stays a delete everywhere.
    await b.delete(first);
    await settle([a, b]);
    assert.strictEqual(await a.get(first), null);
    assert.strictEqual(await b.get(first), null);
  });

  await t.test('a random workload over a mesh converges (seeded)', async (t2) => {
    const names = ['A', 'B', 'C', 'D'];
    const edges = [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'A'],
      ['A', 'C'],
    ];
    const mesh = await createMesh(t2, names, edges, createStorage);
    const storages = names.map((name) => mesh.get(name));
    const random = prng(20260905);
    const ids = ['r1', 'r2', 'r3'];
    for (const id of ids) await storages[0].set(id, { v: 0 });
    await settle(storages);
    for (let step = 0; step < 40; step++) {
      const storage = storages[Math.floor(random() * storages.length)];
      const id = ids[Math.floor(random() * ids.length)];
      const roll = random();
      try {
        if (roll < 0.4) await storage.set(id, { v: step, by: storage.nodeId.slice(0, 4) });
        else if (roll < 0.7) await storage.update(id, { [`f${step % 3}`]: step });
        else if (roll < 0.85) await storage.inc(id, 'count', 1);
        else await storage.delete(id);
      } catch (error) {
        // A record deleted elsewhere is a legitimate outcome of the workload.
        if (!/not found/.test(error.message)) throw error;
      }
    }
    await settle(storages, { timeout: 10_000 });
    await assertConverged(storages);
  });

  await t.test('a late joiner bootstraps from a snapshot once history is compacted', async (t2) => {
    const options = { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } };
    const mesh = await createMesh(t2, ['A', 'B'], [], createStorage, options);
    const a = mesh.get('A');
    const id = await a.insert({ n: 0 });
    for (let i = 0; i < 12; i++) await a.inc(id, 'hits', 1);
    await a.insert({ other: true });
    assert.ok(a.log.floor > 1, 'history was compacted');
    // A holds state stamped by a peer whose clock runs an hour ahead; it
    // reaches B only through the snapshot, never as an op B could observe.
    const ahead = Date.now() + 3_600_000;
    await a.applyRemote([{ origin: 'fast', seq: 1, ts: ahead, type: 'write', id: 'skewed', data: { v: 'fast' } }]);

    const b = mesh.get('B');
    const events = [];
    b.sync.on('bootstrap', (event) => events.push(event));
    await b.sync.addNode({ url: 'mem://A' });
    await settle([a, b]);
    assert.strictEqual(events.length, 1);
    await assertConverged([a, b]);
    assert.strictEqual((await b.get(id)).hits, 12, 'counters are exact after a snapshot');
    // Live after bootstrap, both ways.
    await a.inc(id, 'hits', 1);
    const fromB = await b.insert({ late: true });
    await settle([a, b]);
    assert.strictEqual((await b.get(id)).hits, 13);
    assert.deepStrictEqual(await a.get(fromB), { late: true });
    // B's write to the skew-stamped record wins over what it joined, everywhere.
    await b.update('skewed', { v: 'B' });
    await settle([a, b]);
    assert.deepStrictEqual(await a.get('skewed'), { v: 'B' }, 'a local write outranks the joined state');
    // A snapshot merged into B is in B's log, so a peer of B gets it too.
    const c = await createStorage(t2, 'C', {
      sync: { connect: () => new (require('../utils/memory-link.js').MemoryLink)(b.sync.unit({ access: 'public' })) },
    });
    await c.sync.addNode({ url: 'mem://B' });
    await settle([a, b, c]);
    await assertConverged([a, b, c]);
  });

  await t.test('a disconnect and reconnect resumes from the last event id, both ways', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const id = await a.insert({ n: 0 });
    await settle([a, b]);
    const link = mesh.links.get('mem://B');
    const peers = [];
    a.sync.on('peer', (event) => peers.push(event));

    link.disconnect();
    await waitUntil(() => a.sync.peers()[0].connected === false);
    for (let i = 1; i <= 3; i++) await a.update(id, { [`a${i}`]: i });
    for (let i = 1; i <= 2; i++) await b.update(id, { [`b${i}`]: i });
    const received = [];
    a.sync.on('sync', (event) => received.push(event));
    await link.reconnect();
    await settle([a, b]);
    await assertConverged([a, b]);
    assert.deepStrictEqual(await a.get(id), { n: 0, a1: 1, a2: 2, a3: 3, b1: 1, b2: 2 });
    assert.ok(peers.some((event) => event.reconnected));
    // Exactly one live subscription afterwards, and no bootstrap was needed.
    const [peer] = a.sync.peers();
    assert.strictEqual(peer.subscribed, true);
    assert.strictEqual(a.sync.peers().length, 1);
    assert.ok(!received.some((event) => event.bootstrap));
    // Resume delivered B's two ops, nothing older.
    const replayed = received.filter((event) => event.received !== undefined).reduce((sum, e) => sum + e.received, 0);
    assert.strictEqual(replayed, 2);
  });

  await t.test('scopes: a node syncs only what it asked for, plus everything global', async (t2) => {
    const scope = (id, data) => data.$type ?? '*';
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage, {
      sync: { scope },
      scopes: { A: ['Doc'] },
    });
    const a = mesh.get('A');
    const b = mesh.get('B');
    const doc = await b.insert({ $type: 'Doc', t: 1 });
    const other = await b.insert({ $type: 'Other', t: 2 });
    const global = await b.insert({ t: 3 });
    const fromA = await a.insert({ $type: 'Note', t: 4 });
    await waitUntil(async () => (await a.get(doc)) !== null && (await a.get(global)) !== null);
    // What must NOT arrive gets a moment to not arrive in.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(await a.get(doc), { $type: 'Doc', t: 1 });
    assert.deepStrictEqual(await a.get(global), { t: 3 });
    assert.strictEqual(await a.get(other), null, 'out of scope');
    assert.strictEqual(await b.get(fromA), null, 'A pushes only its scopes too');
    assert.deepStrictEqual(a.sync.peers()[0].node, b.nodeId);
    // The host put the subscriber in the scope's room.
    assert.ok(mesh.links.get('mem://B').client.rooms.has('syncom:Doc'));
  });

  await t.test('a live Record on one node follows writes made on another', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const id = await a.insert({ title: 'Draft', views: 0 });
    await settle([a, b]);
    const record = await b.record(id);
    const seen = [];
    record.on('update', (data, delta) => seen.push(delta));
    record.title = 'B edit';
    await a.update(id, { views: 9 });
    await waitUntil(() => record.views === 9);
    assert.strictEqual(record.title, 'B edit', 'unsaved local edit survives');
    assert.deepStrictEqual(seen.at(-1), { views: 9 });
    await record.save();
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { title: 'B edit', views: 9 });
  });

  await t.test('identity, cursor and vector survive a reopen; no bootstrap is needed', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    let a = mesh.get('A');
    const b = mesh.get('B');
    const id = await a.insert({ n: 1 });
    await settle([a, b]);
    const nodeId = a.nodeId;
    const { cursor } = a.sync.peers()[0];
    await a.close();
    assert.strictEqual(a.sync.started, false);

    await b.update(id, { n: 2 }); // while A is away
    // A fresh link, as a real connect(node) would make a fresh client.
    const connect = (node) => new (require('../utils/memory-link.js').MemoryLink)(mesh.units.get(node.url.slice(6)));
    a = await createStorage(t2, 'A', { sync: { connect, autoStart: false } });
    assert.strictEqual(a.nodeId, nodeId);
    assert.strictEqual(a.sync.listNodes()[0].cursor, cursor);
    const bootstraps = [];
    a.sync.on('bootstrap', (event) => bootstraps.push(event));
    await a.sync.start();
    await settle([a, b]);
    await assertConverged([a, b]);
    assert.deepStrictEqual(await a.get(id), { n: 2 });
    assert.strictEqual(bootstraps.length, 0, 'resumed from the cursor, not re-bootstrapped');
    await a.sync.stop();
    assert.strictEqual(a.sync.peers().length, 0);
  });

  await t.test('the hosting unit refuses what it must', async (t2) => {
    const mesh = await createMesh(t2, ['A'], [], createStorage);
    const a = mesh.get('A');
    const unit = a.sync.unit({ authorize: (context, hello) => hello.token === 'ok' });
    const { MemoryLink } = require('../utils/memory-link.js');
    const link = new MemoryLink(unit);
    await assert.rejects(() => link.call('syncom/push', { ops: [] }), /hello first/);
    await assert.rejects(() => link.call('syncom/hello', { node: a.nodeId, token: 'ok' }), /itself/);
    await assert.rejects(() => link.call('syncom/hello', { node: 'peer', token: 'no' }), /Not authorized/);
    await assert.rejects(() => link.call('syncom/hello', { node: 'peer', token: 'ok', version: 99 }), /protocol/);
    await assert.rejects(() => link.call('syncom/hello', {}), /node id/);
    const hello = await link.call('syncom/hello', { node: 'peer', token: 'ok', version: 1 });
    assert.strictEqual(hello.node, a.nodeId);
    assert.strictEqual(hello.epoch, a.log.epoch);
    assert.strictEqual(unit.hello.access, 'session', 'the default access is wrpc’s default');
    assert.strictEqual(a.sync.unit({ access: 'public' }).push.access, 'public');
    const solo = await createStorage(t2, 'solo');
    await assert.rejects(() => solo.sync.start(), /connect/);
  });
};

module.exports = { runSyncEngineTests };
