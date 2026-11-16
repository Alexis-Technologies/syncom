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
| `pull.handler(checkpoint, batchSize)` | | Answers `{ documents: [{ id, data, deleted }], checkpoint }`, with `reread` where it [looks back](#looking-back) |
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
- **A [parked row](#parked-rows) is a local edit not yet pushed**: the state already known is skipped over it, and
  another state is a conflict.
- **Another state over a record with nothing pending** is the backend's newer state and lands, unless the record
  already reads that way.

A document that is no document (no valid record id, no object as `data` without `deleted: true`) is logged as
`connector.document.malformed` and skipped. A document that cannot land is a `refused` event
`{ direction: 'pull', id, reason, cause }` and the rest of the page lands, the checkpoint moving past it. The reasons:
`collection` (the id belongs to a record of another collection, a tombstone included), `sealed` (an encrypted
record), `value` (what `modifier.pull` returned is not JSON, or the document itself without a modifier; a `BigInt`,
which has no JSON text to remember the backend's state by, even with one), `modifier` (`modifier.pull` threw or
returned no object), or the code of the write the engine refused (a validator's `VALIDATION_FAILED`, a field's
`TypeError`). A landing that fails as a whole (the engine, the database closing) is the pull's failure:
`REPLICATION_FAILED`, the checkpoint unmoved, tried again.

A document refused for what it holds (every reason but `collection` and `sealed`) is not learned: the backend's
state as known stays what this node last landed, and its id is kept (`refused` in the checkpoint). A later edit of
the record is pushed with that state assumed and meets the backend's version as a conflict. When a document of such
a record is pulled, an edit of it counts as one not yet pushed even where nothing else remembers it (a parked row, a
restart): another state over it is a conflict, never a silent landing. `reSync()` first asks the backend about every
such id through the push handler: a record still as last landed is probed (`assumed: undefined`, nothing written) and
the answer is judged as a pulled document, landed or refused again; a record edited since is pushed with the state
known assumed. A connector without a push handler cannot ask, and lands the document when a pull brings it again. A
state learned later (a landing, a push the backend took, its echo) clears the id.

Pulled writes carry `source: 'connector:<name>'` on their `transaction` event and `actor: 'connector:<name>'` on their
ops; a resolution's ops carry `actor: 'connector:<name>:resolve'`, and a resolution landed after a push carries
`source: 'connector:<name>:resolve'`.

## Looking back

A pull that resumes after a timestamp misses a document that becomes visible later with an older stamp: a
transaction that committed late, a replica that lagged, a writer whose clock runs behind. A handler that looks back
asks its backend from before the checkpoint it was handed, and answers `reread`: how many of the page's documents,
the first ones, are at or behind that checkpoint. `reread` is a non-negative integer; anything else fails the pull
(`REPLICATION_FAILED`, a `TypeError` as its cause). A handler that does not look back leaves it out, and nothing
below applies.

A re-read document is passed over, before `modifier.pull` runs and without reading the record, when:

- **it holds the state known** (by the text in memory or the checkpoint's digest; the text is then kept in memory,
  so the next reading compares texts). Nothing lands, even over a record that reads otherwise.
- **it is a deletion and nothing is known of its id.** A record gone on both sides leaves no digest, and an old
  tombstone read again says nothing about a record made here since: it never deletes that record and is never a
  conflict with it.
- **it is refused as it was reported before**: the same document, or, where it was refused before it had a text
  (`collection`, `sealed`, a value JSON has no text for), the same reason; a document that is no document, logged
  as `connector.document.malformed`, is logged once the same way. `reSync()` forgets what was reported, so it judges
  the window anew and reports again what is refused again; a connector started again does the same once.

A passed-over document is not counted (`stats().pulled`, the `syncom.connector.rows` metric), is not part of a
`received` event (a page of nothing else emits none) and is not a `refused` event. Every other re-read document, one
that arrived late or whose state changed without its stamp passing the checkpoint, is judged as any pulled
document: counted, landed, refused, or a conflict over a local edit not yet pushed. `stats().pulls` counts every
call of the handler.

The checkpoint stays opaque to the connector; the handler keeps it from moving back. An adapter reads the one
position it writes: handed anything else (a stamp alone, another adapter's position) it has no checkpoint and pulls
from the beginning, where the connector passes over what it already knows. The adapters:

| Adapter | Cursor | `lookback` |
| --- | --- | --- |
| Supabase | the modified column, then the key | yes; the column must read as a date |
| MongoDB | `_updated`, then `_id` | yes |
| Firestore | the server stamp, then the id | yes |
| Appwrite | `$updatedAt`, then `$id` | yes |
| CouchDB | `last_seq`, a sequence | no: a sequence skips nothing |
| Google Drive, OneDrive | `n`, a sequence inside one file under its ETag | no |
| GraphQL | your schema's | yours: rewind in `pull.variables`, answer `reread` from `pull.read` |

`lookback` is a number of milliseconds, `0` (none) by default; anything but a non-negative number is a `TypeError`.
With it a pull run starts at the checkpoint's stamp minus `lookback`. The checkpoint stays the newest position
pulled through: a document at or behind it moves nothing. A full page answers the checkpoint with `from`, the
position the next page reads on after (`{ at, id, from: { at, id } }` for Supabase and MongoDB, the same fields as
the position for the others), so every full page moves the checkpoint and a window wider than a page is read
through; a run cut short goes on from `from`; the page that comes short carries none, and the next run looks back
again. The adapter remembers nothing of what it handed over: every run reads the window, and a run after a restart
reads as any other. A stamp that does not read as a time (a modified column that is not a date) leaves the plain
cursor. A document that becomes visible more than `lookback` after its stamp is still missed.

## What goes out, and how the answer is read

Every turn of the database that changed a record of the collection is pushed: a local write, a transaction, a peer's
page, a joined snapshot. This connector's own pulls are not. A row whose data equals the state the backend is known to
hold is not sent (a resolution the backend won, a change that leaves the record as the backend has it). An encrypted
record never goes. A change that arrives while its row is in flight is pushed again after that push.

The handler's answer is read row by row:

- **Not in the answer**: written. Its state is what the next push assumes.
- **`{ id, error }`**: refused by name. The row is [parked](#parked-rows) (`refused` with `direction: 'push'` and
  `reason` the error's `code`, or `backend` without one) until a change to the record or `reSync()`.
- **`{ id, data }` or `{ id, deleted: true }`**: a conflict. The record is set to the backend's state, or to what
  `resolve` returns, in one transaction; the `conflict` events follow once it has landed. The id stays pending: equal
  to the backend's state it says nothing more, different it goes again with that state assumed. A resolution the
  engine refuses is a `refused` event with `direction: 'push'`; the record stands, the backend's state is not
  learned (its id kept as a refused pull's is) and the row is parked: a change to the record or `reSync()` pushes it
  again with the state known assumed, which meets the same conflict.
- **Neither a document nor an error**: parked with the reason `answer`.

A backend that refuses a row which assumed exactly what the backend says it holds, twice in a row, contradicts
itself: the row is parked with the reason `conflict` rather than pushed in a loop. A record `modifier.push` throws on
has no row to send: it is parked with the reason `modifier` and the thrown error as the `cause`, and the rest of the
batch goes.

`modifier.pull` turns the backend's shape into the record's, `modifier.push` the record's into the backend's. What the
connector remembers and compares is the backend's shape: a document as it came (before `modifier.pull`, its canonical
JSON text, an object with `toJSON()` such as a `Date` read through it), a row as it went (after `modifier.push`).
`modifier.pull` runs once per document, before the JSON check: what it returns must be JSON. A conflict's `remote`
passes through `modifier.pull` and the same check (a conflict that fails it parks the row with the reason `value` or
`modifier`, the record untouched), and a resolution goes back through `modifier.push`.

## Parked rows

A parked row is an edit the backend did not take and the connector no longer pushes by itself: a row refused by name,
a row answered with neither a document nor an error (`answer`), a record `modifier.push` throws on (`modifier`), a
conflict whose `remote` cannot be read (`value`, `modifier`), a backend contradicting itself (`conflict`), or a
conflict whose resolution the engine refused (the engine's code). It is reported once, as its `refused` event. `stats().parked` counts the rows set aside, and `parked`
lists them as `{ id, reason }`, the reason being the event's (its first 64 characters).

The parked rows are kept with the [checkpoint](#the-checkpoint), because nothing else remembers one: its change is
behind `pushed` in the log. A connector started again under the same `name` restores them still parked: it pushes
none of them by itself, counts and lists them, and tries each again as before the restart:

- **A change to the record** makes the row pending and pushes it. A change made while no connector ran is in the log
  since `pushed`, so the restart pushes that row.
- **`reSync()`** pushes every parked row again. Until the backend answers, the row counts as pending and is still
  kept as parked, so a retry cut short by a failing push or a crash leaves it parked.
- **A row leaves** when the backend takes it, when it has nothing left to say (the record reads as the backend is
  known to hold it), or when a pull lands the backend's state over the record (the backend won a conflict).

A parked row whose record was deleted or purged meanwhile goes as a deletion. A deletion made while no connector
ran is in the log and the restart pushes it; so is a purge, where the backend is known to hold a state of the record,
and a purge of a record the backend never took anything of waits for `reSync()`. A
parked id that has since become an encrypted record or a record of another collection is forgotten. Where the log
cannot resume from `pushed`, every live record of the collection is checked against the backend once, a parked one
with the rest. Because `pushed` never passes a change still waiting to go, a restart can push a parked row once more
where an older change, or another row of the same transaction, was still pending when the checkpoint was saved (at
least once: it is refused and parked again).

There is one entry per parked record, so the list cannot outgrow the collection: a backend that refuses every row
holds an entry per record, as `known` does for a backend that takes them.

## The checkpoint

One JSON text in the database's `connector` key-value namespace, under the connector's `name`, holds what a restart
needs:

```json
{
  "pull": 42,
  "pushed": "mw6l.17",
  "known": { "t1": "b-SQXlGHTSadY8-j1RK7Vt", "t2": null },
  "refused": ["t3"],
  "parked": { "t4": "too_large" }
}
```

`pull` is the backend's position as the pull handler last returned it. `pushed` is this node's log position pushed
through; it never passes a change still waiting to go, so a restart pushes every pending change again (at least once,
never lost). `known` names the backend's state per record: 22 characters of the SHA-256 (base64url) of the canonical
JSON of the backend's shape, `null` where the backend holds nothing, no entry for a record gone on both sides. That is
about 50 bytes a record. `refused` lists the ids whose backend state the database refused to land, which `reSync()`
asks about again. `parked` names the [parked rows](#parked-rows), each with its reason (at most 64 characters). The
text is saved coalesced (one write in flight, the next 200 ms later while pages keep
landing) and at once at the end of a pull run, after a push, after a page of the stream and on `cancel()`. A crash
between a landing and its save lands that page again.

In memory the connector keeps the backend's state as text for up to 10 000 records (the oldest not pending forgotten
first); a push of a record known only by digest is a probe. `start()` reads the checkpoint, pulls from `pull` (judging
a document by its digest where the text is not in memory, so this node's own echo over an offline edit is skipped),
then pushes what the log holds since `pushed`; the parked rows stay parked. A record deleted while no connector ran
goes as a deletion, and so does one purged: a purge erases the record's collection with it, so the connector tells a
purged record of its own by the backend's state it still knows (`known`), and one the backend never held is not
sent. Where the log cannot resume there (compacted past it, another epoch, a connector never run) every live record
of the collection is probed once (`connector.rebuild` in the log): equal records say nothing, differing ones are
conflicts, records the backend lacks are created.

## Live, retries and waiting

The live side begins once the first pull run is through. Everything the pull side lands, the pages of a pull run and
the pages of the stream, goes through one queue in order. A `RESYNC` while a pull runs makes that run go once more
after its pages.

A pull's page and a push take turns, and a turn is the whole exchange: the pull handler is called and its page judged
in one turn, and a push reads its rows, calls the push handler and judges the answer in one. No push is answered
between a page's read and its judgement, so a document is always judged against what the connector knew of its
record when the backend was read. (Judged later, a page read before a push was answered held the older state: it
landed over the newer record, or won a conflict over an edit made since.) A pull handler and a push handler are
therefore never in flight together: a slow page delays a push by that page, and the other way round, and a handler
that never settles holds the other side with it, so give a handler's requests a timeout. The probe `reSync()` sends
for a refused document is asked and judged in one turn the same way.

A page of the stream is read by the backend, not in a turn of the connector, and it waits on the queue. If a push is
answered for a record, or a pull's page reads it, while the stream's page waits, the page's document of that record
may be the older: where it does not hold the state the connector now knows, it is not judged and not counted, and a
pull is asked for instead, which reads the record as it stands. A stream page never moves the checkpoint, so nothing
is skipped. What this cannot see is a page that crossed a push on the wire and was handed over after the push's
answer: that document is judged as it arrives, and the backend's next word on the record corrects it.

A failure in either direction is kept (`errors`, the newest twenty), logged as `connector.failed`, and retried after
`retryTime · 2^n` ms (n the failures in a row in that direction), capped at `maxRetryTime`, times a random factor
between 0.75 and 1.25. `reSync()` on a connector that is not active rejects with `REPLICATION_FAILED` and a `null`
direction, and `start()` on a canceled one throws the same.

`awaitInitialReplication()` resolves when the first pull run and the first push drain have both succeeded;
`awaitInSync()` when, in addition, nothing is pending, no push is in flight and nothing waits on the pull queue. Both
take `{ signal }` to stop waiting, and both reject once the connector is canceled.
