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
| `schema` | — | Entity definitions; each name becomes a collection (see below) |
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
it. A `getId` that is not a function is ignored and the default stands.

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

## On disk

```
data/
├── node.json      { id } — this node's identity
├── keys/          public.pem, private.pem
├── blockchain/    <hash>.json per block, .blockchain.json holds the tail
├── data/          <id>.json per record: { data, meta, encrypted, timestamp, block }
├── log/           the operation log (see Sync)
└── remote/        <url>.json per registered sync node
```

Every record names the block that committed it, which is what makes
[validation](./chain) possible. `meta` is the replication bookkeeping — per
field clocks, the reset watermark, the tombstone, the counters — and is what
lets two nodes' copies merge; a deleted record keeps its file as a tombstone.
