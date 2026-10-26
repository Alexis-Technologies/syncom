# OpenTelemetry

syncom emits OpenTelemetry spans and metrics **without depending on
OpenTelemetry**: you inject the API (or a tracer and a meter), and everything
is duck-typed. With nothing injected, every recording path is a no-op and the
write path does not even read the clock.

The option has the same shape as wrpc's, so one object serves both packages —
and that is the point of the design, see
[What wrpc already gives you](#what-wrpc-already-gives-you).

## Two injection modes

The adapter that turns an OpenTelemetry api or tracer into what the engine
records through is the `telemetry` plugin — `@alexify/syncom/telemetry`,
registered by `@alexify/syncom/all`; without it `open({ telemetry: { api } })`
is `PLUGIN_MISSING`, and a node that never traces ships none of the adapter.

```js
const otelApi = require('@opentelemetry/api');
const { open } = require('@alexify/syncom');
const { telemetry } = require('@alexify/syncom/telemetry');

// The api module: syncom derives its own tracer and meter, so spans carry
// the `@alexify/syncom` instrumentation scope.
const storage = await open({ path: 'data', plugins: [telemetry], telemetry: { api: otelApi } });

// Or pre-built instances — either alone is fine.
const traced = await open({ path: 'data', plugins: [telemetry], telemetry: { tracer, meter } });
```

The core itself records through a **writer** — `enabled` and `withSpan`,
duck-typed — and takes one given to `open({ telemetry })` as it is, plugin
or not: `createTelemetry({ api })` from the same subpath builds one by hand,
to share with an `OpLog` opened on its own (`new OpLog(path, { telemetry:
writer })`) or with a second storage.

`includeIdentity: false` keeps record ids, peer urls/node ids and scopes off
spans, and records a failure's `code` (or class) as the span status instead
of the exception, whose message names the record. None of them is ever a
metric label at any setting.

The writer is `storage.telemetry` (opaque, `@experimental`), and `OpLog`
takes the same option directly. The signals will keep improving in minor
releases; the option and the injection modes are stable.

## What wrpc already gives you

When syncom replicates over wrpc and the host passes `telemetry` to its
`Server` and `WrpcClient`, wrpc emits — with no help from syncom:

| Signal | Where it comes from |
| --- | --- |
| A span and a duration sample for every `syncom/hello`, `push`, `snapshot`, `changes` call, on both ends | wrpc's `rpc.server.duration`, `rpc.client.duration`, `wrpc.server.calls` |
| W3C trace context across the socket (`tp`/`ts` on each packet) | wrpc's propagation |
| Connections, reconnects, subscriptions, stream bytes, backpressure | wrpc's server and client instruments |

syncom does not repeat any of it. What it adds is what only the engine can
see:

| Signal | Why wrpc cannot see it |
| --- | --- |
| The local write path — commit, log append, chain block, record file | never crosses a socket |
| What a push came to: applied, duplicate, gap, malformed, refused | wrpc sees a call that returned 200 |
| Replication lag, origin stamp to applied here | needs the op |
| The log rolling and compacting, the tail replayed at open | local I/O |
| A bootstrap as one unit, with its pages and records | many calls, one operation |
| A push as one batch, however many pages, and why it happened | the coalescing is syncom's |
| Any link that is not wrpc | there is no wrpc |

## Spans

All syncom spans are `INTERNAL`; the `CLIENT` and `SERVER` kinds belong to
wrpc's spans around the actual calls.

| Span | When | Attributes |
| --- | --- | --- |
| `syncom.commit` | one local write — of any op type, a list, text or tree op as much as a `set` — from the moment it runs to after the `change` listeners; inside a transaction, the op built, applied and validated (the append and the landing are the transaction's) | `syncom.op.type`, `syncom.record.id`†, `syncom.result` (`applied` / `noop` / `encrypted`), `syncom.scope` |
| `syncom.apply` | one batch of a peer's ops | `syncom.ops.count`, `syncom.ops.applied`, `syncom.ops.skipped`, `syncom.ops.duplicates`, `syncom.ops.gaps`, `syncom.ops.malformed`, `syncom.ops.unsigned`, `syncom.ops.forged`, `syncom.ops.out_of_scope` |
| `syncom.replay` | the unsealed log tail replayed at open | `syncom.ops.count`, `syncom.records` |
| `syncom.push` | one push to a peer, all its pages | `syncom.push.reason` (`handshake` / `manual` / `relay` / `recover` — a peer that fell behind, caught up from the vector), `syncom.ops.count`, `syncom.pages`, `syncom.peer.url`†, `syncom.peer.node`† |
| `syncom.bootstrap` | the whole snapshot walk from a peer | `syncom.peer.url`†, `syncom.peer.node`†, `syncom.pages`, `syncom.records` |
| `syncom.snapshot` | one page served to a peer (the host side) | `syncom.limit`, `syncom.records`, `syncom.done` |
| `syncom.log.roll` | sealing open files into a segment and compacting | `syncom.log.sealed`, `syncom.log.dropped`, `syncom.log.floor` |
| `syncom.log.scrub` | a purge stripping an id's entries from the log files | `syncom.log.scrubbed` |
| `syncom.catalog.rebuild` | the catalog rebuilt from a scan of `data/` at open | `syncom.records` |
| `syncom.tag` | a tag taken: the catalog copied under the log position | `syncom.records` (the catalog's rows, tombstones included) |
| `syncom.untag` | a tag dropped: the copies the older tag needs moved, the rest removed | — |
| `syncom.history` | `history()`: the record's retained entries folded, the versions handed out | `syncom.ops.count` (every retained entry, whatever the `limit`), `syncom.versions`, `syncom.exact` |
| `syncom.version` | `get(id, { at })`, and each version `diff()` and `restore()` name: one version folded out of the log (a tag's copy is a file read, not a fold, and has no span) | `syncom.ops.count` (the entries inside the cut) |
| `syncom.patches` | `applyPatches()`, and so `restore()` and `compact()`: the batch rehearsed, then every op made (each a `syncom.commit` child) and appended as one transaction | `syncom.ops.count`, `syncom.ops.applied` |
| `syncom.transact` | `transact()`: `fn` run, every op made (each a `syncom.commit` child), the group appended | `syncom.ops.count` |

† off the span when `includeIdentity` is false (so is `syncom.scope`).

A span is marked failed (status `ERROR`, the exception recorded, `error.type`
set) when the work it brackets throws: a write refused by the field-kind
rule or out of range, a push whose call rejected, a bootstrap that could not
read a snapshot, a version the log can no longer give (`HISTORY_GONE`), a
batch of patches its rehearsal refused. A peer's op refused inside
`applyRemote` is a protocol outcome, not a failure of the batch: it is
counted (below), the batch's span stays green.

A `merge` — one per snapshot record during a bootstrap — is counted but not
spanned, or a bootstrap of ten thousand records would open ten thousand
spans under one `syncom.bootstrap`.

## Metrics

Labels are closed sets. A record id, an origin, a peer url or a scope never
appears on one.

| Metric | Instrument | Unit | Labels |
| --- | --- | --- | --- |
| `syncom.commits` | Counter | `{op}` | `syncom.op.type`, `syncom.result` (`applied` / `noop` / `encrypted` / `error`) |
| `syncom.write.duration` | Histogram | `ms` | `syncom.path` (`commit` / `apply` / `replay`) |
| `syncom.ops.received` | Counter | `{op}` | `syncom.outcome` (`applied` / `skipped` — accepted but not applied here: a hook, the schema, an unreadable record / `duplicate` / `gap` / `malformed` — the last includes a stamp beyond `maxSkew` / `refused` — a signature that does not check, or none under `'require'`, or on a host a record outside the pushing peer's scopes) |
| `syncom.ops.rejected` | Counter | `{op}` | `syncom.reason` (`register` / `counter` / `set` / `list` / `text` / `tree` — the kind that holds the field and outranks the op's / `bound` — past a list's or a text's limit / `malformed` — a payload the engine does not admit / `validation` / `scope` / `unreadable` / `forged` / `unsigned`) |
| `syncom.conflicts` | Counter | `{conflict}` | `syncom.kind` (`unique`) |
| `syncom.ops.limited` | Counter | `{push}` | `syncom.reason` (`ops` / `bytes` / `rate`) |
| `syncom.replication.lag` | Histogram | `ms` | — |
| `syncom.push.ops` | Histogram | `{op}` | `syncom.push.reason` (as on the span), `syncom.result` (`ok` / `error`) |
| `syncom.bootstraps` | Counter | `{bootstrap}` | `syncom.result` |
| `syncom.log.segments` | Counter | `{segment}` | `syncom.log.event` (`sealed` / `dropped`) |
| `syncom.log.append.duration` | Histogram | `ms` | — |
| `syncom.hook.duration` | Histogram | `ms` | `syncom.hook` (`beforeWrite` / `afterWrite` / `beforeApply` / `afterApply` — the hooks that run in the mutation queue; read and sync hooks are not timed) |
| `syncom.lock.wait` | Histogram | `ms` | — (what `open()` spent taking the directory lock) |
| `syncom.hello.refused` | Counter | `{call}` | `syncom.code` (`400` / `403` / `409` / `428`) — calls a hosted unit refused before the handler |
| `syncom.outbox.size` | Observable gauge | `{op}` | — (ops queued for peers, over every dialed peer) |
| `syncom.queue.depth` | Observable gauge | `{op}` | — (writes waiting on, or in, the mutation queue) |
| `syncom.cache.size` | Observable gauge | `{entry}` | — |
| `syncom.catalog.size` | Observable gauge | `{entry}` | — (rows, tombstones included) |
| `syncom.log.length` | Observable gauge | `{entry}` | — (entries retained) |

The gauges are observable: the SDK reads them when it collects, through a
callback the storage registers at open. **One storage per meter** for those —
two storages on one meter would observe over each other (the counters and
histograms are fine to share; the SDK merges identical instruments).

`syncom.push.ops` answers three questions with one instrument: its count is
the number of pushes, its sum the ops pushed, and its distribution how many
ops coalesce into one push.

`syncom.replication.lag` is the receiving node's clock minus the op's stamp,
which is the origin's wall clock at commit time — so it includes clock skew
between the two nodes along with transit and queueing. Read it as a trend,
not as an absolute.

Two storages sharing one meter create the same instruments twice; the SDK
returns the same instrument for an identical descriptor, so this is fine.

## One trace across nodes

syncom carries **no trace context** in its ops — ops are durable, traces are
not, and one push carries ops of many origins. Instead, every syncom span is
opened with `startActiveSpan`, so it nests under whatever the host's context
manager says is active:

- On the host, wrpc runs the `syncom/push` handler inside its `SERVER` span,
  so `syncom.apply` becomes its child.
- On the dialing node, `syncom.push` wraps the `syncom/push` call, so wrpc's
  `CLIENT` span becomes *its* child — and wrpc injects that context into the
  packet.
- The relay of an op that just landed is scheduled from inside the commit (or
  apply) that produced it, and inherits that context.

With telemetry on wrpc and syncom at both ends, a write and everything it
caused is one trace:

```
syncom.commit            (node A)
└─ syncom.push {relay}   (node A)
   └─ syncom/push        CLIENT, wrpc (node A)
      └─ syncom/push     SERVER, wrpc (node B)
         └─ syncom.apply (node B)
            └─ syncom.push {relay}   (node B, on to C)
               └─ …
```

```js
const otelApi = require('@opentelemetry/api');
const { Server, WrpcClient, defineRouter } = require('@alexify/wrpc');
const { open } = require('@alexify/syncom');
const { sync } = require('@alexify/syncom/sync');
const { createWrpcLink } = require('@alexify/syncom/wrpc');

const { telemetry: otel } = require('@alexify/syncom/telemetry');
const telemetry = { api: otelApi };

// the host
const hub = await open({ path: 'hub', plugins: [sync, otel], telemetry });
const router = defineRouter({ syncom: hub.sync.unit({ access: 'public' }) });
await new Server({ router, host: '0.0.0.0', port: 8000, protocol: 'http', telemetry }).listen();

// a node
const node = await open({
  path: 'node',
  plugins: [sync, otel],
  telemetry,
  sync: { connect: async (peer) => createWrpcLink(await WrpcClient.connect(peer.url, { telemetry })) },
});
```

Two things to know when reading such a trace:

- Ops that land in one tick travel as one push, and that push is parented to
  the **first** commit or apply that scheduled it; the others in the batch
  ride along.
- A push outlives the commit that scheduled it — the commit ends when its
  caller's `await` resolves, the push runs on a later tick. A child ending
  after its parent is legal in OpenTelemetry, and viewers draw it correctly.

In a browser without a context manager (`ZoneContextManager` or
`StackContextManager` from the OTel web SDK), `startActiveSpan` still opens a
span but nothing sees it as active: every syncom span is a root, as wrpc's
client spans are there.

## Timing

`syncom.commit` and `syncom.apply` start when the write **runs**, not when it
was queued: `Storage` serialises writes, and time spent waiting on an earlier
write is the caller's contention, not this write's cost. They end after the
`change` listeners have run, because that is what the caller awaits — a slow
listener shows up in `syncom.write.duration`, and it should.

## Log events

What the injected `logger` receives is structured — one object per line with
an `event` field — and the names are a stable surface for a dashboard or an
alert to key on:

| Level | `event` | When |
| --- | --- | --- |
| warn | `sync.op.malformed`, `sync.op.skew` | a peer's op refused before it was read; the latter also an `error` event (`SKEW`) |
| warn | `sync.op.forged`, `sync.op.unsigned` | a page with ops refused for their signature, once per page with the count; also an `error` event (`BAD_SIGNATURE`, `UNSIGNED`) |
| warn | `sync.op.rejected`, `sync.op.invalid`, `sync.op.unreadable`, `sync.op.encrypted`, `sync.op.lens` | a peer's op not applied here, by reason |
| warn | `sync.op.refused`, `sync.op.scope`, `sync.hello.refused` | hosting side: ops outside a peer's scopes (`sync.op.scope`: the scope function threw on a pushed record, and the op was refused), a call refused by code |
| warn | `sync.gaps`, `sync.push.gaps`, `sync.error`, `sync.outbox.dropped`, `sync.record.malformed`, `sync.record.skew`, `sync.record.encrypted`, `sync.record.kind` | a page with gaps (received, or answered by the host to a push), a failure on the way to a peer (`REWOUND` and `UNDELIVERABLE` among them), a dropped backlog, a snapshot record left out, a field of a kind this node has no plugin for |
| warn | `log.epoch.new` (when a log was there), `log.segment.unreadable`, `log.open.unreadable`, `log.open.torn` | the log changed epoch or lost a file, or a line of its journal (`torn`: the last line, whose append was never acknowledged) |
| warn | `storage.unpersisted` | logged ops whose record files could not be written, held in memory until the next open; also an `error` event (`UNPERSISTED`) |
| warn | `catalog.skipped`, `catalog.lens`, `catalog.save`, `catalog.search`, `snapshot.skipped`, `replay.skipped`, `record.shadowed`, `record.refresh` | derived state could not follow a record (`catalog.search`: the injected text index threw); a field shadowing a method; a live `Record` not refreshed after a change, a read hook having thrown |
| warn | `listener.error`, `watch.error`, `schema.drift` | an event listener or a watcher threw; two builds of one schema version |
| warn | `editor.binding` | an editor binding (`@alexify/syncom/editor`) failed to send a delta or to reload, and has no `onError`; it reloads the editor from the field |
| warn | `sync.presence.send` | a presence update could not be sent to a peer (`url`); the next renewal tries again |
| warn | `identity.rekeyed` | a directory from before signing: `node.json` held a UUID, the node is now its signing key (once) |
| warn | `tags.dropped`, `tags.unreadable`, `sync.node.unreadable` | a `tags.json` line dropped (`reason`: `name` — not a record id, at open; `catalog` — the tag's catalog unreadable, found at open for the newest tag and at its first read for an older one); `tags.json` itself unreadable — kept as `tags.corrupt.json`, the storage open without tags until it is repaired; a registry entry that cannot be read, skipped |
| info | `schema.upgrade`, `schema.changed`, `schema.held`, `record.repaired` | what a reopen found about the schema; a record rebuilt from the log |
| debug | `catalog.rebuild`, `durable.noop`, `log.epoch.new` (a brand-new log), `schema.lens.issues` | routine |

## Failures

Telemetry never breaks a write. A tracer that throws, a tracer that does not
call back, a span whose `end` throws, a meter whose factories throw, an
instrument that throws on use — each is contained, and the write goes through
exactly once. The one thing that is *not* swallowed is an error thrown by the
work a span brackets: that is the write's own failure and it propagates as it
always did. The hostile-implementation cases are in `tests/telemetry.test.js`.
