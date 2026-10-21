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

```bash
npm install @alexify/syncom
```

## Opening a storage

`open()` is asynchronous: it generates or loads an RSA key pair, initialises
the chain and the operation log, and returns once the storage is ready to use.

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

`path` (or `name`) selects the directory; it defaults to `syncom`. Under it
syncom creates three subdirectories:

| Entry | Contents |
| --- | --- |
| `node.json` | this node's identity — the `origin` of every op it makes |
| `keys/` | `public.pem` / `private.pem`, generated on first open |
| `blockchain/` | one JSON file per block, plus `.blockchain.json` holding the tail hash |
| `data/` | one JSON file per record, each naming the block that committed it |
| `log/` | the operation log — what peers replicate from |
| `remote/` | one JSON file per registered sync node |

## Records

A `Record` is a live view of one stored object. Its properties are real
getters and setters: assigning to one stages a change and emits an `update`
event, and `save()` writes the accumulated delta.

```js
const record = await storage.record(id);

record.on('update', (data, delta) => {
  console.log('changed', delta);
});

record.email = 'ada@lovelace.dev';
console.log(record.delta()); // { email: 'ada@lovelace.dev' }
await record.save();
```

See [Storage](./storage) for collections, CAS writes and the explicit API.

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
