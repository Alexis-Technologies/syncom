---
title: Connectors
description: Keep a collection in step with a backend that does not run syncom, through a pull handler, a push handler and a checkpoint.
---

# Connectors

Your task board syncs between the server, the laptop and the phone, but the company also has a REST API that
other apps read and write, and it owns the tasks too. Those apps will never run syncom. A connector keeps one
collection in step with such a backend: it pulls the backend's changes since a checkpoint and lands them as
writes of this node, and it pushes this node's changes back, telling the backend what it assumed was there so a
change made behind its back is caught as a conflict.

`@alexify/syncom/connector` is the mechanism, and adapters beside it write the two handlers for
[CouchDB](./replication-couchdb), [GraphQL](./replication-graphql), [MongoDB](./replication-mongodb),
[Supabase](./replication-supabase), [Firestore](./replication-firestore), [Appwrite](./replication-appwrite),
[Google Drive](./replication-google-drive) and [OneDrive](./replication-onedrive). For your own API you write the
handlers yourself, which is what this page does. [HTTP](./replication-http) shows the same over a real server.

## When to use a connector

Use a connector when the other side is a system you do not control or that does not run syncom: an existing
database, a SaaS backend, a file in the user's cloud drive. When the other side can run syncom (your own server, a
worker, another device), use [native sync](./replication) instead. Native sync replicates every operation with its
full history, merges counters, sets and text field by field, and needs no code from you; a connector sees whole
documents and leaves the backend's own rules in charge.

The two work together. A record a connector pulls is an ordinary write of the node that runs it, so it reaches
every peer of that node through native sync, and a write any peer makes goes out to the backend through the
connector. Run one connector per backend: two nodes that each push what the other pulled turn every write into a
conflict.

<FigConnector />

## Connect a collection to a backend

A connector takes a database, a `name` that keys its checkpoint, the `collection` it keeps in step, and two
handlers. Here `api` stands for your backend's client: `changes()` reads its change feed and `bulk()` writes rows.

<<< @/examples/connectors.mjs#connect

`replicate()` starts at once. It pulls every page the backend has since the checkpoint (none the first time), pushes
what the collection holds that the backend does not, and then follows both sides. `awaitInitialReplication()`
resolves once the first pull and the first push have both succeeded; a failed first attempt keeps it waiting for
the retry rather than rejecting.

## Write the pull handler

The pull handler receives the checkpoint the last pull returned (`null` the first time) and a `batchSize` (100 by
default). It answers a page of documents changed since that position, oldest first, and the position after them.
A document is `{ id, data }`, or `{ id, deleted: true }` for a deletion; `data` holds the fields alone, without the
collection's `$type`, which the connector adds as the document lands.

The checkpoint is whatever your backend can resume from: a sequence number, a timestamp with an id to break ties, an
opaque cursor. The connector stores it and hands it back unchanged. It keeps asking until a page comes back shorter
than `batchSize`, so a backend that answers full pages forever at the same position is asked three times and then
left alone until the next pull.

Each page lands as one transaction of this node's writes, with `source: 'connector:<name>'` on its
[`transaction` event](./hooks). A document the connector knows the backend already held, such as this node's own
push coming back through the change feed, makes no write, and neither does one that reads as the record already
does. A document that cannot land (a record of another collection, an [encrypted](./encryption) one, a value that
is not JSON, one a [validator](./schema-validation) refuses) is left out and reported, and the rest of the page
lands.

## Write the push handler

Every change to a record of the collection, made here or arriving from a peer, becomes a row for the push handler:

<<< @/examples/connectors.mjs#write

A row is `{ id, data, deleted, assumed }`. `data` is the record as this node reads it (null with `deleted: true` for
a deletion), and `assumed` is the backend's state as this node last saw it: what it pulled, what it pushed, or what
a conflict reported, and `null` for a record the backend has never held. A backend that writes a row only when it
still holds what the row assumed (a compare-and-set, the way an `If-Match` header compares an ETag) catches every
change made behind the connector's back.

The handler answers the rows the backend did not write. A row it refused because the backend holds something else is
answered as the backend holds it, `{ id, data }` or `{ id, deleted: true }`: that is a conflict, and the next
section shows what happens to it. A row it cannot write at all is answered `{ id, error }`. Every row not in the
answer counts as written. One push is in flight at a time, `batchSize` rows per call.

## Follow the backend's changes live

Without a stream, a live connector pulls again every `retryTime` (5 seconds by default). When your backend can tell
you something changed (a WebSocket message, Server-Sent Events, a database change feed), give the pull side a
`stream`:

<<< @/examples/connectors.mjs#stream

The connector subscribes once its first pull is through and hands the stream the checkpoint it left. The stream calls
`emit()` with one of three things. `emit('RESYNC')` asks for a pull from the checkpoint, which is all most streams
need. `emit({ documents })` hands over a page directly; it lands like a pulled page but never moves the checkpoint,
so a page that fails to land is pulled again rather than lost. `emit('END')` says the backend closed the stream: the
connector subscribes again after a backoff and pulls what it missed.

A stream can go quiet without saying so, so a connector with a stream still pulls every `safetyTime` (60 seconds;
`0` turns it off). Pass `live: false` for a connector that pulls and pushes once at the start and afterwards only
pushes the collection's changes and pulls when you call `reSync()`.

## Decide what wins when both sides changed a record

When another app edits a record while this node has its own edit waiting to go out, the push assumes the old state
and the backend refuses it. The backend wins by default: the record is set to the backend's state here, and the
local edit is dropped rather than written over a change it never saw.

<<< @/examples/connectors.mjs#conflict

The same holds when the conflict shows up on the pull side first: a pulled document that differs from what this node
assumed, over a local edit not yet pushed, is a conflict too, never a silent overwrite of the edit. Each conflict is
a `conflict` event with the record as it was here (`local`), the backend's state (`remote`) and what the record became
(`resolved`).

To decide yourself, pass `resolve`. It receives `{ id, local, remote, deleted }` and returns the data to keep, `null`
to delete the record, or anything else (such as `undefined`) to take the backend's state:

<<< @/examples/connectors.mjs#resolve

The resolution lands here and goes back to the backend with the backend's state as what it assumed. A `resolve` that
throws is logged and the backend wins.

## Reshape documents between the two sides

When the backend's documents do not look like your records, `modifier.pull(data, id)` reshapes a document before it
lands and `modifier.push(data, id)` reshapes a record before it goes out:

<<< @/examples/connectors.mjs#modifier

The connector remembers and compares the backend's own shape, so `assumed` and a conflict's comparison use the
document as the backend holds it. A modifier that throws on a document leaves that document out (`refused` with the
reason `modifier`).

## Know where a connector stands

A connector is an event emitter. `received` and `sent` report each page, `conflict` each conflict, `refused` each
document or row left out and why, `error` each failure, and `active` when it starts and stops:

<<< @/examples/connectors.mjs#events

`stats()` counts what went through: documents pulled and applied, rows pushed and probed, conflicts, refusals,
and how many records are pending or parked. `checkpoint` is `{ pull, pushed }`, and `errors` keeps the newest twenty
failures. With the [telemetry](./telemetry) plugin the same counts are the `syncom.connector.rows` metric.
`awaitInSync()` resolves once nothing waits to go out and nothing is in flight in either direction.

## When the backend is down

A handler that throws is reported as an `error` event carrying `REPLICATION_FAILED`, the `direction` (`'pull'` or
`'push'`) and `retryIn`, the wait before the next attempt. The wait starts at `retryTime`, doubles with each failure
in a row up to `maxRetryTime` (60 seconds by default), and varies by a quarter either way so that many clients do not
retry in step. The first success resets it. Nothing is skipped: the rows stay pending and the checkpoint stays where
it was, so the retry picks up exactly what failed. A failing push never delays the pull's retry, or the other way
around.

## Rows the backend refuses outright

Some rows can never be written: an id the backend cannot store, a body over its size limit. Answer such a row with
`{ id, error }` instead of a document, and the connector sets it aside:

<<< @/examples/connectors.mjs#refused

A parked row is reported once as `refused` with `direction: 'push'` and the error's `code` as the `reason`, and the
rest of the batch goes on. The next change to that record tries it again, and so does `reSync()`, which pulls and
pushes again from the checkpoint. A restart does not retry a parked row by itself.

## Restart where you left off

The checkpoint lives in the database, so a connector created again with the same `name` resumes. The backend is
pulled from the saved position, and every change the log holds since the last push goes out:

<<< @/examples/connectors.mjs#restart

After a restart the connector knows the backend's state of each record only by a short digest, so the first push of
such a record asks the backend what it holds instead of writing (a probe: `assumed` is `undefined`), then writes on
the next round with that state assumed. An edit made offline still goes through the compare-and-set, and a backend
that changed the record meanwhile is a conflict, never a silent loss. Where the log can no longer resume from the
saved position, every record of the collection is checked against the backend once.

## Stop a connector

<<< @/examples/connectors.mjs#cancel

`cancel()` stops the stream and the timers, waits for what is in flight and saves the checkpoint. Closing the
database cancels its connectors the same way, so no handler runs after `close()`. A canceled connector stays
canceled: `start()` on it throws `REPLICATION_FAILED`, and you create a new one with the same `name` to go on.
Pass `autoStart: false` to create a connector without starting it and call `start()` yourself.

## Write your own adapter

An adapter is a function that takes the backend's client from the application and answers `{ pull, push }` for
`replicate()`. The adapters syncom ships require nothing: they take `fetch`, the driver's collection or the vendor's
SDK as an argument, so the backend's code stays a dependency of your app, not of syncom.

<<< @/examples/connectors.mjs#adapter

Three rules keep an adapter correct. Answer a conflict as the backend holds the document, never as a guess, and a
deletion where it holds nothing. Answer a probe, a row whose `assumed` is `undefined`, the same way and write
nothing; a backend that compares revisions rather than data cannot tell a probe from a write, so the adapter must.
And throw only for a failure of the whole call (the network, a 5xx): a row the backend refuses by name is that row's
`{ id, error }`, so the rest of the batch still lands.

Where the backend needs a revision for its compare-and-set (CouchDB's `_rev`, an ETag), keep the last one you saw per
document in the adapter's memory and send it with the write. A restarted adapter learns them again with its first
pull, and a write of a document it has not seen yet is a create, which the backend refuses as a conflict if the
document exists.

## Adapters that ship with syncom

| Backend | Import | How it catches a change made elsewhere | Live changes |
| --- | --- | --- | --- |
| [CouchDB](./replication-couchdb) | `@alexify/syncom/connector/couchdb` | `_rev` on `_bulk_docs` | `_changes` long poll |
| [GraphQL](./replication-graphql) | `@alexify/syncom/connector/graphql` | whatever your schema carries | your subscription client |
| [MongoDB](./replication-mongodb) | `@alexify/syncom/connector/mongodb` | `replaceOne` matched on `_rev` | change stream (replica set) |
| [Supabase](./replication-supabase) | `@alexify/syncom/connector/supabase` | `update` matched on the modified column | Realtime `postgres_changes` |
| [Firestore](./replication-firestore) | `@alexify/syncom/connector/firestore` | a transaction's own reads | `onSnapshot` |
| [Appwrite](./replication-appwrite) | `@alexify/syncom/connector/appwrite` | none: a read, then a write | Realtime |
| [Google Drive](./replication-google-drive) | `@alexify/syncom/connector/gdrive` | the file's ETag (`If-Match`) | an ETag probe every `poll` ms |
| [OneDrive](./replication-onedrive) | `@alexify/syncom/connector/onedrive` | the file's eTag (`If-Match`) | an eTag probe every `poll` ms |

## Trade-offs

- **Documents, not operations.** The backend sees whole documents and keeps its own rules, and a conflict with it is
  decided per document, not merged field by field.
- **Plain fields.** A pulled document is written as a whole record of plain fields. A field you made a counter or a
  set with `inc()` or `add()` refuses a pulled value (the whole document is `refused` with the reason `FIELD_KIND`),
  and `inc()` on a field that came from the backend fails with `FIELD_KIND`. Keep a connector's collection to plain
  fields; [fields that merge](./fields) are for native sync.
- **One collection per connector.** A document lands in the connector's collection and never adopts or deletes a
  record of another one.
- **JSON only.** A value the backend's SDK hands over that is not JSON (a `Date`, a `Timestamp`, a reference) is never
  flattened into a string: the document is refused with the reason `value`. The check runs before `modifier.pull`, so
  convert such values in the pull handler itself (wrap an adapter's `pull.handler` to do it).
- **Encrypted records stay local.** A record [encrypted at rest](./encryption) is never pushed, and a pulled document
  never replaces one.
- **One connector per backend.** On a mesh, run it on one node; with [several tabs](./leader-election), in one tab.
  syncom does not pick that instance for you yet.

## Coming from RxDB

A connector is syncom's `replicateRxCollection()`: a pull handler with a checkpoint, a push handler whose rows carry
what the client assumed, a stream that can say `RESYNC`, and the backend winning a conflict unless you decide. The
shapes differ in small ways. A document is `{ id, data, deleted }` rather than the record with `_deleted` mixed in,
the stream is a callback that returns its stop function rather than an Observable, and conflicts are decided per
connector with `resolve` rather than by the collection's conflict handler. syncom does not keep a copy of every
document as the backend last held it; it keeps that state in memory and a digest on disk, and after a restart it asks
the backend (a probe) before it writes. A failure is retried with a growing wait rather than every `retryTime`.

::: code-group

<<< @/examples/connectors.mjs#connect [syncom]

<<< @/examples/rxdb/connectors.mjs#replicate [RxDB]

:::

The full list of members is in the [reference](../reference/api#connector-subpath).

## How the connector decides

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | (required) | The checkpoint's key in the `connector` key-value namespace: letters, digits, `_`, `.`, `-` (up to 101 characters, not starting with `.`) |
| `collection` | (required) | The collection replicated |
| `pull.handler(checkpoint, batchSize)` | | Answers `{ documents: [{ id, data, deleted }], checkpoint }` |
| `pull.stream(emit, { checkpoint })` | | Calls `emit({ documents })`, `emit('RESYNC')` or `emit('END')`; returns what stops it |
| `push.handler(rows)` | | Takes `[{ id, data, deleted, assumed }]`; answers conflicts `[{ id, data, deleted }]` and rows refused by name `[{ id, error }]` |
| `live` | `true` | Follow the backend after the first pull: its stream, or a pull every `retryTime` |
| `retryTime` | `5000` | The first wait after a failure (doubled per failure in a row), and the pull interval without a stream, in ms |
| `maxRetryTime` | `60000` | The longest wait between retries, in ms; at least `retryTime` |
| `safetyTime` | `60000` | With a stream, a pull from the checkpoint this often anyway, in ms; `0` for none |
| `batchSize` | `100` | Documents per pull, rows per push |
| `modifier` | | `{ pull(data, id), push(data, id) }` |
| `resolve` | | `({ id, local, remote, deleted })` → the data to keep, `null` to delete, anything else for the backend's state |
| `autoStart` | `true` | Start at once |

At least one of `pull` and `push` is required; a connector with one side only replicates in that direction. Every
other wrong option is a `TypeError` thrown by `replicate()`.

### What a pulled document is judged against

A pulled document is compared with the backend's state as this node knows it (what it pulled, pushed, or learned in a
conflict), not with the record alone:

- **The state already known** is an echo: this node's own write come back, or another client's write that left the
  document as it was. It makes no write. Over a local edit not yet pushed it changes nothing either, because the push
  compares that edit against the same state. Over a record that reads otherwise with nothing pending, it lands.
- **Another state over a local edit not yet pushed** is a conflict: `resolve` decides or the backend wins, the
  resolution lands in the page's transaction, and the `conflict` event follows.
- **Another state over a record with nothing pending** is the backend's newer state and lands, unless the record
  already reads that way.

A document that is no document (no valid record id, no object as `data` without `deleted: true`) is logged as
`connector.document.malformed` and skipped. A document that cannot land is a `refused` event
`{ direction: 'pull', id, reason, cause }` and the rest of the page lands, the checkpoint moving past it. The reasons:
`collection` (the id belongs to a record of another collection, a tombstone included), `sealed` (an encrypted
record), `value` (not JSON), `modifier` (`modifier.pull` threw or returned no object), or the code of the write the
engine refused (a validator's `VALIDATION_FAILED`, a field's `TypeError`). A landing that fails as a whole (the
engine, the database closing) is the pull's failure: `REPLICATION_FAILED`, the checkpoint unmoved, tried again.

Pulled writes carry `source: 'connector:<name>'` on their `transaction` event and `actor: 'connector:<name>'` on their
ops; a resolution's ops carry `actor: 'connector:<name>:resolve'`, and a resolution landed after a push carries
`source: 'connector:<name>:resolve'`.

### What goes out, and how the answer is read

Every turn of the database that changed a record of the collection is pushed: a local write, a transaction, a peer's
page, a joined snapshot. This connector's own pulls are not. A row whose data equals the state the backend is known to
hold is not sent (a resolution the backend won, a change that leaves the record as the backend has it). An encrypted
record never goes. A change that arrives while its row is in flight is pushed again after that push.

The handler's answer is read row by row:

- **Not in the answer**: written. Its state is what the next push assumes.
- **`{ id, error }`**: refused by name. The row is parked (`refused` with `direction: 'push'` and `reason` the error's
  `code`, or `backend` without one) until a change to the record or `reSync()`.
- **`{ id, data }` or `{ id, deleted: true }`**: a conflict. The record is set to the backend's state, or to what
  `resolve` returns, in one transaction; the `conflict` events follow once it has landed. The id stays pending: equal
  to the backend's state it says nothing more, different it goes again with that state assumed. A resolution the
  engine refuses is a `refused` event with `direction: 'push'`, and the record stands.
- **Neither a document nor an error**: parked with the reason `answer`.

A backend that refuses a row which assumed exactly what the backend says it holds, twice in a row, contradicts
itself: the row is parked with the reason `conflict` rather than pushed in a loop. A `modifier.push` that throws parks
nothing but leaves that row out (`refused`, reason `modifier`).

`modifier.pull` turns the backend's shape into the record's, `modifier.push` the record's into the backend's. What the
connector remembers and compares is the backend's shape: a document as it came (before `modifier.pull`), a row as it
went (after `modifier.push`). A conflict's `remote` passes through `modifier.pull`, and a resolution goes back through
`modifier.push`.

### The checkpoint

One JSON text in the database's `connector` key-value namespace, under the connector's `name`, holds what a restart
needs:

```json
{ "pull": 42, "pushed": "mw6l.17", "known": { "t1": "b-SQXlGHTSadY8-j1RK7Vt", "t2": null } }
```

`pull` is the backend's position as the pull handler last returned it. `pushed` is this node's log position pushed
through; it never passes a change still waiting to go, so a restart pushes every pending change again (at least once,
never lost). `known` names the backend's state per record: 22 characters of the SHA-256 (base64url) of the canonical
JSON of the backend's shape, `null` where the backend holds nothing, no entry for a record gone on both sides. That is
about 50 bytes a record. The text is saved coalesced (one write in flight, the next 200 ms later while pages keep
landing) and at once at the end of a pull run, after a push, after a page of the stream and on `cancel()`. A crash
between a landing and its save lands that page again.

In memory the connector keeps the backend's state as text for up to 10 000 records (the oldest not pending forgotten
first); a push of a record known only by digest is a probe. `start()` reads the checkpoint, pulls from `pull` (judging
a document by its digest where the text is not in memory, so this node's own echo over an offline edit is skipped),
then pushes what the log holds since `pushed`. Where the log cannot resume there (compacted past it, another epoch, a
connector never run) every live record of the collection is probed once (`connector.rebuild` in the log): equal
records say nothing, differing ones are conflicts, records the backend lacks are created.

### Live, retries and waiting

The live side begins once the first pull run is through. Everything the pull side lands, the pages of a pull run and
the pages of the stream, goes through one queue in order, and a landing and a push take turns, so neither judges a
record against a state the other is changing. A `RESYNC` while a pull runs makes that run go once more after its
pages. A page of the stream delivered out of order is judged again by the next pull.

A failure in either direction is kept (`errors`, the newest twenty), logged as `connector.failed`, and retried after
`retryTime · 2^n` ms (n the failures in a row in that direction), capped at `maxRetryTime`, times a random factor
between 0.75 and 1.25. `reSync()` on a connector that is not active rejects with `REPLICATION_FAILED` and a `null`
direction, and `start()` on a canceled one throws the same.

`awaitInitialReplication()` resolves when the first pull run and the first push drain have both succeeded;
`awaitInSync()` when, in addition, nothing is pending, no push is in flight and nothing waits on the pull queue. Both
take `{ signal }` to stop waiting, and both reject once the connector is canceled.
