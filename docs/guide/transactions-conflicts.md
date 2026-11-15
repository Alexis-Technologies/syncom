---
title: Transactions and conflicts
description: Write several records in one transaction, write only if a record holds what you expect, and see how edits from two nodes merge without revisions.
---

# Transactions and conflicts

Two kinds of trouble come up on the task board. On one node, some writes belong together: closing a task
and counting it in the board's totals should happen both or not at all, and claiming a task should
succeed only if nobody claimed it first. Across nodes, Ada and Bob edit the same task while one of them
is offline, and both edits arrive later in either order.

syncom answers the first with real local transactions and conditional writes, and the second with merge
rules built into every field. There is no revision field to send back, no write rejected because another
node got there first, and no conflict handler to write.

<LiveReplication />

## Write several records as one

`transact(fn)` runs `fn` with a transaction object, `tx`, that has the database's write methods. Every
write made through `tx` becomes an op, and when `fn` returns, all of them are appended to the log
together:

<<< @/examples/transactions-conflicts.mjs#schema

<<< @/examples/transactions-conflicts.mjs#transact

All the ops are durable or none is. Inside `fn`, `tx.get()` and `tx.has()` read the records as the
transaction has left them so far, hooks and validators run on each write as it is made, and the
`commit` events fire once the whole transaction has landed, in order. A throw from `fn`, or a write the
database refuses (a validator, a unique key, an index out of range), leaves nothing written:

<<< @/examples/transactions-conflicts.mjs#rollback

Pass `{ message }` to label the change: the message rides on every op of the transaction, peers receive
it with the ops, and [`history()`](./versions) lists it. `tx` has every write method except `purge()`,
which rewrites the log and cannot be undone with the rest. Bulk writes, `modify()` and update operators
use transactions too, so each of them lands whole.

A transaction is local. It makes the ops land together on this node and travel together to the others,
but each op still merges on its own when it arrives, by the rules below.

## Write only if the record still holds what you expect

To claim a task only if it is still unassigned, use `swap(id, changes, expected)`:

<<< @/examples/transactions-conflicts.mjs#swap

`swap()` compares the fields of `expected` with the record and writes `changes` only if every one
matches. The comparison and the write happen in the node's write queue, one after the other with nothing
in between, so two swaps on the same expectation can never both succeed. It resolves to `false` and
writes nothing on a mismatch, and rejects when the record does not exist.

For a condition that is more than equality, `update()` takes a query to match first:

<<< @/examples/transactions-conflicts.mjs#if-match

`ifMatch` is a [query](./query) evaluated against the record inside the write queue, and the update
resolves to whether it wrote.

Both are checks on this node, against what this node holds. They prevent two writes on one node from
overwriting each other; they cannot stop another node from writing the same field while offline. Across
nodes, the merge rules decide.

## Why there is no revision field

Databases that resolve conflicts by revision keep a `_rev` on every document: a write names the revision
it started from and is rejected if the document moved on. That protects a server's copy from a client
that did not see the latest change.

A syncom node does not need it for its own writes, because they go through one queue: each write sees
the result of the one before, `modify()` calls on one record compose, and `swap()` covers the
read-then-write case. Across nodes, a rejection would not help either: the other node may be offline
for a week, and the edit still has to be kept or merged. So instead of one revision per record, syncom
keeps a little metadata per field, out of sight in the record's metadata (never in its data): a
timestamp for each plain field, a running sum per node for each counter, and per element of a set the
additions and removals that touched it. That is what lets two nodes merge any two versions of a record,
in any order, and agree.

## How concurrent edits merge

Ada renames the task and Bob closes it, each also voting and tagging it, while Bob's phone is offline:

<<< @/examples/transactions-conflicts.mjs#fields

Nothing was lost. The rules, which every node applies the same way, depend on the field's kind:

- **Different fields** never conflict: the title came from the laptop, `done` from the phone.
- **A counter** adds up. Each node keeps its own running total and the field reads their sum, so two
  votes made at the same time count twice.
- **A set** keeps concurrent additions: `docs` and `urgent` are both there.
- **A plain field (a register)** keeps one value, the write with the later timestamp, with the node id
  deciding a tie.
- **A list or a text** keeps both insertions, each in place; see [Lists](./lists) and
  [Text](./text).

A field's kind is set by the first call that writes it: `update()` makes a register, `inc()` a counter,
`add()` a set. [Fields that merge](./fields) shows each kind in full.

## Edit the same field on two nodes

When the same plain field is written on two nodes without either seeing the other's write, the later
write wins everywhere. To find out where that happened, listen for `conflict`:

<<< @/examples/transactions-conflicts.mjs#conflict

<<< @/examples/transactions-conflicts.mjs#same-field

The event fires on a node that receives a peer's write stamped below the value it already holds, with the
field, the op, and both sides as `{ ts, origin, value }`. Here that is the laptop and the server, which
held `cy` when Bob's older `bob` arrived. The phone, whose write lost, sees its value replaced as an
ordinary change. The losing write is still applied for any other fields it carried. Use the event to
log, to notify the person whose edit lost, or to write a merged value of your own, which, being newer,
then wins everywhere.

A set has no such case, because a removal names the additions it saw:

<<< @/examples/transactions-conflicts.mjs#remove

Bob's removal could only cancel the `urgent` additions his phone had seen. Ada's new addition was not
among them, so the tag stays, on every node.

## Unique keys across nodes

A unique key is checked when you write, against what the node holds:

<<< @/examples/transactions-conflicts.mjs#unique-local

Two nodes that are offline can still both create a task with slug `notes`. When the second one arrives,
the node keeps both records, because refusing a write that another node already accepted would make the
nodes disagree, and emits `conflict` with `kind: 'unique'`:

<<< @/examples/transactions-conflicts.mjs#unique-remote

Resolve it in your app, for example by renaming one of the two from the listener; the rename then
replicates like any write.

## Trade-offs

- **Last writer wins on plain fields.** A concurrent overwrite keeps one value. Timestamps come from each
  node's clock, which never runs backwards and never falls behind what the node has seen, so a write made
  after reading another always wins over it. Between two writes made without seeing each other, clock
  skew decides which one wins, never whether the nodes agree.
- **A nested object is one register.** Two nodes changing different keys of one nested object keep one of
  the objects, not both changes. Write keys that change independently as their own fields or as
  [paths](./fields).
- **A field keeps its kind.** Writing a counter with `update()` is refused locally (`FIELD_KIND`). If two
  nodes make one field two different kinds at the same time, a fixed precedence (register, counter, set,
  list, text, tree) picks the kind on every node, and the other kind's edits are dropped (a node that
  held the winning kind first reports the refused op as an `OP_REFUSED` error event).
- **One counter case does not merge.** A counter incremented by one node both before and after another
  node's concurrent `set()` of the whole record can read differently on different nodes. Avoid resetting a
  record with `set()` while others increment its counters.
- **Transactions do not span nodes.** There is no distributed lock or consensus; `swap()` and `ifMatch`
  guard one node's writes. For a rule every write must pass, enforce it where the writes meet: the host's
  `authorizeWrite` ([syncom server replication](./replication-server)) or a [hook](./hooks).

## Coming from RxDB

RxDB has no multi-document transactions and keeps a `_rev` on every document: a local write that raced
another is retried by `incrementalModify()`, and a replication conflict goes to the collection's
`conflictHandler`, which by default keeps the server's document. syncom has real transactions, a
compare-and-swap, and no handler to write: concurrent edits merge per field, and the `conflict` event
reports the overwrites that happened. RxDB's handler can express any merge you like on the client; in
syncom you pick the field kinds that merge the way you need.

::: code-group

<<< @/examples/transactions-conflicts.mjs#swap [syncom]

<<< @/examples/rxdb/transactions-conflicts.mjs#claim [RxDB]

:::

::: code-group

<<< @/examples/transactions-conflicts.mjs#conflict [syncom]

<<< @/examples/rxdb/transactions-conflicts.mjs#conflict [RxDB]

:::

<FromRxdb page="transactions-conflicts-revisions" :rows="['transactions', 'cas', 'localConflicts', 'conflictResolve', 'mergeGranularity', 'conflictEvents']" />
