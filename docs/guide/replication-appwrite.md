---
title: Appwrite replication
description: Keep a syncom collection in step with an Appwrite collection through the SDK you inject, its $updatedAt order and Realtime.
---

# Appwrite replication

Choose the Appwrite adapter when an Appwrite collection is the backend of record: your Appwrite functions, the
console or other apps read and write it, and syncom nodes keep a collection in step with it. The adapter takes the
SDK's `Databases` service, `Query` builder and client from your app, pulls the documents updated since a checkpoint,
pushes after reading each document to compare it with what the row assumed, and subscribes to Realtime for live
changes. It is a [connector](./connectors), about 2 KB, and runs in Node.js and in the browser alike.

<div class="sc-steps">

### Prepare the collection

Create a database and a collection in the Appwrite console or CLI, with an attribute for each field of your records
and one more: a boolean `deleted` attribute (default `false`), which marks a deletion so a pull can report it. Give
the users or the API key that will replicate read, create and update permissions on the collection.

### Connect the collection

<<< @/examples/replication-appwrite.mjs#replicate

The adapter calls `listDocuments`, `createDocument`, `updateDocument` and `getDocument` on `databases` with positional
arguments, the builder's `equal`, `greaterThan`, `orderAsc`, `limit`, `or` and `and`, and `client.subscribe` for the
stream. Any object with those members works, so a thin wrapper can adapt another version of the SDK.

### Watch it work

<<< @/examples/replication-appwrite.mjs#use

Other writers delete by setting `deleted: true`, never by removing the document. When another client changed a
document after this node last saw it, the push's read shows a state other than the one the row assumed; the adapter
answers the document as it stands and the connector sets the record to Appwrite's version, unless you pass `resolve`
([conflicts](./connectors#decide-what-wins-when-both-sides-changed-a-record)).

### Keep ids within 36 characters

Appwrite takes document ids of at most 36 characters that do not start with a special character. The ids syncom
generates on `insert()` are UUIDs, 36 characters long, so they fit; an id you choose may not, and Appwrite refuses it:

<<< @/examples/replication-appwrite.mjs#long-id

</div>

## Options that matter

| Option | Default | Meaning |
| --- | --- | --- |
| `databases` | (required) | The SDK's `Databases` service |
| `Query` | (required) | The SDK's query builder |
| `databaseId`, `collectionId` | (required) | The collection replicated |
| `client` | `null` | The SDK's client, for Realtime; none and the connector pulls every `retryTime` |
| `deletedField` | `'deleted'` | The boolean attribute of a deletion |
| `stream` | `true` | Subscribe to Realtime when a `client` is given |
| `lookback` | `0` | How far before its checkpoint each pull starts, in ms: [documents that appear late](#pull-documents-that-appear-late) |

The pull's checkpoint is `{ updatedAt, id }`: the documents updated after `updatedAt`, or at it with a greater `$id`,
in that order. A push lists the batch's documents in one query, then creates a document that is not there (a `409`
meaning another client created it first: a conflict, read back), updates one that holds what the row assumed (a `404`
meaning it was removed: a conflict), and answers any other as it stands. A `400` (an id Appwrite cannot carry, an
attribute the collection lacks) parks that row. Every Realtime event of the collection's documents is a `RESYNC`.

## Pull documents that appear late

The pull reads past a checkpoint `{ updatedAt, id }`, so a document that becomes visible with an `$updatedAt`
already behind it is never pulled. Pass `lookback`, in milliseconds, and each pull starts that far before its
checkpoint:

<<< @/examples/replication-appwrite.mjs#lookback

The documents of that window are read again at every pull. The connector passes over the ones it already knows (no
write, nothing counted in `stats().pulled`) and lands the late one. The checkpoint never moves back.
[Connectors](./connectors#pull-by-a-timestamp-without-missing-late-writes) explains the rules and the cost.

## Limitations

- **No compare-and-set.** Appwrite has no conditional write, so the adapter reads, compares and writes. A write
  another client makes between that read and the update is overwritten. If two clients often write the same document
  at once, make the backend of record one with a conditional write (CouchDB, MongoDB, Supabase, Firestore).
- **The cursor follows `$updatedAt`.** A write that becomes visible after a client pulled past its stamp (the same
  millisecond as one already pulled, with a smaller `$id`) is not pulled by that client unless
  [`lookback`](#pull-documents-that-appear-late) covers how late it was.
- **Deletions are documents.** A document another client removes is never seen; set `deleted` instead.
- **Every field needs an attribute.** A record field the collection has no attribute for makes Appwrite refuse the
  row with a `400`, and the connector parks it as `refused`.

## Coming from RxDB

RxDB's Appwrite plugin also reads before it updates, without a compare-and-set, and marks deletions with a boolean
attribute. This adapter runs in Node.js as well as in the browser, takes the SDK from your app as values (so it is
never an undeclared import), answers a create that lost a race as a conflict, and parks an id Appwrite refuses
instead of failing the batch.

<FromRxdb page="replication-appwrite" :rows="['appwrite', 'foreignBackend']" />
