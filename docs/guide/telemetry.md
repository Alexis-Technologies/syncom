---
title: OpenTelemetry
description: Inject OpenTelemetry into syncom, follow one write as a single trace across nodes, and pick the spans and metrics worth watching first.
---

# OpenTelemetry

syncom emits OpenTelemetry spans and metrics without depending on OpenTelemetry. You inject the API module
(or a tracer and a meter), syncom duck-types it, and with nothing injected every recording path is a no-op:
the write path does not even read the clock. The option has the same shape as wrpc's, so one object serves
both packages, and their spans meet in one trace.

The adapter is the `telemetry` plugin, which `@alexify/syncom/all` registers; with the lean core, pass
`plugins: [telemetry]` from `@alexify/syncom/telemetry`. Without it, `telemetry: { api }` is refused with
`ALX_ERR_PLUGIN_MISSING`, and a node that never traces ships none of the adapter.

## Turn it on

Set up OpenTelemetry in your app as you would anyway. This example keeps the spans in memory so it can look
at them:

<<< @/examples/telemetry.mjs#sdk

Then hand the API module to `createDatabase()`:

<<< @/examples/telemetry.mjs#inject

With `{ api }`, syncom gets its own tracer and meter from the global providers, so its spans carry the
`@alexify/syncom` instrumentation scope. With `{ tracer, meter }` you pass instances you built; either one
alone is fine.

## What wrpc records and what syncom adds

When syncom replicates over [wrpc](./replication-websocket) and you give wrpc the same `telemetry`, the two
split the work without overlap:

| wrpc records | syncom records |
| --- | --- |
| A span and a duration for every `syncom/hello`, `push`, `snapshot` and `changes` call, on both ends | The local write path: commit, log append, chain block, record file, none of which crosses a socket |
| W3C trace context on every packet | What a push came to: applied, duplicate, gap, malformed, refused (wrpc only sees a call that returned) |
| Connections, reconnects, subscriptions, stream bytes, backpressure | Replication lag, the log rolling and compacting, a bootstrap as one unit, a push as one batch and why it happened |

syncom carries no trace context in its ops: ops are durable, traces are not, and one push carries ops of
many origins. Over a link that is not wrpc, syncom's own signals are all you get.

## Follow one write across nodes

<<< @/examples/telemetry.mjs#trace

Every syncom span is opened as the active span, so it nests under whatever the context manager says is
active. On the laptop, `syncom.push` wraps the call and wrpc's client span becomes its child, which wrpc
injects into the packet. On the server, wrpc runs the push handler inside its server span, so
`syncom.apply` becomes that span's child. A relay of a freshly landed op is scheduled from inside the
apply that produced it, so a write and everything it caused across a mesh reads as one trace.

Two things to know when reading such a trace. Ops that land in one tick travel as one push, and that push
is parented to the first commit that scheduled it; the others ride along. And a push outlives the commit
that scheduled it: the commit ends when its caller's `await` resolves, the push runs a tick later, which
viewers draw correctly. In a browser without a context manager (`ZoneContextManager` or
`StackContextManager` from the web SDK), every syncom span is a root.

## What to watch first

The [telemetry reference](../reference/telemetry) lists every span, metric and attribute. These answer the
first questions an operator asks:

- **Is replication healthy?** `syncom.ops.received` by `syncom.outcome` (gaps and refusals should be rare),
  `syncom.ops.rejected` by `syncom.reason`, and the `syncom.outbox.size` gauge, which grows when a peer is
  unreachable.
- **How far behind are peers?** `syncom.replication.lag`, the receiving node's clock minus the op's stamp.
  It includes the clock skew between the two nodes, so read it as a trend, not as an absolute.
- **Is the disk keeping up?** `syncom.write.duration`, `syncom.log.append.duration`,
  `syncom.log.append.failures`, and the `syncom.held` gauge: records kept in memory because their file could
  not be written.
- **Is someone being refused?** `syncom.hello.refused` by code and reason on a host.

`syncom.commit` and `syncom.apply` start when the write runs, not when it was queued, and end after the
`change` listeners ran: a slow listener shows in the write's duration, as it should. A write made at once on
an idle queue opens no span (a span costs the promises that path exists to spare) and is counted in
`syncom.commits` with `syncom.path: 'fast'`.

## Keep identities off spans, share a writer

<<< @/examples/telemetry.mjs#writer

`includeIdentity: false` keeps record ids, peer urls, node ids and scopes off spans, and records a
failure's `code` instead of the exception, whose message names the record. None of those is ever a metric
label at any setting. `createTelemetry()` builds the writer the core records through, which you can hand to
`createDatabase({ telemetry })` as it is (the core takes a writer without the plugin) or to an `OpLog` opened
on its own.

The gauges (`syncom.outbox.size`, `syncom.queue.depth`, `syncom.log.length` and the rest) are observed
through a callback each database registers at open: give each database its own meter. Counters and
histograms are fine to share.

## Telemetry never breaks a write

A tracer that throws, a tracer that never calls back, a span whose `end` throws, a meter whose instruments
throw: each is contained, and the write runs exactly once. The one error that is not swallowed is the one
the bracketed work throws, which is the write's own failure.

## Log events

Separately from OpenTelemetry, the `logger` option receives structured events, one object per line with an
`event` field (`log.append.failed`, `sync.op.forged`, `storage.unpersisted`…), and the names are as stable
as the metric names. The [log events table](../reference/telemetry#log-events) lists every one with its
level; [Logging](./logger) shows how to route them.

## Coming from RxDB

RxDB's logger plugin, part of RxDB Premium, wraps a storage and logs its operations for APM tools. syncom
ships OpenTelemetry spans and metrics in the open-source package, records what replication did as well as
what storage did, and joins wrpc's spans so one trace follows a write from node to node.
