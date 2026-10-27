'use strict';

// What a dialer does after a push fails: it falls behind, and is caught up
// from the vector at the next sign of life on the link — never by a timer,
// never by a page silently dropped. Plus the things that keep a push honest:
// one at a time per peer, a bounded outbox, a vector learned from the feed.

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

// A link whose `syncom/push` calls the test can fail, hang or slow down.
const flaky = (unit, control) => {
  const link = new MemoryLink(unit, { latency: control.latency });
  const call = link.call.bind(link);
  link.call = async (method, args) => {
    if (method === 'syncom/push') {
      control.inflight = (control.inflight ?? 0) + 1;
      control.maxInflight = Math.max(control.maxInflight ?? 0, control.inflight);
      try {
        if (control.hang) return await new Promise(() => {});
        if (control.failNext) {
          control.failNext = false;
          throw Object.assign(new Error('flaky link'), { code: 503 });
        }
        return await call(method, args);
      } finally {
        control.inflight--;
      }
    }
    return call(method, args);
  };
  return link;
};

test('A failed push leaves the peer behind, and the next sign of life catches it up', async (t) => {
  await t.test('a page from the host triggers the recovery', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const control = {};
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => flaky(unit, control) } });
    const errors = [];
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    control.failNext = true;
    const lost = await dialer.insert({ n: 1 });
    await waitUntil(() => errors.length > 0);
    assert.strictEqual(errors[0].code, 503);
    assert.strictEqual(dialer.sync.peers()[0].behind, true);
    assert.strictEqual(await host.get(lost), null);
    // The host writes: its feed delivers a page, the dialer sees the link is alive and recovers.
    const fromHost = await host.insert({ from: 'host' });
    await waitUntil(async () => (await host.get(lost)) !== null);
    assert.deepStrictEqual(await host.get(lost), { n: 1 }, 'pushed from the vector, not from the dropped outbox');
    assert.deepStrictEqual(await dialer.get(fromHost), { from: 'host' });
    await waitUntil(() => !dialer.sync.peers()[0].behind);
    assert.strictEqual(errors.length, 1, 'no second error: the recovery went through');
  });

  await t.test('an op to relay triggers the recovery, and carries what was dropped with it', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const control = {};
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => flaky(unit, control) } });
    const errors = [];
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    control.failNext = true;
    const first = await dialer.insert({ n: 1 });
    await waitUntil(() => dialer.sync.peers()[0].behind);
    const second = await dialer.insert({ n: 2 });
    await waitUntil(async () => (await host.get(second)) !== null);
    assert.deepStrictEqual(await host.get(first), { n: 1 }, 'the dropped op travelled with the recovery');
    assert.strictEqual(dialer.sync.peers()[0].behind, false);
    assert.strictEqual(errors.length, 1);
    // A manual sync() is a recovery too, and clears the flag.
    control.failNext = true;
    const third = await dialer.insert({ n: 3 });
    await waitUntil(() => dialer.sync.peers()[0].behind);
    const [{ pushed }] = await dialer.sync.sync('mem://host');
    assert.strictEqual(pushed, 1);
    assert.deepStrictEqual(await host.get(third), { n: 3 });
    assert.strictEqual(dialer.sync.peers()[0].behind, false);
  });

  await t.test('pushes to one peer never overlap: handshake, relay and sync() take turns', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const control = { latency: 15 };
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => flaky(unit, control) } });
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    const ids = [];
    const writes = [];
    for (let i = 0; i < 4; i++) writes.push(dialer.insert({ i }).then((id) => ids.push(id)));
    const manual = dialer.sync.sync();
    await Promise.all([...writes, manual]);
    await waitUntil(async () => (await host.list()).length === 4);
    assert.strictEqual(control.maxInflight, 1, 'one push in flight at a time');
    assert.deepStrictEqual((await host.list()).sort(), ids.sort());
  });

  await t.test('the outbox is bounded: beyond maxOutbox the backlog is dropped and the peer is behind', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const control = {};
    const warnings = [];
    const logger = { warn: (entry) => warnings.push(entry), debug() {}, info() {}, error() {} };
    const dialer = await openTemp(t2, {
      logger,
      sync: { autoStart: false, maxOutbox: 3, connect: () => flaky(unit, control) },
    });
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    control.hang = true; // the push in flight never answers; what follows queues
    for (let i = 0; i < 6; i++) await dialer.insert({ i });
    const [peer] = dialer.sync.peers();
    assert.strictEqual(peer.behind, true);
    assert.ok(peer.pending <= 4, `pending ${peer.pending}`);
    const dropped = warnings.find((entry) => entry.event === 'sync.outbox.dropped');
    assert.ok(dropped, 'reported');
    assert.strictEqual(dropped.url, 'mem://host');
    await assert.rejects(() => openTemp(t2, { sync: { maxOutbox: 'lots' } }), TypeError);
    await assert.rejects(() => openTemp(t2, { sync: { maxOutbox: 0 } }), TypeError);
  });
});

test('What a push and a page say about the vector', async (t) => {
  await t.test("a received page teaches the dialer the host's vector: nothing is relayed back", async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => new MemoryLink(unit) } });
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    // A third party's op lands on the host after the hello: the dialer learns
    // of it from the feed, and must not offer it back at the next push.
    await host.applyRemote([remoteOp('third', 1, 'write', 'x', { data: { n: 1 } })]);
    await waitUntil(async () => (await dialer.get('x')) !== null);
    const [{ pushed }] = await dialer.sync.sync('mem://host');
    assert.strictEqual(pushed, 0, 'the feed said the host has it');
  });

  await t.test('a push answers with the keys it touched; a second snapshot page carries no vector', async (t2) => {
    const host = await openTemp(t2);
    for (let i = 0; i < 3; i++) await host.insert({ i });
    const unit = host.sync.unit({ access: 'public', pageSize: 2 });
    const link = new MemoryLink(unit);
    await link.call('syncom/hello', { node: 'peer', version: 1 });
    const answer = await link.call('syncom/push', {
      ops: packOps([remoteOp('a', 1, 'write', 'a1', { data: {} }), remoteOp('b', 1, 'write', 'b1', { data: {} })]),
    });
    assert.deepStrictEqual(answer.vector, { a: 1, b: 1 }, "the host's own key is not repeated");
    const first = await link.call('syncom/snapshot', {});
    assert.deepStrictEqual(first.vector, host.vector);
    assert.ok(first.cursor);
    const second = await link.call('syncom/snapshot', { cursor: first.cursor });
    assert.strictEqual(second.vector, undefined);
    const third = await link.call('syncom/snapshot', { cursor: second.cursor });
    assert.strictEqual(third.vector, undefined);
    assert.strictEqual(third.cursor, null);
    assert.deepStrictEqual(
      [first, second, third].map((page) => page.records.length),
      [2, 2, 1],
    );
  });

  await t.test('a host that keeps answering 428 is reported as a loop, not greeted forever', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const connect = () => {
      const link = new MemoryLink(unit);
      const call = link.call.bind(link);
      // The host forgets us right after every hello.
      link.call = async (method, args) => {
        const result = await call(method, args);
        if (method === 'syncom/hello') delete link.client.data.syncom;
        return result;
      };
      return link;
    };
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect } });
    const errors = [];
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => errors.some((error) => error.code === 'HANDSHAKE_LOOP'));
    const [peer] = dialer.sync.peers();
    assert.strictEqual(peer.subscribed, false);
    assert.strictEqual(peer.connected, true, 'the link is up; the host is the problem');
  });

  await t.test('a page of nothing but echoes moves the cursor and announces nothing', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => new MemoryLink(unit) } });
    const events = [];
    dialer.sync.on('sync', (event) => events.push(event));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    const id = await dialer.insert({ n: 1 });
    await waitUntil(async () => (await host.get(id)) !== null);
    await waitUntil(() => dialer.sync.peers()[0].cursor === host.log.lastEventId);
    assert.ok(
      events.every((event) => event.received === undefined || event.received > 0),
      JSON.stringify(events),
    );
  });
});

test('close() refuses writes from the moment it is called', async (t) => {
  const storage = await openTemp(t);
  await storage.insert({ n: 1 });
  const closing = storage.close();
  await assert.rejects(() => storage.insert({ n: 2 }), /closed/);
  await closing;
  await assert.rejects(() => storage.insert({ n: 3 }), /closed/);
});
