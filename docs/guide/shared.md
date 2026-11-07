# Several tabs

Two tabs over one IndexedDB, two windows of one Electron app over one SQLite
file, two workers of one process over one memory engine: several instances
over one database. `createDatabase()` is exclusive per directory
([why](./database#one-instance-per-directory)) — two instances minting the
same sequence number is the bug the lock exists for — so one of them leads and
the others follow. `@alexify/syncom/shared` is that arrangement, elected and
kept:

```js
import { createDatabase } from '@alexify/syncom';
import { idbEngine } from '@alexify/syncom/idb';
import { openShared } from '@alexify/syncom/shared';
import { createSharedChannel } from '@alexify/syncom/wrpc';
import { WrpcClient } from '@alexify/wrpc';

const shared = await openShared({
  createDatabase,
  engine: idbEngine({ name: 'app' }),
  path: 'app',
  schema,
  election: { locks: navigator.locks },
  channel: async () => createSharedChannel(await WrpcClient.connect('worker://app', { worker: sharedWorker.port })),
});

shared.on('leader', () => console.log('this tab leads'));
const id = await shared.insert({ $type: 'Task', title: 'from any tab' }); // through the leader, where this tab follows
const doc = shared.document(id); // follows the instance: re-read once after a failover
```

`openShared` takes what `createDatabase` takes — the engine must be one
several instances may open (`capabilities.shared`: IndexedDB, SQLite, the
memory engine, MongoDB) — and `createDatabase` itself, the one of the flavour
in use (the core's, `/all`'s): the subpath bundles nothing of the core, as
`/branch` opens through the parent's constructor.

## The leader and the followers

The **leader** is a full `Database`: it holds the lock, writes, dials and
hosts. Every **follower** is a `createDatabase({ readOnly: true })` over the
same engine: it reads what the leader lands and hears it through the engine's
change stream (IndexedDB's `BroadcastChannel`, the memory engine's listeners,
MongoDB's change stream), so `shared.get()`, a collection's queries and a live
`Document`'s `update` work on every tab; its writes go to the leader over the
channel, where they are the leader's writes — `shared.set()`, `shared.update()`,
every writer of the database's API, answered as the leader answers them: an id,
a refusal (`NOT_FOUND`, `INVALID_ID`, a validator's `OP_INVALID`) made again
with its code and fields.

What a follower reads is the record whole. A follower raises no `transaction`
event and runs no `observe()` — those are the leader's, as is replication:
`shared.sync` is the leader's `SyncManager` and `NOT_LEADER` on a follower,
which neither dials nor hosts. `shared.db` is the current instance for
anything else — `shared.db.Task.select(…)` — read-only on a follower.

## Collections, attachments, local documents

The same code must not fail by the election, so what a follower's database
refuses as `READ_ONLY` the facade forwards:

```js
const tasks = shared.collection('Task'); // a SharedCollection
const id = await tasks.insert({ title: 'x' }); // the id — on the leader too, never a Document
await tasks.update(id, { done: true });
const { success, error } = await tasks.bulkInsert(rows); // the verdicts, the errors made again
await tasks.select({ done: false }).fetch(); // the current instance's cursor

await shared.attachments.put(id, 'photo.jpg', bytes, { type: 'image/jpeg' });
const photo = await shared.attachments.get(id, 'photo.jpg'); // fetched through the leader where this tab lacks it
await shared.local.set('theme', { dark: true }); // forwarded; shared.local.get() reads this tab's
```

A `SharedCollection`'s readers (`get`, `select`, `count`, `findByIds`,
`distinct`, `countBy`, `document`) are the current instance's collection's,
asked at every call; its writers are the leader's — `insert`, `upsert` and
`insertIfAbsent` answer the **id** on either role (a `Document` does not cross
a wire), a bulk its `{ success, error }` with each error made again with its
code. `modify(id, fn)` and `remove()` are the leader's alone: a function does
not cross, and a write by query (`remove()`, a cursor's `update`/`delete`) is a
read-modify-write the leader makes — `NOT_LEADER` with a `hint` on a follower.
`shared.attachments.put` writes the blob into the shared store from either
role (a blob is content-addressed and outside the write set, so a follower's
put beside the leader is safe) and forwards the register; `get` reads this
instance's store and asks the leader to fetch what it lacks (`fetchBlob`: the
bytes land in the shared store, read again here); `remove` is a forwarded
`unset`. `shared.local.set(key, value)` and `delete` are forwarded as the full
key, `get`/`list`/`scoped` read this instance's; `set(key, fn)` is refused on
both roles, and there is no `observe` — a follower's local store hears no
leader's write, and a thing that would hear nothing is not offered.

A follower's `transact(fn)` is **recorded**: `fn` runs on the follower against
a recorder whose writers note the call and answer at once (`get`/`has` read
the follower), and the batch goes to the leader as one transaction. So `fn`
never reads what it wrote, and `insert()` is refused there — its id would be
the leader's, which `fn` cannot learn in time; `set(id, data)` with an id of
your own instead. The leader's `transact()` is the database's.

## The election

Leadership is Web Locks where the platform has them:
`election: { locks: navigator.locks }` requests `syncom:leader:<path>` in
exclusive mode, the grant resolves when the lock is free, and a grant outlives
nothing but its holder — a tab that closes or crashes lets go, and the next
request in line is granted. Without locks, a `BroadcastChannel`-shaped
`election.channel` runs a heartbeat: a candidate claims with its token and
waits one beat, a leader says `lead` every `heartbeat` ms (1000), a candidate
that hears no leader for `misses` beats (3) and no smaller claim in its round
leads, and two leaders settle by token (the smaller stays). The database's own
lock is the last word either way: an instance granted leadership opens the
database as the leader and tries again on `LOCKED` while the old holder lets
go. With neither locks nor channel the instance leads at once (`mode:
'alone'`).

`openShared` waits `grace` ms (50) for the grant before opening as a follower:
the first tab leads at once, the second follows without a pause. On a fresh
path the follower waits for the elected instance to write the identity
(`node.json`) — a heartbeat election takes `misses` beats to settle, and the
loser follows once it is there (`LEADER_LOST` with `reason: 'fresh'` past
`failover` ms). `openShared` never resolves with `db` null: a first open that
fails rejects and lets the election go. `election: { follower: true }` is an
instance that never leads (`mode: 'follower'`) — a tab beside a SharedWorker
that holds the election, see [the channel](#the-channel).
`waitForLeadership({ signal })` resolves when this instance leads;
`leader`, `isLeader()`, `mode` and the `leader`/`follower` events say which
it is.

## The failover

When the leader goes, the next instance is granted the lock and
**promotes**: it opens the database as the leader beside its follower (which
holds no lock), moves the facade to it, makes every live thing again and
closes the follower. It is the same node — the same `nodeId`, the same log and
vector, the same registry of peers — so the peers see a reconnect, never a new
node, and the new leader dials where the old one did. `generation` counts up;
the `rebind` and `leader` events say so.

Live things are made again: `shared.live((db) => stop)` runs over the current
instance and again over the next, `shared.document(id)` is a Document that
follows the instance (its `update` event, and once after a failover with the
data as the new instance reads it, delta `null`). A follower's write sent
while the leader went is tried again while a leader comes — `channel()` is
called again for a fresh channel — within `failover` ms (10 000); past it, or
when the channel answers nothing readable, `LEADER_LOST`. A write is carried as
a **call** — `{ id: '<token>:<n>', args, retry }`, the id the follower's
election token and a count — and the leader keeps the answers it gave (256 per
follower, 64 followers): a call whose answer was lost goes again with `retry`
and is answered from what the leader kept, in flight or done, never run
twice; a retry that reaches a leader which never saw the call (the leader
changed in between) is `CALL_UNKNOWN` there and `LEADER_LOST` here with
`maybeApplied: true` — read the record before writing again. A dial that
reached nobody, or a `NOT_LEADER` answer, marks nothing sent, so the next try
is a new call. Concurrent writes
waiting on a channel share one dial; a dial that fails sent nothing and is
tried again, as is a call the transport rejects (a `fetch`'s `TypeError`
among them) or a `NOT_LEADER`/`CLOSED` answer from an instance that follows
again or is going.

An instance that was elected but could not open the database — `LOCKED` past
the retries, the engine's error — reports `PROMOTE_FAILED` on its `error`
event (`attempt`, `cause`), **yields** the election so the next in line leads,
and asks for it again after a backoff (50 ms doubling to 5 s): it leads once
the database frees, and never holds a lock it cannot use. `close()` closes the
database first and lets the election go last, so the next leader's open never
finds the old lock still held.

## The channel

The channel is `{ call(method, payload) }`, anything that carries JSON both
ways — the payload a call `{ id, args, retry }`; the leader answers every call
as a value — `{ ok, value }` or `{ ok, error }` — so a refusal round-trips
whatever the wire does with a thrown error. A transport that knows a request
never left may say so with `sent: false` on the error it throws: the retry is
then free of the `retry` flag. The leader mounts its writers with `shared.serve()` (one procedure per
writer and `transact`, `access: 'session'` by default — the tabs' own, never a
router's public face), and the wrpc subpath wraps a `WrpcClient` as the
follower's channel. In a browser the leader's server runs where every tab can
reach it — a SharedWorker — and each tab's `connect(url, { worker })` opens a
port to it, which the worker attaches:

```js
// shared-worker.js — the leader's server; whichever tab leads, its writers are behind the one router.
import { Server, defineRouter } from '@alexify/wrpc';
let served = null; // the leading tab's `serve()`, set by the tab over its own channel to the worker
const procedure = (name) => ({ access: 'public', handler: (context, args) => served[name].handler(context, args) });
const server = new Server({ router: defineRouter({ 'syncom-db': Object.fromEntries(WRITERS.map((name) => [name, procedure(name)])) }) });
self.onconnect = (event) => {
  const [port] = event.ports;
  port.addEventListener('message', (message) => {
    if (message.data?.type === 'wrpc:connect') server.rpc.attachPort(message.ports[0]);
  });
  port.start();
};
```

The handshake — the tab posts `wrpc:connect` with a port, the worker attaches
it — is wrpc's; where the leader itself is the worker (its `openShared` runs
there), `served` is its own `serve()`. The same shape runs in Electron with
the main process leading and the renderers following over
`MessageChannelMain`. `tests/wrpc.integration.test.js` runs three tabs over
one memory engine through wrpc on a `MessageChannel`: the leader serves, a
follower writes through it, a failover keeps the port; `tests/shared.test.js`
runs the facade over the memory engine and the IndexedDB engine with an
in-process channel, and the elections on their own.

## What it costs

A follower is a second database over the same stores: its own cache and
catalog, built at its open and kept by the change stream. The election is one
lock request. A forwarded write is one round trip to the leader; a recorded
transaction one. Nothing of a follower touches the log.
