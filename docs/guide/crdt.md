---
title: CRDT
description: Every syncom field merges as a CRDT of its kind, always on, from registers and counters to text and trees, plus the plain-object delta helpers.
---

# CRDT

A CRDT (conflict-free replicated data type) is a value that several nodes can change on their own and
later merge into the same result, without a server deciding and without asking you to resolve anything.
In syncom every field of every record is one. There is no plugin to add and no option to switch on: the
kind of a field decides how it merges, and the call that first writes the field decides its kind.

## Edit the same task on two nodes

A laptop and a phone sync the task board through a server ([Sync engine](./replication) shows how to
connect them). Both are offline, and both edit the same task. The laptop:

<<< @/examples/crdt.mjs#laptop

The phone, a moment later and before it has seen any of the laptop's edits:

<<< @/examples/crdt.mjs#phone

<LiveReplication />

When they are back online and have synced, every node reads the same task:

<<< @/examples/crdt.mjs#merged

Each field merged by its own rule. The title is a register: both nodes replaced it, so the newer write
won, the phone's. The votes are a counter, so both increments count and the total is 3. The tags are a
set, so both additions are kept. The notes are a text, so the laptop's "First " and the phone's
", reviewed" both landed in the right places. No node had to wait for another, and the result does not
depend on the order in which the ops arrived.

## Every field has a kind

| Kind     | Made by                                                      | Two concurrent writes                                                         |
| -------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Register | `insert()`, `set()`, `update()`                              | The write with the newer stamp wins, on every node                            |
| Counter  | `inc()`                                                      | Both increments count                                                         |
| Set      | `add()`, `remove()`                                          | Both additions are kept; a removal takes out only the additions it had seen   |
| List     | `push()`, `splice()` with an array (the `text` plugin)       | Both insertions are kept, each where it was made                              |
| Text     | `updateText()`, `splice()` with a string (the `text` plugin) | Both edits are kept, character by character, with their formatting            |
| Tree     | `treeMove()` (the `tree` plugin)                             | Both moves apply, and a move that would make a cycle is dropped on every node |

A field keeps its kind: `inc()` on a field that holds a register is refused with `ALX_ERR_FIELD_KIND`, so a typo
cannot turn a title into a counter. If two nodes make the same field two different kinds at the same
time, a fixed order decides the same way everywhere (a register, then a counter, beats a set, a set beats
a list, a list a text, a text a tree). [Fields that merge](./fields) covers registers, counters and sets
in depth; [Lists](./lists), [Text](./text) and [Trees](./trees) cover the rest.

A stamp is a time on the writing node's clock, adjusted so that it is always above every stamp the node
has seen for that record. A register written after a node has seen another write therefore always wins
over it, whatever the wall clocks say; only writes made without seeing each other are decided by time.

## Know when a register lost

Last-writer-wins drops one of two values. syncom tells you when it happens, through the `conflict` event:

<<< @/examples/crdt.mjs#conflict

The event fires on a node that receives a register write stamped below the value it holds, with what
the field kept (`winner`) and what was dropped (`loser`). Use it to log, to show a notice, or to let a
person pick again. The same event reports a [unique key](./schema) that two nodes took at the
same time. [Transactions and conflicts](./transactions-conflicts) goes through every case.

## When CRDT merging is not what you want

A CRDT merges each field on its own, which is the wrong model for some data:

- **Rules across fields or records.** Two nodes that each take the last item in stock both succeed, and
  the counter goes below zero. A merge cannot know your invariant. Check it where one node decides, with
  the host's `authorizeWrite` ([Server](./server)), or keep that data on the server.
- **Values that belong together.** If a street and a city are two fields, two nodes editing the address
  can merge into a street from one and a city from the other, an address nobody wrote. Store the address
  as one field holding an object: it is one register, and it wins or loses whole.
- **Choices a person must make.** When neither concurrent value may silently win, keep both (a set of
  proposals instead of one register) or surface the `conflict` event and ask.
- **Deletes and concurrent edits.** A delete is a marker with a stamp. An edit stamped after it, made by
  a node that had not seen the delete, brings the record back with the fields that edit wrote.

## Merge plain objects with the delta helpers

The package root also exports three small functions over plain objects, `diff`, `merge` and `apply`.
They do not touch a database and are not how syncom replicates; they are helpers for deltas of your own:

<<< @/examples/crdt.mjs#deltas

`merge(source, delta)` returns a new object and never changes its arguments. Its rules are what let two
deltas merged in any order give the same result:

| Value in the delta                         | Effect                             |
| ------------------------------------------ | ---------------------------------- |
| `undefined`                                | Deletes the key                    |
| An array or a `Set`                        | Joins with the existing collection |
| An object                                  | Merges recursively                 |
| A number, where the target is a number too | Adds                               |
| Anything else                              | Replaces                           |

`diff(source, target)` returns the delta that `merge` turns `source` into `target` with: changed keys,
nested objects by their changed leaves, a removed key as `undefined`, and for an array or a `Set` only
the elements the target added (a grow-only set never takes an element out). `apply(source, history)`
replays a list of operations onto a state: `write` replaces the state with `data`, `delta` merges `data`,
`delete` sets `key` to `undefined` (without a `key` the state becomes `{}`), `inc` and `dec` add and
subtract `value` at `key`; anything else is skipped.

::: warning Numbers add, they do not replace
Because `merge` adds numbers, a delta from `diff` is not a plain patch where numbers are involved:

<<< @/examples/crdt.mjs#numbers-add

To set an absolute number, write it to the database with `update()`, which stores it as a register.
:::

Inside a database, `db.diff(id, from, to)` from the versions plugin is a different function: it returns
the patches between two versions of a record ([Versions](./versions)).

## Coming from RxDB

RxDB stores whole documents and resolves a replication conflict with a handler. Its CRDT plugin is opt-in
per collection: the schema names a field for the operations, and every change goes through
`updateCRDT()` with update operators that each node replays in order. In syncom the merge is the storage
model itself: every write is already an op of its kind, so `update()`, `inc()` and `add()` merge without
a special call, and text, lists and trees merge too.

::: code-group

<<< @/examples/crdt.mjs#laptop [syncom]

<<< @/examples/rxdb/crdt.mjs#laptop [RxDB]

:::

<FromRxdb page="crdt" :rows="['crdtModel', 'counters', 'sets', 'text', 'conflictWhere']" />

The functions on their own: [API reference](../reference/api#crdt).
