'use strict';

// The real thing: syncom nodes hosted by wrpc Servers, dialed through
// WrpcClients over WebSocket. Skips (never fails) when @alexify/wrpc is not
// installed, the way wrpc's own adapter suites treat their frameworks.

const test = require('node:test');
const assert = require('node:assert');
const syncom = require('..');
const { createWrpcLink } = require('../wrpc.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { settle, waitUntil } = require('./utils/mesh.js');

const optional = (name) => {
  try {
    return require(name);
  } catch {
    return null;
  }
};

const wrpc = optional('@alexify/wrpc');

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
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
