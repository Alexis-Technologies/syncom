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
const hub = await createDatabase({ path: '/var/lib/syncom', schema, sync: { connect } });
await hub.sync.addNode({ url: 'wss://hub-2.internal/api', scopes: ['*'] });
defineRouter({ syncom: hub.sync.unit({ access: 'session', authorize, limits, meta }) });
```

Two rules keep a hub mesh without a shared log simple. **Sticky sessions**:
a client's `changes` subscription names a position in *one* hub's log
(`<epoch>.<seq>`), so a load balancer must keep a client on the hub it
greeted; a client moved to another hub finds another epoch at hello, drops
its cursor and starts over there — that hub's whole retained log, or a
bootstrap once it has compacted — correct, just more expensive. **A hub
restart resumes**: the log's epoch is minted once, so clients of a restarted
hub pick up from their cursors without a snapshot, as long as retention still
covers them.

### A shared log

What a hub mesh alone does not give is one log every hub process serves
from. `sync.sharedLog` is that log: every op a hub accepts — its own writes,
a client's push, a joined snapshot — is appended to one topic (a batch an
entry, `pageSize` ops at most), every other hub applies from the topic what
it lacks, and `changes` is served from the topic, so a client's cursor is a
position in the shared log — the same on every hub, whose hello answers the
log's epoch (`shared:<topic>`) — and a client moved by the load balancer
resumes on the new hub without a bootstrap. The hubs need no edge between
them. The log is anything with wrpc's `BrokerLog` shape — `append`, `read`,
`parseId`; `isSharedLog()` checks it — so a wrpc broker's `.log` fits with
no adapter:

```js
// Hubs over one broker: Redis Streams here; @alexify/wrpc/broker/nats, /kafka, /amqp the same way.
const { createRedisBroker } = require('@alexify/wrpc/broker/redis');
const broker = createRedisBroker({ client: redis });
const hub = await createDatabase({ path: '/var/lib/syncom', schema, sync: { sharedLog: broker.log } });
defineRouter({ syncom: hub.sync.unit({ access: 'session', authorize, limits, meta }) });
```

`{ log, topic, inbox }` names the topic (`'syncom'`) and the inbox
(`<topic>.inbox`; `false` for none). wrpc's in-process `MemoryBroker` is the
same log in one process — `tests/wrpc.integration.test.js` runs two hubs over
its `log` behind real servers and moves a client between them, which resumes
from its cursor without a bootstrap. Without a broker, a MongoDB the hubs
already share carries the log: `mongoSharedLog()` of `@alexify/syncom/mongodb`
keeps a topic's entries in two collections, numbered by the topic's head
document, with a change stream (or a poll) as the tail — the writer hub and
its followers over one `mongoEngine()` database serve `changes` from it:

```js
const { mongoEngine, mongoSharedLog } = require('@alexify/syncom/mongodb');
const engine = mongoEngine({ client });
const sharedLog = mongoSharedLog({ client });
// The one writer: holds the database's lease, lands every op, appends what it lands.
const writer = await createDatabase({ path: 'hub', engine, schema, sync: { sharedLog } });
// A follower in another process: reads the records as the writer lands them, hosts from the log.
const follower = await createDatabase({ path: 'hub', engine, schema, readOnly: true, sync: { sharedLog } });
defineRouter({ syncom: follower.sync.unit({ access: 'session', authorize }) });
```

A **read-only hub** — a follower, or a writer whose lease was lost — hosts
over the shared log and nowhere else: its hello answers the vector as the log
moved it (a shadow the topic keeps current), its feed comes from the log, and
a client's push is held to that vector and forwarded to the **inbox**, which
a hub that writes consumes, lands and relays to the topic (the push answers
`forwarded: true` with the vector moved past what went in; what the writer
then refuses — a forged op, a record out of scope — the writer reports, and
the next hello sets the client straight). It serves no **snapshot** (403
`READ_ONLY`): its shadow runs ahead of its engine, and a page of it could lack
what the vector claims — so the load balancer's rule is that a client with no
cursor lands on a hub that writes, and follows on any hub from then on (the
epoch is the log's). Without an inbox a read-only hub refuses a push with 503
(`READ_ONLY`). Several writers over one inbox each land every entry of
it — correct, wasteful: a mesh of writers needs no inbox (`inbox: false`),
one writer and its followers need one.

A hub reads the log **once**, however many clients follow it: its consumer's
read serves every `changes` feed from the entries it passed last (a ring of
1 024), and only a feed whose cursor fell behind the ring reads the log its
own way until it catches up — a thousand idle followers cost the log one tail.

A hub **joins** the log with its state: everything its log retains goes to
the topic first (what it compacted reaches the others through a snapshot of
it — dial it once; a log compacted past the watermark is told once, `lost`,
and what it retains still goes). A **fresh client** of a shared-log hub bootstraps: a
`changes` subscription with no cursor is told so, and the snapshot's first
page is positioned at a marker the hub appends — behind every op it offered
to the topic so far — and its consumer passes, so nothing lands between the
pages and the cursor; the page's `vector` is what the hub's reads reflect
(every op announced, none merely reserved in its log), so the client takes
as seen nothing a page could lack. While the relay is behind the snapshot is
refused (503 `SHARED_LOG`, `detail: 'behind'`) until it recovers. **Failures** are
`SHARED_LOG_FAILED` on the manager's `error` event, with a `reason`: an
append that failed (`append`, once per run) is appended again — everything
the log holds above the **watermark**, the last position of this hub's log
every op at or below which is in the topic (moved only by a whole run of
appended positions, never by a position still landing) — once the broker
answers, and every start does the same, so a hub stopped or closed with ops
waiting appends them at its next start (`stop()` waits `stopWait`, 5 s, for
an append in flight, then lets go of it); a
cursor the log trimmed past, or another log's (`gone`), is read from the
oldest entry, and what fell between is a gap of its streams until a bootstrap
from another hub fills it (`addNode` a hub, once); an entry the engine
refuses — the medium down, a lease late, a group the log would not take — is
tried again, backed off (`apply`, told once per run; `sync.shared().retrying`),
until it lands, while one a rule refuses three times — a hook that throws, a
bug — leaves its topic `stuck` (`sync.shared().stuck`) and nothing past it is
taken until `sync.stop()` and `start()`. `sync.shared()`
is the cursors, the watermark (`appended`, and `covered`: the positions
above it known to be in the topic) and the counts. A **hole** — a position
the log handed out whose entry never came (`mongoSharedLog`: a crashed
appender's number) — is told (`hole`, with the id) and passed; the appender's
own recovery appends what it carried once it is back. Retention is the log's —
a broker's `maxEntries`, `mongoSharedLog({ retention: { maxEntries, topics } })`
or `trim()` — and a client whose cursor was trimmed bootstraps; name the
topics retention trims where an inbox is in play: the writer trims the inbox
past its cursor itself (`trimBefore`), so what a follower forwarded is never
dropped before it landed.

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

Two tabs are two instances, and `createDatabase()` is exclusive per directory
([why](./database#one-instance-per-directory)): the second tab sees
`code: 'LOCKED'`. [`@alexify/syncom/shared`](./shared) is the arrangement:
one tab leads — a full database that writes, dials and hosts — and the others
follow as read-only databases over the same engine, hearing the leader's
writes through the engine's change stream and writing through the leader over
a channel (wrpc on a SharedWorker's port); the leader gone, the next tab is
granted the lock and leads with the same node id and log. Replication is the
leader's alone. A storage served from a worker to its tabs is the
follow-up.

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
