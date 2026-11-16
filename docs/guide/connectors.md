---
title: Connectors
description: Keep a collection in step with a backend that does not run syncom, through a pull handler, a push handler and a checkpoint.
---

# Connectors

Your task board syncs between the server, the laptop and the phone, but the company also has a REST API that
other apps read and write, and it owns the tasks too. Those apps will never run syncom. A connector keeps one
collection in step with such a backend: it pulls the backend's changes since a checkpoint and lands them as
writes of this [node](./glossary#node) (the database the connector runs in), and it pushes this node's changes back,
telling the backend what it assumed was there so a change made behind its back is caught as a conflict.

`@alexify/syncom/connector` is the mechanism, and adapters beside it write the two handlers for
[CouchDB](./replication-couchdb), [GraphQL](./replication-graphql), [MongoDB](./replication-mongodb),
[Supabase](./replication-supabase), [Firestore](./replication-firestore), [Appwrite](./replication-appwrite),
[Google Drive](./replication-google-drive) and [OneDrive](./replication-onedrive). For your own API you write the
handlers yourself, which is what this page does. [HTTP](./replication-http) shows the same over a real server.

## When to use a connector

Use a connector when the other side is a system you do not control or that does not run syncom: an existing
database, a SaaS backend, a file in the user's cloud drive. When the other side can run syncom (your own server, a
worker, another device), use [native sync](./replication) instead. Native sync replicates every
[op](./glossary#op) with its full history, merges counters, sets and text field by field, and needs no code from
you; a connector sees whole documents and leaves the backend's own rules in charge.

The two work together. A record a connector pulls is an ordinary write of the node that runs it, so it reaches
every peer of that node through native sync, and a write any peer makes goes out to the backend through the
connector. Run one connector per backend: two nodes that each push what the other pulled turn every write into a
conflict.

<FigConnector />

### Counters and sets stay out of a connector's collection

A connector's collection holds plain fields only, so the Quickstart's `votes` (a counter) and `tags` (a set) do not
belong in one. The backend stores whole documents of plain values: it cannot hold a counter's count per node or a
set's concurrent adds, so everything the connector pulls lands as plain fields, and `inc()`, `add()` or `remove()` on
such a field rejects with `FIELD_KIND`. A field you make a counter or a set here goes out as a plain value, but the
backend's next version of that record is refused with `FIELD_KIND` and never lands. Write such fields as plain
values (`update(id, { votes: 4 })`), and keep [fields that merge](./fields) to collections that sync natively.

## Connect a collection to a backend

A connector takes a database, a `name` that keys its checkpoint, the `collection` it keeps in step, and two
handlers. Here `api` stands for your backend's client: `changes()` reads its change feed and `bulk()` writes rows.

<<< @/examples/connectors.mjs#connect

In your app, `api` is your REST client, SDK or driver. On this page it is a stand-in, a backend kept in memory by
the example file: `changes()` and `bulk()` as above, `write()` playing another app that writes to the backend,
`read()` showing what the backend holds, and `refuse()` making it refuse one row. Every example below builds on this
one: `board`, `api` and `handlersFor` come from it.

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

A document your database refuses is not taken as the backend's state, so neither side wins over it. An edit you make
to that record later goes out assuming the state this node last landed, meets the backend's version as a conflict,
and `resolve` decides; it never writes over the backend's version unseen. On a connector with a push handler,
`reSync()` asks the backend again for every document refused this way, even after a restart, so a document an older
version of your schema refused lands once the database accepts it.

## Write the push handler

Every change to a record of the collection, made here or arriving from a peer, becomes a row for the push handler:

<<< @/examples/connectors.mjs#write

A row is `{ id, data, deleted, assumed }`. `data` is the record as this node reads it (null with `deleted: true` for
a deletion), and `assumed` is the backend's state as this node last saw it: what it pulled, what it pushed, or what
a conflict reported, and `null` for a record the backend has never held. A backend that writes a row only when it
still holds what the row assumed (a compare-and-set, the way an `If-Match` header compares an ETag) catches every
change made behind the connector's back.

The handler answers the rows the backend did not write. A row it refused because the backend holds something else is
answered as the backend holds it, `{ id, data }` or `{ id, deleted: true }`: that is a conflict, and
[Decide what wins](#decide-what-wins-when-both-sides-changed-a-record) shows what happens to it. A row it cannot
write at all is answered `{ id, error }`. Every row not in the answer counts as written. One push is in flight at a
time, `batchSize` rows per call.

## Follow the backend's changes live

Without a stream, a live connector pulls again every `retryTime` (5 seconds by default). When your backend can tell
you something changed (a WebSocket message, Server-Sent Events, a database change feed), give the pull side a
`stream`. A connector's options are fixed when you create it, so the example cancels the first one and creates it
again under the same `name`, which resumes from the checkpoint the first one saved:

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

When another app edits a record while this node has its own edit waiting to go out, the two meet as a conflict. The
backend wins by default: the record is set to the backend's state here, and the local edit is dropped rather than
written over a change it never saw. Here the connector is stopped while both sides edit `t2`, as when the app is
offline, and started again:

<<< @/examples/connectors.mjs#conflict

The restarted connector pulls first, and the backend's new `t2` arrives over an edit this node has not pushed yet: a
conflict, never a silent overwrite of the edit. When the push meets the change first, it assumes the old state, the
backend refuses it, and the outcome is the same. Each conflict is a `conflict` event with the record as it was here
(`local`), the backend's state (`remote`) and what the record became (`resolved`).

To decide yourself, pass `resolve`. It receives `{ id, local, remote, deleted }` and returns the data to keep, `null`
to delete the record, or anything else (such as `undefined`) to take the backend's state. The example goes offline
once more, and both sides edit `t3`:

<<< @/examples/connectors.mjs#resolve

The resolution lands here and goes back to the backend with the backend's state as what it assumed. A `resolve` that
throws is logged and the backend wins. When your database refuses the resolution (a validator says no to the
backend's state), neither side wins: the record keeps your edit, the backend keeps its version, and the row is set
aside as `refused` until the record changes again or you call `reSync()`, each of which meets the same conflict.

## Reshape documents between the two sides

When the backend's documents do not look like your records, `modifier.pull(data, id)` reshapes a document before it
lands and `modifier.push(data, id)` reshapes a record before it goes out. Here `legacy` is a second stand-in like
`api`, an older backend whose documents say `name` and `completed`; it is another backend, so it gets a connector of
its own beside the first:

<<< @/examples/connectors.mjs#modifier

The connector remembers and compares the backend's own shape, so `assumed` and a conflict's comparison use the
document as the backend holds it. `modifier.pull` is also where a value of the backend's SDK becomes JSON (a `Date`
an ISO string, a `Timestamp` a number), since what it answers must be JSON. A modifier that throws on a document
leaves that document out (`refused` with the reason `modifier`).

## Know where a connector stands

A connector is an event emitter. `received` and `sent` report each page, `conflict` each conflict, `refused` each
document or row left out and why, `error` each failure, and `active` when it starts and stops. The listeners here go
on `merging`, the connector the `resolve` example started:

<<< @/examples/connectors.mjs#events

`stats()` counts what went through: documents pulled and applied, rows pushed and probed, conflicts, refusals,
and how many records are pending or parked. `checkpoint` is `{ pull, pushed }`, `errors` keeps the newest twenty
failures, and `parked` lists the rows set aside, each with its reason. With the [telemetry](./telemetry) plugin the
same counts are the `syncom.connector.rows` metric.
`awaitInSync()` resolves once nothing waits to go out and nothing is in flight in either direction.

## When the backend is down

A handler that throws is reported as an `error` event carrying `REPLICATION_FAILED`, the `direction` (`'pull'` or
`'push'`) and `retryIn`, the wait before the next attempt. The wait starts at `retryTime`, doubles with each failure
in a row up to `maxRetryTime` (60 seconds by default; both are options of `replicate()`), and varies by a quarter
either way so that many clients do not retry in step. The first success resets it. Nothing is skipped: the rows stay
pending and the checkpoint stays where it was, so the retry picks up exactly what failed. A failing push never delays
the pull's retry, or the other way around.

## Rows the backend refuses outright

Some rows can never be written: an id the backend cannot store, a body over its size limit. Answer such a row with
`{ id, error }` instead of a document, and the connector sets it aside:

<<< @/examples/connectors.mjs#refused

A parked row is reported once as `refused` with `direction: 'push'` and the error's `code` as the `reason`, and the
rest of the batch goes on. The next change to that record tries it again, and so does `reSync()`, which pulls and
pushes again from the checkpoint. `parked` lists the rows set aside as `{ id, reason }`, which is what you show a
user whose change did not reach the backend.

A restart does not retry a parked row by itself, and it does not forget it either. The parked rows are saved with the
checkpoint, so a connector created again under the same `name` still counts them in `stats().parked`, still lists
them in `parked`, and tries each again at the next change to its record or at `reSync()`. A change made to a parked
record while no connector ran is in the [operation log](./operation-log), so the restart pushes that one.

While a row is parked the record keeps your edit. A pull does not land the backend's version over it unseen: the
state the backend already had is skipped, and a newer one is a conflict, decided like any other.

## Restart where you left off

The checkpoint lives in the database, so a connector created again with the same `name` resumes, after a restart of
the app as after a `cancel()`. The backend is pulled from the saved position, and every change the
[operation log](./operation-log) holds since the last push goes out:

<<< @/examples/connectors.mjs#restart

A row the backend refused before the restart, `huge` here, is still parked after it.

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
SDK as an argument, so the backend's code stays a dependency of your app, not of syncom. The example's connector
replaces the one the restart started, so that one is canceled first:

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

## How the connector decides

A pulled document is judged against the backend's state as this node last knew it, not against the record alone:
that is how an echo of this node's own push makes no write and how an unpushed edit is never overwritten in silence.
The push handler's answer is read row by row, and the checkpoint keeps a short digest of the backend's state per
record. Every option with its default, every rule and reason code, the checkpoint's format and the retry timing are
in the [connector reference](../reference/connectors).

## Trade-offs

- **Documents, not operations.** The backend sees whole documents and keeps its own rules, and a conflict with it is
  decided per document, not merged field by field.
- **Plain fields.** A pulled document is written as a whole record of plain fields, so counters and sets stay out of a
  connector's collection ([see above](#counters-and-sets-stay-out-of-a-connector-s-collection)).
- **One collection per connector.** A document lands in the connector's collection and never adopts or deletes a
  record of another one.
- **JSON only.** A value the backend's SDK hands over that is not JSON (a `Date`, a `Timestamp`, a reference) is never
  flattened into a string: unless `modifier.pull` converts it, the document is refused with the reason `value`. A
  `BigInt` is refused even with a modifier, because the connector cannot remember the backend's state of it as JSON.
- **Sealed records stay local.** A record [sealed](./encryption) with `encrypted: true` is never pushed, and a pulled
  document never replaces one.
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

The options and the rules are in the [connector reference](../reference/connectors), and every member is in the
[API reference](../reference/api#connector-subpath).
