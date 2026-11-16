---
title: Attachments
description: Store files next to a record by their SHA-256, sync their names with the record, upload the bytes with a push and fetch them only when a node reads them.
---

# Attachments

A record is JSON. A screenshot on a bug report, a PDF on an invoice or a recording on a note is bytes, and bytes
do not belong in JSON. The `attachments` plugin keeps them beside the record: the bytes go into the engine's blob
store under their SHA-256 digest, and the record gets a field that names them. The field syncs like any other
field. The bytes travel apart from it: up to a host with the push that names them, and down to a node the first
time that node reads the attachment.

## Add the plugin

The plugin is not part of `@alexify/syncom/all`, so add it yourself:

<<< @/examples/attachments.mjs#open

Every engine that ships with syncom has a blob store: memory, files, IndexedDB, SQLite and MongoDB. An engine
without one is refused when the database opens.

## Attach bytes to a record

`put(id, name, bytes, { type })` stores the bytes and names them on the record:

<<< @/examples/attachments.mjs#put

The bytes can be a `Uint8Array`, an `ArrayBuffer` or a string (stored as UTF-8). The name is up to 128 letters,
digits, `.`, `_`, `@` and `-`, and putting under a name that exists replaces what it names. The record must
exist; `put()` on an id that is not there rejects with `NOT_FOUND`.

## Read them back

<<< @/examples/attachments.mjs#read

The attachment is a field of the record, `_attachments`, holding a small entry per name: the digest, the media
type and the length. That entry is an ordinary [field](./fields): it is in the record you read, it syncs to
other nodes, it shows up in [history and versions](./versions), and [undo](./undo) takes it back. A schema that
validates the record lets `_attachments` through.

A string goes in as UTF-8 and comes back as bytes; decode it yourself:

<<< @/examples/attachments.mjs#text

`get()` resolves to `null` for a name the record does not have. `list(id)` returns every attachment of the
record, and `has(id, name)` tells you whether this node holds the bytes right now (more on that below).

## Fetch the bytes from a peer on demand

Here the server attaches a file and the phone syncs:

<FigAttachments />

<<< @/examples/attachments.mjs#peers

The name arrives with the record; the bytes stay on the server until the phone reads them. Then `get()` asks the
peers the phone is connected to, checks that what comes back hashes to the digest (a peer that answers other bytes
is not believed, and the next peer is asked), stores the bytes and returns them. The next read is local. A phone
that syncs a thousand records with photos downloads the photos it opens, not a thousand.

A host hands out bytes only to a peer that may read a record naming them: the record must be live and in the
peer's [scopes](./partial-sync). A peer that knows a digest but cannot read a record holding it gets nothing.

When no peer can be reached, or none has the bytes, `get()` rejects with `BLOB_NOT_FOUND`. Pass `{ fetch: false }`
to read only what this node holds:

<<< @/examples/attachments.mjs#offline

## Attach on a node that dials a server

Bytes go up with a push. When a node pushes the op that names an attachment and the host takes it, the node
uploads the bytes to that host too, asking first whether the host holds them so they cross once. Here a laptop and
a phone both dial a server; the laptop attaches a sketch and the phone reads it from the server:

<<< @/examples/attachments.mjs#hub

`createMesh` from `@alexify/syncom/testing` wires the three nodes in one process; an app dials a real
[server](./replication-server) the same way. The host takes the bytes only for a live record in the node's [scopes](./partial-sync) that names them under that
name, and only if they hash to the digest. A hub that relays the entry before the bytes reach it uploads them to
its own host once they arrive, so a chain of hubs carries them as well. An upload the host refuses (past
`limits.bytesPerBlob`, say) is reported on the manager's `error` event as `BLOB_UPLOAD_FAILED` and never fails the
push; one that failed on the way is tried again at the next push.

## How the bytes travel

Over a connection that carries binary streams, the bytes cross as bytes. That is every
[wrpc](./replication-websocket) transport except Server-Sent Events: a WebSocket, WebTransport, a
[WebRTC](./replication-webrtc) data channel, a worker port. An upload and a download are each a stream of 64 KiB
chunks, and a chunk is written only when the connection has taken the one before, so a slow peer slows the sender
instead of filling its memory. Nothing is base64-encoded, and no single message holds the file: a server that
refuses messages past 16 MiB still takes a 64 MiB attachment. When the host refuses an upload, or already holds
the bytes, it lets go of the stream and the sender stops; the pieces and the stop are wrpc's (2.1 or later).

Over a text-only link the bytes travel as base64 inside one call, a third larger, and the transport's message
limit bounds the attachment. See [Limits](#limits). You choose neither form: the node and the host settle it per
connection.

## Remove an attachment and free the space

`remove(id, name)` takes the name off the record, and that removal syncs. The bytes stay in the blob store,
because another name or another record may hold the same digest: the same file attached twice is stored once.
`sweep()` frees what nothing names any more:

<<< @/examples/attachments.mjs#remove

A sweep keeps every blob that a live record names, that a [version tag](./versions) still names (pass
`{ tags: false }` to ignore tags), or that a `put()` in progress is writing; it removes the rest. `{ dryRun: true }`
counts without removing. Deleting or purging a record leaves its bytes for the next sweep as well. Run a sweep
from time to time, for example next to [cleanup](./cleanup).

The log is not part of the sweep. If you restore an old version of a record whose bytes were swept, a read fetches
them from a peer that still holds them, or rejects with `BLOB_NOT_FOUND`. In a browser with several tabs open
(the [leader election](./leader-election) setup), sweep from the tab that leads while the others are not attaching
files: a sweep on a follower is refused with `READ_ONLY`, and a put in progress on another tab is not visible to it.

## Compress the stored bytes

<<< @/examples/attachments.mjs#compression

With `compression: 'gzip'` or `'deflate'`, bytes are compressed with `CompressionStream` before they are stored.
The digest is the digest of the stored bytes, the entry says `encoding: 'gzip'`, and `length` stays the length
before compression. A node without the option reads what a node with it wrote, because the entry says how to
inflate it. Compression pays off for text, CSV and JSON; images and video are compressed already.

## Limits

An attachment is at most 64 MiB; a larger `put()` is refused with `BLOB_TOO_LARGE` before anything is stored. An
[encrypted](./encryption) record takes no attachments (`put()` rejects with `ENCRYPTED`): the blob store holds
bytes in the clear, which the record's key does not cover. To encrypt the bytes on disk, wrap the engine in
encryption at rest, which seals blobs as it seals records.

The bytes never come down ahead of a read. A node that must work offline with every file has to read each
attachment once while it is online.

Over a text-only transport an attachment has to fit in one message as base64. With wrpc's Server-Sent Events
transport that is the HTTP body limit, 10 MiB by default, so about 7 MiB of bytes; dial over a WebSocket when
attachments may be larger. A host still holds one attachment in memory while it checks the digest, and
`limits.bytesPerBlob` on the [unit](./replication-server) lowers what it accepts.

They go up only with the push of the entry that names them, from a node that holds them, and only to a host that
writes: a follower of a [shared log](./replication-nats) takes no bytes. What a node still has to upload is kept in
memory, so a node restarted before its upload ran does not send those bytes; a read on the host then fetches them
from a peer the host dials, or rejects with `BLOB_NOT_FOUND`. A [JSON export](./import-export) carries the
`_attachments` entries but not the bytes.

A peer's entry is believed only as far as it is a valid entry. A digest that is not 64 lowercase hex characters, or
a length past the limit, makes `get()` and `has()` reject with `ATTACHMENT_INVALID`, and bytes that do not match
the entry's length reject with `BLOB_MISMATCH`.

## Coming from RxDB

RxDB stores attachments per document and needs `attachments: {}` in the collection's schema. In syncom any record
can carry attachments, the same bytes are stored once whoever names them, and replication moves the names at once
and the bytes apart: up to a host with a push, down to a node when it reads them. RxDB's replication carries
attachment data with the document on the protocols that support it.

::: code-group

<<< @/examples/attachments.mjs#put [syncom]

<<< @/examples/rxdb/attachments.mjs#put [RxDB]

:::

<FromRxdb page="rx-attachment" :rows="['attachments', 'replAttachments', 'compression', 'encAttachments']" />

Every method and its options are in the [reference](../reference/api#attachments-subpath).
