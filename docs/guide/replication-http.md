---
title: HTTP replication
description: Replicate a collection with your own HTTP server through a connector, with pull, push and Server-Sent Events endpoints you write.
---

# HTTP replication

Choose this when you already have, or want, an HTTP API of your own as the backend of record: the server keeps the
tasks in its own database, other clients use the same endpoints, and syncom nodes replicate a collection with it
through a [connector](./connectors). You write three endpoints (pull, push, and an event stream) and two handlers
that call them. The whole example below runs as one file: a Node.js server on `node:http` and a syncom node next to
it.

If the server can run syncom itself, you need none of this. A syncom node hosts the native protocol, and other nodes
dial it over wrpc, whose Server-Sent Events transport carries it over plain HTTP: no endpoints to write, and the
records merge field by field instead of document by document ([WebSocket](./replication-websocket) covers the
transports, [Hosting a node](./server) the server side).

<div class="sc-steps">

### Give every write a change number

The server needs one thing beyond its data: a number that grows with every write, so a client can ask for "what
changed after the last number I saw". A deletion stays as a row with no data, or a client that was away would never
hear of it. The equality helper compares JSON whatever the order of its keys; the push endpoint needs it.

<<< @/examples/replication-http.mjs#store

### Serve the pull endpoint

The pull endpoint answers the tasks written after the client's checkpoint, oldest first, at most `limit` of them,
and the change number of the last one as the next checkpoint. Its answer is exactly what a pull handler returns.

<<< @/examples/replication-http.mjs#pull-endpoint

### Serve the push endpoint

Each row the client pushes carries `assumed`, the server's state as the client last saw it. The server writes a row
only when it still holds that state, and answers every other row as it holds it. That answer is a conflict, which the
client settles (the server wins unless the client passes `resolve`). A row with no `assumed` is a probe the client
sends after a restart to ask what the server holds: answer it and write nothing.

<<< @/examples/replication-http.mjs#push-endpoint

### Tell clients when something changed

An event stream lets clients pull as soon as a write lands instead of polling. One message per write is enough: the
client does not read it, it only pulls from its checkpoint.

<<< @/examples/replication-http.mjs#events-endpoint

### Start the server

<<< @/examples/replication-http.mjs#listen

### Replicate from the client

The client's handlers are thin: the pull handler fetches a page, the push handler posts the rows and returns the
conflicts, and the stream turns every event into a `RESYNC`. The connector keeps the checkpoint, retries failed
requests with a growing wait, and lands pulled tasks as writes of this node, so they reach its peers too.

<<< @/examples/replication-http.mjs#client

The stream reads the event stream with `fetch` so the same code runs in Node.js and in a browser; in a browser you
can use `EventSource` instead and call `emit('RESYNC')` from its `message` listener. When the server closes the
stream, `emit('END')` makes the connector subscribe again after a backoff and pull what it missed.

### Watch it work

<<< @/examples/replication-http.mjs#use

</div>

## Options that matter

The pull endpoint's `limit` is the connector's `batchSize` (100 by default), and the push endpoint receives at most
that many rows per request. Without the events endpoint, leave out `stream` and the connector pulls every `retryTime`
(5 seconds by default); with it, it still pulls every `safetyTime` (60 seconds) in case the stream went quiet without
closing. `retryTime` and `maxRetryTime` set how long the client waits after a failed request, and `live: false`
pulls only at the start and on `reSync()`. The [Connectors](./connectors) page covers `resolve`, `modifier`, the
events and the restart.

## Limitations

- **The change number must follow commit order.** The example keeps everything in memory, where the order of writes
  is obvious. In a database, a sequence number assigned when a transaction starts can become visible after a higher
  one, and a client that already pulled past it never sees it. Assign the number at commit, or pull by a timestamp
  and an id the way the [Supabase](./replication-supabase) adapter does and
  [look back](./connectors#pull-by-a-timestamp-without-missing-late-writes) by as long as a write can stay invisible.
- **The push must compare and write atomically.** Read the stored state and write the row in one transaction, or
  with a conditional update (`WHERE` on the stored state or a revision), so two clients cannot both pass the check.
- **Deletions are rows.** Keep a deleted task as a tombstone the pull can report; removing the row loses the deletion
  for every client that was offline.
- **Authentication is yours.** Add headers to the client's `fetch` calls and check them in every endpoint; the
  connector sends nothing of its own.

## Coming from RxDB

This is the same recipe as RxDB's HTTP replication: endpoints you write and a replication with two handlers. The
server compares what the client assumed in both. The shapes differ: a syncom document is `{ id, data, deleted }` and a
push row carries `assumed` beside the data, where RxDB puts the primary key and `_deleted` into the document and sends
`{ assumedMasterState, newDocumentState }`. syncom's stream is a callback returning its stop function, RxDB's an
Observable you feed.

::: code-group

<<< @/examples/replication-http.mjs#client [syncom]

<<< @/examples/rxdb/replication-http.mjs#client [RxDB]

:::

<FromRxdb page="replication-http" :rows="['http', 'foreignBackend', 'adapters']" />
