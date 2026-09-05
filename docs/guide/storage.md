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

## The explicit API

Every method addresses a record by its id. `insert()` generates one — a UUID by
default, or whatever `getId` returns.

```js
const id = await storage.insert({ title: 'Draft', hits: 0 });

await storage.has(id);                    // true
await storage.get(id);                    // { title: 'Draft', hits: 0 }
await storage.update(id, { hits: 1 });    // merge a partial change
await storage.set(id, { title: 'Final', hits: 1 }); // replace wholesale
await storage.delete(id);
```

`set()` and `update()` both emit an `update` event on any live `Record` for
that id, and append the change to the pending update log.

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

`saveData()` takes an `encrypted` flag. The record is encrypted with the
storage's own RSA public key and decrypted on read:

```js
await storage.saveData(id, { ssn: '...' }, { encrypted: true });
```

RSA-OAEP has a hard payload ceiling (a couple of hundred bytes at 2048-bit
keys), so this is for small secrets, not for whole documents.

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
await record.data();           // the full current object
await record.delete();
```

Properties are defined from whatever keys the record had when it was loaded;
`id` is reserved and never becomes a settable property.

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
├── keys/          public.pem, private.pem
├── blockchain/    <hash>.json per block, .blockchain.json holds the tail
├── data/          <id>.json per record: { data, encrypted, timestamp, block }
└── remote/        <host>.json per registered sync node
```

Every record names the block that committed it, which is what makes
[validation](./chain) possible.
