---
title: Fields that merge
description: How each kind of field merges when two nodes edit one record at once - registers, counters, sets and paths - and how to choose the kind per field.
---

# Fields that merge

Your laptop and your phone both hold the task board, and the train goes into a tunnel. On the laptop you
rename a task and vote for it; on the phone you mark the same task done, vote for it too, and tag it. When
the phone is back online, what should the task look like? Most apps would say: the new name, done, two
votes, both tags. syncom gives you exactly that, because it merges each field on its own, and each field
merges the way its kind says.

<FigReplication />

There is no conflict handler to write. Every write is an [op](./glossary#op) stamped with a clock, and
the rules for each kind of field are chosen so that every [node](./glossary#node) (every database taking
part in sync) applying the same ops, in any order, ends with the same record (the one exception is under
[Trade-offs](#trade-offs)). You choose the kind of a field by the call that first writes it.

The examples with two devices run three nodes in one process: a `server` that hosts, and a `laptop` and a
`phone` that dial it. `MemoryLink` from `@alexify/syncom/testing` is a test stand-in for the network, which
lets `links.phone.disconnect()` cut the phone off. In an app, `connect` opens a wrpc client instead, as in
the [Quickstart](./quickstart#sync-with-another-node); the merge is the same ([Sync engine](./replication)).

<<< @/examples/fields-sync.mjs#nodes

<<< @/examples/fields-sync.mjs#offline

<<< @/examples/fields-sync.mjs#merged

<LiveReplication />

## Plain fields keep the last write

A field written with `insert()`, `update()` or `set()` is a register: it holds one value, and a later write
replaces it. Two nodes that write different fields of a record both keep their change, because each field
is decided on its own.

<<< @/examples/fields.mjs#register

The examples on one node below go on with this `db` and `task`; those with two devices, like the next
one, use the nodes set up at the top of the page.

When two nodes write the same field while apart, the write with the later stamp wins on both nodes. A
stamp is the writer's clock, which never runs behind anything the node has already seen, with the node id
to break a tie, so every node picks the same winner:

<<< @/examples/fields-sync.mjs#same-field

A value that is an object or an array is one register too, replaced whole by the later write. When two
people should be able to edit parts of it at once, write the parts [by path](#edit-part-of-an-object), or
use a [list](./lists) for an array whose elements change.

## Counters add up

The first `inc()` on a field makes it a counter. Every node keeps its own running sum, and the field reads
as the total of all of them, so increments made on two nodes at once all count. An `inc()` may be negative.

<<< @/examples/fields.mjs#counter

`inc()`, and `add()` and `remove()` below, are calls of the database by id, like the others on
[Database](./database#read-and-write-records-by-id). A collection has no `inc()`: through `db.Task`, use
the `$inc`, `$addToSet` and `$pull` [operators](#update-operators-pick-the-kind-for-you) of `update()`.

Use a counter for votes, likes, stock levels and anything else people change by an amount rather than to a
value. A register holding a number would keep only one of two concurrent changes.

## Sets keep every add

The first `add()` on a field makes it a set. Adding an element that is there already changes nothing, and
`remove()` takes out the elements this node has seen added, so an add made elsewhere at the same time
survives the remove. Elements are any JSON values, told apart by their JSON text, and the field reads as an
array sorted by that text.

<<< @/examples/fields.mjs#set

Do not confuse `db.remove(id, field, elements)` with `db.Task.remove()`, which deletes every record of
the collection. Use a set for tags, labels, members and other collections where order does not matter and
an element is either in or out.

## A field is one kind

Once a field has a kind, writes of another kind are refused before anything is stamped: an `update()` of a
counter, an `inc()` of a register, an `add()` to a counter. The error is a `SyncomError` with
`code: 'FIELD_KIND'`, and `kind` says what the field is.

<<< @/examples/fields.mjs#one-kind

Between nodes the rule is different, since a node cannot refuse what a peer already wrote. When two nodes
create one field as two kinds at once, a fixed rule keeps the same kind on every node, and the other side's
edits to that field are dropped (the order of the kinds is in the
[reference](../reference/api#field-kinds-and-paths)). Pick one kind per field in your app and this never
comes up.

## Edit part of an object

A field name may be a path of segments joined by `/`. Each path is a field of its own, of any kind, merged
on its own, and a read puts the paths together into nested objects:

<<< @/examples/fields.mjs#paths

Two nodes that write `assignee/name` and `assignee/team` at the same time both keep their change, as the
offline example above shows. Writing `assignee` whole with a new object is a register write at the prefix:
it replaces what was under it, and a child written after it is laid over it. A counter, a set, a list, a
text or a tree holds its path alone, so a write under it (`votes/today` under a counter `votes`) is refused
with `FIELD_KIND`. How long a path may be and how many a record holds are in the
[reference](../reference/api#field-kinds-and-paths).

A write and a query spell the same path differently, because they look at different things:

<<< @/examples/fields.mjs#path-query

A write names a field, and `assignee/name` is a field of its own, so its segments are joined by `/`. A
query reads the record put together, where `assignee` is an object with a `name` key, so it reaches in
with a dot, as MongoDB does. A dot in a write is an ordinary character of the field's name:
`update(id, { 'a.b': 1 })` writes a field called `a.b`.

## Update operators pick the kind for you

`update()` also takes MongoDB-style operators, and each one becomes the write its field's kind needs:
`$inc` an `inc()` on a counter, `$addToSet` and `$pull` an `add()` and `remove()` on a set, `$set` and
`$unset` register writes, `$push` and `$pop` an insert or a removal at an end of a list. All the operators
of one call are written as one transaction.

<<< @/examples/fields.mjs#operators

An operator applied to a field that does not exist yet creates the kind it means for `$inc` (a counter) and
`$addToSet` (a set). On a register that holds an array, `$addToSet`, `$pull`, `$push` and `$pop` rewrite the
array as a new register value, and an absent field given a `$push` becomes such an array. An operator that
does not fit the field's kind, such as `$inc` on a register, is `FIELD_KIND`, the same as the method would
be. `$min`, `$max` and `$rename` work on registers.

## Remove a field

`unset()` removes fields of any kind, and everything under a path prefix with them. It is a reset of its
own: an older concurrent write of the field loses to it, a newer one makes the field again, as whatever
kind that write is.

<<< @/examples/fields.mjs#unset

## Delete a record another node is editing

A delete leaves a [tombstone](./glossary#tombstone), and the tombstone wins over every edit of a field,
whenever that edit was made. When Ada deletes a task while Bob, offline, edits it and votes for it a
moment later, the task stays deleted on both nodes once they meet:

<<< @/examples/fields-sync.mjs#delete

<<< @/examples/fields-sync.mjs#revived

Bob's edits reach every node, but they stay under the tombstone where no read finds them, so the record
reads as gone everywhere, whichever of the two arrived first. Once Bob's device knows of the delete, a field
method on the record (`update()`, `inc()`, `add()`, `remove()`, `unset()`, a list, text or tree edit)
rejects with `NOT_FOUND`. Only a whole-record write (`set()`, `upsert()`, or `insert()` of the same id)
brings a deleted record back: it holds what that write gives it, and the edits of a field stamped after
it.

When a record should keep every field through such a race, delete it softly: a `deleted: true` field is a
register like any other, so the edit and the deletion both stay, and the later of the two decides whether
the record reads as deleted.

## Lists, text and trees

Three more kinds merge by position rather than by value, and come with the `text` and `tree` plugins.
A [list](./lists) is an array whose elements two nodes can insert, remove and move at once. A
[text](./text) is a string two people can type into at the same spot, with marks for rich text. A
[tree](./trees) holds nodes that move under new parents without ever forming a cycle. They follow the same
rule as every other field: the first write decides the kind.

## Trade-offs

A whole-record write resets the record. `set()`, `upsert()` and a collection's `set()` replace it, counters
and sets included, and a concurrent write made elsewhere with an earlier stamp is lost with them, whichever
order the two arrive in. Change part of a record with `update()`.

<<< @/examples/fields.mjs#whole

- **A register keeps one of two concurrent writes.** That is right for a title or a status, and wrong for
  prose two people edit at once: use a [text](./text) field there.
- **Last write wins by the clock.** A device whose clock runs far ahead would win every register it
  writes, so a peer refuses ops stamped too far ahead of its own clock
  ([`sync.maxSkew`](../reference/api#sync-options)).
- **A counter and a concurrent reset do not converge.** If one node increments a counter both before and
  after another node resets it concurrently (an `unset()`, or a whole-record write that drops the field),
  the nodes can end up reading different totals. Resettable counters would need causal metadata syncom
  does not carry, so do not reset a counter while other nodes may be incrementing it. This is the one case
  where syncom's fields do not converge.
- **Two kinds on one field lose one side.** When nodes create one field as two kinds at once, the rule
  [above](#a-field-is-one-kind) keeps one kind on every node, and the other side's edits to that field are
  gone.
- **A delete wins over every concurrent edit.** An edit made on another node after the delete is kept out of
  sight rather than merged, until a whole-record write brings the record back. Delete softly where edits
  must survive; see [Delete a record another node is editing](#delete-a-record-another-node-is-editing).

The full rules, including what happens to each kind on a peer's snapshot, are in the
[sync protocol](./sync-protocol) and the [wire reference](../reference/wire).
