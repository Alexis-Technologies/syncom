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
    // Optional: the backend's live changes from the checkpoint; without it a live connector pulls every `retryTime`.
    stream: (emit, { checkpoint }) => api.subscribe({ since: checkpoint }, (page) => emit({ documents: page.rows })),
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
never sees an op or a meta. Every document is judged against the backend's state as the connector knows it (what
it pulled, pushed or was told in a conflict), never against the record alone:

- the state known already is an **echo** — this node's own write come back, or a write of another client that left
  the document as it was — and makes no op and no stamp; over a local edit not yet pushed it changes nothing either:
  the push compares the edit against that very state;
- another state over a local edit not yet pushed is a **conflict**: the backend moved under the edit, and the edit
  is neither silently overwritten nor pushed over the backend — `resolve` decides, or the backend wins, the
  resolution lands in the page's transaction and the `conflict` event tells of it ([conflicts](#what-goes-out));
- another state over a record with nothing pending is the backend's **newer state** and lands (a document that reads
  as the record already does makes no op).

`$type` is laid on what comes in and taken off what goes out: the backend holds the fields alone. A document that
is no document — no id, no object where one is due — is left out and said (`connector.document.malformed`), never
the page.

A document that cannot land is refused by name — the `refused` event, `{ direction: 'pull', id, reason, cause }` —
and the rest of its page lands, the checkpoint moving past it: `collection` for a record of another collection (a
backend's tombstone never deletes a `Note` through a `Task` connector, a document never adopts one), `sealed` for a
record encrypted here (a connector reads none and sends none), `value` for a value that is no JSON (a Date, a
Decimal, a Timestamp or a reference of a backend's SDK is never flattened into a string field; the adapters strip
their own fields, the application's `modifier.pull` converts the rest), `modifier` for a modifier that threw, and
the code of a write the engine refused — a validator's `VALIDATION_FAILED`, a field's `TypeError`. A landing that
fails whole (the engine, the database closing under it) is the pull's failure: `REPLICATION_FAILED`, the checkpoint
unmoved, tried again.

`modifier.pull(data, id)` reshapes a document before it lands, `modifier.push(data, id)` a record before it goes.
The backend's shape is what the connector remembers and compares: a document as it came (before `modifier.pull`), a
row as it went (after `modifier.push`); a conflict's `remote` comes through `modifier.pull`, the application's
resolution goes back through `modifier.push`.

## What goes out

Every turn of the database that changed a record of the collection — a local write, a transaction, a peer's page, a
joined snapshot; not a pull of this connector — is pushed, `batchSize` rows a call, one push in flight at a time. A
row is `{ id, data, deleted, assumed }`: the record as this node reads it (`deleted` for a tombstone), and
`assumed`, the backend's state as this node last knew it — what came in a pull, what went out in a push, what a
conflict said — for a backend that checks a write against what it holds (a `_rev`, an `updated_at`, an ETag).

A row that reads as the backend is known to hold it has nothing to say and is not pushed — a resolution the backend
won goes nowhere, a turn that leaves the record as the backend holds it makes no call — and a sealed record never
goes at all.

The handler answers the rows the backend refused, each as the backend holds it. A conflict is the backend's to win:
the record is set to that state here, and both agree. With `resolve({ id, local, remote, deleted })` the application
decides — answer the data to keep (it goes back to the backend, with the backend's state as what was assumed), `null`
to delete, anything else to keep the backend's state; a `resolve` that throws is said (`connector.resolve.failed`)
and the backend wins. Every conflict is a `conflict` event, told once the resolution has landed. A resolution the
engine refuses (a validator says no to the backend's state) is a `refused` event with `direction: 'push'` and the
record stands: it goes to the backend with the backend's state assumed. A backend that refuses a row assuming exactly
what it says it holds, twice in a row, contradicts itself: the row is parked (`reason: 'conflict'`), never pushed in
a loop.

A row the backend refuses by name — an id it cannot carry (CouchDB's `_…`, Appwrite's past 36 letters), a body too
large — is answered as `{ id, error }` rather than a conflict: the row is parked and said (`refused`, `direction:
'push'`, the error's `code`), the rest of the batch lands, and a turn of the record or `reSync()` tries it again
(`stats().parked` counts them; a restart does not retry a parked row).

## The checkpoint

One text in the `connector` kv namespace under the connector's name holds what a restart needs:

```json
{ "pull": 42, "pushed": "mw6l.17", "known": { "t1": "b-SQXlGHTSadY8-j1RK7Vt", "t2": null } }
```

`pull` is the backend's position pulled through (whatever the handler answered as a checkpoint), `pushed` this
node's log position pushed through, and `known` the backend's state per record as last known — not the data but 22
letters of its SHA-256 (the canonical JSON of the backend's shape; `null` for a record the backend holds nothing of;
no entry for one gone on both sides), about 50 bytes a record. The text is saved coalesced: one write in flight and
the next after a short gap while pages keep landing, at once at the end of a pull run, after a push, after a page of
the stream, and on `cancel()`. Nothing is published yet, so the shape may still change.

`start()` reads it: the backend is pulled from `pull` — a document judged by the digest as it would be by the state
in memory, so this node's own echo over an offline edit is skipped — and what the log holds since `pushed` is pushed:
the records of the collection those entries touched, this connector's own pulls left out. `pushed` is a frontier: it
never passes a turn whose record still waits to go, so a restart pushes every pending turn again and, at worst, what
was pushed after the oldest pending one — at least once, never lost. A record whose state is known by digest alone
(after a restart) is pushed as a probe, `assumed: undefined` — "tell me what you hold": the handler answers it among
the refused as the backend holds it and writes nothing; the state the digest names is assumed on the next push, any
other is a conflict. An offline edit so lands through the compare-and-set at one extra round trip, and a backend that
moved meanwhile is a conflict, never a silent loss. Where the log cannot resume from `pushed` (compacted past it,
another epoch, a fresh connector), every record of the collection is asked about once (`connector.rebuild`): equal
records are silent, differing ones conflicts, records the backend holds nothing of are made. A page landed by the
stream whose digests were not yet written when the process died is pulled again from the saved `pull`; an edit made
offline to such a record before the restart meets the backend's state as a conflict.

## Failures

A handler that throws — or the landing of what it answered: the engine, a `resolve` the connector could not land,
the database closing — is told: the connector's `error` event carries `REPLICATION_FAILED` with the `direction` and
`retryIn`, the wait before the retry. The failure is kept (`errors`, the newest twenty) and tried again after a
backoff — `retryTime` doubled per failure in a row up to `maxRetryTime`, with ±25 % of jitter, reset by the next
success of that direction; nothing is skipped, the rows stay pending and no checkpoint moves past the failure. A
push's failure never cancels the pull's retry, nor the other way round. `awaitInitialReplication()` resolves once
the first pull and the first push have succeeded — a first pull that fails keeps it waiting until the retry lands —
and `awaitInSync()` once nothing waits to go out and nothing is in flight either way (`{ signal }` cuts a wait
short). `cancel()` stops for good — the stream stopped, the timers cleared, what is in flight awaited, what is dirty
saved; the database's `close()` cancels the connector the same way, so no handler is called after it. `reSync()`
pulls and pushes again, the parked rows too. `stats()` counts the documents pulled and applied, the rows pushed, the
conflicts, the documents and rows refused, what is pending and what is parked.

## Live

With `live` (the default) the connector follows the backend after the initial pull. Where the handlers have a
`stream(emit, { checkpoint })`, it is subscribed from the checkpoint the last pull left and may say three things:
`emit({ documents })` — a page, landed like a pull's page but never moving the checkpoint (only a pull does, so a page
that fails to land is pulled again from the checkpoint, never passed over); `emit('RESYNC')` — pull again from the
checkpoint (a `RESYNC` while a pull runs makes it run once more after its pages, so a change behind the page just
read never waits for the next signal); `emit('END')` — the stream is over (the backend closed it): it is followed
again after the pull's backoff, from the checkpoint as it stands, and a pull catches up what it missed. Every
`safetyTime` ms (60 000; `0` for none) a pull from the checkpoint runs anyway, for a stream gone quiet without a
word. Without a stream a live connector pulls every `retryTime`. Everything the pull side lands — the pages of a run,
the pages of the stream — goes through one queue in order, and a landing and a push take turns, so neither judges a
record against a state the other is changing. A page of the stream delivered out of order (an older state after a
newer push) is judged again by the next pull run.

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | — | The checkpoint's name in the `connector` kv namespace |
| `collection` | — | The collection replicated |
| `pull.handler(checkpoint, batchSize)` | — | `{ documents: [{ id, data, deleted }], checkpoint }` |
| `pull.stream(emit, { checkpoint })` | — | `emit({ documents })`, `emit('RESYNC')` or `emit('END')`; returns what stops it |
| `push.handler(rows)` | — | `rows: [{ id, data, deleted, assumed }]` (`assumed` `undefined`: a probe); answers the conflicts `[{ id, data, deleted }]` and the rows refused by name `[{ id, error }]` |
| `live` | `true` | Follow the backend after the initial pull: its stream, or a pull every `retryTime` |
| `retryTime` | `5000` | After a failure (doubled per failure in a row), and between pulls without a stream, in ms |
| `maxRetryTime` | `60000` | The most a retry waits, in ms |
| `safetyTime` | `60000` | With a stream, a pull from the checkpoint this often anyway, in ms; `0` for none |
| `batchSize` | `100` | Documents per pull, rows per push |
| `modifier` | — | `{ pull(data, id), push(data, id) }` |
| `resolve` | — | What a refused row's record should be; the backend's state without it |
| `autoStart` | `true` | Start at once |

## Adapters and recipes

Where the far end speaks a protocol of its own, an adapter beside this module writes the two handlers over an
injected client or `fetch` — nothing of the backend's SDK ships with syncom, every adapter is a subpath of its own
under 2 KB, and each is tested over a fake of its backend. Where the far end is reachable over a wire wrpc already
carries — HTTP and Server-Sent Events, WebSocket, WebRTC, a worker port, a broker (NATS, Redis, Kafka, AMQP) — no
connector is needed: the other side runs a syncom node and the protocol goes over wrpc as it is — the recipes are
[HTTP and Server-Sent Events](./wrpc#over-http-and-server-sent-events), [thin clients over HTTP](./wrpc#thin-clients-over-http),
[WebSocket](./wrpc#dialing-a-node), [WebRTC](./webrtc), [a broker as the hubs' shared log](./scaling#a-shared-log) and
[end-to-end encryption](./scaling#end-to-end-encryption).

Every adapter answers `{ pull, push }` to spread into `replicate()`'s options (GraphQL the sides it was given), and
keeps in memory what a compare-and-set needs — the revision or the stamp it last saw for each document — for the
connector's life: a connector started anew learns them with its first pull, and a push of a document it has never
seen lands as a new one, a conflict where one exists, as it should. A conflict is answered as the backend holds the
document, so the connector sets the record to it ([conflicts](#what-goes-out)). A probe — a row with `assumed:
undefined`, what the connector sends after a restart for a record whose state it knows by digest alone — is
answered the same way, as the backend holds the document (a deletion for none), and nothing is written. A document
the backend refuses by name — an id it cannot carry, an attribute it lacks, a body too large — is answered as `{ id,
error: { code, message } }` and the connector parks that row ([refused by name](#what-goes-out)); a failure of the
whole call (the network, a 5xx) is thrown and tried again. A stream that the backend closes says `END`
([live](#live)), and the connector follows again after a backoff.

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
a `_deleted` change a deletion; the stream is `_changes?feed=longpoll` from the checkpoint the connector hands over,
asked again and again (`longpoll` the wait in ms, 60 000; a poll the server never answers is given up after the wait
and ten seconds). A push is `_bulk_docs` with the `_rev` the adapter last saw on each document — the database's
compare-and-set — and a `conflict` answer is the document read back as the database holds it (a 404 a deletion); any
other refusal of a document — an id starting with `_`, which only CouchDB's own documents may have — is that row's
`{ id, error }`, parked by the connector. A probe reads the document back. `fetch` is the platform's unless given,
`headers` ride on every request; credentials in the `url` (`https://user:password@host/db`) move to the
`Authorization` header, so no request's url and no error's message carries them. `revisionOf(id)` says what the
adapter holds. A request that fails is an error with its `status`, which the connector tries again after the backoff.

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
and the rows refused by name (nothing is none); the stream is the application's subscription client, as
`replicate()` takes one. What a compare-and-set needs — a revision on every row, say — is the schema's to carry and
the readers' to remember: the repository's test endpoint answers a `rev` with every document and the rows it refused
as it holds them. A row with `assumed: undefined` is a probe: the `push.variables` should ask the server for the
document as it stands and `push.read` answer it among the refused, writing nothing (the test endpoint's `assumedRev:
null` for an unknown row happens to do the same for a row it holds).

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
a pull is the documents after the checkpoint `{ at, id }` — stamped after it, or stamped the same with a greater
`_id` — in that order, so a batch written within one millisecond is never skipped at a page's edge). The stream is a change stream on the collection, every change
a `RESYNC`, its error or close an `END` — a replica set; `changes: false` without one, and a live connector pulls
every `retryTime`. A push is a `replaceOne` matched on the `_rev` last seen (an upsert for a document never seen; a
duplicate key is a conflict), a conflict is the document read back, a server's code on the document (a validator's
no, a key too large) is that row's `{ id, error }` and an error without a code (the network) the push's failure,
tried again; a probe reads the document back. `revisionOf(id)` says what the adapter holds.

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
ISO date). A pull is the rows after the checkpoint `{ at, id }` — modified after its stamp, or at it with a greater
key, in that order: the rows of one transaction share one `now()` and are never skipped at a page's edge; a push is
an `update` matched on the primary key and the modified value last seen — PostgREST's compare-and-set, no row
matched a conflict; the value kept for the next match is the one the database stored, a trigger's where there is
one, never the adapter's own — or an
`insert` for a row never seen (a duplicate key a conflict), and a conflict is the row read back; a code of the
database's on the row (a check constraint, a type) is that row's `{ id, error }`, an error without a code (the
network) the push's failure, tried again; a probe reads the row back. The stream is Realtime's `postgres_changes` on
the table (`channel`, `syncom:<table>`; `stream: false` for none, and a client without channels has none), every
change a `RESYNC`, the channel's `CHANNEL_ERROR`, `TIMED_OUT` or `CLOSED` an `END`. `stampOf(id)` says what the
adapter holds.

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
ordered by the stamp, then by id, after the checkpoint `{ seconds, nanoseconds, id }` — the stamp whole, as the
server set it (a cursor of milliseconds skipped or repeated the rest of a commit's documents), one cursor, no second
query for the documents stamped at the same instant; a document whose stamp is still pending (a write of the SDK's own cache not yet on the
server) is left to the next pull, and `waitForPendingWrites` is awaited first where the SDK has it. A push is a
transaction per 500 rows (Firestore's limit on a transaction's writes): every row's document read, compared with
what the row assumed, written where it is the same and answered as a conflict where it is not — the transaction's
own reads and writes, so a write that lands between them makes Firestore run the transaction again, and the second
run sees it; a probe is answered as the document stands, nothing written; an id or a body the SDK refuses (a `/` in
the id, the `__name__` form, a nested array) is that row's `{ id, error }`. The stream is `onSnapshot` over the
newest document, every change the server confirmed a `RESYNC`, the listener's error an `END` (`stream: false` for
none).

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
the same is `updateDocument` (a 404 a deletion), a row that differs a conflict answered as the document stands, a
probe the document as it stands with nothing written, and a 400 — an id Appwrite cannot carry (past 36 letters, a
leading `.`), an attribute the collection lacks — that row's `{ id, error }`, parked by the connector (a syncom id is
up to 128 letters: name the records the collection replicates within Appwrite's 36, or let the application mint
them). Appwrite has no compare-and-set write, so a write landing between the read and the update is overwritten — the same
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
`drive.appdata` scope; `folder` a folder's id instead), found by `name` (the oldest by `createdTime`, where two
devices made one each) or taken by `fileId` — through `fetch` and the OAuth `token` (or `headers` carrying the
authorization). The file holds every document with the position of its newest write: a pull answers those after the
checkpoint, in that order, and downloads the file only when its ETag moved; a push writes the file whole under
`If-Match` — the compare-and-set — and a 412 (another device wrote first) reads it again and judges the rows anew, a
few times, before it fails. The ETag comes from the v2 metadata (v3 answers none), the text from `alt=media`, the
write from the media upload. The file is made at the first push, and the list is read again after it: a file older
than ours (another device's first push, made meanwhile) is the collection's — ours is deleted and the rows are judged
against it — so two devices' first pushes into an empty drive end in one file. The first write goes under the fresh
file's ETag like every other; a file whose metadata answers no ETag is refused (428), never written. The stream, where
`poll` is set, probes the ETag every `poll` ms and says `RESYNC` when it moved; without it a live connector pulls
every `retryTime`. A file that is no collection file is refused, never overwritten; an empty file reads as an empty
collection; `fileId()` and `positionOf(id)` say what the adapter holds. There is no lock file and no file per
document: one ETag decides, and a collection stays one upload. (The v2 metadata's ETag against the v3 media upload's
`If-Match` is what the adapter does by reading the API's documentation; it has not been run against Drive here — if
the upload answers 412 for every write, the v2 upload endpoint takes the same `If-Match`.)

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
`/content` the text, and `PUT root:/<path>:/content` writes it — under `If-Match` in place, or, where no file is known,
with `@microsoft.graph.conflictBehavior=fail`, so a file another device made first is a 409, read and judged like a
412 rather than overwritten — a simple upload, so the collection file stays under Graph's 4 MB (`drive` names another
drive than `me/drive`). Everything else — the positions, the retries on a 412 or a 409, the probe for the stream,
`positionOf` — is the Google Drive adapter's.
