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
this node holds the bytes. A sealed record (`{ encrypted: true }`) takes no
attachment: `put` is `ENCRYPTED` — the blobs store holds bytes in the clear
(the [at-rest](./backends#encrypted-at-rest) wrapper apart), which the record's
key does not cover.

A register is believed only as far as it is one. A peer writes registers too
(the field replicates like any other), so `get` and `has` read the register
before anything else touches the store: a `digest` that is not SHA-256 as hex
(64 lowercase hex characters — a digest is a file name in the files engine
and a key everywhere else), a `type` that is no text, a `length` that is no
integer within 64 MiB, an `encoding` the plugin does not know, is
`ATTACHMENT_INVALID` (`id`, `attachment`), and `list` leaves such a register out
with one `attachments.register.invalid` warning. Every engine's blobs store
checks the digest at its own door too (a `TypeError` before the medium sees
it), and every store takes a blob of at most `MAX_BLOB_BYTES` (64 MiB —
`BLOB_TOO_LARGE`, the one cap `syncom/blob` answers within as well): `put`
refuses a larger one before hashing it.

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
own store — once, by `fetchBlob`; a store that refuses them is a
`sync.blob.keep.failed` warning and the bytes are answered all the same — and
answers them. No peer has them: `BLOB_NOT_FOUND` (`id`, `attachment`,
`digest`). `get(id, name, { fetch: false })` asks nobody.

The bytes are what the register says, or `BLOB_MISMATCH` (`id`, `attachment`,
`digest`, `reason`): a plain blob whose length is not the register's `length`
(`reason: 'length'`), a compressed one that inflates past it (`'inflated'`) or
to another length. The inflating stops the moment it passes `length` — a
register is a peer's word, and a few KiB of gzip could name a few GiB
otherwise — so nothing is ever inflated whole on a register's say-so. A host serves blobs
by default; `unit({ allow: { blob: false } })` refuses the call (403
`NOT_SERVED`). `db.sync.fetchBlob(digest)` is the same fetch by digest alone.

So an attachment reaches a node when that node reads it, not before: a phone
syncing a thousand records does not download a thousand photos. Pushing bytes
ahead of a read is not here — see the [comparison](./vs-rxdb).

## Collecting the bytes

`remove`, `delete`, `purge` and `forget` leave an attachment's bytes in the
store — another name, another record may share them, and nothing counts
references. `db.attachments.sweep()` collects them: a mark-and-sweep over the
store, where every digest a live record's register names, a tag's copy names
(`tags: true` by default — a record as it was at a tag keeps its file) or a put
in flight holds is kept, and every other blob is removed. It answers
`{ blobs, marked, removed, pending }`; `sweep({ dryRun: true })` counts and
removes nothing. The log is not marked: a `restore()` or `applyPatches()` that
brings a swept register back names bytes a peer may still hold — fetched on the
read — else `BLOB_NOT_FOUND`. A sweep is the writer's: `READ_ONLY` on a
follower, and a follower's put in flight (`@alexify/syncom/shared`) is not the
leader's to see — sweep when the tabs are quiet, or put again.

```js
const { blobs, marked, removed } = await db.attachments.sweep({ dryRun: true });
await db.attachments.sweep(); // removes what nothing names
```

## Compression

```js
plugins: [attachments({ compression: 'gzip' })]; // or 'deflate'
```

The bytes are stored compressed through `CompressionStream` (Node 18+, every
browser): the digest is the stored bytes', `encoding: 'gzip'` rides on the
register, `length` stays the bytes' length before compression, and `get()`
inflates — as far as `length` and no further (`BLOB_MISMATCH` past it). A node
without compression reads what a node with it wrote: the register says how.
