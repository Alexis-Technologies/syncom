'use strict';

// Presence (src/presence/presence.js): ephemeral state per node, signed,
// never logged (PRES-1); carried over a hub by the sync plugin (PRES-2).

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { memory } = require('../src/memory/memory.js');
const { createPresence, MAX_KEYS } = require('../src/presence/presence.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const open = async (t, name, options = {}) => {
  const storage = await syncom.open({ path: `/${name}`, fsi: memory(), logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

test('presence', async (t) => {
  await t.test(
    'presence: a state is set, renewed, expired and left; the newest by clock wins; a forged or unsigned state is refused; nothing is logged',
    async (t2) => {
      const a = await open(t2, 'a');
      const b = await open(t2, 'b');
      const strict = await open(t2, 'strict', { sync: { signatures: 'require' } });
      const pa = createPresence(a, { timeout: 300 });
      const pb = createPresence(b, { timeout: 300 });
      t2.after(() => pa.destroy());
      t2.after(() => pb.destroy());
      const changes = [];
      pb.on('change', (change) => changes.push(change));
      const updates = [];
      pa.on('update', (update) => updates.push(update));
      assert.deepStrictEqual([pa.node, pa.scope, pa.timeout, pa.local, pa.nodes()], [a.nodeId, '*', 300, null, []]);
      const first = await pa.set({ name: 'ada', cursor: 3 });
      assert.deepStrictEqual(first.p, 1);
      assert.strictEqual(first.s.length, 1);
      const [node, clock, ts, state, sig] = first.s[0];
      assert.deepStrictEqual(
        [node, clock, state, typeof ts, typeof sig],
        [a.nodeId, 1, { name: 'ada', cursor: 3 }, 'number', 'string'],
      );
      assert.deepStrictEqual(pa.local, { name: 'ada', cursor: 3 });
      assert.deepStrictEqual(await pb.apply(first), { applied: 1, stale: 0, forged: 0, unsigned: 0, refused: 0 });
      assert.deepStrictEqual(pb.get(a.nodeId), { name: 'ada', cursor: 3 });
      assert.deepStrictEqual([...pb.states().keys()], [a.nodeId]);
      assert.deepStrictEqual(changes, [{ added: [a.nodeId], updated: [], removed: [] }]);
      // Again: stale. Newer: updated. Tampered: forged. Another node's name: refused with `from`.
      assert.deepStrictEqual((await pb.apply(first)).stale, 1);
      const second = await pa.set({ name: 'ada', cursor: 4 });
      assert.deepStrictEqual((await pb.apply(second)).applied, 1);
      assert.deepStrictEqual(changes[1], { added: [], updated: [a.nodeId], removed: [] });
      assert.deepStrictEqual((await pb.apply(first)).stale, 1, 'an older clock loses');
      const tampered = JSON.parse(JSON.stringify(second));
      tampered.s[0][3].cursor = 99;
      assert.deepStrictEqual((await pb.apply(tampered)).forged, 1);
      assert.deepStrictEqual(pb.get(a.nodeId).cursor, 4);
      assert.deepStrictEqual((await pb.apply(second, { from: b.nodeId })).refused, 1);
      // Unsigned: taken under 'verify', refused under 'require'; malformed and oversized refused; another scope ignored.
      const unsigned = { p: 1, scope: '*', s: [['someone', 1, Date.now(), { x: 1 }]] };
      assert.deepStrictEqual((await pb.apply(unsigned)).applied, 1);
      const ps = createPresence(strict, { timeout: 300 });
      t2.after(() => ps.destroy());
      assert.deepStrictEqual((await ps.apply(unsigned)).unsigned, 1);
      assert.deepStrictEqual((await ps.apply(second)).applied, 1, 'a signed state passes');
      for (const bad of [null, { p: 2 }, { p: 1, scope: '*', s: 'x' }, { p: 1, scope: 'other', s: [] }]) {
        assert.deepStrictEqual(
          await pb.apply(bad),
          { applied: 0, stale: 0, forged: 0, unsigned: 0, refused: 0 },
          JSON.stringify(bad),
        );
      }
      const big = {
        p: 1,
        scope: '*',
        s: [
          ['someone', 2, Date.now(), Object.fromEntries(Array.from({ length: MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]))],
        ],
      };
      assert.deepStrictEqual((await pb.apply(big)).refused, 1);
      assert.deepStrictEqual((await pb.apply({ p: 1, scope: '*', s: [['bad@id', 1, 1, {}]] })).refused, 1);
      await assert.rejects(() => pa.set({ deep: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } } }), {
        code: 'PRESENCE_SIZE',
      });
      await assert.rejects(() => pa.set('x'), { code: 'PRESENCE_SIZE' });
      // Expiry: a state not renewed goes; this node's renews itself. Nothing reached the log.
      await wait(450);
      assert.deepStrictEqual(pb.nodes(), [], 'expired on b');
      assert.deepStrictEqual(pa.local, { name: 'ada', cursor: 4 }, 'renewed on a');
      assert.ok(updates.length > 2, 'renewals announced');
      assert.strictEqual(a.log.length, 0);
      assert.strictEqual(b.log.length, 0);
      // A leave; encode; destroy. (A state older than the timeout is stale: a fresh one first.)
      const third = await pa.set({ name: 'ada', cursor: 5 });
      assert.deepStrictEqual((await pb.apply(second)).stale, 1, 'older than the timeout');
      assert.deepStrictEqual((await pb.apply(third)).applied, 1);
      const left = await pa.delete();
      assert.deepStrictEqual([left.s[0][3], pa.local, pa.nodes()], [null, null, []]);
      assert.deepStrictEqual((await pb.apply(left)).applied, 1);
      assert.deepStrictEqual(pb.nodes(), []);
      assert.deepStrictEqual((await pb.apply(third)).stale, 1, 'the leave is newer');
      const fourth = await pa.set({ name: 'ada', cursor: 6 });
      await pb.apply(fourth);
      assert.deepStrictEqual(
        pb.encode().s.map((entry) => entry[0]),
        [a.nodeId],
      );
      assert.deepStrictEqual(pb.encode([b.nodeId]).s, []);
      await pb.destroy();
      assert.deepStrictEqual(pb.nodes(), []);
      await assert.rejects(() => pb.set({ x: 1 }), TypeError);
      assert.deepStrictEqual(await pb.apply(fourth), { applied: 0, stale: 0, forged: 0, unsigned: 0, refused: 0 });
      // Options.
      assert.throws(() => createPresence(a, { timeout: 0 }), TypeError);
      assert.throws(() => createPresence(a, { scope: 7 }), TypeError);
      assert.throws(() => createPresence({}), TypeError);
      assert.throws(() => a.sync.presence({}), TypeError);
    },
  );

  await t.test(
    'presence over a hub: fan-out to the room but the sender, a newcomer handed the room, a leave reaching everyone, forgery and another scope refused',
    async (t2) => {
      const createStorage = (t3, name, options) => open(t3, name, options);
      const mesh = await createMesh(
        t2,
        ['H', 'A', 'B'],
        [
          ['A', 'H'],
          ['B', 'H'],
        ],
        createStorage,
        {
          unit: { access: 'public', presence: { rate: 5, timeout: 1000 } },
        },
      );
      const [h, a, b] = ['H', 'A', 'B'].map((name) => mesh.get(name));
      await settle([h, a, b]);
      const make = (storage) => {
        const presence = createPresence(storage, { timeout: 1000 });
        t2.after(() => presence.destroy());
        storage.sync.presence(presence);
        return presence;
      };
      const [ph, pa, pb] = [h, a, b].map(make);
      const refused = [];
      h.sync.on('refused', (event) => refused.push(event.reason));
      // The links of the hub, by the node that greeted through them.
      const linkOf = (storage) =>
        [...mesh.servers.get('H').links].find((link) => link.client.data.syncom?.node === storage.nodeId);
      await pa.set({ name: 'ada' });
      await waitUntil(() => pb.get(a.nodeId) !== undefined);
      assert.deepStrictEqual([pb.get(a.nodeId), ph.get(a.nodeId)], [{ name: 'ada' }, { name: 'ada' }]);
      assert.strictEqual(linkOf(a).sent.filter((event) => event === 'syncom/presence').length, 1);
      await pb.set({ name: 'bob' });
      await waitUntil(() => pa.get(b.nodeId) !== undefined);
      assert.deepStrictEqual(pa.nodes().sort(), [a.nodeId, b.nodeId].sort());
      // A newcomer is handed the room at hello; a leave reaches everyone.
      const c = await open(t2, 'C', { sync: { connect: mesh.connect, autoStart: false } });
      await c.sync.addNode({ url: 'mem://H' });
      const pc = make(c);
      await c.sync.start();
      await settle([h, a, b, c]);
      await waitUntil(() => pc.nodes().length === 2);
      assert.deepStrictEqual(pc.nodes().sort(), [a.nodeId, b.nodeId].sort());
      await pa.delete();
      await waitUntil(() => !pb.nodes().includes(a.nodeId) && !pc.nodes().includes(a.nodeId));
      // The host refuses what is not the peer's own, or of a scope it did not ask for, or past the rate.
      const link = linkOf(b);
      link.send('syncom/presence', { p: 1, scope: '*', s: [[a.nodeId, 99, Date.now(), { name: 'mallory' }]] });
      link.send('syncom/presence', { p: 1, scope: 'Secret', s: [[b.nodeId, 99, Date.now(), { name: 'bob' }]] });
      link.send('syncom/presence', 'nonsense');
      await waitUntil(() => refused.length >= 3);
      assert.deepStrictEqual(refused.slice(0, 3), ['PRESENCE_FORGED', 'PRESENCE_SCOPE', 'PRESENCE_MALFORMED']);
      assert.deepStrictEqual(pc.get(a.nodeId), undefined, 'the forgery went nowhere');
      for (let i = 0; i < 8; i++) await pb.set({ name: 'bob', i });
      await waitUntil(() => refused.includes('PRESENCE_RATE'));
      // A stopped carrier sends and hears nothing more.
      const stop = c.sync.presence(pc);
      stop();
      await pb.set({ name: 'bob', quiet: true });
      await waitUntil(() => pa.get(b.nodeId)?.quiet === true);
      assert.notDeepStrictEqual(pc.get(b.nodeId), pa.get(b.nodeId));
    },
  );
});
