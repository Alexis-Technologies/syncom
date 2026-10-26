'use strict';

// A node's own ops are the one thing nobody else can hand a host: a dialer
// keeps them until the nodes it syncs with have them, says so when a host
// lacks ones its log no longer holds, and notices when its own directory was
// rewound under it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const syncom = require('../src/all/all.js');
const core = require('../index.js');
const { memory } = require('../src/memory/memory.js');
const { sync } = require('../src/sync/sync.js');
const { packOps } = require('../src/ops.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { MemoryLink } = require('./utils/memory-link.js');
const { waitUntil } = require('./utils/mesh.js');
const { createSigner } = require('./utils/signed.js');
const { SIGNER } = require('../src/symbols.js');

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
    await dialer.flush();
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
    await reopened.flush();
    await reopened.log.flush();
    assert.ok(reopened.log.floor > 1);
  });

  await t.test('ops compacted before any node was registered are reported UNDELIVERABLE', async (t2) => {
    const host = await openAt(t2, await tempDir(t2));
    const dialer = await openAt(t2, await tempDir(t2), dialerOptions(host));
    for (let i = 0; i < 100; i++) await dialer.insert({ i });
    // The deferred window lands first (the records written, the ops applied), then the roll seals them.
    await dialer.flush();
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
    // The host handed the op it holds at seq 2, signed by this node's key: proof.
    assert.deepStrictEqual(rewound.adopted, { [own]: 2 });
    assert.ok(node.vector[own] >= 2, 'its stream moved past the host');
    assert.deepStrictEqual(await node.get(lost), { n: 'after the backup' }, 'the lost write came back');
    assert.deepStrictEqual(await node.get(kept), { n: 'before the backup' });
    // What it writes now reaches the host instead of being taken as a duplicate.
    const fresh = await node.insert({ n: 'after the restore' });
    await node.sync.sync();
    await waitUntil(async () => (await host.get(fresh)) !== null);
    assert.deepStrictEqual(await host.get(fresh), { n: 'after the restore' });
  });

  // The same story without signatures: nothing proves the host's claim, so
  // the node says REWOUND and leaves its stream where its log has it — unless
  // the application opens it with `sync.rewind: 'adopt'`.
  await t.test('without signing, REWOUND is reported and nothing moves; rewind: adopt moves it', async (t2) => {
    const open = async (dir, options = {}) => {
      const storage = await core.open({ path: dir, logger: false, defer: 0, plugins: [sync], ...options });
      t2.after(() => storage.close().catch(() => {}));
      return storage;
    };
    const host = await open(await tempDir(t2));
    const dir = await tempDir(t2);
    const backup = await tempDir(t2);
    const options = (rewind) => ({
      sync: { autoStart: false, rewind, connect: () => new MemoryLink(host.sync.unit({ access: 'public' })) },
    });
    let node = await open(dir, options());
    await node.sync.addNode({ url: 'mem://host' });
    await node.sync.start();
    await waitUntil(() => node.sync.peers()[0]?.subscribed);
    await node.insert({ n: 'before the backup' });
    await node.sync.sync();
    await node.close();
    await fs.cp(dir, backup, { recursive: true });
    node = await open(dir, options());
    await node.sync.start();
    await waitUntil(() => node.sync.peers()[0]?.subscribed);
    const lost = await node.insert({ n: 'after the backup' });
    await node.sync.sync();
    const own = node.nodeId;
    assert.strictEqual(host.vector[own], 2);
    await node.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.cp(backup, dir, { recursive: true });
    node = await open(dir, options());
    assert.strictEqual(node.vector[own], 1);
    const errors = [];
    node.sync.on('error', (error) => errors.push(error));
    const bootstraps = [];
    node.sync.on('bootstrap', (event) => bootstraps.push(event));
    await node.sync.start();
    await waitUntil(() => errors.some((error) => error.code === 'REWOUND') && node.sync.peers()[0]?.subscribed);
    const rewound = errors.find((error) => error.code === 'REWOUND');
    assert.deepStrictEqual([rewound.local, rewound.remote, rewound.adopted], [{ [own]: 1 }, { [own]: 2 }, {}]);
    assert.strictEqual(node.vector[own], 1, 'an unproven claim moves nothing');
    assert.strictEqual(bootstraps.length, 0);
    assert.strictEqual(await node.get(lost), null);
    await node.close();
    // Told to take the host's word: the stream moves, the lost state comes back.
    node = await open(dir, options('adopt'));
    const adopted = [];
    node.sync.on('error', (error) => adopted.push(error));
    node.sync.on('bootstrap', (event) => bootstraps.push(event));
    await node.sync.start();
    await waitUntil(() => bootstraps.length === 1);
    assert.deepStrictEqual(adopted.find((error) => error.code === 'REWOUND').adopted, { [own]: 2 });
    assert.ok(node.vector[own] >= 2);
    assert.deepStrictEqual(await node.get(lost), { n: 'after the backup' });
  });

  await t.test('sync.rewind is checked at open()', async () => {
    const fsi = memory();
    await assert.rejects(async () => core.open({ path: 'x', fsi, logger: false, sync: { rewind: 'yes' } }), {
      name: 'TypeError',
      message: "open({ sync }): rewind must be 'report' or 'adopt'",
    });
  });
});

// A host that lies at hello: `answer(args, honest)` rewrites what the real
// unit answered.
const lyingHost = (host, answer) => {
  const unit = host.sync.unit({ access: 'public' });
  const hello = unit.hello.handler;
  return {
    ...unit,
    hello: { ...unit.hello, handler: async (context, args) => answer(args, await hello(context, args)) },
  };
};

test('A host cannot move the streams of the nodes that dial it', async (t) => {
  await t.test("a feed host's advance and a joined vector leave this node's own streams alone", async (t2) => {
    const node = await openAt(t2, await tempDir(t2), { defer: 0 });
    const own = node.nodeId;
    await node.insert({ n: 1 });
    const advance = (origin, seq, vector) => ({ origin, seq, ts: Date.now(), type: 'advance', vector });
    const claimed = { [own]: 2 ** 53 - 2, [`${own}@x`]: 9, [`${own}@~`]: 4, other: 3, big: 2 ** 53, zero: 0 };
    const result = await node.applyRemote([advance('host', 1, claimed)], { adoptFrom: 'host' });
    assert.strictEqual(result.applied, 1);
    assert.deepStrictEqual(node.vector, { [own]: 1, 'host@~': 1, other: 3 });
    // A snapshot's vector, adopted after a join: the same rule.
    await node.adoptVector({ [own]: 1000, [`${own}@y`]: 5, third: 1e300, fourth: 2.5, fifth: 2 });
    assert.deepStrictEqual(node.vector, { [own]: 1, 'host@~': 1, other: 3, fifth: 2, [`${own}@~`]: 1 });
    // Its stream runs on from where its log has it.
    const ops = [];
    node.on('change', (op) => ops.push(op));
    await node.insert({ n: 2 });
    await node.insert({ n: 3 });
    assert.deepStrictEqual(
      ops.map((op) => op.seq),
      [2, 3],
    );
  });

  await t.test('a hello that claims more of them without proof is REWOUND, never adopted', async (t2) => {
    const host = await openAt(t2, await tempDir(t2));
    const peer = await createSigner();
    let lie = null;
    const unit = lyingHost(host, (args, honest) => (lie === null ? honest : lie(args, honest)));
    const node = await openAt(t2, await tempDir(t2), {
      defer: 0,
      sync: { autoStart: false, connect: () => new MemoryLink(unit) },
    });
    const own = node.nodeId;
    await node.sync.addNode({ url: 'mem://host' });
    await node.sync.start();
    await waitUntil(() => node.sync.peers()[0]?.subscribed);
    await node.insert({ n: 1 });
    await node.sync.sync();
    const first = host.log.since(undefined).find((entry) => entry.op.origin === own).op;
    const errors = [];
    node.sync.on('error', (error) => errors.push(error));
    const bootstraps = [];
    node.sync.on('bootstrap', (event) => bootstraps.push(event));
    const greet = async () => {
      errors.length = 0;
      await node.sync.stop();
      await node.sync.start();
      await waitUntil(() => errors.some((error) => error.code === 'REWOUND') && node.sync.peers()[0]?.subscribed);
      return errors.find((error) => error.code === 'REWOUND');
    };
    // A bare claim; this node's own op, but of another seq; one under another
    // key; one whose check throws — nothing is proven by any of them.
    const identity = node[SIGNER];
    const verify = identity.verify;
    const throwing = () => {
      throw new Error('cannot check');
    };
    const proofs = [
      [() => undefined, verify],
      [() => packOps([first]), verify],
      [async () => packOps([await peer.sign({ ...first, seq: 1000 })]).map((row) => [own, ...row.slice(1)]), verify],
      [() => packOps([{ ...first, seq: 1000 }]), throwing],
    ];
    for (const [proof, check] of proofs) {
      const shown = await proof();
      identity.verify = check;
      lie = (args, honest) => ({ ...honest, vector: { ...honest.vector, [own]: 1000 }, proof: shown });
      const error = await greet();
      assert.deepStrictEqual([error.remote, error.adopted], [{ [own]: 1000 }, {}]);
      assert.strictEqual(node.vector[own], 1, 'the stream stays where the log has it');
    }
    identity.verify = verify;
    assert.strictEqual(bootstraps.length, 0);
    // Its writes go on from seq 2 — and not to the host that claims to hold them.
    const ops = [];
    node.on('change', (op) => ops.push(op));
    const after = await node.insert({ n: 2 });
    assert.strictEqual(ops[0].seq, 2);
    await node.sync.sync();
    assert.strictEqual(await host.get(after), null);
    // An honest hello again: the stream syncs as before.
    lie = null;
    await node.sync.stop();
    await node.sync.start();
    await waitUntil(async () => (await host.get(after)) !== null);
  });
});
