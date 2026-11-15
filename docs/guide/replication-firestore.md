---
title: Firestore replication
description: Keep a syncom collection in step with a Firestore collection through the modular SDK you inject, its server timestamps and transactions.
---

# Firestore replication

Choose the Firestore adapter when a Firestore collection is the backend of record: other clients, Cloud Functions or
the Firebase console read and write it, and syncom nodes keep a collection in step with it. You hand the adapter the
modular SDK itself; it pulls the documents stamped after a checkpoint, pushes in transactions whose own reads catch a
document changed by someone else, and listens with `onSnapshot` for live changes. It is a
[connector](./connectors), about 2 KB, and it ships none of the SDK.

<div class="sc-steps">

### Connect the collection

Pass the whole `firebase/firestore` module as `sdk`, the `Firestore` instance and the collection reference.

<<< @/examples/replication-firestore.mjs#replicate

The adapter calls the SDK's `query`, `orderBy`, `limit`, `startAfter`, `documentId`, `getDocs`, `doc`,
`runTransaction`, `serverTimestamp`, `Timestamp` and `onSnapshot`. Passing the module keeps the SDK out of syncom and
lets you pin its version yourself.

### Write from other clients

Every document carries two fields of the adapter's: `serverTimestamp`, which the server sets on every write and the
pull orders by, and `_deleted`, which marks a deletion so a pull can report it. Other writers set both:

<<< @/examples/replication-firestore.mjs#use

When another client changed a document after this node last saw it, the push's transaction reads a state other than
the one the row assumed, writes nothing for that row and answers the document as it stands; the connector sets the
record to Firestore's version, unless you pass `resolve`
([conflicts](./connectors#decide-what-wins-when-both-sides-changed-a-record)). A write that lands between the
transaction's read and its commit makes Firestore run the transaction again, and the second run sees it.

### Rename the adapter's fields

<<< @/examples/replication-firestore.mjs#fields

</div>

## Options that matter

| Option | Default | Meaning |
| --- | --- | --- |
| `sdk` | (required) | The `firebase/firestore` module |
| `database` | (required) | The `Firestore` instance |
| `collection` | (required) | The `CollectionReference` |
| `stampField` | `'serverTimestamp'` | The field the server stamps on every write |
| `deletedField` | `'_deleted'` | The boolean field of a deletion |
| `stream` | `true` | Listen with `onSnapshot`; `false` and the connector pulls every `retryTime` |

The pull's checkpoint is `{ seconds, nanoseconds, id }`: the last document's stamp, whole, and its id. A cursor of
milliseconds would skip or repeat the rest of a commit's documents, so the adapter keeps the stamp as the server set
it. A document whose stamp is still pending (a write of the SDK's own cache, not yet on the server) is left to the next
pull, and `waitForPendingWrites` is awaited first where the SDK has it. A push writes at most 500 rows per transaction,
Firestore's limit. `onSnapshot` watches the newest document, and each change the server confirmed is a `RESYNC`; the
listener's error is an `END`, and the connector listens again after a backoff.

## Limitations

- **Documents need the stamp field.** A query ordered by a field leaves out documents that lack it, so documents
  written before you connected are not pulled until they carry `serverTimestamp` (and `_deleted: false`). Backfill
  them once.
- **Deletions are documents.** A `deleteDoc` by another client is never seen; set `_deleted: true` instead.
- **Ids Firestore keeps for itself.** An id of the form `__name__` is refused by the SDK; the connector parks that row
  as `refused` with the SDK's error code, and the rest of the batch goes on. A value the SDK cannot store (a nested
  array) is refused the same way.
- **Firestore types are not JSON.** A `Timestamp`, a `GeoPoint` or a reference in your own fields makes the document
  refused on pull with the reason `value`. The check runs before `modifier.pull`, so store such values as JSON (an
  ISO date, a pair of numbers), or wrap the adapter's `pull.handler` to convert them.

## Coming from RxDB

RxDB's Firestore plugin also stamps documents with a server timestamp, marks deletions with a field and listens with
`onSnapshot`. Here the SDK is a value you pass rather than an import, the checkpoint keeps the stamp's nanoseconds,
and a push is a transaction whose reads catch a concurrent change. A filtered pull (a `where` on the query) is not
available: the adapter replicates the whole collection.

<FromRxdb page="replication-firestore" :rows="['firestore', 'foreignBackend']" />
