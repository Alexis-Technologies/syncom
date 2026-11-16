---
title: MongoDB replication
description: Keep a syncom collection in step with a MongoDB collection of your app's documents, through the driver you inject.
---

# MongoDB replication

Choose the MongoDB adapter when a MongoDB collection of plain documents is the backend of record: your server, a
reporting job or another service reads and writes it, and syncom nodes keep a collection in step with it. The adapter
takes the driver's collection from your app, pulls the documents changed since a checkpoint, pushes with a
`replaceOne` matched on the revision it last saw, and follows a change stream for live updates. It is a
[connector](./connectors), about 2 KB, with nothing of the driver bundled.

This is not the [MongoDB storage](./storage-mongodb), which stores a syncom database itself in MongoDB, nor the
[shared log](./replication-nats) hubs can keep there. Here MongoDB holds your app's documents in their own shape, and
syncom is one of its clients.

<div class="sc-steps">

### Connect the collection

Hand the adapter the driver's collection. Change streams need a replica set (a single-node one is enough).

<<< @/examples/replication-mongodb.mjs#replicate

### See what the adapter stores

Each document is the record's fields plus three of the adapter's: `_rev` counts its writes and is what a push matches
on, `_updated` is the time of its last write in milliseconds and orders the pull, and `_deleted` marks a deletion.

<<< @/examples/replication-mongodb.mjs#use

### Write from other apps

Every other writer of the collection keeps the three fields: it increments `_rev`, sets `_updated` to the current
time, and deletes by setting `_deleted: true` rather than removing the document, which a pull could never report.

<<< @/examples/replication-mongodb.mjs#other-writer

The change stream tells the connector of both writes, and it pulls them. When another writer changed a document after
this node last saw it, the push's `replaceOne` matches no document with the `_rev` it expected; the adapter reads the
document back and the connector sets the record to the collection's version, unless you pass `resolve`
([conflicts](./connectors#decide-what-wins-when-both-sides-changed-a-record)).

### Without a replica set

<<< @/examples/replication-mongodb.mjs#standalone

</div>

## Options that matter

| Option | Default | Meaning |
| --- | --- | --- |
| `collection` | (required) | The driver's collection (`client.db(name).collection(name)`) |
| `changes` | `true` | Follow a change stream; `false` on a standalone server, and the connector pulls every `retryTime` |
| `lookback` | `0` | How far before its checkpoint each pull starts, in ms: [writes stamped late](#pull-writes-stamped-late) |
| `now` | `Date.now` | The clock that stamps `_updated` on this node's pushes |

The adapter also answers `revisionOf(id)`, the `_rev` it last saw for a document. The pull's checkpoint is
`{ at, id }`: the documents stamped after `at`, or stamped at `at` with a greater `_id`, so a batch written within one
millisecond is never skipped at a page's edge. Every change of the stream is a `RESYNC`, and the stream erring or
closing is an `END`: the connector opens it again after a backoff.

## Pull writes stamped late

`_updated` comes from each writer's own clock, and the pull reads past a checkpoint. A writer whose clock runs two
seconds behind stamps its documents two seconds into the past, behind what a client already pulled, and that client
never sees them. Pass `lookback`, in milliseconds, and each pull starts that far before its checkpoint:

<<< @/examples/replication-mongodb.mjs#lookback

The documents of that window are read again at every pull. The connector passes over the ones it already knows (no
write, nothing counted in `stats().pulled`) and lands the late one. The checkpoint never moves back. Set `lookback`
to the largest drift you expect between writers plus a margin;
[Connectors](./connectors#pull-by-a-timestamp-without-missing-late-writes) explains the rules and the cost.

## Limitations

- **`_updated` comes from the writers' clocks.** The pull reads past a checkpoint `{ at, id }`, so a write that lands
  after a client pulled with a stamp below `at`, or at `at` with a smaller `_id`, is not pulled by that client unless
  [`lookback`](#pull-writes-stamped-late) covers how far behind it was. A writer whose clock runs behind does that,
  and so do two writers stamping the same millisecond. Keep the writers' clocks in sync and stamp as late as you
  can, ideally from one place: a write later than the window is still missed.
- **Deletions are documents.** A `deleteOne` by another app is never seen; mark the document `_deleted: true`.
- **One document, one request.** A push is a `replaceOne` per row, not a transaction over the batch. A server error
  with a code on one document (a validator's refusal, a key too large) parks that row as `refused` with the code as
  the reason; an error without a code (the network) fails the push, which is retried.
- **Revisions are remembered in memory.** After a restart the adapter learns them again with its first pull; a push
  of a document it has not seen is an upsert that fails on the duplicate key and comes back as a conflict.

## Coming from RxDB

RxDB's MongoDB plugin runs in Node.js against a replica set, follows a change stream with a resume token, and maps
real deletes through pre-images. This adapter keeps its own `_rev`, `_updated` and `_deleted` fields in your
documents instead, so it pulls by a checkpoint it can resume from at any time, and it works without a change stream
too.

<FromRxdb page="replication-mongodb" :rows="['mongodb', 'foreignBackend']" />
