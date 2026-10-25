'use strict';

// Scopes are a boundary on the hosting side: what hello granted bounds what a
// peer writes (push) and reads (snapshot, changes), not only what it is sent.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
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
      reason: 'SCOPES',
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

  await t.test("a feed moves past other scopes' ops without sending a page", async (t2) => {
    const host = await openTemp(t2, { sync: { autoStart: false, scope } });
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'tenant-a', version: 1, scopes: ['A'] });
    const pages = [];
    link.subscribe(
      'syncom/changes',
      { scopes: ['A'] },
      {
        onData: (value, eventId) => pages.push({ ids: (value.ops ?? []).map((row) => row[4]), eventId }),
        onError: (error) => {
          throw error;
        },
      },
    );
    for (let i = 0; i < 20; i++) await host.insert({ $type: 'B', i });
    // Every B op woke the feed; its cursor followed them to the last real
    // entry, and nothing went out.
    await waitUntil(() => host.sync.hosted()[0]?.cursor === host.log.lastEventId);
    assert.deepStrictEqual(pages, [], 'no empty pages');
    const a = await host.insert({ $type: 'A', n: 1 });
    await waitUntil(() => pages.length === 1);
    assert.deepStrictEqual(pages[0].ids, [a], 'the A op alone, labelled with its own position');
    assert.strictEqual(pages[0].eventId, host.log.lastEventId);
    assert.strictEqual(host.sync.hosted()[0].cursor, host.log.lastEventId);
    // A resume from the last page delivered is exact: the B ops before it are
    // behind the cursor the page carried. (The socket dies first, as it does
    // before a real reconnect — the old feed ends, the new one resumes.)
    link.disconnect();
    await link.reconnect({ freshClient: false });
    const b = await host.insert({ $type: 'B', i: 99 });
    const a2 = await host.insert({ $type: 'A', n: 2 });
    await waitUntil(() => pages.length === 2);
    assert.deepStrictEqual(pages[1].ids, [a2], `B ${b} never reached an A subscriber`);
  });
});

test('Scopes bound the records an op writes', async (t) => {
  await t.test('an update is minted in the scope of its record, not of its delta', async (t2) => {
    const node = await openTemp(t2, { sync: { autoStart: false, scope } });
    const id = await node.insert({ $type: 'Doc', title: 'v1' });
    await node.update(id, { title: 'v2' });
    await node.inc(id, 'views', 1);
    await node.add(id, 'tags', ['a']);
    await node.delete(id);
    const scopes = node.log.entriesOf(id).map(({ op }) => [op.type, op.scope]);
    assert.deepStrictEqual(scopes, [
      ['write', 'Doc'],
      ['set', 'Doc'],
      ['inc', 'Doc'],
      ['add', 'Doc'],
      ['delete', 'Doc'],
    ]);
    // Each in its stream: the Doc stream counts all five.
    assert.strictEqual(node.vector[`${node.nodeId}@Doc`], 5);
  });

  await t.test('the scope is read after validation: a default the validator fills counts', async (t2) => {
    const tenant = (id, data) => data.tenant ?? '*';
    const node = await openTemp(t2, {
      sync: { autoStart: false, scope: tenant },
      schema: { entities: { Task: { schema: (data) => ({ tenant: 't1', ...data }) } } },
    });
    const task = await node.Task.insert({ title: 'x' });
    const [{ op }] = node.log.entriesOf(task.id);
    assert.strictEqual(op.scope, 't1');
    assert.strictEqual(node.vector[`${node.nodeId}@t1`], 1);
    assert.strictEqual(node.vector[node.nodeId], undefined, 'nothing went to the global stream');
  });

  await t.test('a peer that writes a record outside its scopes is refused, whatever the op declares', async (t2) => {
    const host = await openTemp(t2, { sync: { scope } });
    const refused = [];
    host.sync.on('refused', (event) => refused.push(event));
    const doc = await host.insert({ $type: 'Doc', title: 'secret' });
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'tenant-o', version: 1, scopes: ['Other'] });
    const push = (op) => link.call('syncom/push', { ops: packOps([op]) });
    // A set declared global, on a Doc record: what the scope bug let through.
    const set = await push(remoteOp('o1', 1, 'set', doc, { data: { title: 'stub', owner: 'mallory' } }));
    // A write declared in its own scope that would move the Doc record there.
    const move = await push(remoteOp('o2', 1, 'write', doc, { data: { $type: 'Other' }, scope: 'Other' }));
    // A delete declared global.
    const gone = await push(remoteOp('o3', 1, 'delete', doc));
    // A new record declared global whose data puts it in Doc.
    const planted = await push(remoteOp('o4', 1, 'write', 'planted', { data: { $type: 'Doc', n: 1 } }));
    for (const answer of [set, move, gone, planted]) {
      assert.strictEqual(answer.outOfScope, 1);
      assert.strictEqual(answer.applied, 0);
    }
    assert.deepStrictEqual(await host.get(doc), { $type: 'Doc', title: 'secret' });
    assert.strictEqual(await host.get('planted'), null);
    // The peers' streams alone: the host's own key id begins with `o` one
    // time in sixty-four.
    assert.deepStrictEqual(
      Object.keys(host.vector).filter((key) => /^o[1-4](@|$)/.test(key)),
      [],
      'neither logged nor relayed: no stream moved',
    );
    assert.deepStrictEqual(
      refused.map((event) => event.reason),
      ['scope', 'scope', 'scope', 'scope'],
    );
    // In its own scope the same peer writes as before.
    const own = await push(remoteOp('o5', 1, 'write', 'mine', { data: { $type: 'Other' }, scope: 'Other' }));
    assert.strictEqual(own.applied, 1);
    assert.deepStrictEqual(await host.get('mine'), { $type: 'Other' });
  });

  await t.test('an op held for a newer schema version is bound too', async (t2) => {
    const host = await openTemp(t2, { sync: { scope }, schema: { version: 1, ahead: 'hold', entities: {} } });
    const doc = await host.insert({ $type: 'Doc', title: 'secret' });
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'tenant-o', version: 1, scopes: ['Other'] });
    const op = remoteOp('o1', 1, 'set', doc, { data: { title: 'later' }, v: 9 });
    const answer = await link.call('syncom/push', { ops: packOps([op]) });
    assert.strictEqual(answer.outOfScope, 1);
    assert.strictEqual(host.log.held().length, 0, 'not kept for later either');
  });

  await t.test('a peer granted everything, and the dialing side, are bound by nothing', async (t2) => {
    const host = await openTemp(t2, { sync: { scope } });
    const doc = await host.insert({ $type: 'Doc', title: 'v1' });
    const unit = host.sync.unit({ access: 'public' });
    const admin = new MemoryLink(unit);
    await admin.call('syncom/hello', { node: 'admin', version: 1 });
    const ops = packOps([remoteOp('a1', 1, 'set', doc, { data: { title: 'v2' }, scope: 'Doc' })]);
    assert.strictEqual((await admin.call('syncom/push', { ops })).applied, 1);
    // applyRemote without `bound` (a feed the dialer reads) checks nothing.
    const plain = await host.applyRemote([remoteOp('a2', 1, 'set', doc, { data: { title: 'v3' } })]);
    assert.strictEqual(plain.outOfScope, 0);
    assert.strictEqual((await host.get(doc)).title, 'v3');
  });

  await t.test('a scope function that throws on a peer record refuses the op', async (t2) => {
    const picky = (id, data) => {
      if (data.boom) throw new Error('no scope for this');
      return data.$type ?? '*';
    };
    const host = await openTemp(t2, { sync: { scope: picky } });
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'tenant-o', version: 1, scopes: ['Other'] });
    const op = remoteOp('o1', 1, 'write', 'r1', { data: { boom: true } });
    const answer = await link.call('syncom/push', { ops: packOps([op]) });
    assert.strictEqual(answer.outOfScope, 1);
  });
});
