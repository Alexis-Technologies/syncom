'use strict';

// The identity as a block: without `@alexify/syncom/signing` the node id is
// what `getId` mints and nothing is signed or checked; with it the id is the
// key and every op is signed, as it was. What the core refuses without the
// plugin, and how a directory moves between the two.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../index.js');
const { signing } = require('../src/signing/signing.js');
const { createSigner, tamper } = require('./utils/signed.js');
const { createMesh, settle } = require('./utils/mesh.js');
const { MemoryLink } = require('./utils/memory-link.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const unsignedOp = (seq, id, data) => ({ origin: null, seq, ts: Date.now() + seq, type: 'write', id, data });
const collect = () => {
  const warnings = [];
  const logger = { debug() {}, info() {}, warn: (entry) => warnings.push(entry), error() {} };
  return { warnings, logger };
};

test('signing as a plugin', async (t) => {
  await t.test(
    'without the plugin the node id is what getId mints, a UUID by default, and its ops carry no signature',
    async (t2) => {
      const fsi = core.createMemoryFsi();
      const storage = await core.open({ path: 'plain', fsi, logger: false });
      t2.after(() => storage.close().catch(() => {}));
      assert.match(storage.nodeId, UUID);
      assert.deepStrictEqual(storage.plugins, []);
      assert.deepStrictEqual(JSON.parse(await fsi.read('plain', 'node.json')), { id: storage.nodeId, plugins: [] });
      assert.strictEqual(await fsi.exists('plain/keys', 'sign-public.pem'), false);
      const ops = [];
      storage.on('change', (op) => ops.push(op));
      await storage.insert({ a: 1 });
      assert.strictEqual(ops.length, 1);
      assert.strictEqual(ops[0].origin, storage.nodeId);
      assert.deepStrictEqual([ops[0].sig ?? null, ops[0].digest ?? null], [null, null]);
      await storage.close();
      const again = await core.open({ path: 'plain', fsi, logger: false });
      t2.after(() => again.close().catch(() => {}));
      assert.strictEqual(again.nodeId, storage.nodeId, 'node.json keeps it');
      // The id generator is the application's: cuid, ulid, a name — the same
      // one that mints record ids.
      let n = 0;
      const named = await core.open({ path: 'named', fsi, logger: false, getId: () => `node-${++n}` });
      t2.after(() => named.close().catch(() => {}));
      assert.strictEqual(named.nodeId, 'node-1');
      assert.strictEqual(await named.insert({}), 'node-2');
      // A record id is not always a node id: no '@' in a stream name.
      await assert.rejects(() => core.open({ path: 'at', fsi, logger: false, getId: () => 'a@b' }), {
        name: 'TypeError',
        message: /open\(\{ getId \}\): "a@b" cannot be a node id/,
      });
    },
  );

  await t.test('require without the plugin is PLUGIN_MISSING; a tampered signature rides along unread', async (t2) => {
    const fsi = core.createMemoryFsi();
    await assert.rejects(() => core.open({ path: 'strict', fsi, logger: false, sync: { signatures: 'require' } }), {
      name: 'TypeError',
      code: 'PLUGIN_MISSING',
      message:
        "sync.signatures 'require' needs the signing plugin: open({ plugins: [signing] }) from '@alexify/syncom/signing'",
    });
    // 'verify' without the plugin verifies nothing: the semantics an unsigned
    // op always had, now for every op — a node that wants the check
    // registers the plugin.
    const storage = await core.open({ path: 'lax', fsi, logger: false });
    t2.after(() => storage.close().catch(() => {}));
    assert.strictEqual(storage.signatures, 'verify');
    const peer = await createSigner();
    const good = await peer.sign(unsignedOp(1, 'r1', { a: 1 }));
    const bad = tamper(await peer.sign(unsignedOp(2, 'r1', { a: 2 })));
    const answer = await storage.applyRemote([good, bad]);
    assert.deepStrictEqual([answer.applied, answer.forged, answer.unsigned], [2, 0, 0]);
    assert.deepStrictEqual(await storage.get('r1'), { a: 2, tampered: true });
  });

  await t.test(
    'a directory keeps its key id without the plugin; one born without it is rekeyed once when the plugin arrives',
    async () => {
      const fsi = core.createMemoryFsi();
      const { warnings, logger } = collect();
      const signed = await core.open({ path: 'keyed', fsi, logger, plugins: [signing] });
      const key = signed.nodeId;
      assert.match(key, KEY);
      await signed.close();
      // Without the plugin: the id stays the key (node.json names it, and the
      // key pair is on disk), the ops go out unsigned.
      const plain = await core.open({ path: 'keyed', fsi, logger });
      assert.strictEqual(plain.nodeId, key);
      const ops = [];
      plain.on('change', (op) => ops.push(op));
      await plain.insert({ a: 1 });
      assert.strictEqual(ops[0].sig ?? null, null);
      await plain.close();
      const back = await core.open({ path: 'keyed', fsi, logger, plugins: [signing] });
      assert.strictEqual(back.nodeId, key);
      const signedOps = [];
      back.on('change', (op) => signedOps.push(op));
      await back.insert({ b: 1 });
      assert.match(signedOps[0].sig, /^[A-Za-z0-9_-]{86}$/);
      await back.close();
      assert.deepStrictEqual(warnings, [], 'the same key is no rekeying');
      // Born without the plugin: a UUID, which the plugin's first open rekeys —
      // once, with a warning, as a directory from before signing.
      const born = await core.open({ path: 'born', fsi, logger });
      const uuid = born.nodeId;
      assert.match(uuid, UUID);
      await born.close();
      const rekeyed = await core.open({ path: 'born', fsi, logger, plugins: [signing] });
      assert.match(rekeyed.nodeId, KEY);
      assert.deepStrictEqual(warnings, [{ event: 'identity.rekeyed', from: uuid, to: rekeyed.nodeId }]);
      await rekeyed.close();
      const settled = await core.open({ path: 'born', fsi, logger, plugins: [signing] });
      assert.strictEqual(settled.nodeId, rekeyed.nodeId);
      assert.strictEqual(warnings.length, 1);
      await settled.close();
    },
  );

  await t.test('a verify host takes the ops of an unsigned node; a require host refuses its hello', async (t2) => {
    const fsi = core.createMemoryFsi();
    const createStorage = async (t3, name, options = {}) => {
      const storage = await core.open({ path: `mesh-${name}`, fsi, logger: false, ...options });
      t3.after(() => storage.close().catch(() => {}));
      return storage;
    };
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage, {
      nodes: { B: { plugins: [signing] } },
    });
    const a = mesh.get('A');
    const b = mesh.get('B');
    assert.match(a.nodeId, UUID);
    assert.match(b.nodeId, KEY);
    const fromA = await a.insert({ from: 'a' });
    const fromB = await b.insert({ from: 'b' });
    await settle([a, b]);
    assert.deepStrictEqual(await b.get(fromA), { from: 'a' });
    assert.deepStrictEqual(await a.get(fromB), { from: 'b' });
    // The configuration that resists stripping: 'require' on every node, with
    // the plugin — a node id that is no key is refused at hello.
    const strict = await createStorage(t2, 'S', { plugins: [signing], sync: { signatures: 'require' } });
    strict.on('error', () => {});
    const link = new MemoryLink(strict.sync.unit({ access: 'public' }));
    await assert.rejects(() => link.call('syncom/hello', { node: a.nodeId, version: 1 }), {
      code: 403,
      reason: 'UNSIGNED',
    });
  });
});
