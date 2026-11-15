---
title: GraphQL replication
description: Replicate a collection with your GraphQL API through a connector, with the queries, the readers and the subscription client your schema needs.
---

# GraphQL replication

Choose the GraphQL adapter when your backend already speaks GraphQL, or you would rather add two fields to a schema
than write REST endpoints. A GraphQL schema is yours, so the adapter does not guess one: you give it the pull query,
the push mutation, a function that turns the connector's arguments into each one's variables and a function that
reads each answer. It posts them over `fetch` (or your own client), and your subscription client tells it when to
pull again. It is a [connector](./connectors), about 2 KB, and it knows no schema at all.

<div class="sc-steps">

### Add the two operations to your schema

The pull answers the tasks changed after a checkpoint and the checkpoint after them. The push takes rows and answers
the ones it did not write. A subscription is optional; it only has to say that something changed.

```graphql
scalar JSON

type TaskDocument {
  id: ID!
  data: JSON
  deleted: Boolean!
}
type TaskPage {
  documents: [TaskDocument!]!
  checkpoint: Int!
}
input TaskRow {
  id: ID!
  data: JSON
  deleted: Boolean!
  assumed: JSON
}
type PushResult {
  conflicts: [TaskDocument!]!
}

type Query {
  pullTasks(since: Int, limit: Int!): TaskPage!
}
type Mutation {
  pushTasks(rows: [TaskRow!]!): PushResult!
}
type Subscription {
  taskChanged: Int!
}
```

The resolvers do what the [HTTP](./replication-http) page's endpoints do. `pullTasks` answers the tasks written after
the change number `since`, oldest first. `pushTasks` writes a row only when the server still holds what the row's
`assumed` says, and answers every other row as the server holds it. A row that arrives without `assumed` (absent, not
`null`) is a probe the client sends after a restart: answer it and write nothing.

### Connect the collection

<<< @/examples/replication-graphql.mjs#replicate

`pull.variables(checkpoint, batchSize)` and `push.variables(rows)` build the variables; `pull.read(data)` answers
`{ documents, checkpoint }` and `push.read(data)` the conflicts, each from the `data` of the answer. The stream is
your subscription client's, passed as `replicate()` takes one: here every `taskChanged` event becomes a `RESYNC`, and
a subscription that errs or completes says `END`, so the connector subscribes again after a backoff.

### Watch it work

<<< @/examples/replication-graphql.mjs#use

### Use your own GraphQL client

When the app already has a GraphQL client (with its auth, retries and cache rules), pass `request(query, variables)`
instead of `url`. It answers the `data` of the operation.

<<< @/examples/replication-graphql.mjs#request

</div>

## Options that matter

| Option | Meaning |
| --- | --- |
| `url`, `fetch`, `headers` | Where `{ query, variables }` is posted as JSON, with which `fetch` (the global one by default) and which headers |
| `request(query, variables)` | Your own client instead of `url`: answers the operation's `data` |
| `pull.query`, `pull.variables(checkpoint, batchSize)`, `pull.read(data)` | The pull: `read` answers `{ documents, checkpoint }` |
| `push.query`, `push.variables(rows)`, `push.read(data)` | The push: `read` answers the conflicts, and `{ id, error }` for rows refused by name; nothing for none |
| `stream(emit, { checkpoint })` | Your subscription, as `replicate()` takes a stream |

Either side may be left out for a pull-only or push-only connector. The connector's own options (`batchSize`,
`retryTime`, `resolve`, `modifier`) work as on the [Connectors](./connectors) page.

## Limitations

- **The schema carries the compare-and-set.** The adapter posts what your `variables` build; if the server should
  check a revision rather than the data, return the revision with every document and keep it in your readers.
- **An answer with `errors` fails the whole call.** The connector retries it after a backoff and reports it as the
  `cause` of a `REPLICATION_FAILED` error, with the server's `errors` on it (an HTTP failure carries its `status`).
  A row the server cannot write at all (an id it refuses, a body too large) belongs in the push answer as
  `{ id, error: { code, message } }`, which needs a field for it in your schema, so the rest of the batch still lands.
- **Tell an absent `assumed` from `null`.** `null` means "you held nothing" and the row should be written; absent
  means a probe. GraphQL keeps the two apart, but a resolver that fills defaults may not.
- **No schema generation.** The adapter does not derive a schema or queries from your collection; it fits any schema
  because it writes none.

## Coming from RxDB

RxDB's GraphQL plugin builds the queries through query builder functions, can generate a schema from an `RxSchema`,
and opens the subscription over `graphql-ws` itself. Here you pass the query text and two small functions per side, and
the subscription stays in your client, so any transport works. Documents and rows have the connector's shape (`{ id,
data, deleted }` and `assumed`), not RxDB's `_deleted` and `assumedMasterState`.

<FromRxdb page="replication-graphql" :rows="['graphql', 'foreignBackend']" />
