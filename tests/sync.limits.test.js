'use strict';

// A hosted unit's limits — ops and bytes per push, ops per second — the
// codes they answer with, what the dialer makes of them, the `meta` every
// procedure carries, and the reserved shared-log contract.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { packOps } = require('../src/ops.js');
const { isSharedLog } = require('../src/shared-log.js');
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
const ops = (origin, from, n, data = {}) =>
  Array.from({ length: n }, (_, i) => remoteOp(origin, from + i, 'write', `r${from + i}`, { data }));

test('Hosting limits', async (t) => {
  await t.test('opsPerPush and bytesPerPush refuse a page with 413, before anything is applied', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public', limits: { opsPerPush: 3, bytesPerPush: 400 } });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'peer', version: 1 });
    await assert.rejects(() => link.call('syncom/push', { ops: packOps(ops('peer', 1, 4)) }), {
      code: 413,
      reason: 'OPS_PER_PUSH',
      message: 'Push of 4 ops exceeds opsPerPush 3',
    });
    assert.deepStrictEqual(host.vector, {}, 'nothing applied');
    const answer = await link.call('syncom/push', { ops: packOps(ops('peer', 1, 3)) });
    assert.strictEqual(answer.applied, 3);
    const big = packOps(ops('peer', 4, 1, { text: 'x'.repeat(500) }));
    await assert.rejects(() => link.call('syncom/push', { ops: big }), {
      code: 413,
      reason: 'BYTES_PER_PUSH',
      message: /bytes exceeds bytesPerPush 400/,
    });
    assert.strictEqual((await link.call('syncom/push', {})).applied, 0, 'no ops: nothing to limit');
  });

  await t.test('opsPerSecond is a token bucket per peer: 429 when empty, refilled at the rate', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public', limits: { opsPerSecond: 10 } });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'peer', version: 1 });
    assert.strictEqual((await link.call('syncom/push', { ops: packOps(ops('peer', 1, 10)) })).applied, 10);
    await assert.rejects(() => link.call('syncom/push', { ops: packOps(ops('peer', 11, 1)) }), {
      code: 429,
      reason: 'OPS_PER_SECOND',
      message: 'Rate limited: 1 ops over opsPerSecond 10',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual((await link.call('syncom/push', { ops: packOps(ops('peer', 11, 1)) })).applied, 1, 'refilled');
    // Another peer has its own bucket.
    const other = new MemoryLink(unit);
    await other.call('syncom/hello', { node: 'other', version: 1 });
    assert.strictEqual((await other.call('syncom/push', { ops: packOps(ops('other', 1, 10)) })).applied, 10);
  });

  await t.test('a host that sets no limits still refuses a push past 10 000 ops; Infinity lifts it', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'peer', version: 1 });
    await assert.rejects(() => link.call('syncom/push', { ops: packOps(ops('peer', 1, 10_001)) }), {
      code: 413,
      reason: 'OPS_PER_PUSH',
    });
    assert.deepStrictEqual(host.vector, {}, 'refused at the length, nothing applied');
    const open = new MemoryLink(host.sync.unit({ access: 'public', limits: { opsPerPush: Infinity } }));
    await open.call('syncom/hello', { node: 'wide', version: 1 });
    assert.strictEqual((await open.call('syncom/push', { ops: packOps(ops('wide', 1, 10_001)) })).applied, 10_001);
  });

  await t.test('the dialer reports a refused page and recovers at the next handshake', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public', limits: { opsPerPush: 2 } });
    const dialer = await openTemp(t2, { sync: { autoStart: false, pageSize: 5, connect: () => new MemoryLink(unit) } });
    const errors = [];
    dialer.sync.on('error', (error) => errors.push(error));
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await dialer.insert({ i }));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => errors.length > 0);
    assert.strictEqual(errors[0].code, 413);
    assert.strictEqual(errors[0].url, 'mem://host');
    assert.strictEqual(await host.get(ids[0]), null);
    // A dialer paging within the limit gets through.
    const polite = await openTemp(t2, { sync: { autoStart: false, pageSize: 2, connect: () => new MemoryLink(unit) } });
    for (let i = 0; i < 3; i++) await polite.insert({ i });
    await polite.sync.addNode({ url: 'mem://host' });
    await polite.sync.start();
    await waitUntil(async () => (await host.list()).length === 3);
  });

  await t.test('the options are checked; meta rides on every procedure', async (t2) => {
    const host = await openTemp(t2);
    for (const limits of [
      'many',
      { opsPerPush: 0 },
      { opsPerSecond: -1 },
      { bytesPerPush: 'big' },
      { opsPerMinute: 1 },
    ]) {
      assert.throws(() => host.sync.unit({ limits }), TypeError, JSON.stringify(limits));
    }
    assert.throws(() => host.sync.unit({ meta: 'x' }), {
      name: 'TypeError',
      message: 'unit({ meta }): meta must be an object',
    });
    assert.throws(() => host.sync.unit({ meta: [] }), TypeError);
    const meta = { rateLimit: { limit: 5 } };
    const unit = host.sync.unit({ access: 'public', meta, limits: { opsPerPush: undefined } });
    for (const name of ['hello', 'push', 'snapshot', 'changes']) {
      assert.strictEqual(unit[name].meta, meta, name);
      assert.strictEqual(unit[name].access, 'public');
    }
    assert.strictEqual('meta' in host.sync.unit().push, false, 'absent when not given');
    assert.strictEqual('bucket' in host.sync.unit({ limits: null }).push, false);
  });

  await t.test('the shared-log contract is checked, and refused as an option for now', async (t2) => {
    const log = { append: async () => '1.1', read: () => ({}), parseId: () => null };
    assert.strictEqual(isSharedLog(log), true);
    assert.strictEqual(syncom.isSharedLog(log), true);
    for (const value of [null, 'log', {}, { append() {}, read() {} }, { ...log, parseId: 'nope' }]) {
      assert.strictEqual(isSharedLog(value), false, String(value));
    }
    await assert.rejects(async () => openTemp(t2, { sync: { sharedLog: log } }), {
      name: 'TypeError',
      message: 'sync.sharedLog is reserved: the shared-log hub mode is not in this version',
    });
  });
});
