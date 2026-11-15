// The OpenTelemetry page (docs/guide/telemetry.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory. Port 8902 is this file's.
import assert from 'node:assert/strict';
// #region sdk
// Your app's OpenTelemetry setup; here the SDK keeps the spans in memory.
import * as api from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
api.trace.setGlobalTracerProvider(provider);
api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
api.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
// #endregion sdk

// #region inject
import { createDatabase, memoryEngine } from '@alexify/syncom/all';

const telemetry = { api }; // syncom derives its tracer and meter from the api module
const server = await createDatabase({ engine: memoryEngine(), telemetry });
// or pre-built instances, either one alone:
// await createDatabase({ engine: memoryEngine(), telemetry: { tracer: provider.getTracer('board') } });
// #endregion inject

// #region trace
import { Server, defineRouter, WrpcClient } from '@alexify/wrpc';
import { createWrpcLink } from '@alexify/syncom/wrpc';

const router = defineRouter({ syncom: server.sync.unit({ access: 'public' }) });
const http = new Server({ router, host: '127.0.0.1', port: 8902, protocol: 'http', telemetry }); // the same object
await http.listen();

const laptop = await createDatabase({
  engine: memoryEngine(),
  telemetry,
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url, { telemetry })) },
});
await laptop.sync.addNode({ url: 'ws://127.0.0.1:8902/api' });
await laptop.sync.awaitInSync();

await laptop.insert({ title: 'Traced' }); // one write on the laptop...
await laptop.sync.awaitInSync();
// ...and everything it caused, on both nodes, is one trace:
// syncom.commit          (laptop)
// └─ syncom.push         (laptop, reason: relay)
//    └─ syncom/push      (laptop, wrpc's CLIENT span)
//       └─ syncom/push   (server, wrpc's SERVER span)
//          └─ syncom.apply (server)
// #endregion trace
await new Promise((resolve) => setTimeout(resolve, 50));
const spans = exporter.getFinishedSpans();
const commit = spans.find((span) => span.name === 'syncom.commit' && span.attributes['syncom.op.type'] === 'write');
const apply = spans.find((span) => span.name === 'syncom.apply' && span.attributes['syncom.ops.applied'] === 1);
assert.ok(commit, 'a commit span');
assert.ok(apply, 'an apply span');
assert.equal(apply.spanContext().traceId, commit.spanContext().traceId, 'one trace across the two nodes');
const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
const ancestry = [];
for (let span = apply; span; span = byId.get(span.parentSpanContext?.spanId)) ancestry.push(span.name);
assert.deepEqual(ancestry, ['syncom.apply', 'syncom/push', 'syncom/push', 'syncom.push', 'syncom.commit']);

// #region writer
import { createTelemetry } from '@alexify/syncom/telemetry';

const writer = createTelemetry({ api, includeIdentity: false }); // record ids, peers and scopes kept off spans
const quiet = await createDatabase({ engine: memoryEngine(), telemetry: writer }); // a writer as it is
// #endregion writer
assert.equal(quiet.telemetry, writer);

await quiet.close();
await laptop.close();
await server.close();
await http.close();
api.context.disable();
api.propagation.disable();
api.trace.disable();
