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

  // The memory log with the appends to the topic counted, the `nth` one failing: a batch that fails AFTER another
  // landed, which is where a watermark taken from lastEventId lies.
  const failingNth = (shared, nth) => {
    let appends = 0;
    return {
      ...shared,
      async append(topic, value, options) {
        if (topic === TOPIC && ++appends === nth) throw Object.assign(new Error('broker down'), { code: 503 });
        return shared.append(topic, value, options);
      },
    };
  };

  await t.test(
    'the relay’s watermark is the last op the topic holds in log order: a batch that fails leaves what came after it for the recovery, nothing is lost from the bus',
    async (t2) => {
      const shared = createMemorySharedLog();
      const h1 = await createStorage(t2, 'H1', { sync: { sharedLog: failingNth(shared, 2) } });
      const errors = [];
      h1.sync.on('error', (error) => errors.push(error));
      await waitUntil(() => h1.sync.shared().behind === false);
      // Two writes without awaiting the first: the second's position is reserved while the first lands, so the
      // first's announce sees lastEventId at the second's position — the second's append is the one that fails.
      const [a, b] = await Promise.all([h1.insert({ n: 1 }), h1.insert({ n: 2 })]);
      await waitUntil(() => errors.length >= 1, { timeout: 5000 });
      assert.strictEqual(errors[0].reason, 'append');
      // The recovery (after a second): both in the topic, the watermark at the last of them.
      await waitUntil(() => h1.sync.shared().behind === false && h1.sync.shared().relayed >= 2, { timeout: 10_000 });
      const texts = shared.entries(TOPIC).map((entry) => entry.value);
      assert.ok(
        texts.some((text) => text.includes(a)),
        'the first op is in the topic',
      );
      assert.ok(
        texts.some((text) => text.includes(b)),
        'the second op is in the topic',
      );
      const h2 = await createStorage(t2, 'H2', { sync: { sharedLog: shared } });
      await waitUntil(() => h2.hasRecord(a) && h2.hasRecord(b), { timeout: 5000 });
      assert.deepStrictEqual(await h2.get(b), { n: 2 });
      const stats = h1.sync.shared();
      assert.strictEqual(stats.covered, 0, 'nothing covered above the watermark once the run is whole');
      assert.strictEqual(
        stats.appended,
        h1.log.lastEventId,
        'the watermark is the last op, every op below it in the topic',
      );
    },
  );

  await t.test(
    'a hub stopped with ops waiting to be relayed appends them at its next start, from the saved watermark',
    async (t2) => {
      const shared = createMemorySharedLog();
      const h1 = await createStorage(t2, 'H1', { sync: { sharedLog: shared } });
      const h2 = await createStorage(t2, 'H2', { sync: { sharedLog: shared } });
      const x = await h1.insert({ n: 0 });
      await waitUntil(() => h2.hasRecord(x));
      // The broker goes down for one append: the relay falls behind; a second write waits for the recovery — and
      // the hub is stopped before it runs.
      shared.fail(TOPIC, 1);
      const a = await h1.insert({ n: 1 });
      await waitUntil(() => h1.sync.shared().behind === true);
      const b = await h1.insert({ n: 2 });
      await h1.sync.stop();
      assert.strictEqual(h2.hasRecord(a), false);
      assert.strictEqual(h2.hasRecord(b), false);
      await h1.sync.start();
      await waitUntil(() => h2.hasRecord(a) && h2.hasRecord(b), { timeout: 5000 });
      assert.deepStrictEqual(await h2.get(b), { n: 2 });
      // The same across a close: the watermark saved names what the topic holds, the rest goes at the next open.
      shared.fail(TOPIC, 1);
      const c = await h1.insert({ n: 3 });
      await waitUntil(() => h1.sync.shared().behind === true);
      await h1.close();
      const again = await createStorage(t2, 'H1', { sync: { sharedLog: shared } });
      await waitUntil(() => h2.hasRecord(c), { timeout: 5000 });
      await waitUntil(() => again.sync.shared().behind === false);
    },
  );

  await t.test(
    'a stop() does not wait for an append the broker never answers; the next start recovers from the watermark',
    async (t2) => {
      const shared = createMemorySharedLog();
      const h1 = await createStorage(t2, 'H1', { sync: { sharedLog: { log: shared, stopWait: 200 } } });
      const h2 = await createStorage(t2, 'H2', { sync: { sharedLog: shared } });
      shared.hang(TOPIC);
      const a = await h1.insert({ n: 1 });
      await sleep(20);
      const started = Date.now();
      await h1.sync.stop();
      assert.ok(Date.now() - started < 2000, 'stop() let go of the hung append');
      assert.strictEqual(h2.hasRecord(a), false);
      await h1.sync.start();
      await waitUntil(() => h2.hasRecord(a), { timeout: 5000 });
      shared.release();
      const b = await h1.insert({ n: 2 });
      await waitUntil(() => h2.hasRecord(b), { timeout: 5000 });
    },
  );

  await t.test('a hub joins the log with the history it retains after compaction, from the log’s floor', async (t2) => {
    const shared = createMemorySharedLog();
    // A hub alone, its log rolled and compacted: the oldest ops are gone, the floor is above 1.
    const alone = await createStorage(t2, 'H5', { sync: { log: { rollAfter: 1 }, retention: { ops: 4 } } });
    const ids = [];
    for (let i = 1; i <= 12; i++) ids.push(await alone.insert({ n: i }));
    await waitUntil(() => alone.log.floor > 1, { timeout: 5000 });
    await alone.close();
    const errors = [];
    const h5 = await createStorage(t2, 'H5', {
      sync: { sharedLog: shared, log: { rollAfter: 1 }, retention: { ops: 4 } },
    });
    h5.sync.on('error', (error) => errors.push(error));
    await waitUntil(() => h5.sync.shared().behind === false && h5.sync.shared().relayed >= 1, { timeout: 5000 });
    const lost = errors.filter((error) => error.code === 'SHARED_LOG_FAILED' && error.reason === 'lost');
    assert.strictEqual(lost.length, 1, 'told once: what fell below the floor is not in the topic');
    const texts = shared.entries(TOPIC).map((entry) => entry.value);
    assert.ok(
      texts.some((text) => text.includes(ids[11])),
      'what the log retains is in the topic',
    );
    assert.ok(!texts.some((text) => text.includes(ids[0])), 'what fell below the floor is not');
    assert.strictEqual(h5.sync.shared().appended, h5.log.lastEventId, 'the watermark is at the last op');
    // Another hub reads them as a gap of the stream (nothing of it before them) until a bootstrap from H5 fills it.
    const h5unit = h5.sync.unit({ access: 'public' });
    const h2 = await createStorage(t2, 'H2', { sync: { sharedLog: shared, connect: () => new MemoryLink(h5unit) } });
    await waitUntil(() => h2.sync.shared().entries >= 1);
    assert.strictEqual(h2.hasRecord(ids[11]), false, 'a gap of the stream until the hole is filled');
    await h2.sync.addNode({ url: 'mem://H5' });
    await waitUntil(() => h2.hasRecord(ids[11]) && h2.hasRecord(ids[0]), { timeout: 5000 });
    assert.deepStrictEqual(await h2.get(ids[11]), { n: 12 });
  });

  // The memory engine with the log's appends held while the gate is closed: an op reserved in the log, its group
  // not written — not landed, not announced — what a snapshot taken meanwhile must not claim.
  const gatedEngine = (inner) => {
    let gate = Promise.resolve();
    let release = null;
    let failures = 0;
    return {
      close: () => {
        gate = new Promise((resolve) => {
          release = resolve;
        });
      },
      open: () => {
        release?.();
        release = null;
      },
      /** The next `count` appends of the log fail (the medium refusing a group). */
      fail: (count) => {
        failures = count;
      },
      engine: {
        name: inner.name,
        capabilities: inner.capabilities,
        async open(path) {
          const db = await inner.open(path);
          // The log store's contract: a group the medium refuses is told through `onFail`, and `false` answered.
          const append = async (batch, headers, options) => {
            await gate;
            if (failures > 0) {
              failures--;
              options.onFail(new Error('the disk is full'));
              return false;
            }
            return db.log.append(batch, headers, options);
          };
          return { ...db, log: Object.create(db.log, { append: { value: append } }) };
        },
        remove: (path) => inner.remove(path),
      },
    };
  };

  await t.test(
    'a snapshot on a writing hub claims only what its records hold: a write in flight at the marker lands in the topic after it and reaches the client as an op',
    async (t2) => {
      const shared = createMemorySharedLog();
      const gated = gatedEngine(syncom.memoryEngine());
      const h = await syncom.createDatabase({
        engine: gated.engine,
        path: `${t2.name}/H`,
        logger: false,
        defer: 0,
        sync: { sharedLog: shared },
      });
      t2.after(() => h.close().catch(() => {}));
      const a = await h.insert({ n: 1 });
      await waitUntil(() => h.sync.shared().relayed >= 1);
      // A write whose group the engine has not written yet: its position is reserved in the log, the record is not
      // readable, nothing was announced.
      gated.close();
      const pending = h.set('b', { n: 2 });
      await sleep(20);
      assert.strictEqual(h.hasRecord('b'), false, 'not landed');
      assert.ok(h.log.vector[h.nodeId] > (h.sync.shared().appended === null ? 0 : 1), 'reserved in the log');
      const unit = h.sync.unit({ access: 'public' });
      const c = await createStorage(t2, 'C', { sync: { connect: () => new MemoryLink(unit) } });
      await c.sync.addNode({ url: 'mem://H' });
      await waitUntil(() => c.hasRecord(a), { timeout: 5000 });
      assert.strictEqual(c.hasRecord('b'), false, 'the page could not hold it');
      // The vector the client adopted claims nothing of the write in flight.
      assert.ok((c.vector[h.nodeId] ?? 0) < h.log.vector[h.nodeId], 'the page’s vector is what the records show');
      gated.open();
      await pending;
      // Landed now: announced, relayed after the marker, read by the client as an op it lacks.
      await waitUntil(() => c.hasRecord('b'), { timeout: 5000 });
      assert.deepStrictEqual(await c.get('b'), { n: 2 });
    },
  );

  await t.test(
    'a snapshot while the relay is behind is refused (503 SHARED_LOG, reason behind), never positioned on a topic that lacks ops',
    async (t2) => {
      const shared = createMemorySharedLog();
      const h = await createStorage(t2, 'H', { sync: { sharedLog: shared } });
      shared.fail(TOPIC, 1);
      const a = await h.insert({ n: 1 });
      await waitUntil(() => h.sync.shared().behind === true);
      const link = new MemoryLink(h.sync.unit({ access: 'public' }));
      await link.call('syncom/hello', { node: 'probe', version: 1 });
      await assert.rejects(
        () => link.call('syncom/snapshot', { cursor: null }),
        (error) => error.code === 503 && error.reason === 'SHARED_LOG' && error.detail === 'behind',
      );
      assert.ok(!shared.entries(TOPIC).some((entry) => JSON.parse(entry.value).mark === true), 'no marker');
      // Recovered: the snapshot is positioned behind every op the hub offered.
      await waitUntil(() => h.sync.shared().behind === false, { timeout: 5000 });
      const page = await link.call('syncom/snapshot', { cursor: null });
      assert.match(page.eventId, /^[a-z0-9]+\.\d+$/);
      assert.ok(page.records.some((record) => record.id === a));
      const entries = shared.entries(TOPIC);
      const marker = entries.findIndex((entry) => JSON.parse(entry.value).mark === true);
      assert.ok(
        entries.slice(0, marker).some((entry) => entry.value.includes(a)),
        'the op is before the marker',
      );
      assert.deepStrictEqual(page.vector[h.nodeId], h.vector[h.nodeId]);
    },
  );

  await t.test(
    'the feeds of a hub share one read of the topic: many subscribers, one reader; a cursor behind the ring reads its own way until it catches up',
    async (t2) => {
      const shared = createMemorySharedLog();
      let reads = 0;
      const counted = {
        ...shared,
        read(topic, options) {
          if (topic === TOPIC) reads++;
          return shared.read(topic, options);
        },
      };
      const hub = await createStorage(t2, 'H', { sync: { sharedLog: counted } });
      await waitUntil(() => reads >= 1);
      const consumer = reads;
      const unit = hub.sync.unit({ access: 'public' });
      // Five subscribers positioned at a marker: none reads the log itself.
      const feeds = [];
      for (let i = 0; i < 5; i++) {
        const link = new MemoryLink(unit);
        await link.call('syncom/hello', { node: `c${i}`, version: 1 });
        const snapshot = await link.call('syncom/snapshot', { cursor: null });
        const received = [];
        link.subscribe(
          'syncom/changes',
          {},
          { lastEventId: snapshot.eventId, onData: (value) => received.push(value) },
        );
        feeds.push(received);
      }
      await hub.insert({ n: 1 });
      await hub.insert({ n: 2 });
      const opsOf = (received) => received.flatMap((page) => page.ops ?? []);
      await waitUntil(() => feeds.every((received) => opsOf(received).length >= 2), { timeout: 5000 });
      assert.strictEqual(reads, consumer, 'one reader of the topic: the consumer');
      // A cursor behind the ring: more entries than it keeps pass through, then a feed from the very first.
      const first = shared.entries(TOPIC)[0].id;
      const n = (id) => Number(id.slice(id.lastIndexOf('.') + 1));
      for (let i = 0; i < 1100; i++) await shared.append(TOPIC, JSON.stringify({ v: 1, node: 'other', ops: [] }));
      await waitUntil(() => hub.sync.shared().entries >= 1100, { timeout: 10_000 });
      const late = new MemoryLink(unit);
      await late.call('syncom/hello', { node: 'late', version: 1 });
      const seen = [];
      late.subscribe(
        'syncom/changes',
        {},
        { lastEventId: first, onData: (value, eventId) => seen.push({ value, eventId }) },
      );
      await waitUntil(() => reads === consumer + 1, { timeout: 5000 });
      const c = await hub.insert({ n: 3 });
      await waitUntil(() => seen.some((page) => JSON.stringify(page.value).includes(c)), { timeout: 5000 });
      // Every page once, in the log's order, from behind the ring through it: the read of its own, then the ring.
      const positions = seen.map((page) => n(page.eventId));
      for (let i = 1; i < positions.length; i++) assert.ok(positions[i] > positions[i - 1], 'in order, each once');
      assert.deepStrictEqual(
        opsOf(seen.map((page) => page.value)).map((row) => row[6].n),
        [1, 2, 3],
      );
      assert.strictEqual(reads, consumer + 1, 'its own read, once');
      const d = await hub.insert({ n: 4 });
      await waitUntil(() => seen.some((page) => JSON.stringify(page.value).includes(d)), { timeout: 5000 });
      assert.strictEqual(reads, consumer + 1, 'caught up: served from the ring');
      // A hub stopped: the feeds go on from the log their own way.
      await hub.sync.stop();
      await shared.append(TOPIC, JSON.stringify({ v: 1, node: 'other', ops: [] }));
      await waitUntil(() => reads > consumer + 1, { timeout: 5000 });
      await hub.sync.start();
    },
  );

  await t.test(
    'an entry whose apply fails on the engine is tried again, backed off, until it lands (SHARED_LOG_FAILED apply, told once); a hook that throws leaves the topic stuck after three',
    async (t2) => {
      const shared = createMemorySharedLog();
      const h1 = await createStorage(t2, 'H1', { sync: { sharedLog: shared } });
      const gated = gatedEngine(syncom.memoryEngine());
      const h2 = await syncom.createDatabase({
        engine: gated.engine,
        path: `${t2.name}/H2`,
        logger: false,
        defer: 0,
        sync: { sharedLog: shared },
      });
      t2.after(() => h2.close().catch(() => {}));
      const errors = [];
      h2.sync.on('error', (error) => errors.push(error));
      await waitUntil(() => h2.sync.shared().running === true);
      // The medium refuses the log's group twice: the entry is tried again after a second, then two.
      gated.fail(2);
      const a = await h1.insert({ n: 1 });
      await waitUntil(() => h2.sync.shared().retrying.topic === true, { timeout: 5000 });
      assert.strictEqual(h2.hasRecord(a), false);
      const told = errors.filter((error) => error.code === 'SHARED_LOG_FAILED' && error.reason === 'apply');
      assert.strictEqual(told.length, 1, 'told once per run');
      assert.match(told[0].cursor, /^[a-z0-9]+\.\d+$/);
      assert.strictEqual(told[0].cause.message, 'the disk is full');
      assert.deepStrictEqual(h2.sync.shared().stuck, { topic: false, inbox: false }, 'never stuck on the engine');
      await waitUntil(() => h2.hasRecord(a), { timeout: 10_000 });
      assert.deepStrictEqual(await h2.get(a), { n: 1 });
      assert.strictEqual(h2.sync.shared().retrying.topic, false);
      assert.strictEqual(errors.filter((error) => error.reason === 'apply').length, 1, 'one run, told once');
      const b = await h1.insert({ n: 2 });
      await waitUntil(() => h2.hasRecord(b), { timeout: 5000 });
    },
  );

  await t.test(
    'a hook that throws three times leaves the topic stuck (SHARED_LOG_FAILED stuck); stop() and start() read it again',
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
