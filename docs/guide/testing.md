# Testing

`@alexify/syncom/testing` is what a test over syncom stands on, and what this repository's own suite runs on: the
memory engine, an in-process link that behaves as wrpc does at the boundary — with the hazards a real transport
has — a mesh of nodes from an adjacency list, and `settle()` for the moment it has gone quiet. It imports no test
runner: node:test, vitest or a browser's harness call it alike.

```js
const { createDatabase } = require('@alexify/syncom/all');
const { createMesh, settle, memoryEngine } = require('@alexify/syncom/testing');

const engine = memoryEngine();
const mesh = await createMesh(['A', 'B', 'C'], [['A', 'B'], ['C', 'B']], {
  createStorage: (name, options) => createDatabase({ ...options, path: name, engine, lock: false, logger: false }),
});
const id = await mesh.get('A').insert({ title: 'from A' });
await settle(mesh.storages);
await mesh.get('C').get(id); // { title: 'from A' } — A dialed B, C dialed B, B relayed
await mesh.close();
```

## A database in memory

`memoryEngine()` is the engine of [`@alexify/syncom/memory`](./backends#engines): one engine holds any number of
databases, each by its `path`, nothing on disk. In one process there is no other instance to lock against, so
`lock: false`; `logger: false` keeps a test's output to its own. `withDatabase(open, fn)` opens, runs `fn(db)` and
closes whatever `fn` does:

```js
const { withDatabase } = require('@alexify/syncom/testing');

const count = await withDatabase(
  () => createDatabase({ engine, path: 'solo', lock: false }),
  async (db) => {
    await db.insert({ n: 1 });
    return (await db.list()).length;
  },
);
```

## The mesh

`createMesh(names, edges, options)` makes a database per name and wires them: an edge `['A', 'B']` means A dials B
(`addNode({ url: 'mem://B' })`); every node hosts a unit and every manager is started before the mesh is answered.

| Option | What it is |
| --- | --- |
| `createStorage(name, options)` | Yours: `options` carries `sync.connect` (the mesh's links) and `autoStart: false` — spread it into `createDatabase()` with the engine, plugins and schema under test |
| `link` | Every link's hazards (below) |
| `sync` | Sync options for every node, under `connect` and `autoStart` — `retention`, `pageSize`, `scope` |
| `nodes` | Options for one node by name: `{ B: { schema } }` |
| `unit` | What every node hosts, `sync.unit(unit)`; `{ access: 'public' }` by default |
| `scopes` | The scopes a node dials for, by its name: `{ A: ['team:1'] }` |

The mesh answers `storages` (by name; `get(name)` is the same), `links` by the url dialed — `mesh.links.get('mem://B')`
is the link of the last node that dialed B; a host's `servers.get('B').links` holds every one — `units`, `connect`
(the function the nodes dial with) and `close()`, which closes every database.

## The link's hazards

`MemoryLink` is wrpc at the boundary: arguments and results cross as JSON, the `changes` feed runs as an async
generator, and a reconnect re-opens every subscription from the last event id it delivered — against a fresh
server-side client, so the host greets it again. Its options are what a real transport does to a protocol:

```js
const mesh = await createMesh(['A', 'B'], [['A', 'B']], {
  createStorage,
  link: {
    latency: 5, // ms on every call and event
    drop: (page) => page.ops?.length > 0 && Math.random() < 0.1, // a page lost on the way
    duplicate: (page) => page.ops?.length > 0, // a page delivered twice
  },
});
const link = mesh.links.get('mem://B');
link.disconnect(); // calls fail with code 503, feeds stop, `close` is announced
await link.reconnect(); // every subscription re-opened from its last event id, `reconnect` announced
link.calls; // ['syncom/hello', 'syncom/push', …] — what crossed
```

The hazard walk of this repository (`tests/suites/sync-engine.js`: drops, duplicates, a reconnect, a reopen) runs
over these options; an application's test over its own schema and plugins runs over the same boundary.

## Waiting

`settle(storages, { timeout, step })` resolves once every node's vector is the same and nothing is in flight — no
queue holds a turn, no peer has a page pending — three polls in a row (every 10 ms, 5 s at most). Vectors alone are
not enough: a peer's page moves the vector at the log append and lands its records after, so a read right then
could still find nothing. `sameVectors(storages)` is the first half on its own; `waitUntil(predicate, { timeout,
step })` polls anything else; `prng(seed)` gives the same numbers for the same seed, for a fuzz a failure can be
run again. A timeout is a plain `Error` — a test's failure, not a condition a program handles.

## Other runtimes

The suite is node:test's and runs under Node. A smoke of the package — a database in memory written and queried,
two nodes over the in-process link converging — runs under Deno and Bun in CI (`tests/smoke/smoke.js`, plain
`node:assert`); it is what their Node compatibility has to carry for `require('@alexify/syncom')` to work there.

## Checked how

`tests/testing.test.js` runs the examples above: the three-node mesh converges and `settle()` takes the Map, a dial
to a host that is not there is a `TypeError`, `settle()` rejects past its timeout where a link drops every page,
`withDatabase()` closes after a `fn` that threw. Every suite of the repository runs over the same link and mesh.
