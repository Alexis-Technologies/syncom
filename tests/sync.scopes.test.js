'use strict';

// Scopes are a boundary on the hosting side: what hello granted bounds what a
// peer writes (push) and reads (snapshot, changes), not only what it is sent.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { packOps } = require('../src/ops.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { MemoryLink } = require('./utils/memory-link.js');
const { waitUntil } = require('./utils/mesh.js');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

const remoteOp = (origin, seq, type, id, extra = {}) => ({ origin, seq, ts: Date.now() + seq, type, id, ...extra });
const scope = (id, data) => data.$type ?? '*';

test('Hosting scopes', async (t) => {
  await t.test('push: an op outside the scopes hello granted is refused, counted and announced', async (t2) => {
    const host = await openTemp(t2, { sync: { scope } });
    const refused = [];
    host.sync.on('refused', (event) => refused.push(event));
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'tenant-a', version: 1, scopes: ['A'] });
    const answer = await link.call('syncom/push', {
      ops: packOps([
        remoteOp('tenant-a', 1, 'write', 'a1', { data: { $type: 'A' }, scope: 'A' }),
        remoteOp('tenant-a', 1, 'write', 'g1', { data: { n: 1 } }),
        remoteOp('tenant-a', 1, 'write', 'b1', { data: { $type: 'B' }, scope: 'B' }),
      ]),
    });
    assert.strictEqual(answer.applied, 2);
    assert.strictEqual(answer.outOfScope, 1);
    assert.strictEqual(await host.get('b1'), null);
    assert.deepStrictEqual(host.vector, { 'tenant-a@A': 1, 'tenant-a': 1 }, 'the refused stream is untouched');
    assert.deepStrictEqual(refused, [{ node: 'tenant-a', reason: 'scope', count: 1 }]);
    // A peer granted everything is bound by nothing.
    const admin = new MemoryLink(unit);
    await admin.call('syncom/hello', { node: 'admin', version: 1 });
    const ops = packOps([remoteOp('admin', 1, 'write', 'b2', { data: { $type: 'B' }, scope: 'B' })]);
    const all = await admin.call('syncom/push', { ops });
    assert.strictEqual(all.outOfScope, 0);
    assert.deepStrictEqual(await host.get('b2'), { $type: 'B' });
  });

  await t.test('snapshot and changes: what is asked is narrowed to what was granted', async (t2) => {
    const host = await openTemp(t2, { sync: { scope } });
    await host.insert({ $type: 'A', n: 1 });
    await host.insert({ $type: 'B', n: 2 });
    await host.insert({ n: 3 });
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'tenant-a', version: 1, scopes: ['A'] });
    const types = (page) => page.records.map((r) => r.data.$type ?? '*').sort();
    assert.deepStrictEqual(types(await link.call('syncom/snapshot', {})), ['*', 'A'], 'nothing asked: its scopes');
    assert.deepStrictEqual(types(await link.call('syncom/snapshot', { scopes: ['*'] })), ['*', 'A'], "'*': its scopes");
    assert.deepStrictEqual(types(await link.call('syncom/snapshot', { scopes: ['A', 'B'] })), ['*', 'A'], 'narrowed');
    await assert.rejects(() => link.call('syncom/snapshot', { scopes: ['B'] }), {
      code: 403,
      message: 'Scopes not granted',
    });
    // The live feed is bound the same way.
    let failed = null;
    link.subscribe('syncom/changes', { scopes: ['B'] }, { onData() {}, onError: (error) => (failed = error) });
    await waitUntil(() => failed !== null);
    assert.strictEqual(failed.code, 403);
    const seen = [];
    const handlers = {
      onData: (value) => seen.push(...(value.ops ?? []).map((row) => row[4])),
      onError: (error) => {
        throw error;
      },
    };
    link.subscribe('syncom/changes', { scopes: ['A', 'B'] }, handlers);
    const a2 = await host.insert({ $type: 'A', n: 4 });
    const b2 = await host.insert({ $type: 'B', n: 5 });
    const g2 = await host.insert({ n: 6 });
    await waitUntil(() => seen.includes(g2));
    assert.ok(seen.includes(a2), 'A reaches an A subscriber');
    assert.ok(!seen.includes(b2), 'B never does');
    // Unrestricted: as asked.
    const admin = new MemoryLink(unit);
    await admin.call('syncom/hello', { node: 'admin', version: 1 });
    assert.deepStrictEqual(types(await admin.call('syncom/snapshot', {})), ['*', '*', 'A', 'A', 'B', 'B']);
    assert.deepStrictEqual(types(await admin.call('syncom/snapshot', { scopes: ['B'] })), ['*', '*', 'B', 'B']);
  });
});
