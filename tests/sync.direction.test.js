'use strict';

// What a link carries and what a host serves: a node dialed `pull` or `push`
// alone, a unit that allows some procedures and not others, the host's idle
// page and the dialer's `caughtUp`, the three awaits, and a peer's register
// write that lost to a newer stamp — told as a `conflict` of kind `register`.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { packOps } = require('../src/ops.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');
const { MemoryLink } = require('./utils/memory-link.js');
const { createMemorySharedLog } = require('./utils/shared-log.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Directions, allow, idle pages and the awaits', async (t) => {
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
    'a pull-only node takes the host’s ops and pushes none; a push-only node pushes and subscribes to nothing; retention waits for neither pull node',
    async (t2) => {
      const mesh = await createMesh(t2, ['H', 'P', 'Q'], [], createStorage);
      const [h, p, q] = ['H', 'P', 'Q'].map((name) => mesh.get(name));
      await p.sync.addNode({ url: 'mem://H', direction: 'pull' });
      await q.sync.addNode({ url: 'mem://H', direction: 'push' });
      await assert.rejects(() => p.sync.addNode({ url: 'mem://X', direction: 'sideways' }), {
        name: 'TypeError',
        message: /direction must be 'both', 'pull' or 'push'/,
      });
      assert.strictEqual(p.sync.listNodes()[0].direction, 'pull');
      assert.strictEqual(q.sync.listNodes()[0].direction, 'push');
      await waitUntil(() => p.sync.peers()[0]?.subscribed && q.sync.peers()[0]?.connected);
      const fromHost = await h.insert({ from: 'H' });
      const fromPull = await p.insert({ from: 'P' });
      const fromPush = await q.insert({ from: 'Q' });
      await waitUntil(() => p.hasRecord(fromHost) && h.hasRecord(fromPush));
      await sleep(50);
      assert.deepStrictEqual(await p.get(fromHost), { from: 'H' }, 'the pull node took the host’s op');
      assert.strictEqual(h.hasRecord(fromPull), false, 'nothing of the pull node reached the host');
      assert.deepStrictEqual(await h.get(fromPush), { from: 'Q' }, 'the push node pushed');
      assert.strictEqual(q.hasRecord(fromHost), false, 'the push node subscribed to nothing');
      assert.strictEqual(q.sync.peers()[0].subscribed, false);
      assert.strictEqual(q.sync.peers()[0].direction, 'push');
      assert.strictEqual(p.sync.peers()[0].direction, 'pull');
      await waitUntil(() => p.sync.peers()[0].caughtUp === true);
      // Retention: P's own op is not kept for a host P never pushes to.
      const [node] = p.sync.listNodes();
      assert.strictEqual(node.acked?.[p.nodeId], undefined);
      assert.strictEqual(p.log.length >= 1, true);
      await p.sync.awaitInSync();
      await q.sync.awaitInSync();
      // sync() on a pull node pushes nothing.
      assert.deepStrictEqual(await p.sync.sync(), [{ url: 'mem://H', pushed: 0 }]);
      // A reopen keeps the direction.
      await p.close();
      const again = await createStorage(t2, 'P', { sync: { connect: mesh.connect, autoStart: false } });
      assert.strictEqual(again.sync.listNodes()[0].direction, 'pull');
    },
  );

  await t.test(
    'unit({ allow }) refuses the procedures it does not serve by code: push 403 READ_ONLY, snapshot and changes 403 NOT_SERVED',
    async (t2) => {
      const host = await createStorage(t2, 'H');
      const refusals = [];
      const unit = host.sync.unit({ access: 'public', allow: { push: false, snapshot: false, changes: false } });
      const link = new MemoryLink(unit);
      await link.call('syncom/hello', { node: 'peer', version: 1 });
      const op = { origin: 'peer', seq: 1, ts: Date.now(), type: 'write', id: 'x', data: {} };
      await assert.rejects(
        () => link.call('syncom/push', { ops: packOps([op]) }),
        (error) => error.code === 403 && error.reason === 'READ_ONLY',
      );
      await assert.rejects(
        () => link.call('syncom/snapshot', { cursor: null }),
        (error) => error.code === 403 && error.reason === 'NOT_SERVED',
      );
      link.subscribe('syncom/changes', {}, { onError: (error) => refusals.push(error) });
      await waitUntil(() => refusals.length === 1);
      assert.strictEqual(refusals[0].code, 403);
      assert.strictEqual(refusals[0].reason, 'NOT_SERVED');
      assert.strictEqual(host.hasRecord('x'), false);
      // A unit that serves pushes alone, beside one that serves everything.
      const pushes = new MemoryLink(host.sync.unit({ access: 'public', allow: { changes: false, snapshot: false } }));
      await pushes.call('syncom/hello', { node: 'peer', version: 1 });
      assert.strictEqual((await pushes.call('syncom/push', { ops: packOps([op]) })).applied, 1);
      assert.throws(() => host.sync.unit({ allow: { hello: false } }), {
        name: 'TypeError',
        message: /unknown procedure/,
      });
      assert.throws(() => host.sync.unit({ allow: { push: 'no' } }), {
        name: 'TypeError',
        message: /must be a boolean/,
      });
      assert.throws(() => host.sync.unit({ allow: 7 }), { name: 'TypeError', message: /must be an object/ });
    },
  );

  await t.test(
    'the host’s feed tells a peer it is caught up with an idle page once per lull; awaitInSync, awaitInitialReplication and awaitDocumentPushed wait for the peers',
    async (t2) => {
      const mesh = await createMesh(t2, ['H', 'C'], [['C', 'H']], createStorage);
      const [h, c] = ['H', 'C'].map((name) => mesh.get(name));
      await c.sync.awaitInitialReplication();
      await c.sync.awaitInSync();
      assert.strictEqual(c.sync.peers()[0].caughtUp, true);
      // The idle page is labelled with the feed's position and carries no ops: the dialer announces nothing of it.
      const events = [];
      c.sync.on('sync', (event) => events.push(event));
      const unit = mesh.units.get('H');
      const pages = [];
      const link = new MemoryLink(unit);
      await link.call('syncom/hello', { node: 'probe', version: 1 });
      link.subscribe('syncom/changes', {}, { onData: (value, eventId) => pages.push({ value, eventId }) });
      await waitUntil(() => pages.length === 1);
      assert.deepStrictEqual(pages[0].value, { ops: [], eventId: pages[0].eventId, idle: true });
      assert.match(pages[0].eventId, /\.0$/, 'an empty log: the position before its first op');
      const a = await h.insert({ n: 1 });
      await waitUntil(() => pages.length === 3);
      assert.strictEqual(pages[1].value.ops.length, 1, 'the op');
      assert.deepStrictEqual(
        pages[2].value,
        { ops: [], eventId: pages[1].eventId, idle: true },
        'then idle again, at the op’s position',
      );
      await waitUntil(() => c.hasRecord(a));
      await c.sync.awaitInSync();
      assert.strictEqual(
        events.every((event) => event.received === undefined || event.received > 0),
        true,
      );

      // awaitDocumentPushed: resolved once the host acknowledged this node's newest op for the record.
      const own = await c.insert({ n: 2 });
      await c.sync.awaitDocumentPushed(own);
      assert.deepStrictEqual(await h.get(own), { n: 2 });
      await c.sync.awaitDocumentPushed('never-written');
      assert.throws(() => c.sync.awaitDocumentPushed(7), { name: 'TypeError' });

      // awaitInSync waits while the link is down (the feed cannot be read to its end); a signal cuts it short.
      const down = mesh.links.get('mem://H');
      down.disconnect();
      await waitUntil(() => c.sync.peers()[0].connected === false);
      const controller = new AbortController();
      const cut = c.sync.awaitInSync({ signal: controller.signal });
      let settled = false;
      cut.then(
        () => (settled = true),
        () => (settled = true),
      );
      await sleep(20);
      assert.strictEqual(settled, false, 'waits while the link is down');
      controller.abort(new Error('enough'));
      await assert.rejects(cut, { message: 'enough' });
      const aborted = new AbortController();
      aborted.abort(new Error('already'));
      await assert.rejects(c.sync.awaitInSync({ signal: aborted.signal }), { message: 'already' });
      const waiting = c.sync.awaitInSync();
      await down.reconnect();
      await waiting;
      assert.strictEqual(c.sync.peers()[0].caughtUp, true);
      // A node whose dial failed is not waited for, nor a disabled one.
      await c.sync.addNode({ url: 'mem://nowhere' });
      await waitUntil(() => c.sync.peers().some((peer) => peer.url === 'mem://nowhere' && peer.lastError !== null));
      await c.sync.awaitInSync();
      await c.sync.enableNode('mem://nowhere', false);
      await c.sync.awaitInSync();
      await settle([h, c]);
    },
  );

  await t.test('a feed over the shared log tells a peer it is caught up once the log is quiet', async (t2) => {
    const shared = createMemorySharedLog();
    const mesh = await createMesh(t2, ['H', 'C'], [['C', 'H']], createStorage, {
      nodes: { H: { sync: { sharedLog: shared } } },
    });
    const [h, c] = ['H', 'C'].map((name) => mesh.get(name));
    await c.sync.awaitInitialReplication();
    assert.strictEqual(c.sync.peers()[0].caughtUp, true);
    const a = await h.insert({ n: 1 });
    await waitUntil(() => c.hasRecord(a));
    await c.sync.awaitInSync();
    assert.strictEqual(c.sync.peers()[0].caughtUp, true);
  });

  await t.test(
    'a peer’s register write stamped below the one held here is told as a conflict of kind register, with the winner and the loser',
    async (t2) => {
      const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
      const [a, b] = ['A', 'B'].map((name) => mesh.get(name));
      await a.sync.awaitInitialReplication();
      const id = await a.insert({ title: 'first', other: 1 });
      await settle([a, b]);
      const conflicts = { a: [], b: [] };
      a.on('conflict', (event) => conflicts.a.push(event));
      b.on('conflict', (event) => conflicts.b.push(event));
      // Both write the same field while the link is down: the newer stamp wins everywhere, the older is told.
      const link = mesh.links.get('mem://B');
      link.disconnect();
      await a.update(id, { title: 'from A', other: 2 });
      await sleep(5);
      await b.update(id, { title: 'from B' });
      await link.reconnect();
      await settle([a, b]);
      assert.deepStrictEqual(await a.get(id), { title: 'from B', other: 2 });
      assert.deepStrictEqual(await b.get(id), { title: 'from B', other: 2 });
      // A's op lost its `title` at B (B holds the newer stamp); `other` won — B's op lost nothing at A.
      assert.strictEqual(conflicts.a.length, 0, 'the newer write loses nowhere');
      assert.strictEqual(conflicts.b.length, 1);
      const [event] = conflicts.b;
      assert.strictEqual(event.kind, 'register');
      assert.strictEqual(event.id, id);
      assert.strictEqual(event.field, 'title');
      assert.strictEqual(event.op.origin, a.nodeId);
      assert.deepStrictEqual(event.winner, { ts: event.winner.ts, origin: b.nodeId, value: 'from B' });
      assert.deepStrictEqual(event.loser, { ts: event.op.ts, origin: a.nodeId, value: 'from A' });
      assert.ok(event.winner.ts > event.loser.ts);
      // Nothing is reported while nobody listens, and the same write twice is no conflict.
      b.off('conflict');
      await b.applyRemote([event.op]);
      assert.strictEqual(conflicts.b.length, 1);
    },
  );
});
