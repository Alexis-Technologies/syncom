'use strict';

// A node's own ops are the one thing nobody else can hand a host: a dialer
// keeps them until the nodes it syncs with have them, says so when a host
// lacks ones its log no longer holds, and notices when its own directory was
// rewound under it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const syncom = require('..');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { MemoryLink } = require('./utils/memory-link.js');
const { waitUntil } = require('./utils/mesh.js');

const tempDir = async (t) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  return dir;
};

const openAt = async (t, dir, options = {}) => {
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

// A dialer of `host` that keeps few ops and rolls often, so compaction runs.
const dialerOptions = (host, sync = {}) => ({
  sync: {
    autoStart: false,
    connect: () => new MemoryLink(host.sync.unit({ access: 'public' })),
    retention: { ops: 20 },
    log: { rollAfter: 4 },
    ...sync,
  },
});

test('A dialer keeps its own ops until the nodes it syncs with have them', async (t) => {
  await t.test('written offline past retention, delivered whole once the host is reached', async (t2) => {
    const host = await openAt(t2, await tempDir(t2));
    const dialer = await openAt(t2, await tempDir(t2), dialerOptions(host));
    await dialer.sync.addNode({ url: 'mem://host' });
    for (let i = 0; i < 100; i++) await dialer.insert({ i });
    await dialer.log.flush();
    assert.strictEqual(dialer.log.floor, 1, 'nothing compacted: the host has none of them yet');
    assert.ok(dialer.log.length >= 100);
    await dialer.sync.start();
    await waitUntil(async () => (await host.list()).length === 100);
    assert.strictEqual(dialer.sync.listNodes()[0].acked[dialer.nodeId], 100);
    // Delivered: the next roll compacts as retention says.
    await dialer.insert({ i: 100 });
    await dialer.log.flush();
    assert.ok(dialer.log.floor > 1, 'compacted once acknowledged');
  });

  await t.test('what a node acknowledged survives a restart; a disabled node is not waited for', async (t2) => {
    const host = await openAt(t2, await tempDir(t2));
    const dir = await tempDir(t2);
    const first = await openAt(t2, dir, dialerOptions(host));
    await first.sync.addNode({ url: 'mem://host' });
    await first.sync.start();
    await waitUntil(() => first.sync.peers()[0]?.subscribed);
    await first.insert({ n: 1 });
    await first.sync.sync();
    await first.close();
    const reopened = await openAt(t2, dir, dialerOptions(host));
    assert.deepStrictEqual(reopened.sync.listNodes()[0].acked, { [reopened.nodeId]: 1 });
    // A second node that never connects would hold every op back; disabled, it holds none.
    await reopened.sync.addNode({ url: 'mem://elsewhere' });
    await reopened.sync.enableNode('mem://elsewhere', false);
    for (let i = 0; i < 60; i++) await reopened.insert({ i });
    await reopened.sync.start();
    await waitUntil(async () => (await host.list()).length === 61);
    await reopened.log.flush();
    assert.ok(reopened.log.floor > 1);
  });

  await t.test('ops compacted before any node was registered are reported UNDELIVERABLE', async (t2) => {
    const host = await openAt(t2, await tempDir(t2));
    const dialer = await openAt(t2, await tempDir(t2), dialerOptions(host));
    for (let i = 0; i < 100; i++) await dialer.insert({ i });
    await dialer.log.flush();
    assert.ok(dialer.log.floor > 1, 'compacted: no node was waiting for them');
    const errors = [];
    dialer.sync.on('error', (error) => errors.push(error));
    await dialer.sync.addNode({ url: 'mem://host' });
    await dialer.sync.start();
    await waitUntil(() => errors.length > 0);
    const [error] = errors;
    assert.strictEqual(error.code, 'UNDELIVERABLE');
    assert.ok(error instanceof syncom.SyncomError);
    const { host: held, retained } = error.missing[dialer.nodeId];
    assert.strictEqual(held, 0);
    assert.ok(retained > 1);
    assert.strictEqual(dialer.sync.peers()[0].lastError.code, 'UNDELIVERABLE');
    // Said once per hello, not once per push.
    await dialer.insert({ late: true });
    await dialer.sync.sync();
    assert.strictEqual(errors.length, 1);
  });
});

test('A node restored from an older copy of its directory', async (t) => {
  await t.test('is told REWOUND, mints past what the host holds and joins the lost state back', async (t2) => {
    const host = await openAt(t2, await tempDir(t2));
    const dir = await tempDir(t2);
    const backup = await tempDir(t2);
    const options = dialerOptions(host, { retention: undefined, log: undefined });
    let node = await openAt(t2, dir, options);
    await node.sync.addNode({ url: 'mem://host' });
    await node.sync.start();
    await waitUntil(() => node.sync.peers()[0]?.subscribed);
    const kept = await node.insert({ n: 'before the backup' });
    await node.sync.sync();
    await node.close();
    await fs.cp(dir, backup, { recursive: true });
    node = await openAt(t2, dir, options);
    await node.sync.start();
    await waitUntil(() => node.sync.peers()[0]?.subscribed);
    const lost = await node.insert({ n: 'after the backup' });
    await node.sync.sync();
    const own = node.nodeId;
    assert.strictEqual(host.vector[own], 2);
    await node.close();
    // The directory goes back to the copy.
    await fs.rm(dir, { recursive: true, force: true });
    await fs.cp(backup, dir, { recursive: true });
    node = await openAt(t2, dir, options);
    assert.strictEqual(node.vector[own], 1, 'the restored log ends before the lost op');
    assert.strictEqual(await node.get(lost), null);
    const errors = [];
    node.sync.on('error', (error) => errors.push(error));
    const bootstraps = [];
    node.sync.on('bootstrap', (event) => bootstraps.push(event));
    await node.sync.start();
    await waitUntil(() => bootstraps.length === 1);
    const rewound = errors.find((error) => error.code === 'REWOUND');
    assert.ok(rewound, 'reported');
    assert.deepStrictEqual(rewound.local, { [own]: 1 });
    assert.deepStrictEqual(rewound.remote, { [own]: 2 });
    assert.ok(node.vector[own] >= 2, 'its stream moved past the host');
    assert.deepStrictEqual(await node.get(lost), { n: 'after the backup' }, 'the lost write came back');
    assert.deepStrictEqual(await node.get(kept), { n: 'before the backup' });
    // What it writes now reaches the host instead of being taken as a duplicate.
    const fresh = await node.insert({ n: 'after the restore' });
    await node.sync.sync();
    await waitUntil(async () => (await host.get(fresh)) !== null);
    assert.deepStrictEqual(await host.get(fresh), { n: 'after the restore' });
  });
});
