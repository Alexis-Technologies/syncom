'use strict';

// Files land at once here (`defer: 0`): what these tests read of the disk is the engine's, not the window's — the window has tests of its own (storage.defer, storage.group).

// The real thing: syncom nodes hosted by wrpc Servers, dialed through
// WrpcClients over WebSocket. Skips (never fails) when @alexify/wrpc is not
// installed, the way wrpc's own adapter suites treat their frameworks.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('../src/all/all.js');
const { createWrpcLink } = require('../src/wrpc/wrpc.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { settle, waitUntil } = require('./utils/mesh.js');
const { createPresence } = require('../src/presence/presence.js');

// Skip only when the module is not there; a broken one is a failure to see.
const optional = (name) => {
  try {
    return require(name);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
};

const wrpc = optional('@alexify/wrpc');
// The WebRTC subpath registers `WrpcClient.transport.webrtc` when required.
const webrtc = wrpc && optional('@alexify/wrpc/webrtc');
// The SSE subpath registers the client's `transport: 'sse'`; the broker subpath holds the in-process broker.
const sse = wrpc && optional('@alexify/wrpc/sse');
const brokers = wrpc && optional('@alexify/wrpc/broker');
const { PROTOCOL } = require('../src/sync/protocol.js');
const { MessageChannel } = require('node:worker_threads');
const { openShared, PROCEDURES } = require('../src/shared/shared.js');
const { createSharedChannel } = require('../src/wrpc/wrpc.js');
const { createFakeLocks } = require('./utils/fake-locks.js');
const { createChannelPair } = require('./utils/fake-channel.js');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.createDatabase({ defer: 0, path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return storage;
};

// wrpc's own boot pattern: port 0, quiet logger, teardown registered at once.
const host = async (t, storage, unitOptions = { access: 'public' }, port = 0) => {
  const router = wrpc.defineRouter({ syncom: storage.sync.unit(unitOptions) });
  const server = new wrpc.Server({ router, host: '127.0.0.1', port, protocol: 'http', logger: false });
  await server.listen();
  t.after(() => server.close().catch(() => {}));
  const address = server.address();
  return { server, url: `ws://127.0.0.1:${address.port}${server.rpc.basePath}`, port: address.port };
};

const connect =
  (clientOptions = {}) =>
  async (node) =>
    createWrpcLink(
      await wrpc.WrpcClient.connect(node.url, {
        heartbeat: false,
        reconnect: { minDelay: 50, maxDelay: 200, jitter: false },
        logger: false,
        ...clientOptions,
      }),
    );

test('syncom over wrpc', { skip: wrpc ? false : '@alexify/wrpc unavailable' }, async (t) => {
  await t.test('two servers and a dialer: transitive replication over WebSocket', async (t2) => {
    const a = await openTemp(t2);
    const b = await openTemp(t2);
    const c = await openTemp(t2, { sync: { connect: connect(), autoStart: false } });
    const hostA = await host(t2, a);
    const hostB = await host(t2, b);
    await c.sync.addNode({ url: hostA.url });
    await c.sync.addNode({ url: hostB.url });
    await c.sync.start();

    const fromA = await a.insert({ from: 'A' });
    const fromB = await b.insert({ from: 'B' });
    const fromC = await c.insert({ from: 'C' });
    await settle([a, b, c], { timeout: 10_000 });
    for (const storage of [a, b, c]) {
      assert.deepStrictEqual(await storage.get(fromA), { from: 'A' });
      assert.deepStrictEqual(await storage.get(fromB), { from: 'B' });
      assert.deepStrictEqual(await storage.get(fromC), { from: 'C' });
    }
    // The dialer sits in the scope room on both hosts.
    assert.strictEqual(hostA.server.rooms.count('syncom:*'), 1);
    assert.strictEqual(hostB.server.rooms.count('syncom:*'), 1);
    const peers = c.sync.peers();
    assert.deepStrictEqual(peers.map((peer) => peer.node).sort(), [a.nodeId, b.nodeId].sort());
    assert.ok(peers.every((peer) => peer.subscribed));
  });

  await t.test(
    'presence over wrpc: the unit’s inbound event, relayed through the room, handed at hello',
    async (t2) => {
      const a = await openTemp(t2);
      const b = await openTemp(t2, { sync: { connect: connect(), autoStart: false } });
      const c = await openTemp(t2, { sync: { connect: connect(), autoStart: false } });
      const hostA = await host(t2, a, { access: 'public', presence: { timeout: 2000 } });
      const make = (storage) => {
        const presence = createPresence(storage, { timeout: 2000 });
        t2.after(() => presence.destroy());
        storage.sync.presence(presence);
        return presence;
      };
      const [pa, pb] = [a, b].map(make);
      await b.sync.addNode({ url: hostA.url });
      await b.sync.start();
      await settle([a, b], { timeout: 10_000 });
      await pb.set({ name: 'bob', cursor: 2 });
      await waitUntil(() => pa.get(b.nodeId) !== undefined, { timeout: 5000 });
      assert.deepStrictEqual(pa.get(b.nodeId), { name: 'bob', cursor: 2 });
      // A newcomer is handed the room at hello; a state then travels to it through the room.
      const pc = make(c);
      await c.sync.addNode({ url: hostA.url });
      await c.sync.start();
      await waitUntil(() => pc.get(b.nodeId) !== undefined, { timeout: 5000 });
      await pb.set({ name: 'bob', cursor: 3 });
      await waitUntil(() => pc.get(b.nodeId)?.cursor === 3, { timeout: 5000 });
      await pc.set({ name: 'cy' });
      await waitUntil(() => pb.get(c.nodeId) !== undefined && pa.get(c.nodeId) !== undefined, { timeout: 5000 });
      assert.strictEqual(a.log.length + b.log.length + c.log.length, 0, 'nothing of it is logged');
    },
  );

  await t.test('a server restart on the same port: wrpc reconnects, the feed resumes, offline ops flow', async (t2) => {
    const a = await openTemp(t2);
    const c = await openTemp(t2, { sync: { connect: connect(), autoStart: false } });
    let hostA = await host(t2, a);
    await c.sync.addNode({ url: hostA.url });
    await c.sync.start();
    const id = await a.insert({ n: 0 });
    await settle([a, c], { timeout: 10_000 });

    const events = [];
    c.sync.on('peer', (event) => events.push(event));
    c.sync.on('bootstrap', (event) => events.push({ bootstrap: true, ...event }));
    await hostA.server.close();
    await waitUntil(() => c.sync.peers()[0].connected === false, { timeout: 5000 });
    await a.update(id, { whileDown: 'a' });
    await c.update(id, { whileDown: 'c' });

    hostA = await host(t2, a, { access: 'public' }, hostA.port);
    await settle([a, c], { timeout: 15_000 });
    assert.deepStrictEqual(await a.get(id), await c.get(id));
    assert.ok(
      events.some((event) => event.reconnected),
      'the link announced its reconnect',
    );
    assert.ok(!events.some((event) => event.bootstrap), 'resumed from the cursor, no snapshot needed');
    assert.strictEqual(c.sync.peers().length, 1);
    assert.strictEqual(c.sync.peers()[0].subscribed, true);
  });

  await t.test('a late joiner bootstraps through a binary stream', async (t2) => {
    const a = await openTemp(t2, { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } });
    const id = await a.insert({ n: 0 });
    for (let i = 0; i < 10; i++) await a.inc(id, 'hits', 1);
    for (let i = 0; i < 30; i++) await a.insert({ i, padding: 'x'.repeat(200) });
    assert.ok(a.log.floor > 1);
    const hostA = await host(t2, a);

    const c = await openTemp(t2, { sync: { connect: connect(), autoStart: false } });
    const bootstraps = [];
    c.sync.on('bootstrap', (event) => bootstraps.push(event));
    await c.sync.addNode({ url: hostA.url });
    await c.sync.start();
    await settle([a, c], { timeout: 15_000 });
    assert.strictEqual(bootstraps.length, 1);
    assert.strictEqual(bootstraps[0].records, 31);
    assert.deepStrictEqual((await c.list()).sort(), (await a.list()).sort());
    assert.strictEqual((await c.get(id)).hits, 10);
    await a.inc(id, 'hits', 1);
    await settle([a, c], { timeout: 10_000 });
    assert.strictEqual((await c.get(id)).hits, 11);
  });

  await t.test('authorize gates the handshake by the token the node carries', async (t2) => {
    const a = await openTemp(t2);
    const hostA = await host(t2, a, { access: 'public', authorize: (context, hello) => hello.token === 'secret' });
    const good = await openTemp(t2, { sync: { connect: connect(), autoStart: false } });
    const bad = await openTemp(t2, { sync: { connect: connect(), autoStart: false } });
    const refused = [];
    bad.sync.on('error', (error) => refused.push(error));
    await good.sync.addNode({ url: hostA.url, token: 'secret' });
    await bad.sync.addNode({ url: hostA.url, token: 'nope' });
    await good.sync.start();
    await bad.sync.start();
    const id = await a.insert({ n: 1 });
    await settle([a, good], { timeout: 10_000 });
    assert.deepStrictEqual(await good.get(id), { n: 1 });
    await waitUntil(() => refused.length > 0, { timeout: 5000 });
    assert.match(refused[0].message, /Not authorized/);
    assert.strictEqual(await bad.get(id), null);
  });

  await t.test(
    'the protocol over Server-Sent Events: a dialer on transport sse bootstraps from a plain page, pushes and hears a live update',
    { skip: sse ? false : '@alexify/wrpc/sse unavailable' },
    async (t2) => {
      const a = await openTemp(t2);
      const before = await a.insert({ from: 'A', n: 1 });
      const hostA = await host(t2, a);
      // The same server, its HTTP side: `GET <basePath>/events` is the stream, `POST <basePath>` the way up.
      const url = hostA.url.replace(/^ws:/, 'http:');
      const c = await openTemp(t2, { sync: { connect: connect({ transport: 'sse' }), autoStart: false } });
      await c.sync.addNode({ url });
      await c.sync.start();
      await waitUntil(() => c.sync.peers()[0]?.subscribed, { timeout: 10_000 });
      // SSE carries text alone: the host answers the snapshot page itself, not a binary stream, and the dialer joins it.
      await waitUntil(() => c.hasRecord(before), { timeout: 10_000 });
      assert.deepStrictEqual(await c.get(before), { from: 'A', n: 1 });
      const fromC = await c.insert({ from: 'C' });
      await waitUntil(() => a.hasRecord(fromC), { timeout: 10_000 });
      assert.deepStrictEqual(await a.get(fromC), { from: 'C' });
      // A live update comes down the event stream.
      await a.update(before, { n: 2 });
      await waitUntil(async () => (await c.get(before))?.n === 2, { timeout: 10_000 });
      await settle([a, c], { timeout: 10_000 });
      const [peer] = c.sync.peers();
      assert.strictEqual(peer.node, a.nodeId);
      assert.strictEqual(peer.subscribed, true);
      assert.strictEqual(hostA.server.rooms.count('syncom:*'), 1, 'the dialer sits in the scope room over SSE too');
    },
  );

  await t.test(
    'a thin client over plain HTTP: query and count against unit({ query: true }) with the hello carried in the call — no log, no node of its own',
    async (t2) => {
      const schema = { entities: { Task: { index: ['done'] } } };
      const a = await openTemp(t2, { schema });
      await a.insert({ $type: 'Task', title: 'write the recipe', done: false });
      await a.insert({ $type: 'Task', title: 'test it', done: false });
      await a.insert({ $type: 'Task', title: 'ship it', done: true });
      const hostA = await host(t2, a, { access: 'public', query: true, limits: { rowsPerQuery: 100 } });
      const client = await wrpc.WrpcClient.connect(hostA.url.replace(/^ws:/, 'http:'), {
        transport: 'http',
        logger: false,
      });
      t2.after(() => client.close());
      // One request is one client over plain HTTP, so no hello can come first: the call carries it. The host greets the
      // caller as it would (authorize, the scopes) and keeps nothing of it — no room, no session.
      const hello = { node: 'thin-client', version: PROTOCOL };
      await assert.rejects(() => client.call('syncom/query', { entity: 'Task' }), /hello/i);
      const { rows } = await client.call('syncom/query', {
        hello,
        entity: 'Task',
        query: { done: false },
        order: ['title'],
        limit: 10,
      });
      assert.deepStrictEqual(
        rows.map((row) => row.title ?? row.data?.title),
        ['test it', 'write the recipe'],
      );
      const { count } = await client.call('syncom/count', { hello, entity: 'Task', query: { done: true } });
      assert.strictEqual(hostA.server.rooms.count('syncom:*'), 0, 'a thin client joins no room');
      assert.strictEqual(count, 1);
      // A host without `query` mounts no such procedure: wrpc answers Not Found.
      const closed = await host(t2, a, { access: 'public' });
      const other = await wrpc.WrpcClient.connect(closed.url.replace(/^ws:/, 'http:'), {
        transport: 'http',
        logger: false,
      });
      t2.after(() => other.close());
      await assert.rejects(
        () => other.call('syncom/query', { hello, entity: 'Task' }),
        (error) => {
          assert.match(String(error.message ?? error), /Not Found|queries/);
          return true;
        },
      );
    },
  );

  await t.test(
    'two hubs over a wrpc broker’s log: ops cross through it, and a client moved between the hubs resumes without a bootstrap',
    { skip: brokers ? false : '@alexify/wrpc/broker unavailable' },
    async (t2) => {
      const broker = new brokers.MemoryBroker({ logger: false });
      t2.after(() => broker.close());
      const h1 = await openTemp(t2, { sync: { sharedLog: broker.log } });
      const h2 = await openTemp(t2, { sync: { sharedLog: broker.log } });
      const hostH1 = await host(t2, h1);
      const hostH2 = await host(t2, h2);
      // A load balancer in front of the hubs: one url, whichever hub answers.
      let target = hostH1.url;
      const c = await openTemp(t2, {
        sync: {
          connect: async () =>
            createWrpcLink(
              await wrpc.WrpcClient.connect(target, {
                heartbeat: false,
                reconnect: { minDelay: 50, maxDelay: 200, jitter: false },
                logger: false,
              }),
            ),
          autoStart: false,
        },
      });
      const lb = 'ws://hubs.example/api';
      await c.sync.addNode({ url: lb });
      await c.sync.start();
      await waitUntil(() => c.sync.peers()[0]?.subscribed, { timeout: 10_000 });
      const fromC = await c.insert({ from: 'C' });
      const fromH2 = await h2.insert({ from: 'H2' });
      await waitUntil(() => h2.hasRecord(fromC) && c.hasRecord(fromH2), { timeout: 10_000 });
      assert.deepStrictEqual(await h2.get(fromC), { from: 'C' }, 'C → H1 → the broker’s log → H2');
      assert.deepStrictEqual(await c.get(fromH2), { from: 'H2' }, 'H2 → the log → H1 → C');
      const [node] = c.sync.listNodes();
      assert.strictEqual(node.remote.epoch, 'shared:syncom', 'the hubs’ epoch is the log’s');
      const cursor = node.cursor;
      // The balancer now answers with H2: the same url, another hub, the cursor still a position in the one log.
      const bootstraps = [];
      c.sync.on('bootstrap', (event) => bootstraps.push(event));
      target = hostH2.url;
      await c.sync.enableNode(lb, false);
      await c.sync.enableNode(lb, true);
      await waitUntil(() => c.sync.peers()[0]?.subscribed && c.sync.peers()[0].node === h2.nodeId, { timeout: 10_000 });
      const later = await h1.insert({ from: 'H1', n: 3 });
      const fromCagain = await c.insert({ from: 'C', n: 4 });
      await waitUntil(() => c.hasRecord(later) && h1.hasRecord(fromCagain), { timeout: 10_000 });
      assert.deepStrictEqual(await c.get(later), { from: 'H1', n: 3 });
      assert.deepStrictEqual(await h1.get(fromCagain), { from: 'C', n: 4 }, 'C → H2 → the log → H1');
      assert.deepStrictEqual(bootstraps, [], 'resumed from the cursor, not bootstrapped');
      assert.notStrictEqual(c.sync.listNodes()[0].cursor, cursor);
      const stats = h1.sync.shared();
      assert.ok(stats.relayed >= 1 && stats.applied >= 1, JSON.stringify(stats));
    },
  );

  await t.test(
    'several tabs over one database through wrpc on a worker port: the leader serves its writers, a follower writes through them, a failover keeps the port',
    async (t2) => {
      // The leader's writers behind one router, whichever instance leads now (the SharedWorker's server stays up
      // while the tabs come and go).
      const tabs = new Set();
      let served = null;
      const leading = () => {
        for (const tab of tabs) if (tab.leader) return tab;
        return null;
      };
      const procedure = (name) => ({
        access: 'public',
        async handler(context, args) {
          if (served === null) served = leading()?.serve() ?? null;
          if (served === null) throw new Error('no leader yet');
          return served[name].handler(context, args);
        },
      });
      const procedures = {};
      // Every procedure a follower forwards — the writers, a transaction, a collection's, a local document's, a blob's.
      for (const name of PROCEDURES) procedures[name] = procedure(name);
      const router = wrpc.defineRouter({ 'syncom-db': procedures });
      const server = new wrpc.Server({ router, host: '127.0.0.1', port: 0, protocol: 'http', logger: false });
      await server.listen();
      t2.after(() => server.close().catch(() => {}));
      // The worker's end of every tab's channel: a `wrpc:connect` brings the port the page speaks on; attached.
      const worker = () => {
        const { port1, port2 } = new MessageChannel();
        port1.addEventListener('message', (event) => {
          if (event.data?.type === 'wrpc:connect' && event.ports?.[0]) server.rpc.attachPort(event.ports[0]);
        });
        port1.start();
        t2.after(() => {
          port1.close();
          port2.close();
        });
        return port2;
      };
      const engine = syncom.memoryEngine();
      const locks = createFakeLocks();
      const open = async () => {
        const tab = await openShared({
          createDatabase: syncom.createDatabase,
          engine,
          path: 'tabs',
          logger: false,
          defer: 0,
          schema: { entities: { Task: {} } },
          election: { locks },
          grace: 20,
          failover: 5000,
          channel: async () =>
            createSharedChannel(
              await wrpc.WrpcClient.connect('worker://leader', { worker: worker(), logger: false, heartbeat: false }),
            ),
        });
        tab.on('leader', () => {
          served = null;
        });
        tabs.add(tab);
        t2.after(() => tab.close().catch(() => {}));
        return tab;
      };
      const a = await open();
      const b = await open();
      const c = await open();
      assert.strictEqual(a.leader, true);
      assert.strictEqual(b.leader, false);
      const id = await b.insert({ $type: 'Task', title: 'from a tab' });
      assert.deepStrictEqual(await a.get(id), { $type: 'Task', title: 'from a tab' });
      await waitUntil(() => c.hasRecord(id), { timeout: 10_000 });
      await c.transact(async (tx) => {
        await tx.update(id, { done: true });
        await tx.inc(id, 'edits', 1);
      });
      await waitUntil(async () => (await b.get(id))?.done === true, { timeout: 10_000 });
      assert.strictEqual((await a.get(id)).edits, 1);
      await assert.rejects(() => b.update('missing', { x: 1 }), { code: 'NOT_FOUND' });
      // The leader's tab closes: the next takes the lock; the follower's channel still reaches the worker's server.
      const leadership = b.waitForLeadership();
      tabs.delete(a);
      await a.close();
      served = null;
      await leadership;
      assert.strictEqual(b.leader, true);
      const later = await c.insert({ $type: 'Task', title: 'after the failover' });
      assert.deepStrictEqual(await b.get(later), { $type: 'Task', title: 'after the failover' });
      await waitUntil(() => c.hasRecord(later), { timeout: 10_000 });
    },
  );

  await t.test('a wrpc onRequest hook reads unit({ meta }): the per-procedure rate-limit recipe', async (t2) => {
    // wrpc ships no limiter. The recipe in docs/guide/scaling.md is one
    // router-level `onRequest` hook that reads `context.procedure.meta.rateLimit`
    // — what `unit({ meta })` put on every syncom procedure — and answers 429;
    // a bucket per client and per procedure, so hello and changes keep their own.
    const buckets = new WeakMap();
    const rateLimitFromMeta = (context) => {
      const config = context.procedure.meta?.rateLimit;
      if (!config) return;
      let perClient = buckets.get(context.client);
      if (!perClient) buckets.set(context.client, (perClient = new Map()));
      let bucket = perClient.get(context.procedure);
      const now = Date.now();
      if (!bucket || now - bucket.start >= config.windowMs) {
        perClient.set(context.procedure, (bucket = { start: now, used: 0 }));
      }
      if (++bucket.used > config.limit) {
        const error = new Error('Rate limit exceeded');
        error.code = 429;
        error.expose = true;
        throw error;
      }
    };
    const hub = await openTemp(t2);
    const router = wrpc.defineRouter(
      { syncom: hub.sync.unit({ access: 'public', meta: { rateLimit: { limit: 5, windowMs: 500 } } }) },
      { hooks: { onRequest: rateLimitFromMeta } },
    );
    const server = new wrpc.Server({ router, host: '127.0.0.1', port: 0, protocol: 'http', logger: false });
    await server.listen();
    t2.after(() => server.close().catch(() => {}));
    const url = `ws://127.0.0.1:${server.address().port}${server.rpc.basePath}`;
    // Seven ops, one per page: the sixth push of the window is refused.
    const c = await openTemp(t2, { sync: { connect: connect(), autoStart: false, pageSize: 1 } });
    const errors = [];
    c.sync.on('error', (error) => errors.push(error));
    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await c.insert({ i }));
    await c.sync.addNode({ url });
    await c.sync.start();
    await waitUntil(() => errors.length > 0, { timeout: 5000 });
    assert.strictEqual(errors[0].code, 429);
    assert.match(errors[0].message, /Rate limit exceeded/);
    assert.strictEqual(errors[0].url, url);
    // Five pages got through before the refusal — hello was not counted
    // against push — and the hub keeps them; the dialer keeps its cursor.
    assert.strictEqual((await hub.list()).length, 5);
    assert.deepStrictEqual(await hub.get(ids[4]), { i: 4 });
    assert.strictEqual(await hub.get(ids[5]), null);
    // The push stopped; the feed did not wait for it.
    await waitUntil(() => c.sync.peers()[0].subscribed, { timeout: 5000 });
    // The window passes; the next push — a sync(), a relay, a page that comes
    // in — sends what the hub's vector says it lacks: two pages, not seven.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await c.sync.sync(url);
    await settle([hub, c], { timeout: 10_000 });
    assert.strictEqual((await hub.list()).length, 7);
    assert.strictEqual(errors.length, 1, 'the resend fit the window');
  });
});

// WebRTC is wrpc's: a PeerLink's `remote` is a WrpcClient, and so is a
// client over a raw data channel, so `createWrpcLink` takes either as it is.
// What a test can drive without ICE is the raw-channel level — a pair of
// fake channels, one end attached to a server or a PeerHost, the other
// dialled — which is also the level every WrpcPeer link rests on.
test('syncom over a WebRTC data channel', { skip: webrtc ? false : '@alexify/wrpc/webrtc unavailable' }, async (t) => {
  const dial = async (channel, clientOptions = {}) =>
    createWrpcLink(
      await wrpc.WrpcClient.connect('webrtc:host', {
        transport: 'webrtc',
        channel,
        heartbeat: false,
        reconnect: false,
        logger: false,
        ...clientOptions,
      }),
    );

  await t.test('a raw channel attached to an RpcServer: both directions, a streamed bootstrap, a close', async (t2) => {
    const a = await openTemp(t2, { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } });
    const id = await a.insert({ n: 0 });
    for (let i = 0; i < 10; i++) await a.inc(id, 'hits', 1);
    for (let i = 0; i < 30; i++) await a.insert({ i, padding: 'x'.repeat(200) });
    assert.ok(a.log.floor > 1, 'the dialer will have to bootstrap');
    const hostA = await host(t2, a);
    const [chC, chA] = createChannelPair();
    // No session over a raw channel: the unit is `access: 'public'` (host()).
    const attached = webrtc.attachChannel(hostA.server.rpc, chA, { peer: 'c' });
    assert.strictEqual(attached.transportKind, 'webrtc');
    const c = await openTemp(t2, { sync: { autoStart: false, connect: () => dial(chC) } });
    const events = [];
    c.sync.on('peer', (event) => events.push(event));
    c.sync.on('bootstrap', (event) => events.push({ bootstrap: true, ...event }));
    await c.sync.addNode({ url: 'webrtc:host' });
    await c.sync.start();
    await settle([a, c], { timeout: 15_000 });
    assert.deepStrictEqual((await c.list()).sort(), (await a.list()).sort());
    assert.strictEqual((await c.get(id)).hits, 10);
    assert.ok(
      events.some((event) => event.bootstrap && event.records === 31),
      'bootstrapped — streamed over the channel',
    );
    assert.strictEqual(attached.binary, true, 'the channel carries binary streams');
    const fromC = await c.insert({ from: 'C' });
    await a.inc(id, 'hits', 1);
    await settle([a, c], { timeout: 10_000 });
    assert.deepStrictEqual(await a.get(fromC), { from: 'C' });
    assert.strictEqual((await c.get(id)).hits, 11);
    assert.strictEqual(hostA.server.rooms.count('syncom:*'), 1, 'in the scope room, like any client');
    // The channel closes: the link is down, and with no factory stays down.
    chC.close();
    await waitUntil(() => c.sync.peers()[0]?.connected === false, { timeout: 5000 });
    assert.ok(events.some((event) => event.connected === false));
  });

  await t.test(
    'a channel factory: wrpc rebuilds the link, the subscription resumes, syncom greets again',
    async (t2) => {
      const a = await openTemp(t2);
      const hostA = await host(t2, a);
      const channels = [];
      // Every (re)open asks for the next channel: a new pair, its far end
      // attached to the host — what an application's own signaling does.
      const next = async () => {
        const [mine, theirs] = createChannelPair();
        webrtc.attachChannel(hostA.server.rpc, theirs, { peer: 'c' });
        channels.push(mine);
        return mine;
      };
      const c = await openTemp(t2, {
        sync: {
          autoStart: false,
          connect: () => dial(next, { reconnect: { minDelay: 50, maxDelay: 100, jitter: false } }),
        },
      });
      const events = [];
      c.sync.on('peer', (event) => events.push(event));
      c.sync.on('bootstrap', (event) => events.push({ bootstrap: true, ...event }));
      await c.sync.addNode({ url: 'webrtc:host' });
      await c.sync.start();
      const first = await a.insert({ n: 1 });
      await settle([a, c], { timeout: 10_000 });
      assert.deepStrictEqual(await c.get(first), { n: 1 });
      // The path dies; wrpc asks the factory, restores the subscription from
      // its lastEventId (428: a fresh server-side client), syncom says hello
      // again and pushes what it wrote meanwhile — no snapshot.
      channels[0].close();
      await waitUntil(() => c.sync.peers()[0]?.connected === false, { timeout: 5000 });
      const whileDown = await c.insert({ whileDown: true });
      const second = await a.insert({ n: 2 });
      await settle([a, c], { timeout: 15_000 });
      assert.strictEqual(channels.length, 2, 'one redial');
      assert.deepStrictEqual(await c.get(second), { n: 2 });
      assert.deepStrictEqual(await a.get(whileDown), { whileDown: true });
      assert.ok(
        events.some((event) => event.reconnected),
        'the link announced its reconnect',
      );
      assert.ok(!events.some((event) => event.bootstrap), 'resumed from the cursor');
      assert.strictEqual(c.sync.peers()[0].subscribed, true);
    },
  );

  await t.test(
    'a raw channel attached to a PeerHost: the browser hosts, and authorize sees the pseudo-session',
    async (t2) => {
      const b = await openTemp(t2);
      let c = null;
      const greeted = [];
      const unit = b.sync.unit({
        access: 'session',
        authorize: (context, hello) => {
          greeted.push([context.session?.data?.peer, hello.node]);
          return context.session?.data?.peer === 'c' && hello.node === c.nodeId;
        },
        limits: { opsPerPush: 2 },
      });
      // What a browser would run: no RpcServer, no sessions — a PeerHost
      // over the host half of the transport, with `trust: 'link'` handing
      // every client a pseudo-session naming the peer.
      const peerHost = new webrtc.PeerHost({ router: wrpc.defineRouter({ syncom: unit }), logger: false });
      t2.after(() => peerHost.close());
      const attach = (channel, peer) => peerHost.attach(new webrtc.RtcPeerTransport(channel, { peer }), { peer });
      const [chC, chB] = createChannelPair();
      attach(chB, 'c');
      // A redial takes whatever channel the application negotiated last.
      let current = chC;
      c = await openTemp(t2, { sync: { autoStart: false, pageSize: 5, connect: () => dial(current) } });
      const errors = [];
      c.sync.on('error', (error) => errors.push(error));
      await c.sync.addNode({ url: 'webrtc:host' });
      await c.sync.start();
      const fromB = await b.insert({ from: 'B' });
      const fromC = await c.insert({ from: 'C' });
      await settle([b, c], { timeout: 10_000 });
      assert.deepStrictEqual(await c.get(fromB), { from: 'B' });
      assert.deepStrictEqual(await b.get(fromC), { from: 'C' });
      assert.deepStrictEqual(greeted, [['c', c.nodeId]]);
      assert.strictEqual(peerHost.clients.size, 1);
      assert.strictEqual(peerHost.trust, 'link');
      // The host's limits hold over a PeerHost too: three ops in one page is 413.
      await c.sync.enableNode('webrtc:host', false);
      for (let i = 0; i < 3; i++) await c.insert({ i });
      const [chC2, chB2] = createChannelPair();
      attach(chB2, 'c');
      current = chC2;
      await c.sync.enableNode('webrtc:host', true);
      await waitUntil(() => errors.some((error) => error.code === 413), { timeout: 5000 });
      // Another peer id than the one authorize expects: 403 at hello.
      const [chX, chBx] = createChannelPair();
      attach(chBx, 'x');
      const x = await openTemp(t2, { sync: { autoStart: false, connect: () => dial(chX) } });
      const refused = [];
      x.sync.on('error', (error) => refused.push(error));
      await x.sync.addNode({ url: 'webrtc:host' });
      await x.sync.start();
      await waitUntil(() => refused.length > 0, { timeout: 5000 });
      assert.strictEqual(refused[0].code, 403);
      assert.match(refused[0].message, /Not authorized/);
      assert.deepStrictEqual(greeted.at(-1), ['x', x.nodeId]);
      // `trust: 'none'`: no session at all, so `access: 'session'` is 403 before hello.
      const none = new webrtc.PeerHost({ router: wrpc.defineRouter({ syncom: unit }), logger: false, trust: 'none' });
      t2.after(() => none.close());
      const [chN, chBn] = createChannelPair();
      none.attach(new webrtc.RtcPeerTransport(chBn, { peer: 'n' }), { peer: 'n' });
      const n = await openTemp(t2, { sync: { autoStart: false, connect: () => dial(chN) } });
      const denied = [];
      n.sync.on('error', (error) => denied.push(error));
      await n.sync.addNode({ url: 'webrtc:host' });
      await n.sync.start();
      await waitUntil(() => denied.length > 0, { timeout: 5000 });
      assert.strictEqual(denied[0].code, 403);
      assert.ok(
        !greeted.some(([, node]) => node === n.nodeId),
        'authorize never ran: refused by access before the handler',
      );
    },
  );
});

// The two packages meet in one trace: syncom opens `syncom.push` around the
// call, wrpc's client span nests under it and carries the context across
// the wire, wrpc's server span receives it, and `syncom.apply` runs inside
// that. Nothing in syncom touches a traceparent.
const otel = wrpc &&
  optional('@opentelemetry/api') && {
    api: require('@opentelemetry/api'),
    ...require('@opentelemetry/sdk-trace-base'),
    ...require('@opentelemetry/context-async-hooks'),
    ...require('@opentelemetry/core'),
  };

test(
  'syncom over wrpc: one trace from a write to the peer apply',
  { skip: otel ? false : 'wrpc or otel unavailable' },
  async (t) => {
    const manager = new otel.AsyncLocalStorageContextManager().enable();
    otel.api.context.setGlobalContextManager(manager);
    otel.api.propagation.setGlobalPropagator(new otel.W3CTraceContextPropagator());
    t.after(() => {
      otel.api.context.disable();
      otel.api.propagation.disable();
    });
    // Each side exports to its own memory, so a shared trace id proves the
    // context crossed the socket rather than leaking within the process.
    const tracing = (name) => {
      const exporter = new otel.InMemorySpanExporter();
      const provider = new otel.BasicTracerProvider({ spanProcessors: [new otel.SimpleSpanProcessor(exporter)] });
      return { tracer: provider.getTracer(name), spans: () => exporter.getFinishedSpans() };
    };
    const hostSide = tracing('host');
    const dialSide = tracing('dialer');
    const wire = { propagation: otel.api.propagation, context: otel.api.context };

    const a = await openTemp(t, { telemetry: { tracer: hostSide.tracer } });
    const router = wrpc.defineRouter({ syncom: a.sync.unit({ access: 'public' }) });
    const server = new wrpc.Server({
      router,
      host: '127.0.0.1',
      port: 0,
      protocol: 'http',
      logger: false,
      telemetry: { tracer: hostSide.tracer, ...wire },
    });
    await server.listen();
    t.after(() => server.close().catch(() => {}));
    const url = `ws://127.0.0.1:${server.address().port}${server.rpc.basePath}`;

    const c = await openTemp(t, {
      telemetry: { tracer: dialSide.tracer },
      sync: { connect: connect({ telemetry: { tracer: dialSide.tracer, ...wire } }), autoStart: false },
    });
    await c.sync.addNode({ url });
    await c.sync.start();
    // Greeted and subscribed first: a write that lands mid-handshake rides the
    // handshake push AND a relay, and the chain below wants exactly one push.
    await waitUntil(() => c.sync.peers().some((peer) => peer.subscribed));
    const id = await c.insert({ from: 'C' });
    await settle([a, c], { timeout: 10_000 });
    assert.deepStrictEqual(await a.get(id), { from: 'C' });

    const one = (side, predicate) => {
      const found = side.spans().filter(predicate);
      const describe = (span) =>
        `${span.name}(${span.attributes['syncom.push.reason'] ?? span.attributes['syncom.ops.count'] ?? ''})`;
      assert.strictEqual(found.length, 1, `expected one span, got ${found.map(describe).join(', ')}`);
      return found[0];
    };
    const commit = one(dialSide, (span) => span.name === 'syncom.commit');
    const push = one(dialSide, (span) => span.name === 'syncom.push');
    const clientCall = one(dialSide, (span) => span.name === 'syncom/push');
    const serverCall = one(hostSide, (span) => span.name === 'syncom/push');
    const apply = one(hostSide, (span) => span.name === 'syncom.apply');
    assert.strictEqual(clientCall.kind, 2, 'CLIENT');
    assert.strictEqual(serverCall.kind, 1, 'SERVER');
    const chain = [commit, push, clientCall, serverCall, apply];
    for (let i = 1; i < chain.length; i++) {
      assert.strictEqual(chain[i].parentSpanContext?.spanId, chain[i - 1].spanContext().spanId, chain[i].name);
      assert.strictEqual(chain[i].spanContext().traceId, commit.spanContext().traceId, chain[i].name);
    }
    assert.strictEqual(apply.attributes['syncom.ops.applied'], 1);
  },
);
