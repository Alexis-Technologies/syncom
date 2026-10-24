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

  await t.test('sets converge: concurrent adds both keep, an unobserved add beats a remove', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const id = await a.insert({ title: 'tags' });
    await a.add(id, 'tags', ['x', 'shared']);
    await settle([a, b]);
    assert.deepStrictEqual((await b.get(id)).tags, ['shared', 'x']);
    const link = mesh.links.get('mem://B');
    link.disconnect();
    await a.add(id, 'tags', ['p']);
    await a.remove(id, 'tags', ['x', 'shared']);
    await tick();
    // B, cut off, drops x too, then adds it back: A's remove never observed
    // that add, so x survives everywhere; shared, removed on both, is gone.
    await b.add(id, 'tags', ['q']);
    await b.remove(id, 'tags', ['x', 'shared']);
    await b.add(id, 'tags', ['x']);
    await link.reconnect();
    await settle([a, b]);
    const state = await assertConverged([a, b]);
    assert.deepStrictEqual(state[id].tags, ['p', 'q', 'x']);
    // The kind rule holds across the wire too.
    await assert.rejects(() => b.update(id, { tags: [] }), /set/);
    await assert.rejects(() => b.add(id, 'title', ['x']), /register/);
    // A remove of what the other side added, once seen, lands on both.
    await b.remove(id, 'tags', ['p']);
    await settle([a, b]);
    assert.deepStrictEqual((await a.get(id)).tags, ['q', 'x']);
    assert.deepStrictEqual((await b.get(id)).tags, ['q', 'x']);
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

  await t.test('lists and texts converge: concurrent inserts and cuts, each writer’s run whole', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const a = mesh.get('A');
    const b = mesh.get('B');
    const id = await a.insert({ title: 'doc' });
    await a.splice(id, 'body', 0, 0, 'hello');
    await a.push(id, 'items', [1, 2, 3]);
    await settle([a, b]);
    assert.deepStrictEqual(await b.get(id), { title: 'doc', body: 'hello', items: [1, 2, 3] });
    const link = mesh.links.get('mem://B');
    link.disconnect();
    // Apart: A types on at the end, B types at the end too and cuts the
    // start; both edit the list at one spot.
    for (const ch of ' AAA') await a.push(id, 'body', ch);
    await tick();
    for (const ch of ' BBB') await b.push(id, 'body', ch);
    await b.splice(id, 'body', 0, 1);
    await a.splice(id, 'items', 1, 1, ['a']);
    await b.splice(id, 'items', 1, 0, ['b']);
    await link.reconnect();
    await settle([a, b]);
    const state = await assertConverged([a, b]);
    assert.match(state[id].body, /^ello( AAA| BBB){2}$/, state[id].body);
    assert.ok(
      JSON.stringify(state[id].items) === JSON.stringify([1, 'b', 'a', 3]) ||
        JSON.stringify(state[id].items) === JSON.stringify([1, 'a', 'b', 3]),
      JSON.stringify(state[id].items),
    );
    // The blocks agree too, not only the readings.
    const blocks = async (storage) => (await storage.snapshot()).records.find((r) => r.id === id).meta.seqs;
    assert.deepStrictEqual(await blocks(a), await blocks(b));
    // Live again: a cut on one side, typing on the other, in one spot.
    await a.splice(id, 'body', 0, 4);
    await b.splice(id, 'body', 4, 0, '!');
    await settle([a, b]);
    await assertConverged([a, b]);
    // Two moves of one element apart: it ends up once, where the newer move put it.
    await a.push(id, 'items', ['x', 'y', 'z']);
    await settle([a, b]);
    const before = (await a.get(id)).items;
    link.disconnect();
    await a.move(id, 'items', before.indexOf('x'), before.length - 1);
    await tick();
    await b.move(id, 'items', before.indexOf('x'), 0);
    await b.setAt(id, 'items', 0, 'X');
    await link.reconnect();
    await settle([a, b]);
    const after = await assertConverged([a, b]);
    assert.strictEqual(after[id].items.length, before.length);
    assert.strictEqual(after[id].items.filter((v) => v === 'X' || v === 'x').length, 1, 'the element shows once');
    assert.strictEqual(after[id].items[0], 'X', 'at the newer move’s place, with the assigned value');
    // Two editors hand over whole new texts apart: each one's change lands.
    await a.updateText(id, 'body', 'one two three');
    await settle([a, b]);
    link.disconnect();
    await a.updateText(id, 'body', 'ONE two three');
    await tick();
    await b.updateText(id, 'body', 'one two THREE');
    await link.reconnect();
    await settle([a, b]);
    const texts = await assertConverged([a, b]);
    assert.strictEqual(texts[id].body, 'ONE two THREE');
    // A reset by one side frees the field everywhere; typing after it starts over.
    await a.set(id, { title: 'reset' });
    await settle([a, b]);
    assert.deepStrictEqual(await b.get(id), { title: 'reset' });
    await b.splice(id, 'body', 0, 0, 'again');
    await settle([a, b]);
    assert.deepStrictEqual(await a.get(id), { title: 'reset', body: 'again' });
  });

  await t.test('three nodes type words apart; after the merge every word is whole', async (t2) => {
    // A line with one dialer per host, so every link has a url of its own
    // to disconnect: mesh.links is keyed by the host url.
    const mesh = await createMesh(
      t2,
      ['A', 'B', 'C'],
      [
        ['A', 'B'],
        ['B', 'C'],
      ],
      createStorage,
    );
    const nodes = ['A', 'B', 'C'].map((name) => mesh.get(name));
    const [a] = nodes;
    const id = await a.insert({});
    await a.splice(id, 'body', 0, 0, 'the quick brown fox');
    await settle(nodes);
    for (const link of mesh.links.values()) link.disconnect();
    const random = prng(7);
    for (const node of nodes) {
      const word = node.nodeId.slice(0, 1).repeat(4);
      const at = Math.floor(random() * ((await node.get(id)).body.length + 1));
      for (let i = 0; i < word.length; i++) await node.splice(id, 'body', at + i, 0, word[i]);
    }
    for (const link of mesh.links.values()) await link.reconnect();
    await settle(nodes);
    const state = await assertConverged(nodes);
    for (const node of nodes) {
      const word = node.nodeId.slice(0, 1).repeat(4);
      assert.ok(state[id].body.includes(word), `${word} is whole in ${state[id].body}`);
    }
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
    // r1–r3 take every kind of write, resets included; c1 is never reset, so
    // its counter stays clear of the documented counter/reset straddle.
    const ids = ['r1', 'r2', 'r3'];
    for (const id of ids) await storages[0].set(id, { v: 0 });
    await settle(storages);
    const letter = (storage) => storage.nodeId.slice(0, 1);
    const spliceAt = async (storage, id, key, content) => {
      const current = (await storage.get(id))?.[key];
      const length = typeof current === 'string' || Array.isArray(current) ? current.length : 0;
      const at = Math.floor(random() * (length + 1));
      const count = Math.floor(random() * Math.min(3, length - at + 1));
      await storage.splice(id, key, at, count, content);
    };
    let incs = 0;
    for (let step = 0; step < 80; step++) {
      const storage = storages[Math.floor(random() * storages.length)];
      const id = ids[Math.floor(random() * ids.length)];
      const roll = random();
      try {
        if (roll < 0.12) await storage.set(id, { v: step, by: storage.nodeId.slice(0, 4) });
        else if (roll < 0.24) await storage.update(id, { [`f${step % 3}`]: step });
        else if (roll < 0.3) {
          await storage.inc('c1', 'count', 1);
          incs++;
        } else if (roll < 0.4) await storage.add(id, 'tags', [`t${step % 4}`]);
        else if (roll < 0.48) await storage.remove(id, 'tags', [`t${step % 4}`]);
        else if (roll < 0.54) await storage.delete(id);
        else if (roll < 0.72) await spliceAt(storage, id, 'body', letter(storage).repeat(1 + (step % 3)));
        else if (roll < 0.82) await spliceAt(storage, id, 'items', [`${letter(storage)}${step}`]);
        else {
          const items = (await storage.get(id))?.items ?? [];
          if (items.length === 0) await storage.push(id, 'items', [`${letter(storage)}${step}`]);
          else if (roll < 0.9) {
            await storage.setAt(id, 'items', Math.floor(random() * items.length), `${letter(storage)}=${step}`);
          } else {
            await storage.move(id, 'items', Math.floor(random() * items.length), Math.floor(random() * items.length));
          }
        }
      } catch (error) {
        // A record deleted or shortened elsewhere is a legitimate outcome.
        if (!/not found|out of range|takes a count/.test(error.message)) throw error;
      }
    }
    await settle(storages, { timeout: 10_000 });
    await assertConverged(storages);
    // The sequence blocks agree too, not only what they read as.
    const blocks = async (storage) => {
      const out = {};
      for (const record of (await storage.snapshot()).records) out[record.id] = record.meta.seqs ?? {};
      return out;
    };
    const expected = await blocks(storages[0]);
    for (const other of storages.slice(1)) assert.deepStrictEqual(await blocks(other), expected);
    assert.strictEqual((await storages[0].get('c1')).count, incs, 'every inc counted once');
  });

  await t.test(
    'a mesh that requires signatures converges, and every logged op verifies against its origin',
    async (t2) => {
      const options = { sync: { signatures: 'require' } };
      const mesh = await createMesh(
        t2,
        ['A', 'B', 'C'],
        [
          ['A', 'B'],
          ['B', 'C'],
        ],
        createStorage,
        options,
      );
      const a = mesh.get('A');
      const b = mesh.get('B');
      const c = mesh.get('C');
      const id = await a.insert({ n: 1 });
      await settle([a, b, c]);
      await b.update(id, { m: 2 });
      await c.inc(id, 'hits', 1);
      await c.add(id, 'tags', ['x']);
      await c.delete(await a.insert({ gone: true }));
      await settle([a, b, c]);
      await assertConverged([a, b, c]);
      assert.deepStrictEqual(await c.get(id), { n: 1, m: 2, hits: 1, tags: ['x'] });
      const { verifyOp } = require('../../src/signing.js');
      for (const storage of [a, b, c]) {
        const entries = storage.log.since(undefined);
        assert.ok(entries.length >= 5);
        for (const entry of entries) {
          assert.strictEqual(await verifyOp(entry.op, 'require'), 'ok', `${storage.nodeId}: ${entry.op.type}`);
        }
      }
    },
  );

  await t.test('a late joiner bootstraps from a snapshot once history is compacted', async (t2) => {
    const options = { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } };
    const mesh = await createMesh(t2, ['A', 'B'], [], createStorage, options);
    const a = mesh.get('A');
    const id = await a.insert({ n: 0 });
    for (let i = 0; i < 12; i++) await a.inc(id, 'hits', 1);
    await a.add(id, 'tags', ['x', 'y']);
    await a.remove(id, 'tags', ['x']);
    await a.splice(id, 'body', 0, 0, 'hello');
    await a.splice(id, 'body', 5, 0, ' world');
    await a.splice(id, 'body', 0, 1);
    await a.push(id, 'items', [1, 2]);
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
    assert.deepStrictEqual((await b.get(id)).tags, ['y'], 'and so is a set, tags included');
    assert.strictEqual((await b.get(id)).body, 'ello world', 'and a text, with its runs and cuts');
    assert.deepStrictEqual((await b.get(id)).items, [1, 2]);
    // Live after bootstrap, both ways.
    await a.inc(id, 'hits', 1);
    await a.remove(id, 'tags', ['y']);
    await b.add(id, 'tags', ['z']);
    await b.splice(id, 'body', 0, 0, 'h'); // anchored into the joined runs
    await a.push(id, 'body', '!');
    await b.push(id, 'items', [3]);
    const fromB = await b.insert({ late: true });
    await settle([a, b]);
    assert.strictEqual((await b.get(id)).hits, 13);
    assert.deepStrictEqual((await a.get(id)).tags, ['z']);
    assert.deepStrictEqual((await b.get(id)).tags, ['z']);
    assert.strictEqual((await a.get(id)).body, 'hello world!');
    assert.deepStrictEqual((await a.get(id)).items, [1, 2, 3]);
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
