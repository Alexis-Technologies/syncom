# Attachments

A record is JSON. The bytes beside it — a photo, a PDF, an export — are an
**attachment**: kept in the engine's `blobs` store under their SHA-256, and
named on the record as a field that replicates like any other:

```js
import { createDatabase } from '@alexify/syncom';
import { attachments } from '@alexify/syncom/attachments';

const db = await createDatabase({ path: 'data', plugins: [attachments()] });
const id = await db.insert({ $type: 'Task', title: 'with a photo' });

const entry = await db.attachments.put(id, 'photo.jpg', bytes, { type: 'image/jpeg' });
// → { digest: '9f86d0…', type: 'image/jpeg', length: 48213 }
const photo = await db.attachments.get(id, 'photo.jpg'); // { bytes, type, length, digest }
await db.attachments.list(id); // [{ name: 'photo.jpg', digest, type, length }]
await db.attachments.remove(id, 'photo.jpg');
```

`put` writes the bytes to the blobs store by their digest — the same bytes
under two names, or on two records, are one blob — and sets the register
`_attachments/<name>` on the record to `{ digest, type, length }`: an ordinary
`update`, logged, replicated, undone and tagged like any field. The record
reads with `_attachments: { 'photo.jpg': { … } }`; a schema that validates the
record allows the field. `remove` is an `unset` of that register; the bytes
stay in the store (another name may share them). `has(id, name)` says whether
this node holds the bytes.

The engine must keep blobs (`capabilities.blobs`): the memory, IndexedDB
(a seventh object store; an older IndexedDB database is upgraded at its open),
files (`blobs/<digest>`, as base64 text — an fsi carries text), SQLite (a
`blobs` table) and MongoDB (a `blobs` collection) engines do, and the
[at-rest](./backends#encrypted-at-rest) wrapper seals the bytes as it seals a record.
`copyEngine()` carries them. An engine without the store refuses the plugin at
`createDatabase()`.

## Over the wire

The name travels with the record; the bytes do not. A node that reads a record
naming bytes it lacks asks the peers it dials — `syncom/blob { digest }`,
answered as a stream where the transport carries one, as base64 otherwise —
checks the answer against the digest (a peer answering other bytes is not
believed: `sync.blob.mismatch`, the next peer asked), keeps the bytes in its
own store and answers them. No peer has them: `BLOB_NOT_FOUND` (`id`, `name`,
`digest`). `get(id, name, { fetch: false })` asks nobody. A host serves blobs
by default; `unit({ allow: { blob: false } })` refuses the call (403
`NOT_SERVED`). `db.sync.fetchBlob(digest)` is the same fetch by digest alone.

So an attachment reaches a node when that node reads it, not before: a phone
syncing a thousand records does not download a thousand photos. Pushing bytes
ahead of a read is not here — see the [comparison](./vs-rxdb).

## Compression

```js
plugins: [attachments({ compression: 'gzip' })]; // or 'deflate'
```

The bytes are stored compressed through `CompressionStream` (Node 18+, every
browser): the digest is the stored bytes', `encoding: 'gzip'` rides on the
register, `length` stays the bytes' length before compression, and `get()`
inflates. A node without compression reads what a node with it wrote: the
register says how.
