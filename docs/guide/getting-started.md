# Getting Started

`syncom` is a distributed data sync engine. It stores records on disk (or, in
the browser, in the origin-private filesystem or IndexedDB) and logs every write
as an op that its peers replicate, and every replica converges on the same records
without coordination. Every write can also be committed to a hash-linked chain,
so tampering is detectable. [Why syncom?](./why) says what it is for and when
something else fits better.

It has **no runtime dependencies**.

## Requirements

- **Node.js ≥ 22**, or any modern browser with OPFS and Web Crypto.

## Installation

syncom is not on npm yet: `0.0.1` is a development version, and there is no
release until the package does what it is meant to. Until then, depend on the
repository — a git dependency, or a workspace link. Once it is published:

```bash
npm install @alexify/syncom
```

## Opening a storage

`open()` is asynchronous: it generates or loads its two key pairs — RSA to
seal encrypted records, Ed25519 to sign ops, whose public key is the node id —
initialises the chain and the operation log, and returns once the storage is
ready to use.

```js
'use strict';

const { open } = require('@alexify/syncom');

const main = async () => {
  const storage = await open({ path: 'data' });

  const id = await storage.insert({ name: 'Ada', email: 'ada@example.com' });
  console.log(await storage.get(id)); // { name: 'Ada', email: 'ada@example.com' }

  await storage.update(id, { email: 'ada@lovelace.dev' });
  console.log(await storage.get(id)); // { name: 'Ada', email: 'ada@lovelace.dev' }
};

main();
```

`open()` takes one options object; `path` (or `name`) selects the directory,
and it defaults to `syncom`. Under it syncom keeps:

| Entry | Contents |
| --- | --- |
| `node.json` | this node's identity — the `origin` of every op it makes |
| `keys/` | `public.pem` / `private.pem` (RSA) and `sign-public.pem` / `sign-private.pem` (Ed25519), generated on first open |
| `lock.json` | while an instance holds the directory |
| `blockchain/` | one JSON file per block, plus `.blockchain.json` holding the tail hash (none with `chain: false`) |
| `data/` | one JSON file per record, each naming the block that committed it |
| `index/` | `catalog.json` — the record catalog, derived and rebuilt when missing |
| `log/` | the operation log — what peers replicate from |
| `remote/` | one JSON file per registered sync node, from the first `addNode()` |

[Storage](./storage#on-disk) lists the rest — `schema.json`, and `tags.json` and
`tags/` once a tag is taken.

## Records

A `Record` is a live view of one stored object. Its properties are real
getters and setters: assigning to one stages a change and emits an `update`
event, and `save()` writes the accumulated delta.

```js
const record = await storage.record(id);

record.on('update', (data, delta) => {
  console.log('changed', delta);
});

record.name = 'Ada Lovelace';
console.log(record.delta()); // { name: 'Ada Lovelace' }
await record.save();
```

See [Storage](./storage) for collections, CAS writes and the explicit API.

## Fields that merge

A field written with `insert()` or `update()` is a register: the last writer
wins. The other kinds are made by the calls that write them, and each merges
its own way when two nodes edit it at once:

```js
await storage.inc(id, 'views', 1);                      // a counter: increments add up
await storage.add(id, 'tags', ['draft', 'ideas']);      // a set: concurrent adds both keep
await storage.splice(id, 'body', 0, 0, 'Hello world');  // a text: merges by position
await storage.mark(id, 'body', 0, 5, 'bold', true);     // rich text over it
await storage.push(id, 'todo', ['write', 'review']);    // a list
await storage.treeMove(id, 'outline', 'intro');         // a tree: nodes that move
console.log(await storage.get(id));
// { name: 'Ada Lovelace', email: 'ada@lovelace.dev', views: 1, tags: ['draft', 'ideas'],
//   body: 'Hello world', todo: ['write', 'review'], outline: [{ id: 'intro', children: [] }] }
```

[Lists, text and trees](./lists) has the whole story, and [Sync](./sync#registers-counters-sets-lists-and-text)
how each kind converges.

## Reading the past

Every op is in the log, so a record's past reads back from it:

```js
const { versions } = await storage.history(id);         // newest first
const first = versions[versions.length - 1];
await storage.get(id, { at: first.eventId });           // the record as the first write left it
await storage.restore(id, first.eventId);               // back to it, with new ops that merge
```

[Versions and history](./versions) covers versions by stamp and vector, tags,
diff, an undo stack and branches.

## Verifying integrity

Every record carries the hash of the block that committed it. `validate()`
walks the chain backwards, re-hashing each block:

```js
await storage.validate({ last: 10 }); // true — the last 10 blocks are intact
await storage.validate();             // the whole chain
```

Reading a record that no longer matches its block throws rather than returning
the modified data. See [Blockchain log](./chain).

## Syncing with other nodes

Hand `open()` a way to reach a peer and register it; from then on writes flow
both ways and converge without coordination:

```js
const { createWrpcLink } = require('@alexify/syncom/wrpc');
const { WrpcClient } = require('@alexify/wrpc');

const storage = await open({
  path: 'data',
  sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
});
await storage.sync.addNode({ url: 'ws://hub.example.com:8000/api', token: 'secret' });
```

See [Sync](./sync) for the model — registers, counters, tombstones, the log —
and [wrpc transport](./wrpc) for hosting the other end.
