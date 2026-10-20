# Storage

`Storage` is the entry point. `open(options)` returns a promise — key
generation and chain initialisation happen before it resolves.

```js
const { open } = require('@alexify/syncom');

const storage = await open({ path: 'data' });
```

| Option | Default | Meaning |
| --- | --- | --- |
| `path` | `'syncom'` | Directory (or OPFS path) holding keys, chain, data and peers |
| `name` | — | Alias for `path` |
| `fsi` | `node:fs` / OPFS | The backend — any object with `read`, `write`, `exists`, `remove`, `list` (see [Backends](../reference/api#backends)) |
| `durable` | `false` | fsync after every write, where the backend can (`node:fs`); OPFS and memory are as durable as they are |
| `lock` | `'fail'` | One instance per directory: `'fail'` rejects a second `open()` (`code: 'LOCKED'`), `'wait'` waits, `false` leaves it to you ([see below](#one-instance-per-directory)) |
| `cache` | `{ max: 5000 }` | How many entries stay in memory; a live `Record` pins its own ([see below](#the-catalog-and-the-cache)) |
| `integrity` | `'verify'` | `'lazy'` trusts a record file on the cold read instead of re-verifying it against its block |
| `chain` | `true` | `false` keeps no [chain](./chain#through-storage) — a hub that only replicates has nothing to audit; two file writes less per record, reads lazy, `validate()` rejects with `code: 'NO_CHAIN'` |
| `catalog` | `{ flushEvery: 64 }` | How often the record catalog is persisted; the log catches up the rest |
| `actor` | — | Who writes — stamped on every op as `actor`: a string, or a function asked per write ([see Sync](./sync#operations)) |
| `schema` | — | Entity definitions: collections, their validators and indexes ([see below](#collections)); `version` and `snapshot` ([see below](#schema-versions)) |
| `validator` | — | Compiles entity schemas that are plain objects without `~standard` ([see below](#validation)) |
| `getId` | `crypto.randomUUID()` | Id generator for `insert()`; sync or async ([see below](#custom-identifiers)) |
| `logger` | `console` | A Console or pino-shaped logger, or `false` for silence |
| `encrypted` | `false` | Encrypt every record at rest by default ([see below](#encryption-at-rest)) |
| `sync` | — | Replication: `connect`, `scope`, `retention`, … — see [Sync](./sync#options) |
| `hooks` | — | `beforeWrite`, `afterRead`, `beforeApply`, … — see [Hooks and events](./hooks) |

## The explicit API

Every method addresses a record by its id. `insert()` generates one — a UUID by
default, or whatever `getId` returns.

```js
const id = await storage.insert({ title: 'Draft' });

await storage.has(id);                    // true
await storage.get(id);                    // { title: 'Draft' }
await storage.update(id, { status: 'review' }); // set some fields
await storage.update(id, { status: 'done' }, { actor: 'ada' }); // … and say who
await storage.inc(id, 'views', 1);        // add to a counter field
await storage.set(id, { title: 'Final' }); // replace wholesale — status and views are gone
await storage.list();                     // every live id
await storage.delete(id);
await storage.purge(id);                  // forget it for good — see below
await storage.close();                    // stop replication, seal the log
```

Every one of these is an **operation**: applied here, written to the
[log](./sync#the-log), announced as a `change` event, and replicated to peers
when a transport is configured. `set()`, `update()` and `inc()` also emit an
`update` event on any live `Record` for that id.

::: tip Registers and counters
A field written with `insert()`, `set()` or `update()` is a *register* — last
writer wins. A field created with `inc()` is a *counter* — increments add up
across nodes. A field cannot be both: `update()` on a counter and `inc()` on a
register throw. See [Sync](./sync#registers-and-counters).
:::

### Compare-and-swap

`swap()` writes only if the fields you name still hold the values you expect,
which is how two writers avoid clobbering each other:

```js
const ok = await storage.swap(id, { hits: 2 }, { hits: 1 });
// ok === false if hits was no longer 1 — nothing was written
```

The comparison runs inside the mutation queue, against the record as it reads
(the lens applied, the read hooks not run), so two concurrent swaps on the same
expectation cannot both pass. An absent record rejects.

### Purge

`delete()` leaves a tombstone, and the record's history stays in the log —
that is what lets a peer that was away catch up. `purge(id)` is the other
thing: the record is gone for good. It is a `purge` op, which wins over
every other op at any stamp (a later write does not revive it, nor does a
concurrent one on another node), and a **scrub** of every entry of the id
in this node's log — their `data`, `meta`, `key` and `value` are stripped,
in memory and in the files, with the position, origin and stamp kept so the
vector and a resuming peer are unaffected. A peer that receives the purge
scrubs its own log the same way, and so does any peer that receives
anything else about that id afterwards. The chain keeps hashes only. A
purged record is listed nowhere, reads as `null`, and a `Record` of it reads
`null` too.

```js
await storage.purge(id);          // nothing of it left here
await storage.purge(id, { actor: 'dpo' });
```

Two limits. Scrubbing rewrites a log file in place — no backend has a
rename — so a crash in the middle tears it, and a peer resuming through it
bootstraps instead; `purge()` is idempotent, so run it again. And what a
peer that never comes back holds is theirs.

### Custom identifiers

Pass `getId` to replace UUIDs with ULIDs, CUID2s, nanoids or ids minted by your
own server. The package has no runtime dependencies, so the generator is yours
to install and supply:

```js
const { ulid } = require('ulid');

const storage = await open({ path: 'data', getId: () => ulid() });
const id = await storage.insert({ title: 'Draft' });
// 01ARZ3NDEKTSV4RRFFQ69G5FAV — lexicographically sortable by creation time
```

The generator takes no arguments and may be asynchronous — `insert()` awaits
it either way:

```js
await open({ path: 'data', getId: async () => (await fetch('/next-id')).text() });
```

`Storage.generateId()` is the default generator, should you want to fall back to
it. A `getId` that is not a function is refused at `open()`.

**Ids are file names.** A record is written to `data/${id}.json`, on every
platform, so an id is letters, digits, `.`, `_`, `-` and `@`, not starting
with a dot, 128 characters at most — UUIDs, ULIDs, CUID2s and nanoids all
qualify. Anything else is refused with a `TypeError` (`code: 'INVALID_ID'`)
before anything is written: from `insert()` (naming `getId`), from `set()` and
the other writers, and from a peer — whose op is then counted as `malformed`
and never logged. `get()` and `has()` answer `null` and `false` for such an id.

One thing the engine does not check for you: **ids are matched against string
fields.** A `Record` turns any string field whose value is a known id into a
[reference](#references). Short, guessable ids raise the odds of an accidental
match; UUIDs, ULIDs and CUID2s do not.

### One instance per directory

Two storages over one directory would both read the log's vector and both
mint the next sequence number — the same number for two different ops, which
every peer drops as a duplicate. So `open()` holds the directory: through the
Web Locks API in the browser (released when the tab dies), through
`<path>/lock.json` with the process id elsewhere (stale once that process is
gone, or after 30 minutes when there is no way to tell).

```js
const a = await open({ path: 'data' });
await open({ path: 'data' });                   // Error, code 'LOCKED'
await open({ path: 'data', lock: 'wait' });     // resolves once `a` closes
const b = await open({ path: 'data', lock: false }); // yours to coordinate
```

Two browser tabs are two instances: with the default `'fail'` the second tab
sees `LOCKED` and must work through the first (a SharedWorker that owns the
storage, say) or read-only. `close()` releases the lock; a crash releases it
in the browser and leaves a stale file elsewhere, which the next open takes
over. The lock is per machine — on a shared network filesystem, coordinate
yourself and pass `lock: false`.

### The catalog and the cache

`snapshot()` pages over the catalog too — it keeps a row for every entry with a
file, tombstones included, so a bootstrap never lists the data directory.
`list()` and `hasRecord()` answer from the **catalog**: every live record's
id, collection and indexed field values, in memory, kept up to date by every
write — local or a peer's — and persisted as `index/catalog.json` stamped
with the log position it reflects (every `catalog.flushEvery` changes, and
at `close()`). A reopen reads it back and re-reads only the records the log
changed since the stamp; when the log cannot say — a first open, a stamp
from another epoch or below the retention floor, other indexes — the
catalog is rebuilt from one scan of `data/`. It is derived state: delete the
file and the next open rebuilds it.

The **cache** holds the last `cache.max` entries read or written, evicting
the oldest; a record with a live `Record` is never evicted. What leaves the
storage leaves as a **copy**, as JSON — the value `get()` returns, a cursor's
rows, a `Record`'s data — and what comes in (`set()`, `update()`) is copied the
same way, so editing an object on either side of the call changes nothing in
the cache, the log or the next write's base. `getCachedData()` and `snapshot()`
hand out the raw objects, for callers that know not to touch them. A cold read re-verifies the record against the chain block
that committed it; `integrity: 'lazy'` trusts the file instead — the choice
for a browser rebuilding a large catalog, where that verification is one
hash and two reads per record. `storage.validate(id, data, block)` is still
there for a check on demand.

### Health

`storage.stats()` is what an operator reads at runtime, from memory: whether
the storage is closed, how many writes wait on the mutation queue, the cache
(`size`, `max`, `pinned` by live Records), the catalog (`entries`, tombstones
included, and `dirty` puts since the last save), the log (`length`, `floor`,
`next`, `epoch`, `segments`, `latestTs`), the chain's `tail` (or `null` under
`chain: false`) and the lock `mode` (or `null` under `lock: false`). The
[sync manager](./sync#lifecycle-and-events) adds `peers()`, `hosted()` and the
`log` event; [telemetry](./telemetry) adds the gauges.

### Encryption at rest

Open the storage with `encrypted: true`, or pass the flag per write:

```js
const vault = await open({ path: 'vault', encrypted: true });
await vault.insert({ ssn: '...' });                       // sealed on disk

await storage.insert({ ssn: '...' }, { encrypted: true }); // one record, in a plain storage
await storage.saveData(id, data, { encrypted: true });
```

A record is sealed with a fresh AES-256-GCM key, and that key is wrapped with
the storage's RSA-OAEP (SHA-256) public key — the same envelope on Node.js and
in the browser, so ciphertext and keys move between the two. There is no size
ceiling. The key pair lives in `<path>/keys/`, unprotected: whoever can read
the directory can read the records.

Encrypted records are **local**. No peer holds this node's private key, so
they produce no operations, never appear in a snapshot, and `inc()` on one
throws — `update()`, `set()` and `delete()` still work, they simply stay
here. A record never changes kind: writing an encrypted record over a
replicated one (or the reverse) is refused.

## Records

`storage.record(id)` returns a live `Record`. It is cached per id, so two
calls for the same record return the same object — and therefore the same
event listeners.

```js
const record = await storage.record(id);

record.on('update', (data, delta) => {
  console.log(delta); // { title: 'Final' }
});

record.title = 'Final';        // stages the change and emits
record.delta();                // { title: 'Final' }
await record.save();           // writes, then clears the delta
await record.inc('views', 1);  // a counter, through the record
await record.data();           // the full current object
await record.delete();
```

Properties are defined from whatever keys the record had when it was loaded;
`id` is reserved and never becomes a settable property.

A record also follows changes made **elsewhere** — `storage.update()` in the
same process, or an op from a peer: its properties are refreshed, `update`
fires with the delta, and edits staged but not yet saved stay on top. A
record deleted elsewhere reports `update` with `null` data.

### References

When a stored string happens to be the id of another record that storage
already knows about, reading it back gives you a `Reference` rather than the
raw string. `reference.record()` resolves it:

```js
const post = await storage.record(postId);
const author = await post.author.record();
```

## Collections

Pass a `schema` and every entity name becomes a collection on the storage
object. Records inserted through a collection carry a `$type` field naming it.

```js
const storage = await open({
  path: 'data',
  schema: { entities: { Post: {}, Author: {} } },
});

const post = await storage.Post.insert({ title: 'Hello' });
post.title;                         // 'Hello'
await storage.Post.get(post.id);    // { title: 'Hello', $type: 'Post' }
await storage.Post.update(post.id, { title: 'Hi' });
await storage.Post.delete(post.id);
```

`entities` may be a plain object or a `Map`. Without a schema the storage has
no collections and you address records by id only.

An entity definition is `{ schema?, idField?, validate?, index?, unique?, fields? }`;
`{}` is a bare collection. `schema` validates the records ([below](#validation)),
`idField` names the key the id is handed to the validator under, `index` and
`unique` — explicit, or read off a metaschema schema's `indexes` and
`unique: true` fields — are what [queries](#queries) key on, and `fields` is
free-form notes kept as given. Anything else is a `TypeError` at
`open()`: a definition with a typo is a validation that silently never runs.

`$type` is the record's collection and never changes. `storage.set()` without
it keeps it, `Collection.set()` stamps its own, a write that would change it
throws, and `Collection.update()` refuses a delta that names it. A record
outside any collection may join one, and a deleted record may be reborn in
another.

```js
await storage.Post.set(post.id, { title: 'Replaced' }); // { title: 'Replaced', $type: 'Post' }
await storage.set(post.id, { title: 'Again' });          // keeps $type: 'Post'
await storage.Author.set(post.id, { name: 'x' });        // TypeError: $type is immutable
```

### Queries

The full guide is [Queries](./query); the shape, in short.
`collection.select(query)` is a cursor: build it, then `fetch()`, `count()`,
`one()`, iterate it, or `watch()` it. The query is Mango-shaped —
`{ field: value }` is equality (a dotted path reaches into the record, an
array field holds a scalar value), `{ field: { $op } }` the operators `$eq`,
`$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`
(with `$options`), and `$and` / `$or` / `$not` nest. A malformed query is a
`TypeError` at `select()`.

```js
const storage = await open({
  path: 'data',
  schema: { entities: { Project: { index: ['orgId'], unique: ['slug', ['orgId', 'name']] } } },
});

await storage.Project.insert({ orgId: 'o1', name: 'Alioth', slug: 'alioth', stars: 3 });
await storage.Project.insert({ orgId: 'o1', name: 'Vega', slug: 'vega', stars: 7 });

await storage.Project.select({ orgId: 'o1', stars: { $gte: 5 } }).fetch();
// [{ id: '…', orgId: 'o1', name: 'Vega', slug: 'vega', stars: 7, $type: 'Project' }]
await storage.Project.select({ orgId: 'o1' }).order('name').limit(10).offset(0).projection(['name']).fetch();
// [{ id: '…', name: 'Alioth' }, { id: '…', name: 'Vega' }]
await storage.Project.count({ orgId: 'o1' }); // 2
await storage.Project.select({ slug: 'vega' }).one(); // the record, or null

const stop = storage.Project.select({ orgId: 'o1' }).order('name').watch((rows) => render(rows));
```

Rows are the records as they read (the lens applied, `$type` included)
under their `id`; `projection(fields)` keeps only those (a dotted field comes
back under its dotted name), `filter(fn)` takes a predicate over the loaded
row, `order(field)` / `desc(field)` sort by any field — nothing first, then
booleans, numbers, strings — stably, and `offset` / `limit` cut after the
sort. A cursor does not run the read hooks: like `snapshot()` and `swap()`,
it reads the records themselves.

The entity's `index` and `unique` fields are what the catalog keeps: a query
whose fields, order and projection are all indexed — and has no `filter` —
is answered from the catalog alone, with no record read; an equality on an
indexed field narrows every other query to its posting list before the
records are read. `watch(listener)` runs the cursor now and again after
every change to the collection (one run per batch of changes), until the
returned function is called; a failing run goes to `onError` or the logger.

A `unique` key — a field, or a composite — is refused on a local write with
a `ValidationError` whose issue has `code: 'unique'` and `conflict`, the id
holding the key. Two nodes writing the same key at once cannot be refused:
both records arrive, both are kept, and the `conflict` event
`{ kind: 'unique', entity, fields, id, other, op }` names them — the
application decides which yields.

### Validation

The full guide is [Schema and validation](./schema); the shape, in short.
Give an entity a `schema` and every write to its collection — `insert()`,
`set()`, `update()`, `inc()`, a `Record.save()` — is validated as the whole
record the write leaves behind, before anything is stamped, logged or written.
Three shapes are understood, and the package requires none of them:

- a **Standard Schema** — anything with a `~standard` property: an entity of a
  metaschema `Model`, a zod, valibot or arktype schema;
- a **function** — an ajv-compiled validator (`false` plus `fn.errors`), or any
  function that throws on a bad value and returns the value (or nothing) on a
  good one;
- a **plain object** compiled through `open({ validator })` — a JSON Schema or
  TypeBox object handed to `validator.compile(schema, { entity })`; an Ajv
  instance fits as it is.

```js
const { Model } = require('@alexify/metaschema');

const model = new Model(
  {},
  new Map([
    [
      'Project',
      {
        Registry: {},
        orgId: 'string',
        name: { type: 'string', aliases: ['title'] },
        slug: 'string',
        'desc?': { type: 'string', default: '' },
      },
    ],
  ]),
);

const storage = await open({
  path: 'data',
  schema: { entities: { Project: { schema: model.entities.get('Project') } } },
});

const project = await storage.Project.insert({ title: 'Alioth', slug: 'alioth', orgId: 'org1' });
await storage.get(project.id);
// { name: 'Alioth', slug: 'alioth', orgId: 'org1', desc: '', $type: 'Project' }

await storage.Project.insert({ name: 'x' });
// ValidationError: Project failed validation at orgId: is required (+1 more)
//   error.issues → [{ path: ['orgId'], message: 'is required', code: 'required' }, { path: ['slug'], … }]

await storage.check('Project', { title: 'Alioth', slug: 'alioth', orgId: 'org1' });
// { name: 'Alioth', slug: 'alioth', orgId: 'org1', desc: '' } — validated, nothing written
```

What the validator returns is what is written and replicated: the defaults it
filled, the aliases it resolved (`title` became `name`), the keys it stripped —
taken as JSON, so a `Date` a decoder produced is stored as the string it
serializes to. A failed write rejects with a `ValidationError` — `code:
'VALIDATION_FAILED'`, `entity`, and `issues` as `[{ path, message, code? }]`,
with `cause` when the validator threw something of its own — and leaves nothing
behind. `storage.check(entity, data)` runs the same validator without writing.

The validator sees the record without `$type` and with its id under `idField`:
`id` by default; metaschema's `<entityName>Id` when the schema's fields have
that (an entity of a `Model` needs no configuration); nothing at all (`false`)
for a schema that shows its fields and has neither, such as a metaschema
struct. Set `idField` to override. The id is dropped from the validator's
output again. A schema you only want read, not run — one from
`@alexify/metaschema/definition`, say — takes `validate: false`.

Two things to know about `update()`:

- it is validated as the whole record it leaves, so a required field missing
  from the delta is fine as long as the record has it;
- it stays a `set` op: of what the validator returns, only the keys the delta
  named (in their validated form) and the keys the record did not have (a
  default, an alias target) are written. Write a field by its own name, not an
  alias — a delta under an alias of a field the record already has changes
  nothing, and the alias key an older record holds stays until a whole-record
  write replaces it.

A peer's op is validated here too, but never rewritten: an op that would leave
the record invalid under this node's schema is skipped exactly like a
[`beforeApply` hook returning `false`](./hooks#skipping-a-peers-op) — logged,
relayed, replay-safe — and reported through the `error` event with
`error.entity` and `error.issues`. Give every node the same schema and every
node reaches the same verdict.

### Schema versions

`schema.version` (a positive integer, `1` by default) is stamped on every op
this node makes as `v`, and a record remembers the version of its last
whole-record write as `meta.v` — what tells a node on another version which
shape a record is in. `schema.snapshot` is any JSON that describes the
schema — metaschema's `model.toJSON()`, whose key order is deterministic —
and is hashed:

```js
const storage = await open({
  path: 'data',
  schema: { version: 2, snapshot: model.toJSON(), entities: { /* … */ } },
});

storage.schemaInfo;
// { version: 2, hash: '9f3c…', previous: null }
```

`schema.json` in the directory remembers the version and hash it last ran.
When they differ at open, `schemaInfo.previous` holds what it was — an
upgrade to run migrations after, a snapshot change of the same version, or a
downgrade (logged as a warning) — and is `null` otherwise. Peers exchange
`{ version, hash }` in [hello](./sync#schemas): the same version with another
hash is reported as drift.

### Reading across versions

Nodes on different versions keep working together. A record written under an
older version is read through a **lens** — nothing is rewritten, the view is
computed once per cached entry — in two steps:

1. the **migrations**: `migrations` is keyed by the version each one migrates
   *to* (`2` takes a record from 1 to 2), either storage-wide `{ up }` or per
   entity `{ Post: { up } }`; `up(data, { entity, id, from, to })` gets the
   record without `$type` and returns it as it is under `to`;
2. the entity's **Standard Schema validator**: its aliases and defaults are a
   rename and a fill for free, so a metaschema entity with
   `name: { aliases: ['title'] }` and `'desc?': { default: '' }` reads a v1
   `{ title }` as `{ name, desc }` with no migration written. A validator that
   refuses the record leaves step 1's result and logs at debug.

`lens` picks the steps: `'both'` (default), `'migrations'`, or `'validate'`
(refused together with `migrations`).

```js
const storage = await open({
  path: 'data',
  schema: {
    version: 2,
    entities: { Post: {} },
    migrations: { 2: { Post: { up: ({ title, ...rest }) => ({ ...rest, name: title }) } } },
  },
});

await storage.get(oldPost); // { name: 'Hello', $type: 'Post' } — on disk it is still { title: 'Hello' }
```

Writes go through the lens too: `update()` validates the record as it reads,
and carries only the keys that changed. `get()`, `Record`, `swap()` read the
view; `snapshot()` and `getCachedData()` read the raw data, and so does
replication — a peer on the older version sees the record exactly as it was
written.

`migrate()` rewrites what the lens only reads: every record of an older
version becomes a whole-record write of its view (the version with it), with
its counters added back. Run it on one node after an upgrade; peers receive
ordinary ops. It is idempotent, and `{ entities }` limits it to those
collections:

```js
if (storage.schemaInfo.previous) {
  await storage.migrate(); // { migrated: 12, counters: 3 }
}
```

The other direction — an op from a **newer** version — is `ahead`:
`'apply'` (default) applies it as it is, unvalidated (registers are
forward-tolerant; the validator does not know the shape), and emits `schema`
`{ kind: 'ahead', op, held: false }`; `'hold'` keeps it in the log, skipped
and flagged with its version, relays it, and applies it at the first open
that runs that version — `schemaInfo.held` is then `{ replayed, lost }`,
`lost` counting held ops that retention dropped before the upgrade. A hold
needs `sync.retention.ops` of 1000 or more, and a directory that ran a newer
version cannot be reopened with `'hold'` on an older one.

## On disk

```
data/
├── node.json      { id } — this node's identity
├── keys/          public.pem, private.pem
├── blockchain/    <hash>.json per block, .blockchain.json holds the tail
├── lock.json      { pid, id, since } — while an instance holds the directory (not with Web Locks)
├── schema.json    { version, migrated, hash } — the schema this directory last ran
├── index/         catalog.json — the record catalog as of a log position (derived; rebuilt when missing)
├── data/          <id>.json per record: { data, meta, encrypted, timestamp, block }
├── log/           the operation log (see Sync)
└── remote/        <url>.json per registered sync node
```

Every record names the block that committed it, which is what makes
[validation](./chain) possible. `meta` is the replication bookkeeping — per
field clocks, the reset watermark, the tombstone, the counters — and is what
lets two nodes' copies merge; a deleted record keeps its file as a tombstone.
