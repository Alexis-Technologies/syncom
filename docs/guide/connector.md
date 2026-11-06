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

Where the far end speaks a protocol of its own, an adapter beside this module writes the handlers over an injected
client (see the pages of this section as they land). Where the far end is reachable over a wire wrpc already carries
— HTTP and Server-Sent Events, WebSocket, WebRTC, a worker port, a broker (NATS, Redis, Kafka, AMQP) — no connector
is needed: the other side runs a syncom node and the protocol goes over wrpc as it is ([wrpc transport](./wrpc),
[Scaling](./scaling#a-shared-log)).
