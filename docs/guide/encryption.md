---
title: Encryption
description: Seal single records for this node with encrypted true, encrypt a whole database at rest with atRest(), rotate its key, and decide where keys live.
---

# Encryption

`@alexify/syncom/encryption` protects data on disk in two independent ways. A **sealed record**
(`{ encrypted: true }`) is one record encrypted for this node alone; it never leaves the node. **Encryption at
rest** (`atRest()`) wraps the storage so that every file, or every value an engine stores, is ciphertext under a key
your application holds, while sync works as usual. Use the first for a few private records on a node that
replicates everything else, the second for a device that may be lost or a disk you do not trust, and both together
when you need both.

## Seal one record

Pass `{ encrypted: true }` to a write:

<<< @/examples/encryption.mjs#sealed

The record reads and queries like any other on this node. On disk its file holds an envelope instead of the data:
the record encrypted with AES-256-GCM under a fresh key, and that key wrapped with this node's RSA public key
(RSA-OAEP, SHA-256). The same envelope is made in Node.js and in the browser, so a sealed record and its keys move
between the two. To seal every record of a database by default, open it with `createDatabase({ encrypted: true })`.

Sealed records are the `encryption` plugin. `@alexify/syncom/all` registers it; with the lean core, add `encryption`
to `plugins`, or a sealed write rejects with `PLUGIN_MISSING`.

## Why sealed records never sync

A sealed record is encrypted for this node's private key, and no other node holds that key. A copy sent to a peer
would be bytes the peer cannot read, merge or validate, so syncom does not send one. A sealed record produces no
operation in the log and is left out of every snapshot:

<FigSealed />

<<< @/examples/encryption.mjs#stays-local

Because it is outside the log, a sealed record also cannot use what the log gives a field. Plain writes work
(`update()`, `set()`, `delete()`, `purge()`) and seal the record again; a merging field does not:

<<< @/examples/encryption.mjs#refused

`inc()`, `add()`, `remove()`, every list, text and tree edit, and `history()`, `diff()` and `compact()` on a sealed
record reject with `ENCRYPTED`, and so does a sealed write inside a [transaction](./transactions-conflicts), whose
ops all go to the log. A record never changes kind: an encrypted write over a record that already replicates is
refused with `ENCRYPTED` too, so you cannot pull a record back from your peers by sealing it.

Queries find sealed records on the node that holds the key, and only there: a host answering a peer's query, an
agent's [tools](./mcp) and a [connector](./connectors) leave them out.

## Encrypt the whole database at rest

`atRest()` wraps the backend the database writes through. Every file that passes through it is AES-256-GCM
ciphertext under one key, and every read decrypts on the way back; the database does not know the difference:

<<< @/examples/encryption.mjs#at-rest

The records, the operation log, the catalog, the keys and `node.json` are all ciphertext, and opening the directory
without the key fails. Unlike a sealed record, an encrypted-at-rest database syncs normally: the ops it sends and
receives are decrypted in memory, so what reaches a peer is plain data, protected on the wire by the transport.

`atRest()` wraps an engine the same way: the memory, IndexedDB, SQLite and MongoDB engines. The key can also be
derived from a password with PBKDF2-SHA-256 under a salt you keep (8 characters or more, 600 000 rounds by default):

<<< @/examples/encryption.mjs#password

Over an engine, every value its stores hold is sealed: each record, its pieces, the copies a tag keeps, the small
named texts, each log entry and the log's index, and an attachment's bytes (28 bytes larger than the original). The
files engine, which is what a `path` opens by default, is wrapped at its backend as in the first example, because
its log reads back what it appends. Each value is bound to its place, so a ciphertext copied over another record's
place, or into another database of the same engine, does not open.

A file that is not the key's is refused with `DECRYPT_FAILED` and a `reason`: `'key'` for another key or a
ciphertext cut short, `'plain'` for a file that was never encrypted, `'torn'` for one whose text is damaged. The
first such file fails `createDatabase()`.

## Rotate the at-rest key

The key is changed by copying the database, never in place:

<<< @/examples/encryption.mjs#rotate

`rotateAtRest()` copies everything the database holds into `into` (another path, another engine or backend, or
both), sealed under the new key. The copy is the same node, with the same id, log and position in every stream, so
no peer has to bootstrap from it. Once the copy is complete, the old place is fenced: `createDatabase()` there
rejects with `MOVED` and names where the database went, until `dropDatabase()` removes it. That keeps two copies of
one node from writing at the same time. A copy cut short leaves the source as it was; the next rotation into the
same target clears the leftovers first. Over an engine, pass the engine instead of `{ fsi, filesEngine }`.

A sealed record's RSA pair is not rotated. It belongs to the directory, and a new pair is a new node.

## Where the keys live

The at-rest key, or the password and salt, is yours: syncom never writes it. Keep it where the platform keeps
secrets (an operating system keychain, a key your server hands out after sign-in, a password the user types) and
pass it at every open. If the key is lost, so is the data.

The RSA pair that seals records, and the Ed25519 pair that [signs this node's ops](./signing), are files under
`<path>/keys/` with owner-only permissions where the backend has them, and nothing more. Whoever can read the
directory can read the sealed records and sign as this node. Wrap the backend with `atRest()` as well to keep those
files encrypted too.

To replicate encrypted values, encrypt the fields yourself in a `beforeWrite` [hook](./hooks) and decrypt them in
`afterRead`. Peers then store and relay ciphertext, at a price: a field encrypted that way cannot be indexed,
queried or kept unique, and a counter cannot be encrypted at all, because its sum needs the numbers.

## Limitations

- **A sealed record hides its data, not its existence.** Its id (the file name), its collection and its timestamps
  stay readable, and the log, the catalog and the other records stay plain unless the backend is wrapped too.
- **Sealed records are not indexed.** A query reads every sealed record of the collection, and `$text` leaves them
  out.
- **At rest hides contents, not shapes.** File names (record ids, tag names, the log's sequence numbers) and file
  sizes stay visible, and an older copy of a file put back in its place opens: to the key it is a restored backup.
  The [chain](./chain) tells a record rolled back this way; nothing tells an older log file or catalog.
- **The wrapper writes whole files.** The log under `atRest()` over a backend writes one file per group of ops
  instead of appending lines to a journal.

## Coming from RxDB

RxDB encrypts the fields a schema lists, with a password per database, and replicates those fields decrypted. syncom
encrypts a whole record for one node and keeps it off the network, or a whole database at rest under a key that
can be rotated. Field-level encryption that replicates is the hook recipe above, not a built-in.

::: code-group

<<< @/examples/encryption.mjs#sealed [syncom]

<<< @/examples/rxdb/encryption.mjs#fields [RxDB]

:::

<FromRxdb page="encryption" :rows="['atRest', 'encScope', 'encSync', 'keyOffDisk', 'keyRotation', 'encryptedFields']" />

The functions are in the [API reference](../reference/api#encryption-subpath), and what the at-rest wrapper seals
in the [engines reference](../reference/engines#encrypted-at-rest).
