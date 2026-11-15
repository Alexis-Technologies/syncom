---
title: CouchDB replication
description: Keep a syncom collection in step with a CouchDB database through _changes, _bulk_docs and its revisions.
---

# CouchDB replication

Choose the CouchDB adapter when a CouchDB (or a server that speaks its HTTP API) is the backend of record and other
clients read and write it directly. It keeps one syncom collection in step with one CouchDB database: CouchDB's
`_changes` feed is the pull, a long poll on it is the live stream, and `_bulk_docs` with the revision each document
last had is the push, so CouchDB itself refuses a write over a change the node has not seen. It is a
[connector](./connectors) over `fetch`, about 2 KB, with nothing of CouchDB's bundled.

<div class="sc-steps">

### Create the database

One CouchDB database per collection. Create it once, with the credentials of a user allowed to write it:

```bash
curl -X PUT https://admin:secret@couch.example.com/tasks
```

### Connect the collection

`couchdb()` answers the two handlers; spread them into `replicate()` with a `name` for the checkpoint and the
collection to keep in step.

<<< @/examples/replication-couchdb.mjs#replicate

The first pull reads `_changes` from the start with the documents included, a page of `batchSize` at a time, and
CouchDB's `last_seq` becomes the checkpoint. Once that is through, the adapter long-polls `_changes` from the
checkpoint and hands every answer to the connector as a page.

### Pass credentials

Credentials in the url move to an `Authorization` header, so neither a request's url nor an error message ever
carries them. `headers` adds any header to every request (a bearer token, a cookie, a proxy's key).

<<< @/examples/replication-couchdb.mjs#credentials

### Watch it work

<<< @/examples/replication-couchdb.mjs#use

A deletion goes out as a document with `_deleted: true`, and a `_deleted` change in the feed deletes the record here.
When another client changed a document after this node last saw it, CouchDB answers the push with a `conflict`; the
adapter reads the document back and the connector sets the record to CouchDB's version, unless you pass `resolve`
([conflicts](./connectors#decide-what-wins-when-both-sides-changed-a-record)).

</div>

## Options that matter

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | (required) | The database, `https://host/db`; credentials in it become the `Authorization` header |
| `fetch` | the global `fetch` | The `fetch` the adapter calls: pass one for a custom agent, retries or a test double |
| `headers` | `{}` | Sent with every request |
| `longpoll` | `60000` | How long one long poll waits for a change, in ms; a poll the server never answers is given up 10 s after that |

The adapter also answers `revisionOf(id)`, the `_rev` it last saw for a document. The connector's own options
(`batchSize`, `retryTime`, `resolve`, `modifier`, `live`) work as on the [Connectors](./connectors) page; with
`live: false` the long poll is not started.

## Limitations

- **Only the winning revision crosses.** The adapter reads documents as CouchDB serves them by default, so a
  document with conflicting revisions inside CouchDB (from CouchDB's own replication) arrives as its winner, and the
  losers stay in CouchDB.
- **No attachments.** CouchDB attachments are not replicated, and a document's `_attachments` stubs would arrive as an
  ordinary field. Keep attachments out of a replicated database, or drop the field in `modifier.pull`.
- **Ids starting with `_` are CouchDB's.** A record whose id starts with an underscore is refused by CouchDB; the
  connector parks that row and reports it as `refused` with the reason `bad_request`, and the rest goes on.
- **Revisions are remembered in memory.** After a restart the adapter learns them again with its first pull; a push
  before that is a probe or a create, and CouchDB answers a create over an existing document as a conflict.
- **This is not CouchDB's replication protocol.** A CouchDB or PouchDB peer cannot replicate with a syncom node
  directly; the adapter is a client of the HTTP API.

## Coming from RxDB

RxDB's CouchDB plugin and this adapter make the same calls: `_changes` for the pull and the long poll, `_bulk_docs`
with `_rev` for the push. Here the adapter reads a conflicted document back itself and the connector decides with
`resolve` (the backend wins without one). Credentials can ride in the url, where RxDB asks for a wrapped `fetch`
(`getFetchWithCouchDBAuthorization`), and the url may end with a slash or not, where RxDB requires one.

<FromRxdb page="replication-couchdb" :rows="['couchdb', 'foreignBackend']" />
