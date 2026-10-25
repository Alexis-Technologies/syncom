'use strict';

// What an operator can read at runtime: the storage's stats, the peers'
// last errors, the feeds a host serves, the log rolling, and who an op came
// through — without reaching into anything private.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
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

test('storage.stats() reads the node without I/O', async (t) => {
  const storage = await openTemp(t, { cache: { max: 2 }, sync: { log: { rollAfter: 2 } } });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await storage.insert({ i }));
  await storage.delete(ids[2]);
  const pinned = await storage.record(ids[0]);
  const stats = storage.stats();
  assert.strictEqual(stats.closed, false);
  assert.strictEqual(stats.queue, 0);
  assert.deepStrictEqual(stats.cache, { size: 2, max: 2, pinned: 1 });
  assert.strictEqual(stats.catalog.entries, 3, 'rows, the tombstone included');
  assert.strictEqual(typeof stats.catalog.dirty, 'number');
  assert.strictEqual(stats.log.length, 4);
  assert.strictEqual(stats.log.next, 5);
  assert.strictEqual(stats.log.epoch, storage.log.epoch);
  assert.ok(stats.log.segments >= 1, 'rollAfter 2: something was sealed');
  assert.ok(stats.log.latestTs > 0);
  assert.strictEqual(typeof stats.chain.tail, 'string');
  assert.deepStrictEqual(stats.lock, { mode: 'fail' });
  assert.strictEqual(pinned.i, 0);
  const bare = await openTemp(t, { chain: false, lock: false });
  assert.strictEqual(bare.stats().chain, null);
  assert.strictEqual(bare.stats().lock, null);
  await storage.close();
  assert.strictEqual(storage.stats().closed, true);
});

test('the log says when it rolls', async (t) => {
  const storage = await openTemp(t, { sync: { log: { rollAfter: 1 }, retention: { ops: 2 } } });
  const rolls = [];
  storage.on('log', (event) => rolls.push(event));
  for (let i = 0; i < 6; i++) await storage.insert({ i });
  assert.ok(rolls.length >= 4, `${rolls.length} rolls`);
  assert.ok(rolls.every((roll) => roll.kind === 'roll' && roll.sealed === 1 && Number.isInteger(roll.segments)));
  assert.ok(rolls.at(-1).floor > 1, 'the floor moved up as old segments were dropped');
  assert.ok(rolls.some((roll) => roll.dropped >= 1));
});

test('who an op came through, what a host serves, and what last went wrong', async (t) => {
  const host = await openTemp(t);
  const unit = host.sync.unit({ access: 'public' });
  let fail = false;
  const connect = () => {
    const link = new MemoryLink(unit);
    const call = link.call.bind(link);
    link.call = async (method, args) => {
      if (fail && method === 'syncom/push') throw Object.assign(new Error('down'), { code: 503 });
      return call(method, args);
    };
    return link;
  };
  const dialer = await openTemp(t, { sync: { autoStart: false, connect } });
  const hostVias = [];
  const dialerVias = [];
  host.on('change', (op, via) => via !== null && hostVias.push(via));
  dialer.on('change', (op, via) => via !== null && dialerVias.push(via));
  const hooked = [];
  await dialer.sync.addNode({ url: 'mem://host' });
  await dialer.sync.start();
  await waitUntil(() => dialer.sync.peers()[0]?.subscribed);
  // The host serves one live feed: this dialer's.
  const [feed] = host.sync.hosted();
  assert.strictEqual(feed.node, dialer.nodeId);
  assert.deepStrictEqual(feed.scopes, ['*'], "the registry's default: every scope");
  assert.ok(feed.since <= Date.now());
  const up = await dialer.insert({ up: true });
  const down = await host.insert({ down: true });
  await settle([host, dialer]);
  assert.deepStrictEqual(hostVias, [{ url: null, node: dialer.nodeId }], 'the host names the peer, not the client');
  assert.deepStrictEqual(
    dialerVias,
    [{ url: 'mem://host', node: host.nodeId }],
    'the dialer names the host, not the link',
  );
  assert.ok('token' in dialerVias[0] === false && 'link' in dialerVias[0] === false);
  assert.deepStrictEqual(await host.get(up), { up: true });
  assert.deepStrictEqual(await dialer.get(down), { down: true });
  assert.strictEqual(host.sync.hosted()[0].cursor, host.log.lastEventId, 'the feed is at the end of the log');
  assert.strictEqual(dialer.sync.peers()[0].lastError, null);
  // A failed push is remembered on the peer.
  fail = true;
  await dialer.insert({ lost: true });
  await waitUntil(() => dialer.sync.peers()[0].lastError !== null);
  const { lastError } = dialer.sync.peers()[0];
  assert.strictEqual(lastError.code, 503);
  assert.strictEqual(lastError.message, 'down');
  assert.ok(lastError.at <= Date.now());
  fail = false;
  // The feed ends with the dialer; the host serves nobody.
  await dialer.sync.stop();
  await waitUntil(() => host.sync.hosted().length === 0);
  assert.strictEqual(hooked.length, 0);
});
