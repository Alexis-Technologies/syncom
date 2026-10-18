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
await storage.inc(id, 'views', 1);        // add to a counter field
await storage.set(id, { title: 'Final' }); // replace wholesale — status and views are gone
await storage.list();                     // every live id
await storage.delete(id);
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

Two things the engine does not check for you:

- **Ids become filenames.** A record is written to `data/${id}.json` with no
  sanitising, so a generator that can emit `/`, `\` or `..` will break the
  write. Keep ids to filename-safe characters.
- **Ids are matched against string fields.** A `Record` turns any string field
  whose value is a known id into a [reference](#references). Short, guessable
  ids raise the odds of an accidental match; UUIDs, ULIDs and CUID2s do not.

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
`unique: true` fields — are checked at open (no query reads them yet), and
`fields` is free-form notes kept as given. Anything else is a `TypeError` at
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

### Validation

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
├── schema.json    { version, migrated, hash } — the schema this directory last ran
├── data/          <id>.json per record: { data, meta, encrypted, timestamp, block }
├── log/           the operation log (see Sync)
└── remote/        <url>.json per registered sync node
```

Every record names the block that committed it, which is what makes
[validation](./chain) possible. `meta` is the replication bookkeeping — per
field clocks, the reset watermark, the tombstone, the counters — and is what
lets two nodes' copies merge; a deleted record keeps its file as a tombstone.
