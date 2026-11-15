---
title: Connectors
description: "The connector's rules as a specification: every option, how a pulled document is judged, how a push answer is read, the checkpoint and the retries."
---

# Connectors

The specification of `@alexify/syncom/connector` (`src/connector/connector.js`): the options of `replicate()`, how a
pulled document is judged, how the push handler's answer is read, what the checkpoint holds and how the live side,
the retries and the waits behave. The guide's [Connectors](../guide/connectors) page teaches the handlers with a
running example; the members and the events are in the [API reference](./api#connector-subpath).

## Options

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

## What a pulled document is judged against

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

## What goes out, and how the answer is read

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

## The checkpoint

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

## Live, retries and waiting

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
