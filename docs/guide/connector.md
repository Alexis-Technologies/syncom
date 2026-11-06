# Connectors

`@alexify/syncom/connector` keeps one collection in step with a backend of its own — a CouchDB, a GraphQL
endpoint, a Firestore, a table behind Supabase, a MongoDB collection, a file in a drive — through two handlers you
write (or take from an adapter beside the module): `pull`, the backend's documents since a checkpoint, and `push`,
this node's records as they change. Peers are not involved: a connector is how a syncom mesh meets a system that
is not one.

```js
const { replicate } = require('@alexify/syncom/connector');

const tasks = replicate(db, {
  name: 'tasks',
  collection: 'Task',
  pull: {
    // The backend's documents changed since `checkpoint`, at most `batchSize`, and the position after them.
    handler: async (checkpoint, batchSize) => {
      const page = await api.changes({ since: checkpoint, limit: batchSize });
      return { documents: page.rows.map(({ id, doc, deleted }) => ({ id, data: doc, deleted })), checkpoint: page.seq };
    },
    // Optional: the backend's live changes; without it a live connector pulls every `retryTime`.
    stream: (emit) => api.subscribe((page) => emit({ documents: page.rows, checkpoint: page.seq })),
  },
  push: {
    // This node's records, with what the backend was assumed to hold; answer the rows the backend refused.
    handler: async (rows) => api.bulk(rows.map(({ id, data, deleted, assumed }) => ({ id, data, deleted, ifMatch: assumed }))),
  },
});
await tasks.awaitInitialReplication();
```

## What comes in

A pulled document — `{ id, data, deleted }` — lands as an ordinary write of this node: one transaction per page of
`set`s and `delete`s, stamped here, so the record reaches every peer the way a local write does, and the backend
never sees an op or a meta. A document that reads as the record already does makes no op at all: that is how this
node's own writes, come back from the backend, leave no echo and no stamp (a hash of what was pushed would be lost
at a restart; a comparison is not). `$type` is laid on what comes in and taken off what goes out: the backend holds
the fields alone. A document that is no document — no id, no object where one is due — is left out and said
(`connector.document.malformed`), never the page.

`modifier.pull(data, id)` reshapes a document before it lands, `modifier.push(data, id)` a record before it goes.

## What goes out

Every turn of the database that changed a record of the collection — a local write, a transaction, a peer's page, a
joined snapshot; not a pull of this connector — is pushed, `batchSize` rows a call, one push in flight at a time. A
row is `{ id, data, deleted, assumed }`: the record as this node reads it (`deleted` for a tombstone), and
`assumed`, the backend's state as this node last knew it — what came in a pull, what went out in a push, what a
conflict said — for a backend that checks a write against what it holds (a `_rev`, an `updated_at`, an ETag).

The handler answers the rows the backend refused, each as the backend holds it. A conflict is the backend's to win:
the record is set to that state here, and both agree. With `resolve({ id, local, remote, deleted })` the application
decides — answer the data to keep (it goes back to the backend, with the backend's state as what was assumed), `null`
to delete, anything else to keep the backend's state. Every conflict is a `conflict` event.

## The checkpoint

`{ pull, pushed }` — the backend's position pulled through, and this node's log position pushed through — lives in
the `connector` kv namespace under the connector's name, written after each page. `start()` reads it: the backend
is pulled from `pull`, and what the log holds since `pushed` is pushed — the records of the collection those entries
touched, this connector's own writes left out. Where the log cannot resume from `pushed` (compacted past it, another
epoch, a fresh connector), every record of the collection is pushed once (`connector.rebuild`), the ones just pulled
and unchanged left out. A restart in the middle pushes a row twice at worst: the backend's compare-and-set, or the
equality of the data, makes the second a no-op.

## Failures

A handler that throws is told — the connector's `error` event carries `REPLICATION_FAILED` with the `direction` —
kept (`errors`, the newest twenty) and tried again after `retryTime`; nothing is skipped and no checkpoint moves
past it. `awaitInitialReplication()` resolves once the first pull and push are through, `awaitInSync()` once
nothing waits to go out and nothing is in flight either way (`{ signal }` cuts a wait short). `cancel()` stops for
good; `reSync()` pulls and pushes again. `stats()` counts the documents pulled and applied, the rows pushed, the
conflicts, and what is pending.

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | — | The checkpoint's name in the `connector` kv namespace |
| `collection` | — | The collection replicated |
| `pull.handler(checkpoint, batchSize)` | — | `{ documents: [{ id, data, deleted }], checkpoint }` |
| `pull.stream(emit)` | — | `emit({ documents, checkpoint })` or `emit('RESYNC')`; returns what stops it |
| `push.handler(rows)` | — | `rows: [{ id, data, deleted, assumed }]`; answers the conflicts `[{ id, data, deleted }]` |
| `live` | `true` | Follow the backend after the initial pull: its stream, or a pull every `retryTime` |
| `retryTime` | `5000` | After a failure, and between pulls without a stream, in ms |
| `batchSize` | `100` | Documents per pull, rows per push |
| `modifier` | — | `{ pull(data, id), push(data, id) }` |
| `resolve` | — | What a refused row's record should be; the backend's state without it |
| `autoStart` | `true` | Start at once |

## Adapters and recipes

Where the far end speaks a protocol of its own, an adapter beside this module writes the two handlers over an
injected client or `fetch` — nothing of the backend's SDK ships with syncom, every adapter is a subpath of its own
under 2 KB, and each is tested over a fake of its backend. Where the far end is reachable over a wire wrpc already
carries — HTTP and Server-Sent Events, WebSocket, WebRTC, a worker port, a broker (NATS, Redis, Kafka, AMQP) — no
connector is needed: the other side runs a syncom node and the protocol goes over wrpc as it is
([wrpc transport](./wrpc), [Scaling](./scaling#a-shared-log)).

Every adapter answers `{ pull, push }` to spread into `replicate()`'s options (GraphQL the sides it was given), and
keeps in memory what a compare-and-set needs — the revision or the stamp it last saw for each document — for the
connector's life: a connector started anew learns them with its first pull, and a push of a document it has never
seen lands as a new one, a conflict where one exists, as it should. A conflict is answered as the backend holds the
document, so the connector sets the record to it ([conflicts](#what-goes-out)).

### CouchDB

```js
const { couchdb } = require('@alexify/syncom/connector/couchdb');

replicate(db, {
  name: 'couch',
  collection: 'Task',
  ...couchdb({ url: 'https://couch.example.com/tasks', headers: { authorization: `Basic ${credentials}` } }),
});
```

One database. A pull is `_changes?include_docs=true` since the checkpoint (CouchDB's `last_seq`), `limit` the batch,
a `_deleted` change a deletion; the stream is `_changes?feed=longpoll` asked again and again (`longpoll` the wait in
ms, 60 000). A push is `_bulk_docs` with the `_rev` the adapter last saw on each document — the database's
compare-and-set — and a `conflict` answer is the document read back as the database holds it (a 404 a deletion).
`fetch` is the platform's unless given, `headers` ride on every request, and `revisionOf(id)` says what the adapter
holds. A request that fails is an error with its `status`, which the connector tries again after `retryTime`.

### GraphQL

A GraphQL schema is the application's, so the adapter posts the queries it is given and reads their answers through
the functions it is given — one adapter for every schema:

```js
const { graphql } = require('@alexify/syncom/connector/graphql');

replicate(db, {
  name: 'api',
  collection: 'Task',
  ...graphql({
    url: 'https://api.example.com/graphql',
    headers: { authorization: `Bearer ${token}` },
    pull: {
      query: `query ($since: Int, $limit: Int!) {
        tasks(since: $since, limit: $limit) { documents { id data deleted } checkpoint }
      }`,
      variables: (checkpoint, batchSize) => ({ since: checkpoint, limit: batchSize }),
      read: (data) => data.tasks,
    },
    push: {
      query: `mutation ($rows: [TaskInput!]!) { pushTasks(rows: $rows) { conflicts { id data deleted } } }`,
      variables: (rows) => ({ rows }),
      read: (data) => data.pushTasks.conflicts,
    },
    stream: (emit) => subscribeToTasks(() => emit('RESYNC')),
  }),
});
```

`url` and `fetch` post `{ query, variables }` as JSON with `headers`; `request(query, variables)` is the
application's own client instead, answering the `data`. An answer with `errors` is a failure the connector tries
again. `pull.read(data)` answers `{ documents, checkpoint }` as a pull handler does, `push.read(data)` the conflicts
(nothing is none); the stream is the application's subscription client, as `replicate()` takes one. What a
compare-and-set needs — a revision on every row, say — is the schema's to carry and the readers' to remember: the
repository's test endpoint answers a `rev` with every document and the rows it refused as it holds them.

### MongoDB

```js
const { mongodb } = require('@alexify/syncom/connector/mongodb');

replicate(db, {
  name: 'mongo',
  collection: 'Task',
  ...mongodb({ collection: client.db('app').collection('tasks') }),
});
```

One collection of the driver's, injected — a collection of the application's documents, not a syncom database (the
[engine](./backends#engines) and the [shared log](./scaling#a-shared-log) are the other two things syncom does over
the driver). Every document carries three fields of the adapter's: `_rev` (a count of its writes, the
compare-and-set), `_deleted` (a tombstone, so a pull sees a deletion) and `_updated` (the position, stamped by `now`:
a pull is the documents `_updated` after the checkpoint, in that order; two writes in one millisecond are read again
at the next pull, and an equal document makes no op). The stream is a change stream on the collection, every change
a `RESYNC` — a replica set; `changes: false` without one, and a live connector pulls every `retryTime`. A push is a
`replaceOne` matched on the `_rev` last seen (an upsert for a document never seen; a duplicate key is a conflict),
and a conflict is the document read back. `revisionOf(id)` says what the adapter holds.

### Supabase

```js
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('@alexify/syncom/connector/supabase');

const client = createClient(url, anonKey);
replicate(db, { name: 'supabase', collection: 'Task', ...supabase({ client, table: 'tasks' }) });
```

One table through the injected client (`@supabase/supabase-js`, or anything with its `from().select()…` shape): a
primary key column (`primaryKey`, `id`), a boolean column of a deletion (`deletedColumn`, `deleted`) and a text column
the database sets on every write (`modifiedColumn`, `updated_at` — a trigger, or the adapter's own stamp, `now`, an
ISO date). A pull is the rows modified after the checkpoint, in that order; a push is an `update` matched on the
primary key and the modified value last seen — PostgREST's compare-and-set, no row matched a conflict — or an
`insert` for a row never seen (a duplicate key a conflict), and a conflict is the row read back. The stream is
Realtime's `postgres_changes` on the table (`channel`, `syncom:<table>`; `stream: false` for none, and a client
without channels has none), every change a `RESYNC`. `stampOf(id)` says what the adapter holds.

### Firestore

```js
const sdk = require('firebase/firestore');
const { firestore } = require('@alexify/syncom/connector/firestore');

const database = sdk.getFirestore(app);
replicate(db, {
  name: 'firestore',
  collection: 'Task',
  ...firestore({ sdk, database, collection: sdk.collection(database, 'tasks') }),
});
```

The modular SDK is handed in whole as `sdk` — the adapter calls its `query`, `orderBy`, `limit`, `startAfter`,
`documentId`, `getDocs`, `doc`, `runTransaction`, `serverTimestamp`, `Timestamp` and `onSnapshot`, and ships none of
them. Every document carries two fields of the adapter's: the stamp the server sets on every write (`stampField`,
`serverTimestamp`) and a tombstone (`deletedField`, `_deleted`), so a pull sees a deletion. A pull is the documents
ordered by the stamp, then by id, after the checkpoint `{ at, id }` — one cursor, no second query for the documents
stamped at the same instant; a document whose stamp is still pending (a write of the SDK's own cache not yet on the
server) is left to the next pull, and `waitForPendingWrites` is awaited first where the SDK has it. A push is one
transaction: every row's document read, compared with what the row assumed, written where it is the same and
answered as a conflict where it is not — the transaction's own reads and writes, so a write that lands between them
makes Firestore run the transaction again, and the second run sees it. The stream is `onSnapshot` over the newest
document, every change the server confirmed a `RESYNC` (`stream: false` for none).

### Appwrite

```js
const { Client, Databases, Query } = require('appwrite');
const { appwrite } = require('@alexify/syncom/connector/appwrite');

const client = new Client().setEndpoint(endpoint).setProject(project);
replicate(db, {
  name: 'appwrite',
  collection: 'Task',
  ...appwrite({ client, databases: new Databases(client), Query, databaseId: 'main', collectionId: 'tasks' }),
});
```

One collection through the injected SDK: `databases` (its `Databases` service), `Query` (its builder) and, for the
stream, `client` (its `subscribe`; `client: null` or `stream: false` for none). A document's `$updatedAt` is the
position — a pull is the documents updated after the checkpoint `{ updatedAt, id }`, those at the same instant by
`$id` — and a tombstone is a boolean attribute of the collection's (`deletedField`, `deleted`), so a pull sees a
deletion: add it to the collection's attributes. A push reads the rows' documents in one query and compares each
with what its row assumed: a row never there is `createDocument` (a 409 the conflict, the document read back), a row
the same is `updateDocument` (a 404 a deletion), a row that differs a conflict answered as the document stands.
Appwrite has no compare-and-set write, so a write landing between the read and the update is overwritten — the same
window RxDB's plugin has; where two clients write one document at once, let the backend of record be one with a
conditional write. The stream is Realtime's channel of the collection's documents, every event a `RESYNC`.

### Google Drive

```js
const { gdrive } = require('@alexify/syncom/connector/gdrive');

replicate(db, {
  name: 'drive',
  collection: 'Task',
  ...gdrive({ token: accessToken, name: 'tasks.json', poll: 30_000 }),
});
```

One JSON file of the collection in the user's Drive — the application data folder by default (the
`drive.appdata` scope; `folder` a folder's id instead), found by `name` or taken by `fileId` — through `fetch` and the
OAuth `token` (or `headers` carrying the authorization). The file holds every document with the position of its
newest write: a pull answers those after the checkpoint, in that order, and downloads the file only when its ETag
moved; a push writes the file whole under `If-Match` — the compare-and-set — and a 412 (another device wrote first)
reads it again and judges the rows anew, a few times, before it fails. The ETag comes from the v2 metadata (v3
answers none), the text from `alt=media`, the write from the media upload, and the file is made at the first push. The
stream, where `poll` is set, probes the ETag every `poll` ms and says `RESYNC` when it moved; without it a live
connector pulls every `retryTime`. A file that is no collection file is refused, never overwritten; `fileId()` and
`positionOf(id)` say what the adapter holds. There is no lock file and no file per document: one ETag decides, and a
collection stays one upload.

### OneDrive

```js
const { onedrive } = require('@alexify/syncom/connector/onedrive');

replicate(db, {
  name: 'onedrive',
  collection: 'Task',
  ...onedrive({ token: accessToken, path: 'syncom/tasks.json', poll: 30_000 }),
});
```

The same file through Microsoft Graph with a `Files.ReadWrite` token: the item at `root:/<path>` gives the eTag,
`/content` the text, and `PUT root:/<path>:/content` under `If-Match` writes it in place or makes it — a simple
upload, so the collection file stays under Graph's 4 MB (`drive` names another drive than `me/drive`). Everything
else — the positions, the retries on a 412, the probe for the stream, `positionOf` — is the Google Drive adapter's.
