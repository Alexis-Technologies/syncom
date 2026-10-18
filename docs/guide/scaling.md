# Scaling

A syncom mesh has no coordinator: every node holds its own log, every link
carries ops both ways, and the version vector stops an op from being applied
twice. Scaling it is a matter of topology and limits.

## Hubs

The hub is a node like any other, with its unit mounted on a wrpc server.
Run several — one per region, or one per process behind a load balancer —
and have them dial each other: ops a client pushes to hub 1 reach hub 2 the
way they reach any peer, and a client of hub 2 receives them from there.
`tests/hub.mesh.test.js` is the smallest such mesh: two hubs, two clients.

```js
// every hub process: a full node, the same schema and snapshot
const hub = await open({ path: '/var/lib/syncom', schema, sync: { connect } });
await hub.sync.addNode({ url: 'wss://hub-2.internal/api', scopes: ['*'] });
defineRouter({ syncom: hub.sync.unit({ access: 'session', authorize, limits, meta }) });
```

Two rules keep it simple. **Sticky sessions**: a client's `changes`
subscription names a position in *one* hub's log (`<epoch>.<seq>`), so a
load balancer must keep a client on the hub it greeted; a client moved to
another hub resumes from a cursor that hub does not know and bootstraps
from it — correct, just more expensive. **A hub restart resumes**: the log's
epoch is minted once, so clients of a restarted hub pick up from their
cursors without a snapshot, as long as retention still covers them.

What a hub mesh does not give is one log shared by every hub process. That
is the next step — a **shared log** on a broker (Redis Streams, NATS,
Kafka), every hub appending what it accepts and serving `changes` from the
stream, so a client resumes on any hub. The contract is reserved as
`SharedLog` (`append`, `read`, `parseId` — the shape of wrpc's
`BrokerLog`, so a broker's `.log` fits with no adapter; `isSharedLog()`
checks it) and `open({ sync: { sharedLog } })` is refused until that mode
exists.

## Scopes as buckets

Partial replication is the lever: `sync.scope(id, data)` assigns a record to
a scope, `addNode({ scopes })` says which scopes a node receives, and the
hub serves each peer its scopes alone — a tenant, an organisation, a
project. A hub that holds every tenant's data sends each client only its own,
and the version vector runs per origin *and scope*, so a client of one scope
sees no holes.

## Limits

Three layers, each its own:

- `unit({ limits: { opsPerPush, bytesPerPush, opsPerSecond } })` bounds what
  a peer pushes, in `push`, whatever transport carried it: 413 for a page too
  large, 429 for a peer too fast — codes the dialer reports and recovers
  from, never a hang-up ([Hosting](./sync#hosting));
- wrpc's own `maxCalls`, `maxSubscriptions`, `maxBatch`, `maxPayload` bound
  the wire;
- a hub-wide policy — a rate limit per session across every unit, an audit
  of who called what — is a wrpc `onRequest` hook on the router, and
  `unit({ meta })` is what it reads as `context.procedure.meta`:

```js
const router = defineRouter(
  { syncom: hub.sync.unit({ access: 'session', meta: { rateLimit: { limit: 200, windowMs: 1000 } } }) },
  { hooks: { onRequest: rateLimitFromMeta } }, // your hook, reading context.procedure.meta.rateLimit
);
```

Retention bounds the log: `sync.retention.ops` / `.days` size it for the
longest outage a client may have — below the floor a client bootstraps,
which is one snapshot of its scopes.

## Presence

Who is online, who is editing what, where a cursor is — ephemeral state has
no place in a durable, replicated log. On a hub it is a room:
`context.server.to('presence:' + docId).except(context.client).emit(…)`;
among [WebRTC](./webrtc) peers it is `mesh.broadcast('presence/state', …)`.
Both are wrpc's, both cost nothing in the log.

## Several tabs

Two tabs are two instances, and `open()` is exclusive per directory
([why](./storage#one-instance-per-directory)): the second tab sees
`code: 'LOCKED'`. The connection is easy to share — a SharedWorker running
wrpc's `WrpcClientProxy` holds one WebSocket, and every tab's
`connect(url, { worker })` goes through it — but the storage is not: a
proxied connection does not stop two storages from minting the same
sequence number. For v1, one tab syncs (take the lock with `lock: 'wait'`
and let the others work read-only, or route writes to it through a
`BroadcastChannel`); a storage served from a worker to its tabs is the
follow-up.

## End-to-end encryption

wrpc's `createSealer` / `createOpener` (HPKE per message) work on a record's
fields today without any change here — seal in `beforeWrite`, open in
`afterRead` — with the consequences a CRDT implies: a register holding
ciphertext converges like any register, a counter cannot be sealed (its sum
needs the number), and an index, a unique key or a query over a sealed field
is impossible, since the catalog sees ciphertext. A key per scope is the
natural shape, and a follow-up.

## Observability

Every path emits through the injected OpenTelemetry writer
([telemetry](./telemetry)): `syncom.ops.received` by outcome,
`syncom.ops.rejected` by reason (`register`, `counter`, `validation`),
`syncom.conflicts`, `syncom.ops.limited` by reason, `syncom.replication.lag`,
the push and bootstrap spans nested under wrpc's. On the hub, those plus
the `hello`, `conflict`, `schema` and `error` events are what a dashboard
and an audit are built from — and `op.actor` says who.
