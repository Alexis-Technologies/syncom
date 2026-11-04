'use strict';

// Hubs over one shared log: what any hub accepts reaches every other through
// the log, a client's cursor is a position in the log so it resumes on any hub,
// a fresh client's snapshot is positioned at a marker, and the failures — a
// broker down, a cursor trimmed past, an entry that will not apply — are told
// and recovered from.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { packOps } = require('../src/ops.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');
const { MemoryLink } = require('./utils/memory-link.js');
const { createMemorySharedLog } = require('./utils/shared-log.js');

const TOPIC = 'syncom';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Hubs over a shared log', async (t) => {
  const engine = syncom.memoryEngine();
  const createStorage = async (t2, name, options = {}) => {
    const storage = await syncom.createDatabase({
      engine,
      path: `${t2.name}/${name}`,
      logger: false,
      defer: 0,
      ...options,
    });
    t2.after(() => storage.close().catch(() => {}));
    return storage;
  };

  await t.test(
    'two hubs over one log: ops cross through it, and a client moved between the hubs resumes from its cursor without a bootstrap',
    async (t2) => {
      const shared = createMemorySharedLog();
      const hub = { sync: { sharedLog: shared } };
      // No hub-to-hub edge: the log is the only way between H1 and H2.
      const mesh = await createMesh(t2, ['H1', 'H2', 'C1', 'C2'], [['C2', 'H2']], createStorage, {
        nodes: { H1: hub, H2: hub },
      });
      const [h1, h2, c1, c2] = ['H1', 'H2', 'C1', 'C2'].map((name) => mesh.get(name));
      // C1 dials the load balancer's url, which answers with H1 now.
      mesh.units.set('LB', mesh.units.get('H1'));
      await c1.sync.addNode({ url: 'mem://LB' });
      await waitUntil(() => [c1, c2].every((s) => s.sync.peers()[0]?.subscribed));
      const first = await c1.insert({ from: 'C1' });
      const second = await c2.insert({ from: 'C2' });
      await settle([h1, h2, c1, c2]);
      assert.deepStrictEqual(await c2.get(first), { from: 'C1' }, 'H1 → the log → H2 → C2');
      assert.deepStrictEqual(await c1.get(second), { from: 'C2' });
      assert.deepStrictEqual(await h2.get(first), { from: 'C1' });
      const stats = h1.sync.shared();
      assert.strictEqual(stats.topic, TOPIC);
      assert.strictEqual(stats.inbox, 'syncom.inbox');
      assert.ok(stats.relayed >= 1 && stats.applied >= 1, JSON.stringify(stats));
      assert.strictEqual(stats.behind, false);
      assert.deepStrictEqual(stats.stuck, { topic: false, inbox: false });
      assert.match(stats.cursor.topic, /^[a-z0-9]+\.\d+$/);
      assert.match(stats.appended, /^[a-z0-9]+\.\d+$/, 'the watermark: this hub’s log position appended through');
      // Every entry is one appender's batch, labelled by its token.
      for (const entry of shared.entries(TOPIC)) assert.match(entry.headers.by, /^[a-z0-9]+$/);

      // The client's cursor is a position in the shared log, and the hubs' epoch the log's.
      const [node] = c1.sync.listNodes();
      assert.match(node.cursor, /^[a-z0-9]+\.\d+$/);
      assert.strictEqual(node.remote.epoch, `shared:${TOPIC}`);
      assert.strictEqual(c2.sync.listNodes()[0].remote.epoch, `shared:${TOPIC}`);

      // The load balancer now answers with H2: the same url, another hub.
      const bootstraps = [];
      c1.sync.on('bootstrap', (event) => bootstraps.push(event));
      const cursor = node.cursor;
      mesh.units.set('LB', mesh.units.get('H2'));
      await c1.sync.enableNode('mem://LB', false);
      await c1.sync.enableNode('mem://LB', true);
      await waitUntil(() => c1.sync.peers()[0]?.subscribed);
      assert.strictEqual(c1.sync.peers()[0].node, h2.nodeId, 'greeted H2');
      const third = await c2.insert({ from: 'C2', n: 3 });
      const fourth = await c1.insert({ from: 'C1', n: 4 });
      await settle([h1, h2, c1, c2]);
      assert.deepStrictEqual(await c1.get(third), { from: 'C2', n: 3 });
      assert.deepStrictEqual(await c2.get(fourth), { from: 'C1', n: 4 });
      assert.deepStrictEqual(await h1.get(fourth), { from: 'C1', n: 4 }, 'H2 → the log → H1');
      assert.deepStrictEqual(bootstraps, [], 'resumed from the cursor, not bootstrapped');
      assert.notStrictEqual(c1.sync.listNodes()[0].cursor, cursor, 'the cursor moved on');
      assert.ok(h2.sync.hosted().some((feed) => feed.node === c1.nodeId));
    },
  );

  await t.test(
    'a fresh client bootstraps from a snapshot positioned at a marker in the log; what lands while it pages replays as duplicates',
    async (t2) => {
      const shared = createMemorySharedLog();
      const mesh = await createMesh(t2, ['H', 'C'], [['C', 'H']], createStorage, {
        nodes: { H: { sync: { sharedLog: shared } } },
      });
      const [h, c] = ['H', 'C'].map((name) => mesh.get(name));
      const bootstraps = [];
      c.sync.on('bootstrap', (event) => bootstraps.push(event));
      await waitUntil(() => c.sync.peers()[0]?.subscribed);
      const a = await h.insert({ n: 1 });
      await settle([h, c]);
      assert.deepStrictEqual(await c.get(a), { n: 1 });
      // A client with no cursor over a shared log bootstraps: the hub's own log is not what positions it.
      assert.strictEqual(bootstraps.length, 1);
      assert.match(c.sync.listNodes()[0].cursor, /^[a-z0-9]+\.\d+$/);
      const entries = shared.entries(TOPIC);
      assert.ok(
        entries.some((entry) => JSON.parse(entry.value).mark === true),
        'the marker the snapshot was positioned at',
      );
      // The marker names the position: the client's cursor starts at or after it.
      const marker = entries.findIndex((entry) => JSON.parse(entry.value).mark === true);
      const [, markerN] = entries[marker].id.split('.');
      assert.ok(Number(c.sync.listNodes()[0].cursor.split('.')[1]) >= Number(markerN));
      const b = await h.insert({ n: 2 });
      const fromClient = await c.insert({ n: 3 });
      await settle([h, c]);
      assert.deepStrictEqual(await c.get(b), { n: 2 });
      assert.deepStrictEqual(await h.get(fromClient), { n: 3 });
      assert.strictEqual(bootstraps.length, 1, 'once');
    },
  );

  await t.test(
    'a hub that joins late reads the log from its oldest entry; a cursor the log trimmed past is told (SHARED_LOG_FAILED gone), what fell between is a gap until a bootstrap from another hub; a hub joins with its history',
    async (t2) => {
      const shared = createMemorySharedLog();
      const h1 = await createStorage(t2, 'H1', { sync: { sharedLog: shared } });
      const a = await h1.insert({ n: 1 });
      const b = await h1.insert({ n: 2 });
      await waitUntil(() => h1.sync.shared().relayed >= 2);
      const h3 = await createStorage(t2, 'H3', { sync: { sharedLog: shared } });
      await waitUntil(() => h3.hasRecord(a) && h3.hasRecord(b));
      assert.deepStrictEqual(await h3.get(b), { n: 2 });
      // H3 goes down; the log moves on and is trimmed past H3's cursor: told once at its reopen, what fell between is
      // not at H3 and what comes after is a gap of the stream, until H3 bootstraps from a hub that holds it all.
      await h3.close();
      const c = await h1.insert({ n: 3 });
      await waitUntil(() => h1.sync.shared().relayed >= 3);
      shared.trim(TOPIC, 0);
      const errors = [];
      const h1unit = h1.sync.unit({ access: 'public' });
      const h3again = await createStorage(t2, 'H3', {
        sync: { sharedLog: shared, connect: () => new MemoryLink(h1unit) },
      });
      h3again.sync.on('error', (error) => errors.push(error));
      await waitUntil(() => errors.some((error) => error.code === 'SHARED_LOG_FAILED'));
      const gone = errors.filter((error) => error.code === 'SHARED_LOG_FAILED');
      assert.strictEqual(gone.length, 1);
      assert.strictEqual(gone[0].reason, 'gone');
      assert.strictEqual(gone[0].topic, TOPIC);
      assert.match(gone[0].cursor, /^[a-z0-9]+\.\d+$/);
      assert.strictEqual(h3again.hasRecord(c), false, 'what fell between the cursor and the trim is not here');
      const d = await h1.insert({ n: 4 });
      await waitUntil(() => h3again.sync.shared().entries >= 1);
      await sleep(30);
      assert.strictEqual(
        h3again.hasRecord(d),
        false,
        'a gap of the stream: nothing of it applies until the hole is filled',
      );
      assert.strictEqual(h3again.sync.shared().cursor.topic !== null, true, 'the entry was passed all the same');
      // A bootstrap from H1 fills the hole: H1 has a shared log, so H3's fresh subscription bootstraps from its snapshot.
      const bootstraps = [];
      h3again.sync.on('bootstrap', (event) => bootstraps.push(event));
      await h3again.sync.addNode({ url: 'mem://H1' });
      await waitUntil(() => h3again.hasRecord(c) && h3again.hasRecord(d));
      assert.strictEqual(bootstraps.length, 1);
      assert.deepStrictEqual(await h3again.get(d), { n: 4 });
      const e = await h1.insert({ n: 5 });
      await waitUntil(() => h3again.hasRecord(e), { timeout: 5000 });
      // A hub with history joins the log: everything its log retains goes to the topic first.
      const alone = await createStorage(t2, 'H4');
      const own = await alone.insert({ n: 40 });
      await alone.close();
      const h4 = await createStorage(t2, 'H4', { sync: { sharedLog: shared } });
      await waitUntil(() => h1.hasRecord(own));
      assert.deepStrictEqual(await h1.get(own), { n: 40 });
      await waitUntil(() => h4.sync.shared().behind === false && h4.sync.shared().appended !== null);
      await h4.close();
      // A reopen continues from the saved cursor and watermark: nothing is applied or appended twice.
      const again = await createStorage(t2, 'H4', { sync: { sharedLog: shared } });
      await sleep(50);
      const stats = again.sync.shared();
      assert.strictEqual(stats.applied, 0, 'nothing new since the cursor');
      assert.strictEqual(stats.relayed, 0, 'nothing appended again');
      assert.match(stats.appended, /^[a-z0-9]+\.\d+$/);
    },
  );

  await t.test(
    'an append that fails is told once (SHARED_LOG_FAILED append), and what the log holds since is appended once the broker answers',
    async (t2) => {
      const shared = createMemorySharedLog();
      const h1 = await createStorage(t2, 'H1', { sync: { sharedLog: shared } });
      const h2 = await createStorage(t2, 'H2', { sync: { sharedLog: shared } });
      const errors = [];
      h1.sync.on('error', (error) => errors.push(error));
      shared.fail(TOPIC, 2);
      const a = await h1.insert({ n: 1 });
      await waitUntil(() => h1.sync.shared().behind === true);
      const b = await h1.insert({ n: 2 });
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].code, 'SHARED_LOG_FAILED');
      assert.strictEqual(errors[0].reason, 'append');
      assert.ok(errors[0].cause);
      // The recovery after a second (doubling): both land, in order, once.
      await waitUntil(() => h2.hasRecord(a) && h2.hasRecord(b), { timeout: 10_000 });
      assert.deepStrictEqual(await h2.get(a), { n: 1 });
      assert.deepStrictEqual(await h2.get(b), { n: 2 });
      await waitUntil(() => h1.sync.shared().behind === false);
      assert.strictEqual(h1.sync.shared().appendFailures, 2);
      assert.strictEqual(errors.length, 1, 'told once per run of failures');
      const c = await h1.insert({ n: 3 });
      await waitUntil(() => h2.hasRecord(c));
    },
  );

  await t.test(
    'an entry that fails to apply three times leaves the topic stuck (SHARED_LOG_FAILED stuck); stop() and start() read it again',
    async (t2) => {
      const shared = createMemorySharedLog();
      let refusing = true;
      const h1 = await createStorage(t2, 'H1', { sync: { sharedLog: shared } });
      const h2 = await createStorage(t2, 'H2', {
        sync: { sharedLog: shared },
        hooks: {
          beforeApply: ({ op }) => {
            if (refusing && op.data?.poison) throw new Error('not here');
          },
        },
      });
      const errors = [];
      h2.sync.on('error', (error) => errors.push(error));
      const poison = await h1.insert({ poison: true });
      await waitUntil(() => h2.sync.shared().stuck.topic === true, { timeout: 15_000 });
      const stuck = errors.filter((error) => error.code === 'SHARED_LOG_FAILED' && error.reason === 'stuck');
      assert.strictEqual(stuck.length, 1);
      assert.match(stuck[0].cursor, /^[a-z0-9]+\.\d+$/);
      assert.strictEqual(stuck[0].cause.name, 'HookError');
      const after = await h1.insert({ n: 2 });
      await sleep(50);
      assert.strictEqual(h2.hasRecord(after), false, 'nothing past the stuck entry');
      refusing = false;
      await h2.sync.stop();
      assert.strictEqual(h2.sync.shared().running, false);
      await h2.sync.start();
      await waitUntil(() => h2.hasRecord(poison) && h2.hasRecord(after));
      assert.deepStrictEqual(h2.sync.shared().stuck, { topic: false, inbox: false });
    },
  );

  await t.test(
    'the feed over the log: a fresh subscription is told to bootstrap, a scoped peer reads its scopes alone and never its own echoes, a position of another log too',
    async (t2) => {
      const shared = createMemorySharedLog();
      const scope = (id, data) => data.$type ?? '*';
      const hub = await createStorage(t2, 'H', { sync: { sharedLog: shared, scope } });
      const unit = hub.sync.unit({ access: 'public' });
      const link = new MemoryLink(unit);
      await link.call('syncom/hello', { node: 'tenant-a', version: 1, scopes: ['A'] });
      const pages = [];
      const fresh = link.subscribe('syncom/changes', { scopes: ['A'] }, { onData: (value) => pages.push(value) });
      await waitUntil(() => pages.length === 1);
      assert.deepStrictEqual(pages, [{ bootstrap: true }], 'no cursor: the snapshot positions a client');
      fresh.unsubscribe();
      // Positioned at a marker, like a snapshot's first page.
      const snapshot = await link.call('syncom/snapshot', { cursor: null, scopes: ['A'] });
      assert.match(snapshot.eventId, /^[a-z0-9]+\.\d+$/);
      assert.deepStrictEqual(snapshot.records, []);
      const received = [];
      link.subscribe(
        'syncom/changes',
        { scopes: ['A'] },
        { lastEventId: snapshot.eventId, onData: (value, eventId) => received.push({ value, eventId }) },
      );
      await hub.insert({ $type: 'A', n: 1 });
      await hub.insert({ $type: 'B', n: 2 });
      await hub.insert({ $type: 'A', n: 3 });
      // The peer's own op comes back from the log but never down its feed.
      const own = {
        origin: 'tenant-a',
        seq: 1,
        ts: Date.now(),
        type: 'write',
        id: 'own-1',
        scope: 'A',
        data: { $type: 'A' },
      };
      await link.call('syncom/push', { ops: packOps([own]) });
      await waitUntil(() => received.length >= 2);
      await sleep(30);
      const ops = received.flatMap((page) => page.value.ops);
      assert.deepStrictEqual(
        ops.map((row) => row[6].n),
        [1, 3],
        'the A ops alone: not B, not the echo',
      );
      for (const page of received) assert.strictEqual(page.eventId, page.value.eventId);
      // A cursor of another log: the feed ends with bootstrap.
      const foreign = [];
      link.subscribe('syncom/changes', { scopes: ['A'] }, { lastEventId: 'other.5', onData: (v) => foreign.push(v) });
      await waitUntil(() => foreign.length === 1);
      assert.deepStrictEqual(foreign, [{ bootstrap: true }]);
      assert.ok(hub.sync.hosted().length >= 1);
    },
  );
});
