# Getting Started

`syncom` is a local-first data engine. It stores records on disk (or in the
browser's origin-private filesystem), commits every write to a hash-linked log
so tampering is detectable, and produces CRDT deltas that peers can merge
without coordination.

It has **no runtime dependencies**.

## Requirements

- **Node.js ≥ 22**, or any modern browser with OPFS and Web Crypto.

## Installation

```bash
npm install @alexify/syncom
```

## Opening a storage

`open()` is asynchronous: it generates or loads an RSA key pair, initialises
the chain, and returns once the storage is ready to use.

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

| Directory | Contents |
| --- | --- |
| `keys/` | `public.pem` / `private.pem`, generated on first open |
| `blockchain/` | one JSON file per block, plus `.blockchain.json` holding the tail hash |
| `data/` | one JSON file per record, each naming the block that committed it |
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

## What is not implemented yet

`storage.sync` registers and persists peer nodes, but **no transport is
implemented** — `sync.start()` is a no-op. See [Sync](./sync) for what exists
today.
