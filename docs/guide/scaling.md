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
another hub finds another epoch at hello, drops its cursor and starts over
there — that hub's whole retained log, or a bootstrap once it has compacted
— correct, just more expensive. **A hub restart resumes**: the log's
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
project. A hub that holds every tenant's data sends each client only its own
and takes from it only its own: the scopes `hello` named bound `push` as well
as `snapshot` and `changes` ([Scopes](./sync#scopes)). The version vector runs
per origin *and scope*, so a client of one scope sees no holes.

## Limits

Three layers, each its own:

- `unit({ limits: { opsPerPush, bytesPerPush, opsPerSecond } })` bounds what
  a peer pushes, in `push`, whatever transport carried it: 413 for a page too
  large, 429 for a peer too fast — codes the dialer reports and recovers
  from, never a hang-up ([Hosting](./sync#hosting)); `opsPerPush` is 10 000
  when not given;
- wrpc's own `maxCalls`, `maxSubscriptions`, `maxBatch`, `maxPayload` bound
  the wire;
- a hub-wide policy — a rate limit per session across every unit, an audit
  of who called what — is a wrpc `onRequest` hook on the router, and
  `unit({ meta })` is what it reads as `context.procedure.meta`:

```js
// A bucket per client and per procedure; the limit comes off the procedure.
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

const router = defineRouter(
  { syncom: hub.sync.unit({ access: 'session', meta: { rateLimit: { limit: 200, windowMs: 1000 } } }) },
  { hooks: { onRequest: rateLimitFromMeta } },
);
```

The hook runs before access and the handler, on every transport the router
serves — a WebSocket, a `PeerHost` — with a bucket per procedure, so `hello`
and `changes` keep their own. A refused push reaches the dialer as its
`error` event with `code` 429; it keeps its cursor and marks the peer
behind. What the hub's vector still lacks is pushed at the next sign of
life on the link (a page from the hub, an op to relay) or on `sync()` —
backed off after a recovery that failed. A push refused during the
handshake does not hold the `changes` subscription back: it opens anyway,
and the rest goes at the next push ([Hosting](./sync#hosting)). The wrpc
integration test runs exactly this recipe: a handshake push refused, the
feed open, the rest sent by a `sync()` once the window passed.

Retention bounds the log: `sync.retention.ops` / `.days` size it for the
longest outage a client may have — below the floor a client bootstraps,
which is one snapshot of its scopes.

## Presence

Who is online, who is editing what, where a cursor is — ephemeral state has
no place in a durable, replicated log. [`@alexify/syncom/presence`](./presence)
keeps it per node and the hub relays it through wrpc's rooms: a peer's
update comes in as the unit's `on.presence` event, checked (its own node, a
scope it asked for, `unit({ presence: { rate } })` updates a second, signed
under `'require'`) and goes to `syncom:<scope>` but the sender; the hub keeps
the newest state per node for `presence.timeout` and hands them to a newcomer
at hello. Nothing of it touches the log. Among [WebRTC](./webrtc) peers the
same updates travel over the mesh.

## Several tabs

Two tabs are two instances, and `open()` is exclusive per directory
([why](./storage#one-instance-per-directory)): the second tab sees
`code: 'LOCKED'`. The connection is easy to share — a SharedWorker running
wrpc's `WrpcClientProxy` holds one WebSocket, and every tab's
`connect(url, { worker })` goes through it — but the storage is not: a
proxied connection does not stop two storages from minting the same
sequence number. For v1, one tab owns the storage and syncs: the others
wait for the lock (`lock: 'wait'`) or route reads and writes to it through a
`BroadcastChannel` — there is no read-only open. A storage served from a
worker to its tabs is the follow-up.

## End-to-end encryption

wrpc's `createSealer` / `createOpener` (HPKE per message) work on a record's
fields today without any change here — seal in `beforeWrite`, open in
`afterRead` — with the consequences a CRDT implies: a register holding
ciphertext converges like any register, a counter cannot be sealed (its sum
needs the number), and an index, a unique key or a query over a sealed field
is impossible, since the catalog sees ciphertext. A key per scope is the
natural shape, and a follow-up.

[Signatures](./sync#signatures) are a different matter, and already there:
every op is signed by its origin and verified by every node that takes it —
about a tenth of a millisecond of CPU per op, which Node.js spends on libuv's
thread pool, so a hub's verification grows with `UV_THREADPOOL_SIZE` (4 by
default; the pool is shared with `node:fs` and DNS, so raise it on a hub that
takes many peers) — and a hub that runs `sync: { signatures: false }` to spare
itself the check still relays the signatures intact, since the fields are
opaque to it. A mesh in which every node is yours can run `'require'` end to
end.

## Observability

Every path emits through the injected OpenTelemetry writer
([telemetry](./telemetry)): `syncom.ops.received` by outcome,
`syncom.ops.rejected` by reason (the kind that held a field, `bound`,
`malformed`, `validation`, `scope`, `unreadable`, `forged`, `unsigned`),
`syncom.conflicts`, `syncom.ops.limited` by reason (`ops`, `bytes`, `rate`),
`syncom.replication.lag`, the push and bootstrap spans nested under wrpc's.
On the hub, those plus the `hello`, `refused`, `conflict`, `schema` and
`error` events are what a dashboard and an audit are built from — and
`op.actor` says who.
