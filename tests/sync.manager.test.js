'use strict';

// The dialing side's edges: registry toggles, manual sync, refusals from the
// link factory, a host that already dials us, a link that cannot stream, and
// failures on the way out.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { MemoryLink } = require('./utils/memory-link.js');
const { waitUntil, settle } = require('./utils/mesh.js');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

test('SyncManager edges', async (t) => {
  await t.test('enableNode disconnects and reconnects; sync(url) pushes on demand', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const links = [];
    const dialer = await openTemp(t2, {
      sync: {
        autoStart: false,
        connect: () => {
          const link = new MemoryLink(unit);
          links.push(link);
          return link;
        },
      },
    });
    assert.strictEqual(dialer.sync.storage, dialer);
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);

    await dialer.sync.enableNode('mem://host', false);
    assert.strictEqual(dialer.sync.peers().length, 0);
    assert.strictEqual(dialer.sync.listNodes()[0].enabled, false);
    const id = await dialer.insert({ offline: true });
    assert.strictEqual(await host.get(id), null);

    await dialer.sync.enableNode('mem://host');
    await settle([host, dialer]);
    assert.deepStrictEqual(await host.get(id), { offline: true });
    assert.strictEqual(links.length, 2, 'a fresh link per connect');
    await assert.rejects(() => dialer.sync.enableNode('mem://nope'), /not found/);

    const results = await dialer.sync.sync('mem://host');
    assert.deepStrictEqual(results, [{ url: 'mem://host', pushed: 0 }]);
    assert.deepStrictEqual(await dialer.sync.sync('mem://unknown'), []);
    assert.strictEqual((await dialer.sync.sync()).length, 1);
    // start() twice is a no-op; removing a connected node drops its link.
    await dialer.sync.start();
    await dialer.sync.removeNode('mem://host');
    assert.strictEqual(dialer.sync.peers().length, 0);
  });

  await t.test('a connect() that does not yield a link is reported, not thrown', async (t2) => {
    const errors = [];
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => ({ call() {} }) } });
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://bad' });
    await dialer.sync.start();
    await waitUntil(() => errors.length > 0);
    assert.match(errors[0].message, /must return a SyncLink/);
    assert.strictEqual(errors[0].url, 'mem://bad');
    // Without an error listener the failure goes to the logger only.
    const quiet = await openTemp(t2, {
      sync: {
        autoStart: false,
        connect: () => {
          throw new Error('boom');
        },
      },
    });
    await quiet.sync.addNode({ url: 'mem://bad' });
    await quiet.sync.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(quiet.sync.peers()[0].connected, false);
  });

  await t.test('a host that already dials us answers duplicate and we hang up', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    class Duplicate extends MemoryLink {
      async call(method, args) {
        if (method === 'syncom/hello') return { node: 'other', duplicate: true };
        return super.call(method, args);
      }

      close() {
        super.close();
        throw new Error('already closed');
      }
    }
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => new Duplicate(unit) } });
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers().length === 0);
    // The throwing close() was swallowed; a bad hello is an error event.
    const errors = [];
    class Bad extends MemoryLink {
      async call() {
        return { nope: true };
      }
    }
    const other = await openTemp(t2, { sync: { autoStart: false, connect: () => new Bad(unit) } });
    other.sync.on('error', (error) => errors.push(error));
    await other.sync.addNode({ url: 'mem://host' });
    await other.sync.start();
    await waitUntil(() => errors.length > 0);
    assert.match(errors[0].message, /Bad hello/);
  });

  await t.test('a streamed snapshot needs a link that can read streams', async (t2) => {
    const host = await openTemp(t2, { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } });
    for (let i = 0; i < 8; i++) await host.insert({ i });
    const unit = host.sync.unit({ access: 'public' });
    // A link whose "client" claims binary support but that cannot stream.
    class Binary extends MemoryLink {
      constructor(u) {
        super(u);
        this.client.binary = true;
        this.client.createStream = (name, size) => ({ id: 's1', size, write() {}, end() {} });
      }
    }
    const errors = [];
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => new Binary(unit) } });
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => errors.length > 0);
    assert.match(errors[0].message, /cannot read streams/);
  });

  await t.test('a push that fails mid-flight is reported and recomputed from the vector', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    let failing = false;
    class Flaky extends MemoryLink {
      async call(method, args) {
        if (failing && method === 'syncom/push') throw Object.assign(new Error('flaky'), { code: 503 });
        return super.call(method, args);
      }
    }
    const link = new Flaky(unit);
    const errors = [];
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => link } });
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);

    failing = true;
    const id = await dialer.insert({ n: 1 });
    await waitUntil(() => errors.length > 0);
    assert.match(errors[0].message, /flaky/);
    assert.strictEqual(await host.get(id), null);
    failing = false;
    // The next handshake (a reconnect) pushes what the host still lacks.
    link.disconnect();
    await link.reconnect();
    await settle([host, dialer]);
    assert.deepStrictEqual(await host.get(id), { n: 1 });
  });

  await t.test('a scoped late joiner adopts only the vector keys of its scopes', async (t2) => {
    const scope = (id, data) => data.$type ?? '*';
    const host = await openTemp(t2, { sync: { scope, log: { rollAfter: 2 }, retention: { ops: 4 } } });
    const doc = await host.insert({ $type: 'Doc', n: 1 });
    for (let i = 0; i < 8; i++) await host.insert({ $type: 'Other', i });
    const unit = host.sync.unit({ access: 'public' });
    const dialer = await openTemp(t2, { sync: { scope, autoStart: false, connect: () => new MemoryLink(unit) } });
    await dialer.sync.addNode({ url: 'mem://host', scopes: ['Doc'] });
    const bootstraps = [];
    dialer.sync.on('bootstrap', (event) => bootstraps.push(event));
    await dialer.sync.start();
    await waitUntil(() => bootstraps.length > 0);
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    assert.deepStrictEqual(await dialer.get(doc), { $type: 'Doc', n: 1 });
    assert.strictEqual((await dialer.list()).length, 1, 'Other records were not in the snapshot');
    const keys = Object.keys(dialer.vector);
    assert.ok(keys.includes(`${host.nodeId}@Doc`));
    assert.ok(!keys.includes(`${host.nodeId}@Other`), 'a scope we did not ask for is not claimed');
  });

  await t.test('a subscription error that is not "hello first" is reported', async (t2) => {
    const host = await openTemp(t2);
    const unit = host.sync.unit({ access: 'public' });
    const link = new MemoryLink(unit);
    const errors = [];
    const dialer = await openTemp(t2, { sync: { autoStart: false, connect: () => link } });
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
    // Break the feed from the host side: the generator throws on its next pull.
    const original = unit.changes.handler;
    unit.changes.handler = async function* () {
      throw new Error('feed broke');
    };
    link.disconnect();
    await link.reconnect({ freshClient: false });
    await waitUntil(() => errors.some((error) => /feed broke/.test(error.message)));
    unit.changes.handler = original;
  });
});

test('SyncManager: events are contained', async (t) => {
  await t.test('listeners that throw do not break the handshake or the feed', async (t2) => {
    const entries = [];
    const logger = { warn: (entry) => entries.push(entry), info() {}, debug() {}, error() {} };
    const host = await openTemp(t2, { logger });
    const unit = host.sync.unit({ access: 'public' });
    const dialer = await openTemp(t2, { logger, sync: { autoStart: false, connect: () => new MemoryLink(unit) } });
    for (const event of ['peer', 'sync', 'bootstrap', 'error']) {
      dialer.sync.on(event, () => {
        throw new Error(`${event} boom`);
      });
    }
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    const id = await dialer.insert({ through: true });
    await settle([host, dialer]);
    assert.deepStrictEqual(await host.get(id), { through: true });
    await new Promise((resolve) => setImmediate(resolve));
    const names = new Set(entries.filter((e) => e.event === 'listener.error').map((e) => e.name));
    assert.ok(names.has('peer') && names.has('sync'), `logged: ${[...names].join(', ')}`);
  });
});
