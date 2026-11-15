---
title: Testing
description: Test code that uses syncom with a database in memory, a mesh of nodes in one process, a link that misbehaves on purpose, and settle().
---

# Testing

A test of an app built on syncom needs three things: a database that starts empty and leaves nothing on disk,
several nodes that sync without a network, and a way to know when they are done syncing.
`@alexify/syncom/testing` gives you all three. It is the same code this repository's own test suite runs on, and
it imports no test runner, so it works under `node:test`, Vitest, Jest or a browser harness alike. The examples on
this page use `node:test`.

## Open a database in memory

`memoryEngine()` keeps every database in the process, each under its `path`. Make one engine per test file (or
per test) and open as many databases on it as you like.

<<< @/examples/testing.mjs#memory

`logger: false` keeps syncom's log lines out of your test output. Everything else is an ordinary database: the
same collections, queries, plugins and errors as on disk, which is why a test on the memory engine tells you how
the app behaves in production. The [Memory](./storage-memory) page covers the engine itself.

A database reopened on the same engine and `path` finds its records again, so a test can close and reopen a
database to check what survives a restart. A new engine is a clean slate.

## Close the database whatever happens

A test that fails halfway leaves its database open, and the next test that opens the same path is refused with
`LOCKED`. `withDatabase(open, fn)` opens the database, hands it to `fn`, and closes it when `fn` returns or throws:

<<< @/examples/testing.mjs#with-database

It resolves to what `fn` returned. Pass it a function that opens the database (as here), a promise of one, or an
open database.

## Sync several nodes in one process

`createMesh(names, edges, options)` builds a small network: one database per name, each one hosting the sync
protocol, and a link for every edge. The edge `['phone', 'server']` means the phone dials the server, exactly as
`sync.addNode()` would over [WebSocket](./replication-websocket).

<<< @/examples/testing.mjs#mesh

You write `createStorage(name, options)` and the mesh calls it once per node. The `options` it hands you carry
the mesh's links (`sync.connect`) and must be spread into your own `createDatabase()` call; the engine, the
plugins and the schema are yours. Other options of `createMesh()`:

- `nodes` gives one node options of its own, such as an older schema: `nodes: { phone: { schema } }`.
- `sync` gives every node the same [sync options](./replication), such as `retention`.
- `scopes` names the [scopes](./partial-sync) a node dials for: `scopes: { phone: ['team:1'] }`.
- `unit` is what every node hosts, `{ access: 'public' }` by default.

The mesh answers `get(name)` (and `storages`, the databases by name), `links` by the url dialed
(`mesh.links.get('mem://server')` is the link of the last node that dialed the server), and `close()`, which
closes every database.

## Wait until the nodes agree

Sync is asynchronous: an insert returns before the other nodes have it. `settle(storages)` resolves once every
node holds the same ops and nothing is still in flight, so a read right after it sees the result. Never use a
fixed `setTimeout` instead; it is either too long or, on a slow CI machine, too short.

`settle()` polls every 10 ms and gives up after 5 seconds with an `Error` that lists each node's vector, which
tells you which node is behind. Change the limits with `settle(storages, { timeout, step })`. For anything else
worth waiting for, `waitUntil(predicate, { timeout, step })` polls your own condition until it is true.

## Simulate a slow or unreliable network

The link between two nodes of a mesh behaves as wrpc does at the boundary: arguments and results cross as JSON,
and the change feed runs as an async generator. The `link` option adds the hazards of a real network to every link:

<<< @/examples/testing.mjs#hazards

`latency` delays every call and every event by that many milliseconds, which exposes code that assumes a write
arrives at once. `duplicate` delivers a page of the change feed twice; syncom recognizes the second copy and
applies nothing from it. `prng(seed)` returns the same sequence of numbers for the same seed, so a randomized
test that fails can be run again with the same choices.

`drop` loses a page of the change feed on the way. A real WebSocket does not lose a message without closing, and
syncom does not fetch a lost page again, so a dropped page leaves the receiving node behind for good and
`settle()` times out. Use it to test what your code does when nodes never converge:

<<< @/examples/testing.mjs#drop

## Take a node offline and bring it back

`link.disconnect()` cuts a link as a dead socket would: calls fail with code 503 and the change feed stops. Writes
made meanwhile wait in the node's log. `link.reconnect()` restores it the way wrpc reconnects, re-opening every
subscription from the last event it delivered, and the nodes exchange what each is missing.

<<< @/examples/testing.mjs#offline

A link is made when its node first dials, so call `settle()` once before you reach for `mesh.links`. The link
also records what crossed it, in order, which helps when a test needs to check that a node did or did not talk
to another:

<<< @/examples/testing.mjs#calls

## Run on Deno and Bun

The repository's suite runs under Node.js. A smaller smoke test (a database in memory written and queried, two
nodes over the in-process link converging) also runs under Deno and Bun in CI, so the testing helpers work on
those runtimes as far as their Node.js compatibility carries `@alexify/syncom`.

## Coming from RxDB

RxDB tests run on its memory storage, the same idea as the memory engine here. What syncom adds is the network:
a mesh of nodes in one process with a link you can slow down, cut and restore, plus `settle()` to wait for
convergence, where an RxDB test of replication needs a server or a hand-made replication handler.

::: code-group

<<< @/examples/testing.mjs#memory [syncom]

<<< @/examples/rxdb/testing.mjs#memory [RxDB]

:::

<FromRxdb page="testing" :rows="['testing', 'memoryBackend', 'ci']" />

Every helper and option is listed in the [reference](../reference/api#testing-subpath).
