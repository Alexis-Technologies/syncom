'use strict';

// The injected OpenTelemetry writer: what enables it, what it emits, and —
// most of the file — that nothing a hostile tracer, meter, span or
// instrument does can break a write.

const { test } = require('node:test');
const assert = require('node:assert');

const otelApi = require('@opentelemetry/api');
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} = require('@opentelemetry/sdk-metrics');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');

const syncom = require('..');
const { createTelemetry, DISABLED, SCOPE_NAME } = require('../src/telemetry.js');
const { createTemp, cleanupTemp } = require('./utils/temp.js');
const { createMesh, settle, waitUntil } = require('./utils/mesh.js');
const { MemoryLink } = require('./utils/memory-link.js');

// A real SDK, exporting into memory. Anything less would not prove that what
// syncom emits is actually a valid span or a valid metric.
const createTracing = () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return {
    provider,
    tracer: provider.getTracer(SCOPE_NAME),
    spans: () => exporter.getFinishedSpans(),
    named: (name) => exporter.getFinishedSpans().filter((span) => span.name === name),
  };
};

const createMetrics = () => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // A very long interval: the reader is flushed by hand so the assertions
  // are not racing a background timer.
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({ readers: [reader] });
  const collect = async () => {
    await reader.forceFlush();
    const metrics = [];
    for (const batch of exporter.getMetrics()) {
      for (const scope of batch.scopeMetrics) metrics.push(...scope.metrics);
    }
    return metrics;
  };
  const points = async (name) => {
    const metric = (await collect()).find((m) => m.descriptor.name === name);
    return metric ? metric.dataPoints : [];
  };
  return { provider, meter: provider.getMeter(SCOPE_NAME), collect, points };
};

const useActiveContext = (t) => {
  const manager = new AsyncLocalStorageContextManager().enable();
  otelApi.context.setGlobalContextManager(manager);
  t.after(() => otelApi.context.disable());
};

const openTemp = async (t, options = {}) => {
  const dir = await createTemp();
  t.after(() => cleanupTemp(dir));
  const storage = await syncom.open({ path: dir, logger: false, ...options });
  t.after(() => storage.close().catch(() => {}));
  return { dir, storage };
};

const remoteOp = (origin, seq, type, id, extra = {}) => ({ origin, seq, ts: Date.now() + seq, type, id, ...extra });

const sum = (dataPoints, predicate = () => true) =>
  dataPoints.filter(predicate).reduce((total, point) => total + (point.value.sum ?? point.value), 0);

const point = (dataPoints, attributes) =>
  dataPoints.find((candidate) =>
    Object.entries(attributes).every(([key, value]) => candidate.attributes[key] === value),
  );

// Never a metric label: anything that identifies a record, a node or a peer.
const IDENTITY_LABELS = ['syncom.record.id', 'syncom.op.origin', 'syncom.peer.url', 'syncom.peer.node', 'syncom.scope'];
const assertNoIdentityLabels = (metrics) => {
  for (const metric of metrics) {
    for (const dataPoint of metric.dataPoints) {
      for (const key of Object.keys(dataPoint.attributes)) {
        assert.ok(!IDENTITY_LABELS.includes(key), `${metric.descriptor.name} carries ${key}`);
      }
    }
  }
};

test('createTelemetry: what enables it', async (t) => {
  await t.test('nothing, a non-object, or an empty bag is the frozen DISABLED writer', () => {
    for (const value of [undefined, null, false, 'otel', 42, {}]) {
      assert.strictEqual(createTelemetry(value), DISABLED, String(value));
    }
    assert.ok(Object.isFrozen(DISABLED));
  });

  await t.test('an api module with neither trace nor metrics is disabled', () => {
    assert.strictEqual(createTelemetry({ api: { trace: {}, metrics: {} } }), DISABLED);
  });

  await t.test('a getter that throws is disabled rather than fatal', () => {
    const telemetry = {
      get api() {
        throw new Error('exploded while resolving');
      },
    };
    assert.strictEqual(createTelemetry(telemetry), DISABLED);
  });

  await t.test('a writer is returned as-is, so Storage can hand its own down', () => {
    const { tracer } = createTracing();
    const writer = createTelemetry({ tracer });
    assert.strictEqual(createTelemetry(writer), writer);
    assert.strictEqual(createTelemetry(DISABLED), DISABLED);
  });

  await t.test('the disabled writer still runs the callback and answers everything', () => {
    let handle = 'untouched';
    const result = DISABLED.withSpan('syncom.commit', {}, (value) => {
      handle = value;
      return 'returned';
    });
    assert.strictEqual(result, 'returned');
    assert.strictEqual(handle, null);
    assert.doesNotThrow(() => {
      DISABLED.recordCommit('write', 'applied', 1);
      DISABLED.recordApply({ applied: 1, duplicates: 0, gaps: 0 }, 1);
      DISABLED.recordError(null, new Error('x'));
      DISABLED.endSpan(null);
    });
  });

  await t.test('{ api } derives a tracer and meter with the syncom scope', async () => {
    const { provider, spans } = createTracing();
    const metrics = createMetrics();
    const api = {
      trace: { getTracer: (name) => provider.getTracer(name) },
      metrics: { getMeter: (name) => metrics.provider.getMeter(name) },
    };
    const otel = createTelemetry({ api });
    assert.strictEqual(otel.enabled, true);
    otel.withSpan('syncom.commit', {}, (handle) => otel.endSpan(handle));
    otel.recordCommit('write', 'applied', 2);
    assert.strictEqual(spans()[0].instrumentationScope.name, SCOPE_NAME);
    const [commits] = await metrics.collect();
    assert.strictEqual(commits.descriptor.name, 'syncom.commits');
  });

  await t.test('tracer-only and meter-only are both supported', async () => {
    const { tracer, spans } = createTracing();
    const traced = createTelemetry({ tracer });
    assert.strictEqual(traced.enabled, true);
    traced.withSpan('syncom.commit', {}, (handle) => traced.endSpan(handle));
    traced.recordCommit('write', 'applied', 1);
    assert.strictEqual(spans().length, 1);

    const { meter, points } = createMetrics();
    const metered = createTelemetry({ meter });
    assert.strictEqual(metered.enabled, true);
    let seen;
    metered.withSpan('syncom.commit', {}, (handle) => {
      seen = handle;
      metered.endSpan(handle);
    });
    assert.deepStrictEqual(seen, { span: null, error: false });
    metered.recordCommit('write', 'applied', 1);
    assert.strictEqual(sum(await points('syncom.commits')), 1);
  });

  await t.test('a meter missing a factory leaves metrics off, not the writer', () => {
    const otel = createTelemetry({ meter: { createCounter: () => ({ add() {} }) } });
    assert.strictEqual(otel.enabled, true);
    assert.doesNotThrow(() => otel.recordCommit('write', 'applied', 1));
  });

  await t.test('a meter whose factories throw leaves the writer enabled and silent', () => {
    const meter = {
      createCounter: () => {
        throw new Error('no instruments today');
      },
      createHistogram: () => ({ record() {} }),
    };
    const otel = createTelemetry({ meter });
    assert.strictEqual(otel.enabled, true);
    assert.doesNotThrow(() => {
      otel.recordCommit('write', 'applied', 1);
      otel.recordApply({ applied: 1, duplicates: 1, gaps: 1 }, 1);
      otel.recordLogRoll(1, 1);
    });
  });
});

test('spans', async (t) => {
  await t.test('an error sets status 2 and records the exception', () => {
    const { tracer, spans } = createTracing();
    const otel = createTelemetry({ tracer });
    const boom = new TypeError('bad field');
    otel.withSpan('syncom.commit', { 'syncom.op.type': 'inc' }, (handle) => {
      otel.recordError(handle, boom);
      otel.endSpan(handle, { 'syncom.result': 'error' });
    });
    const [span] = spans();
    assert.strictEqual(span.status.code, 2);
    assert.strictEqual(span.status.message, 'bad field');
    assert.strictEqual(span.attributes['error.type'], 'TypeError');
    assert.strictEqual(span.attributes['syncom.op.type'], 'inc');
    assert.strictEqual(span.attributes['syncom.result'], 'error');
    assert.strictEqual(span.events[0].name, 'exception');
  });

  await t.test('null and undefined end-attributes are skipped', () => {
    const { tracer, spans } = createTracing();
    const otel = createTelemetry({ tracer });
    otel.withSpan('syncom.apply', {}, (handle) => otel.endSpan(handle, { a: null, b: undefined, c: 0 }));
    const [span] = spans();
    assert.deepStrictEqual(span.attributes, { c: 0 });
  });

  await t.test('identity attributes are stripped when includeIdentity is false', () => {
    const { tracer, spans } = createTracing();
    const otel = createTelemetry({ tracer, includeIdentity: false });
    otel.withSpan(
      'syncom.push',
      { 'syncom.peer.url': 'ws://x', 'syncom.peer.node': 'n', 'syncom.record.id': 'r', 'syncom.ops.count': 3 },
      (handle) => otel.endSpan(handle),
    );
    const [span] = spans();
    assert.deepStrictEqual(span.attributes, { 'syncom.ops.count': 3 });
  });

  await t.test('spans nest through startActiveSpan under a context manager', (t2) => {
    useActiveContext(t2);
    const { provider, tracer, spans } = createTracing();
    const otel = createTelemetry({ tracer });
    otel.withSpan('syncom.commit', {}, (handle) => {
      const inner = provider.getTracer('inner').startSpan('host-listener');
      inner.end();
      otel.endSpan(handle);
    });
    const [inner, outer] = spans();
    assert.strictEqual(inner.name, 'host-listener');
    assert.strictEqual(inner.parentSpanContext?.spanId, outer.spanContext().spanId);
  });
});

test('containment: a hostile tracer never breaks the work', async (t) => {
  const work = (otel) => {
    let runs = 0;
    const result = otel.withSpan('syncom.commit', {}, (handle) => {
      runs++;
      otel.endSpan(handle);
      return 'done';
    });
    return { runs, result };
  };

  await t.test('a tracer that throws before invoking the callback', () => {
    const tracer = {
      startActiveSpan() {
        throw new Error('tracer down');
      },
    };
    assert.deepStrictEqual(work(createTelemetry({ tracer })), { runs: 1, result: 'done' });
  });

  await t.test('a tracer that never invokes the callback still gets the work run once', () => {
    const tracer = { startActiveSpan: () => 'ignored you' };
    assert.deepStrictEqual(work(createTelemetry({ tracer })), { runs: 1, result: 'done' });
  });

  await t.test('a tracer that invokes the callback twice runs the work once', () => {
    const tracer = {
      startActiveSpan(_name, _options, fn) {
        fn({ end() {} });
        return fn({ end() {} });
      },
    };
    assert.deepStrictEqual(work(createTelemetry({ tracer })), { runs: 1, result: 'done' });
  });

  await t.test("the callback's result wins over whatever the tracer returns", () => {
    const tracer = {
      startActiveSpan(_name, _options, fn) {
        fn({ end() {} });
        return 'not the result';
      },
    };
    assert.deepStrictEqual(work(createTelemetry({ tracer })), { runs: 1, result: 'done' });
  });

  await t.test('an error thrown by the work propagates untouched', () => {
    const { tracer } = createTracing();
    const otel = createTelemetry({ tracer });
    const boom = new Error('from the work');
    assert.throws(
      () =>
        otel.withSpan('syncom.commit', {}, () => {
          throw boom;
        }),
      (error) => error === boom,
    );
  });

  await t.test('a tracer with only startSpan opens a detached span', () => {
    let ended = 0;
    const tracer = { startSpan: () => ({ end: () => ended++ }) };
    assert.deepStrictEqual(work(createTelemetry({ tracer })), { runs: 1, result: 'done' });
    assert.strictEqual(ended, 1);
  });

  await t.test('a tracer whose startSpan throws', () => {
    const tracer = {
      startSpan() {
        throw new Error('no span for you');
      },
    };
    assert.deepStrictEqual(work(createTelemetry({ tracer })), { runs: 1, result: 'done' });
  });

  await t.test('a tracer with neither method', () => {
    const tracer = { getSpan: () => null };
    assert.deepStrictEqual(work(createTelemetry({ tracer })), { runs: 1, result: 'done' });
  });

  await t.test('a span whose methods throw', () => {
    const hostile = () => {
      throw new Error('span exploded');
    };
    const span = { end: hostile, setAttribute: hostile, setStatus: hostile, recordException: hostile };
    const tracer = { startActiveSpan: (_n, _o, fn) => fn(span) };
    const otel = createTelemetry({ tracer });
    const result = otel.withSpan('syncom.commit', {}, (handle) => {
      otel.recordError(handle, new Error('x'));
      otel.endSpan(handle, { 'syncom.result': 'error' });
      return 'done';
    });
    assert.strictEqual(result, 'done');
  });

  await t.test('an instrument that throws on use', () => {
    const hostile = () => {
      throw new Error('instrument exploded');
    };
    const meter = { createCounter: () => ({ add: hostile }), createHistogram: () => ({ record: hostile }) };
    const otel = createTelemetry({ meter });
    assert.doesNotThrow(() => {
      otel.recordCommit('write', 'applied', 1);
      otel.recordApply({ applied: 1, duplicates: 1, gaps: 1 }, 1);
      otel.recordMalformed();
      otel.recordRejected('register');
      otel.recordLag(Date.now());
      otel.recordLag('not a stamp');
      otel.recordReplay(1);
      otel.recordPush('relay', 'ok', 1);
      otel.recordBootstrap('ok');
      otel.recordLogRoll(1, 2);
      otel.recordAppend(1);
    });
  });

  await t.test('recordError and endSpan tolerate a null handle', () => {
    const { tracer } = createTracing();
    const otel = createTelemetry({ tracer });
    assert.doesNotThrow(() => {
      otel.recordError(null, new Error('x'));
      otel.endSpan(null);
      otel.endSpan({ span: null });
    });
  });
});

test('Storage telemetry', async (t) => {
  await t.test('a commit span per local write, counted by type and result', async (t2) => {
    const { tracer, named } = createTracing();
    const { meter, points } = createMetrics();
    const { storage } = await openTemp(t2, { telemetry: { tracer, meter } });
    const id = await storage.insert({ title: 'Draft' });
    await storage.inc(id, 'views', 2);
    await storage.delete(id);
    const spans = named('syncom.commit');
    assert.deepStrictEqual(
      spans.map((span) => [
        span.attributes['syncom.op.type'],
        span.attributes['syncom.result'],
        span.attributes['syncom.scope'],
      ]),
      [
        ['write', 'applied', '*'],
        ['inc', 'applied', '*'],
        ['delete', 'applied', '*'],
      ],
    );
    assert.ok(spans.every((span) => span.attributes['syncom.record.id'] === id));
    assert.ok(spans.every((span) => span.status.code === 0));
    assert.strictEqual(spans[0].instrumentationScope.name, SCOPE_NAME);
    assert.strictEqual(
      sum(await points('syncom.commits'), (p) => p.attributes['syncom.result'] === 'applied'),
      3,
    );
    assert.strictEqual(point(await points('syncom.write.duration'), { 'syncom.path': 'commit' }).value.count, 3);
  });

  await t.test('a refused local write is an error span and an error sample', async (t2) => {
    const { tracer, named } = createTracing();
    const { meter, points } = createMetrics();
    const { storage } = await openTemp(t2, { telemetry: { tracer, meter } });
    const id = await storage.insert({ hits: 'text' });
    await assert.rejects(() => storage.inc(id, 'hits', 1), /register/);
    const span = named('syncom.commit').at(-1);
    assert.strictEqual(span.attributes['syncom.op.type'], 'inc');
    assert.strictEqual(span.status.code, 2);
    assert.strictEqual(span.attributes['error.type'], 'Error');
    assert.strictEqual(span.events[0].name, 'exception');
    assert.strictEqual(
      sum(await points('syncom.commits'), (p) => p.attributes['syncom.result'] === 'error'),
      1,
    );
  });

  await t.test('a write to an encrypted record stays local: result encrypted, no error', async (t2) => {
    const { tracer, named } = createTracing();
    const { storage } = await openTemp(t2, { telemetry: { tracer } });
    await storage.saveData('s1', { secret: 1 }, { encrypted: true });
    await storage.set('s1', { secret: 2 });
    assert.deepStrictEqual(await storage.get('s1'), { secret: 2 });
    const [span] = named('syncom.commit');
    assert.strictEqual(span.attributes['syncom.result'], 'encrypted');
    assert.strictEqual(span.attributes['syncom.scope'], undefined);
    assert.strictEqual(span.status.code, 0);
  });

  await t.test('a merge is counted but not spanned; joining what is held already is a noop', async (t2) => {
    const { tracer, named } = createTracing();
    const { meter, points } = createMetrics();
    const { storage } = await openTemp(t2, { telemetry: { tracer, meter } });
    await storage.insert({ a: 1 });
    const page = await storage.snapshot();
    await storage.mergeSnapshot(page.records);
    assert.strictEqual(named('syncom.commit').length, 1, 'only the insert has a span');
    const commits = await points('syncom.commits');
    assert.strictEqual(point(commits, { 'syncom.op.type': 'merge', 'syncom.result': 'noop' }).value, 1);
  });

  await t.test('an apply span counts the batch; ops by outcome, rejections and lag are sampled', async (t2) => {
    const { tracer, named } = createTracing();
    const { meter, points, collect } = createMetrics();
    const { storage } = await openTemp(t2, { telemetry: { tracer, meter } });
    storage.on('error', () => {});
    const id = await storage.insert({ hits: 'text' });
    const result = await storage.applyRemote([
      remoteOp('peer', 1, 'write', 'r1', { data: { a: 1 } }),
      remoteOp('peer', 1, 'write', 'r1', { data: { a: 1 } }),
      remoteOp('peer', 3, 'set', 'r1', { data: { b: 1 } }),
      'garbage',
      remoteOp('peer', 2, 'inc', id, { key: 'hits', value: 1 }),
    ]);
    assert.deepStrictEqual(result, { applied: 2, skipped: 0, duplicates: 1, gaps: 1 });
    const [span] = named('syncom.apply');
    assert.strictEqual(span.attributes['syncom.ops.count'], 5);
    assert.strictEqual(span.attributes['syncom.ops.applied'], 2);
    assert.strictEqual(span.attributes['syncom.ops.duplicates'], 1);
    assert.strictEqual(span.attributes['syncom.ops.gaps'], 1);
    assert.strictEqual(span.status.code, 0);
    const received = await points('syncom.ops.received');
    assert.strictEqual(point(received, { 'syncom.outcome': 'applied' }).value, 2);
    assert.strictEqual(point(received, { 'syncom.outcome': 'duplicate' }).value, 1);
    assert.strictEqual(point(received, { 'syncom.outcome': 'gap' }).value, 1);
    assert.strictEqual(point(received, { 'syncom.outcome': 'malformed' }).value, 1);
    assert.strictEqual(point(await points('syncom.ops.rejected'), { 'syncom.reason': 'register' }).value, 1);
    const [lag] = await points('syncom.replication.lag');
    assert.strictEqual(lag.value.count, 2);
    assert.strictEqual(point(await points('syncom.write.duration'), { 'syncom.path': 'apply' }).value.count, 1);
    assertNoIdentityLabels(await collect());
  });

  await t.test('a replayed tail is spanned on reopen', async (t2) => {
    const { tracer, named } = createTracing();
    const { meter, points } = createMetrics();
    const { dir, storage: first } = await openTemp(t2);
    const id = await first.insert({ n: 1 });
    await first.close();
    // Crash between "logged" and "written": the record file is gone.
    await require('node:fs/promises').rm(require('node:path').join(dir, 'data', `${id}.json`));
    const second = await syncom.open({ path: dir, logger: false, telemetry: { tracer, meter } });
    t2.after(() => second.close().catch(() => {}));
    assert.deepStrictEqual(await second.get(id), { n: 1 });
    const [span] = named('syncom.replay');
    assert.strictEqual(span.attributes['syncom.ops.count'], 1);
    assert.strictEqual(span.attributes['syncom.records'], 1);
    assert.strictEqual(point(await points('syncom.write.duration'), { 'syncom.path': 'replay' }).value.count, 1);
  });

  await t.test('includeIdentity: false keeps the record id off the span', async (t2) => {
    const { tracer, named } = createTracing();
    const { storage } = await openTemp(t2, { telemetry: { tracer, includeIdentity: false } });
    await storage.insert({ n: 1 });
    const [span] = named('syncom.commit');
    assert.strictEqual(span.attributes['syncom.record.id'], undefined);
    assert.strictEqual(span.attributes['syncom.op.type'], 'write');
  });

  await t.test('a commit nests under whatever span is active — a wrpc handler, say', async (t2) => {
    useActiveContext(t2);
    const { provider, tracer, named } = createTracing();
    const { storage } = await openTemp(t2, { telemetry: { tracer } });
    const outer = await provider.getTracer('host').startActiveSpan('request', async (span) => {
      await storage.insert({ n: 1 });
      span.end();
      return span;
    });
    const [commit] = named('syncom.commit');
    assert.strictEqual(commit.parentSpanContext?.spanId, outer.spanContext().spanId);
  });

  await t.test('nothing is recorded, and nothing is measured, when telemetry is off', async (t2) => {
    const { storage } = await openTemp(t2);
    assert.strictEqual(storage.telemetry, DISABLED);
    assert.strictEqual(storage.sync.storage.telemetry.enabled, false);
    await storage.insert({ n: 1 });
  });
});

test('Sync telemetry', async (t) => {
  const createStorage =
    (telemetryOf) =>
    async (t2, name, options = {}) => {
      const dir = await createTemp();
      t2.after(() => cleanupTemp(dir));
      const storage = await syncom.open({ path: dir, logger: false, telemetry: telemetryOf(name), ...options });
      t2.after(() => storage.close().catch(() => {}));
      return storage;
    };

  await t.test('a write, its relay push and the peer apply form one trace', async (t2) => {
    useActiveContext(t2);
    const tracing = { A: createTracing(), B: createTracing() };
    const mesh = await createMesh(
      t2,
      ['A', 'B'],
      [['A', 'B']],
      createStorage((name) => ({ tracer: tracing[name].tracer })),
    );
    const a = mesh.get('A');
    const b = mesh.get('B');
    await a.insert({ n: 1 });
    await settle([a, b]);
    const [commit] = tracing.A.named('syncom.commit');
    const [push] = tracing.A.named('syncom.push');
    const [apply] = tracing.B.named('syncom.apply');
    assert.strictEqual(push.attributes['syncom.push.reason'], 'relay');
    assert.strictEqual(push.attributes['syncom.ops.count'], 1);
    assert.strictEqual(push.attributes['syncom.pages'], 1);
    assert.strictEqual(push.attributes['syncom.peer.url'], 'mem://B');
    assert.strictEqual(push.attributes['syncom.peer.node'], b.nodeId);
    assert.strictEqual(push.status.code, 0);
    // The relay was scheduled from inside the commit; the peer applied it
    // inside the push. One trace, three spans, two nodes.
    assert.strictEqual(push.parentSpanContext?.spanId, commit.spanContext().spanId);
    assert.strictEqual(apply.parentSpanContext?.spanId, push.spanContext().spanId);
    assert.strictEqual(apply.spanContext().traceId, commit.spanContext().traceId);
    assert.strictEqual(apply.attributes['syncom.ops.applied'], 1);
  });

  await t.test('a handshake push, a failed relay and a manual retry each say why', async (t2) => {
    const { tracer, named } = createTracing();
    const { meter, points, collect } = createMetrics();
    const { storage: b } = await openTemp(t2);
    const unit = b.sync.unit({ access: 'public' });
    let link = null;
    const connect = () => {
      link = new MemoryLink(unit);
      return link;
    };
    const { storage: a } = await openTemp(t2, { telemetry: { tracer, meter }, sync: { connect, autoStart: false } });
    await a.insert({ first: true });
    await a.sync.addNode({ url: 'mem://B' });
    await a.sync.start();
    await settle([a, b]);
    const [handshake] = named('syncom.push');
    assert.strictEqual(handshake.attributes['syncom.push.reason'], 'handshake');
    assert.strictEqual(handshake.attributes['syncom.ops.count'], 1);

    // The relay of the next write is refused by the link.
    const call = link.call.bind(link);
    let refuse = true;
    link.call = (method, args) =>
      refuse && method === 'syncom/push' ? Promise.reject(new Error('push refused')) : call(method, args);
    await a.insert({ second: true });
    await waitUntil(() => named('syncom.push').length === 2);
    const relay = named('syncom.push')[1];
    assert.strictEqual(relay.attributes['syncom.push.reason'], 'relay');
    assert.strictEqual(relay.status.code, 2);
    assert.strictEqual(relay.status.message, 'push refused');

    refuse = false;
    const [{ pushed }] = await a.sync.sync();
    assert.strictEqual(pushed, 1);
    const manual = named('syncom.push')[2];
    assert.strictEqual(manual.attributes['syncom.push.reason'], 'manual');
    assert.strictEqual(manual.status.code, 0);

    const pushes = await points('syncom.push.ops');
    assert.strictEqual(point(pushes, { 'syncom.push.reason': 'handshake', 'syncom.result': 'ok' }).value.count, 1);
    assert.strictEqual(point(pushes, { 'syncom.push.reason': 'relay', 'syncom.result': 'error' }).value.count, 1);
    assert.strictEqual(point(pushes, { 'syncom.push.reason': 'manual', 'syncom.result': 'ok' }).value.sum, 1);
    assertNoIdentityLabels(await collect());
  });

  await t.test('a bootstrap is one span; the host rolls its log under spans of its own', async (t2) => {
    const tracing = { A: createTracing(), B: createTracing() };
    const metrics = { A: createMetrics(), B: createMetrics() };
    const options = { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } };
    const telemetryOf = (name) => ({ tracer: tracing[name].tracer, meter: metrics[name].meter });
    const mesh = await createMesh(t2, ['A', 'B'], [], createStorage(telemetryOf), options);
    const a = mesh.get('A');
    const id = await a.insert({ n: 0 });
    for (let i = 0; i < 12; i++) await a.inc(id, 'hits', 1);
    await a.insert({ other: true });
    assert.ok(a.log.floor > 1, 'history was compacted');

    const rolls = tracing.A.named('syncom.log.roll');
    assert.ok(rolls.length >= 3);
    assert.ok(rolls.every((span) => span.attributes['syncom.log.sealed'] === 2));
    assert.ok(rolls.at(-1).attributes['syncom.log.floor'] > 1);
    assert.ok(rolls.some((span) => span.attributes['syncom.log.dropped'] >= 1));
    const segments = await metrics.A.points('syncom.log.segments');
    assert.strictEqual(point(segments, { 'syncom.log.event': 'sealed' }).value, rolls.length);
    assert.ok(point(segments, { 'syncom.log.event': 'dropped' }).value >= 1);
    assert.strictEqual((await metrics.A.points('syncom.log.append.duration'))[0].value.count, 14);

    const b = mesh.get('B');
    await b.sync.addNode({ url: 'mem://A' });
    await settle([a, b]);
    assert.strictEqual((await b.get(id)).hits, 12);
    const [bootstrap] = tracing.B.named('syncom.bootstrap');
    assert.strictEqual(bootstrap.attributes['syncom.peer.url'], 'mem://A');
    assert.strictEqual(bootstrap.attributes['syncom.peer.node'], a.nodeId);
    assert.ok(bootstrap.attributes['syncom.pages'] >= 1);
    assert.strictEqual(bootstrap.attributes['syncom.records'], 2);
    assert.strictEqual(bootstrap.status.code, 0);
    assert.strictEqual(point(await metrics.B.points('syncom.bootstraps'), { 'syncom.result': 'ok' }).value, 1);
    // The joined records were merges: counted, never spanned.
    const merges = point(await metrics.B.points('syncom.commits'), {
      'syncom.op.type': 'merge',
      'syncom.result': 'applied',
    });
    assert.strictEqual(merges.value, 2);
    assert.ok(tracing.B.named('syncom.commit').every((span) => span.attributes['syncom.op.type'] !== 'merge'));
  });

  await t.test('a failed bootstrap is an error span and an error sample', async (t2) => {
    const { tracer, named } = createTracing();
    const { meter, points } = createMetrics();
    const options = { sync: { log: { rollAfter: 2 }, retention: { ops: 4 } } };
    const { storage: a } = await openTemp(t2, options);
    const id = await a.insert({ n: 0 });
    for (let i = 0; i < 12; i++) await a.inc(id, 'hits', 1);
    assert.ok(a.log.floor > 1);
    const unit = a.sync.unit({ access: 'public' });
    const connect = () => {
      const link = new MemoryLink(unit);
      const call = link.call.bind(link);
      link.call = (method, args) =>
        method === 'syncom/snapshot' ? Promise.reject(new Error('no snapshots')) : call(method, args);
      return link;
    };
    const { storage: b } = await openTemp(t2, { telemetry: { tracer, meter }, sync: { connect, autoStart: false } });
    b.sync.on('error', () => {});
    await b.sync.addNode({ url: 'mem://A' });
    await b.sync.start();
    await waitUntil(() => named('syncom.bootstrap').length === 1);
    const [span] = named('syncom.bootstrap');
    assert.strictEqual(span.status.code, 2);
    assert.strictEqual(span.status.message, 'no snapshots');
    assert.strictEqual(point(await points('syncom.bootstraps'), { 'syncom.result': 'error' }).value, 1);
  });
});

test('OpLog telemetry', async (t) => {
  await t.test('a bare log takes the option too', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const { tracer, named } = createTracing();
    const { meter, points } = createMetrics();
    const log = await new syncom.OpLog(dir, { telemetry: { tracer, meter }, rollAfter: 2, retention: { ops: 4 } });
    for (let seq = 1; seq <= 8; seq++) {
      await log.append([{ origin: 'n', seq, ts: seq, type: 'write', id: 'r', data: {} }]);
    }
    await log.close();
    const rolls = named('syncom.log.roll');
    assert.strictEqual(rolls.length, 4);
    assert.ok(rolls.every((span) => span.attributes['syncom.log.sealed'] === 2));
    assert.strictEqual(rolls[0].attributes['syncom.log.dropped'], 0);
    assert.strictEqual(rolls.at(-1).attributes['syncom.log.dropped'], 1);
    assert.strictEqual(rolls.at(-1).attributes['syncom.log.floor'], log.floor);
    const segments = await points('syncom.log.segments');
    assert.strictEqual(point(segments, { 'syncom.log.event': 'sealed' }).value, 4);
    assert.strictEqual(point(segments, { 'syncom.log.event': 'dropped' }).value, 2);
    assert.strictEqual((await points('syncom.log.append.duration'))[0].value.count, 8);
  });

  await t.test('an empty append is neither measured nor spanned', async (t2) => {
    const dir = await createTemp();
    t2.after(() => cleanupTemp(dir));
    const { tracer, spans } = createTracing();
    const { meter, collect } = createMetrics();
    const log = await new syncom.OpLog(dir, { telemetry: { tracer, meter } });
    assert.deepStrictEqual(await log.append([]), []);
    await log.close();
    assert.strictEqual(spans().length, 0);
    assert.strictEqual((await collect()).length, 0);
  });
});
